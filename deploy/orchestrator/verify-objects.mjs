/**
 * 校验对象层：内容寻址、去重、取回一致性、老记录降级。
 *
 * 用法：`node deploy/orchestrator/verify-objects.mjs`
 * 退出码非 0 表示有断言失败。全部在临时目录里跑，不碰生产对象库。
 *
 * 要证明的四件事：
 *   1. 入库存的 digest 与独立算出的 sha256 一致（否则「校验 digest 再删本地」就是空话）；
 *   2. 同一份内容重复入库幂等、只有一个副本（内容寻址的实际收益）；
 *   3. materialize 取回的字节与原文完全一致（归档能不能恢复，全靠这一条）；
 *   4. 真实归档包（archives/ 下现成的 tar.gz）也能原样往返 —— 合成数据太小，
 *      发现不了大文件与二进制内容上的问题。
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const root = mkdtempSync(join(tmpdir(), 'dsh-objects-'))
process.env.CONSOLE_OBJECTS_DIR = join(root, 'objects')

const { putFile, materialize, statObject, objectExists, deleteObject, objectPath, listObjectFiles, OBJECTS_DIR } =
	await import('./objects.mjs')

let failed = 0
const check = (label, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected)
	console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`}`)
	if (!ok) failed += 1
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

/* ---------- 1. 合成文件：digest / bytes / 取回一致 ---------- */
const sample = Buffer.alloc(256 * 1024)
for (let i = 0; i < sample.length; i += 1) sample[i] = (i * 31) % 256
const src = join(root, 'sample.bin')
writeFileSync(src, sample)

const stored = await putFile(src, { prefix: 'blobs' })
check('digest 与独立 sha256 一致', stored.digest, sha(sample))
check('bytes 与源文件一致', stored.bytes, sample.length)
check('入库后源文件已移走（putFile 是移入不是复制）', existsSync(src), false)
check('对象键 = prefix/digest', stored.key, `blobs/${stored.digest}`)

/* ---------- 2. 落盘分片：<prefix>/<digest 前两位>/<digest> ---------- */
const disk = objectPath(stored.key)
check('分片目录名取 digest 前两位', disk.includes(`/blobs/${stored.digest.slice(0, 2)}/`), true)
check('对象落在 OBJECTS_DIR 下', disk.startsWith(OBJECTS_DIR), true)

/* ---------- 3. 去重：同内容再入库不产生第二个副本 ---------- */
const again = join(root, 'sample2.bin')
writeFileSync(again, sample)
const second = await putFile(again, { prefix: 'blobs' })
check('同内容得到同一个对象键', second.key, stored.key)
check('同内容只留一份文件', listObjectFiles('blobs').length, 1)

/* ---------- 4. 取回：字节完全一致 ---------- */
const back = join(root, 'back.bin')
await materialize(stored.key, back)
check('取回内容与原文一致', sha(readFileSync(back)), sha(sample))
check('statObject 报告的大小正确', statObject(stored.key)?.bytes, sample.length)
check('statObject 对不存在的键返回 null', statObject('blobs/deadbeef'), null)

/* ---------- 5. 存在性判断：残缺键不能抛 ---------- */
check('存在的键 → true', objectExists(stored.key), true)
check('不存在的键 → false', objectExists('blobs/nope'), false)
check('残缺键（只有文件名，像老记录）→ false 而不是抛', objectExists('team-c-20261103.tar.gz'), false)
check('materialize 不存在的键会报错', await materialize('blobs/nope', join(root, 'x')).then(() => 'no-error').catch(() => 'error'), 'error')

/* ---------- 6. 删除：幂等 ---------- */
check('删除存在的对象 → true', deleteObject(stored.key), true)
check('再删一次 → false', deleteObject(stored.key), false)
check('删除后取回会报错', await materialize(stored.key, join(root, 'y')).then(() => 'no-error').catch(() => 'error'), 'error')

/* ---------- 7. 真实归档包往返（有现成 tar.gz 才跑） ---------- */
const archiveDir = resolve(HERE, 'archives')
const real = existsSync(archiveDir) ? readdirSync(archiveDir).find((name) => name.endsWith('.tar.gz')) : null
if (!real) {
	console.log('· 没有现成归档包，跳过真实包往返')
} else {
	// 先复制一份再入库：putFile 会把源文件移走，绝不能指向真正的归档包
	const copy = join(root, real)
	copyFileSync(join(archiveDir, real), copy)
	const realBytes = statSync(copy).size
	const realSha = sha(readFileSync(copy))
	const result = await putFile(copy, { prefix: 'archives/team-x' })
	check(`真实包 ${real}（${realBytes} 字节）digest 一致`, result.digest, realSha)
	const restored = join(root, 'restored.tar.gz')
	await materialize(result.key, restored)
	check('真实包取回后字节一致', sha(readFileSync(restored)), realSha)
	check('对象键按团队分前缀', result.key, `archives/team-x/${realSha}`)
	console.log(`· 真实包测试对象：${result.key}`)
}

/* ---------- 8. 对象层不可用：归档包必须留在本机 ---------- */
// 这条是整个改造里最要紧的安全点：调用 storeArchive 之前卷已经被 down -v 删掉，
// 传进去的 tar 就是唯一副本。所以「上传失败」只允许换位置，不允许丢。
const archiveHome = join(root, 'archives')
mkdirSync(archiveHome, { recursive: true })
const orphan = join(root, 'team-y-20260101-000000.tar.gz')
writeFileSync(orphan, sample)
const child = spawnSync(
	process.execPath,
	[
		'--input-type=module',
		'-e',
		`const { storeArchive } = await import(${JSON.stringify(resolve(HERE, 'runtime.mjs'))})
		 const out = await storeArchive(${JSON.stringify(orphan)}, 'team-y')
		 console.log(JSON.stringify(out))`,
	],
	{
		encoding: 'utf8',
		// /dev/null 下面建不了目录 → putFile 必失败，稳定复现降级分支
		env: { ...process.env, CONSOLE_OBJECTS_DIR: '/dev/null/objects', CONSOLE_ARCHIVE_DIR: archiveHome },
	},
)
let degraded = null
try {
	degraded = JSON.parse(child.stdout.trim().split('\n').pop())
} catch {
	degraded = null
}
check('对象层故障时没有抛错（归档流程能走完）', child.status, 0)
check('降级结果指向本机归档目录', String(degraded?.file || '').startsWith(archiveHome), true)
check('降级后文件真的存在（数据没丢）', Boolean(degraded?.file) && existsSync(degraded.file), true)
check('降级后字节与原文一致', degraded?.file ? statSync(degraded.file).size : -1, sample.length)
check('降级原因写进了记录', Boolean(degraded?.degraded), true)

rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
