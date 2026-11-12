/**
 * 校验多文件技能包的「打包 / 解包 / 入库 / 读闸门」。
 *
 * 用法：`node deploy/orchestrator/verify-bundle.mjs`
 * 不需要 docker，也不需要真库（用 `:memory:`，建表语句与线上同一份 init-db.sql）。
 *
 * 为什么单独立一条：
 *   1. 解包是最容易被塞进恶意路径的一层，`../`、绝对路径、符号链接各来一发，
 *      每一发都要有明确结果，不能靠「真机上应该没事」；
 *   2. digest 是缓存与「要不要重下」的唯一判据，它一旦把 mtime / 顺序算进去，
 *      就会出现「内容没变但天天重下」或者更糟的「内容变了却不重下」。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
	BUNDLE_LIMITS,
	buildTarGz,
	filesDigest,
	mimeOf,
	readTarGz,
	safeEntryPath,
	stripFrontmatter,
	walkSkillDir,
} from './bundle.mjs'
import { bundleInfoMap, itemFiles, openDb, skillBundleForTeam, upsertItem } from './db.mjs'
import { publishSkillFromBundle } from './market.mjs'

let failed = 0
const ok = (label, condition, detail = '') => {
	console.log(`${condition ? '✓' : '✗'} ${label}${condition ? '' : `  ${detail}`}`)
	if (!condition) failed += 1
}
const eq = (label, actual, expected) =>
	ok(label, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
const throws = (label, fn, match) => {
	try {
		fn()
		ok(label, false, '没有抛错')
	} catch (error) {
		ok(label, !match || error.message.includes(match), `错误信息不符：${error.message}`)
	}
}

const root = mkdtempSync(join(tmpdir(), 'verify-bundle-'))
const skillDir = join(root, 'demo-skill')
mkdirSync(join(skillDir, 'references'), { recursive: true })
mkdirSync(join(skillDir, 'scripts'), { recursive: true })
mkdirSync(join(skillDir, 'node_modules'), { recursive: true })
writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: 演示\n---\n\n正文\n')
writeFileSync(join(skillDir, 'references/sql-style.md'), '# 规范\n')
writeFileSync(join(skillDir, 'scripts/run.sh'), '#!/bin/sh\necho hi\n')
chmodSync(join(skillDir, 'scripts/run.sh'), 0o755)
writeFileSync(join(skillDir, '.DS_Store'), 'junk')
writeFileSync(join(skillDir, '._SKILL.md'), 'junk')
writeFileSync(join(skillDir, 'node_modules/x.js'), 'junk')

// ---------- 目录 → 文件清单 ----------
const walked = walkSkillDir(skillDir)
eq(
	'walkSkillDir 按路径排序且只留要发的文件',
	walked.map((f) => f.path),
	['SKILL.md', 'references/sql-style.md', 'scripts/run.sh'],
)
ok('walkSkillDir 认出可执行位', walked.find((f) => f.path === 'scripts/run.sh').executable)
ok('walkSkillDir 不把 SKILL.md 当可执行', !walked.find((f) => f.path === 'SKILL.md').executable)

// ---------- digest ----------
const digestA = filesDigest(walked)
eq('digest 与文件顺序无关', filesDigest([...walked].reverse()), digestA)
const tweaked = walked.map((f) => (f.path === 'references/sql-style.md' ? { ...f, data: Buffer.from('# 规范 v2\n') } : f))
ok('内容一变 digest 就变', filesDigest(tweaked) !== digestA)
const execBit = walked.map((f) => (f.path === 'SKILL.md' ? { ...f, executable: true } : f))
ok('可执行位一变 digest 就变', filesDigest(execBit) !== digestA)
eq('digest 是 64 位十六进制', digestA.length, 64)

// ---------- 打包是确定的 ----------
ok('同样的输入打两次字节完全一致', buildTarGz(walked).equals(buildTarGz(walked)))

// ---------- 往返 ----------
const tar = buildTarGz(walked)
const back = readTarGz(tar)
eq(
	'解包回来的路径与顺序一致',
	back.map((f) => f.path),
	walked.map((f) => f.path),
)
ok(
	'解包回来的字节一致',
	back.every((f, i) => f.data.equals(Buffer.from(walked[i].data))),
)
ok('解包保住可执行位', back.find((f) => f.path === 'scripts/run.sh').executable)
eq('往返后 digest 不变', filesDigest(back), digestA)
ok('中文与二进制都不走样', readTarGz(buildTarGz([{ path: 'SKILL.md', data: Buffer.from([0xff, 0x00, 0x80]) }]))[0].data.equals(Buffer.from([0xff, 0x00, 0x80])))

// ---------- 路径安全 ----------
for (const good of ['./a/b', 'a/b', 'a//b']) ok(`safeEntryPath 接受 ${good}`, safeEntryPath(good) === 'a/b')
for (const bad of ['', '/etc/passwd', '../x', 'a/../../b', 'C:\\x', 'a/\u0000b'])
	ok(`safeEntryPath 拒绝 ${JSON.stringify(bad)}`, safeEntryPath(bad) === null)

/** 手工拼一个最小 tar，用来造 buildTarGz 永远不会产出的恶意条目。 */
const rawTar = (entries) => {
	const blocks = []
	for (const entry of entries) {
		const header = Buffer.alloc(512)
		header.write(entry.name, 0, 100, 'utf8')
		header.write('0000644\0', 100, 8)
		header.write('0000000\0', 108, 8)
		header.write('0000000\0', 116, 8)
		header.write(`${entry.data.length.toString(8).padStart(11, '0')}\0`, 124, 12)
		header.write('00000000000\0', 136, 12)
		header.write('        ', 148, 8)
		header.write(entry.type || '0', 156, 1)
		header.write('ustar\0', 257, 6)
		header.write('00', 263, 2)
		let sum = 0
		for (const byte of header) sum += byte
		header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
		blocks.push(header, entry.data, Buffer.alloc((512 - (entry.data.length % 512)) % 512))
	}
	blocks.push(Buffer.alloc(1024))
	return gzipSync(Buffer.concat(blocks))
}

throws('拒绝 ../ 逃逸', () => readTarGz(rawTar([{ name: '../evil.md', data: Buffer.from('x') }])), '路径不安全')
throws('拒绝绝对路径', () => readTarGz(rawTar([{ name: '/etc/passwd', data: Buffer.from('x') }])), '路径不安全')
throws(
	'拒绝符号链接条目',
	() => readTarGz(rawTar([{ name: 'SKILL.md', data: Buffer.from('x') }, { name: 'link', data: Buffer.alloc(0), type: '2' }])),
	'不支持的条目类型',
)
throws('没有 SKILL.md 直接拒绝', () => readTarGz(rawTar([{ name: 'a.md', data: Buffer.from('x') }])), '缺少 SKILL.md')
throws('不是 gzip 直接拒绝', () => readTarGz(Buffer.from('not a gzip')), '不是合法的 tar.gz')
throws(
	'条目数超限',
	() => readTarGz(rawTar([{ name: 'SKILL.md', data: Buffer.from('x') }, ...Array.from({ length: 4 }, (_, i) => ({ name: `f${i}.md`, data: Buffer.from('x') }))]), {
		maxEntries: 3,
	}),
	'文件数超过上限',
)

// 允许整包套一层顶层目录（`tar czf x.tgz my-skill` 是常见的打法）
const nested = rawTar([
	{ name: 'my-skill/SKILL.md', data: Buffer.from('---\nname: a\n---\n正文\n') },
	{ name: 'my-skill/references/x.md', data: Buffer.from('x') },
])
eq(
	'顶层多套一层目录会被剥掉',
	readTarGz(nested).map((f) => f.path),
	['SKILL.md', 'references/x.md'],
)

// ---------- frontmatter / mime ----------
eq('stripFrontmatter 剥掉 ---', stripFrontmatter('---\nname: a\n---\n\n正文'), '正文')
eq('stripFrontmatter 对无 frontmatter 原样返回', stripFrontmatter('正文'), '正文')
eq('stripFrontmatter 对没闭合的 --- 原样返回', stripFrontmatter('---\nname: a'), '---\nname: a')
eq('mimeOf 认 md', mimeOf('SKILL.md'), 'text/markdown; charset=utf-8')
eq('mimeOf 认 sh', mimeOf('scripts/run.sh'), 'text/x-shellscript')

// ---------- 入库 ----------
const db = openDb(':memory:')
const base = {
	kind: 'skill',
	name: 'demo-skill',
	version: '1.0.0',
	title: 'demo',
	description: '演示',
	visibility: 'public',
	ownerTeam: '_system',
	createdBy: 'verify',
	files: walked,
}
const itemId = upsertItem(db, base)
eq(
	'入库后能按清单读回 3 个文件',
	itemFiles(db, itemId).map((f) => f.path),
	['SKILL.md', 'references/sql-style.md', 'scripts/run.sh'],
)
eq('清单带回 size', itemFiles(db, itemId).find((f) => f.path === 'SKILL.md').size, Buffer.byteLength('---\nname: demo-skill\ndescription: 演示\n---\n\n正文\n'))
ok('清单带回 executable', itemFiles(db, itemId).find((f) => f.path === 'scripts/run.sh').executable)
eq(
	'多文件包 hasBundle = true',
	bundleInfoMap(db, [itemId]).get(itemId).hasBundle,
	true,
)

// 同版本重发：文件必须整组替换，删掉的文件要一起消失
upsertItem(db, { ...base, files: walked.filter((f) => f.path !== 'references/sql-style.md') })
eq(
	'重发时删掉的文件真的没了',
	itemFiles(db, itemId).map((f) => f.path),
	['SKILL.md', 'scripts/run.sh'],
)

// 单文件包不走 bundle：打 tar 只会让每次加载都多一次解包
const singleId = upsertItem(db, { ...base, name: 'single-skill', files: [walked[0]] })
eq('单文件包 hasBundle = false', bundleInfoMap(db, [singleId]).get(singleId).hasBundle, false)
const digestBefore = db.prepare('SELECT digest FROM market_items WHERE id = ?').get(itemId).digest
upsertItem(db, { ...base, files: walked.filter((f) => f.path !== 'scripts/run.sh') })
ok(
	'文件变了 digest 跟着变',
	db.prepare('SELECT digest FROM market_items WHERE id = ?').get(itemId).digest !== digestBefore,
)

// ---------- 读闸门 ----------
// 直接插 team_skills 是为了只测「读侧」这三道闸；写入侧另有 verify-ownership 覆盖
const mount = (team, enabled, version = '1.0.0') =>
	db
		.prepare(
			`INSERT OR REPLACE INTO team_skills
			   (team_id, name, item_id, version, enabled, source, installed_by, installed_at)
			 VALUES (?,?,?,?,?,'market','verify','2026-01-01T00:00:00Z')`,
		)
		.run(team, 'demo-skill', itemId, version, enabled ? 1 : 0)
ok('没装的团队读不到 bundle', skillBundleForTeam(db, 'team-x', 'demo-skill', '1.0.0') === undefined)
mount('team-x', false)
ok('装了但没启用也读不到', skillBundleForTeam(db, 'team-x', 'demo-skill', '1.0.0') === undefined)
mount('team-x', true)
ok('启用后才拿到文件', skillBundleForTeam(db, 'team-x', 'demo-skill', '1.0.0')?.files.length === 2)
ok('版本对不上读不到', skillBundleForTeam(db, 'team-x', 'demo-skill', '9.9.9') === undefined)
ok('别的团队读不到', skillBundleForTeam(db, 'team-y', 'demo-skill', '1.0.0') === undefined)
eq(
	'bundle 里的文件是原始字节（含 frontmatter）',
	skillBundleForTeam(db, 'team-x', 'demo-skill', '1.0.0').files.find((f) => f.path === 'SKILL.md').data.toString('utf8').startsWith('---'),
	true,
)

// ---------- 上传发布 ----------
const upload = await publishSkillFromBundle({
	team: 'team-x',
	name: 'upload-skill',
	buffer: buildTarGz([
		{ path: 'SKILL.md', data: Buffer.from('---\nname: upload-skill\ndescription: 上传的\n---\n\n正文\n') },
		{ path: 'scripts/go.sh', data: Buffer.from('#!/bin/sh\n'), executable: true },
	]),
})
eq('上传发布写入 2 个文件', upload.files, 2)
eq('上传发布标题取自 frontmatter', db.prepare('SELECT title FROM market_items WHERE id = ?').get(`skill:upload-skill@1.0.0`).title, 'upload-skill')
ok('上传发布的包能被取回', openDb().prepare("SELECT COUNT(*) c FROM market_item_files WHERE item_id = 'skill:upload-skill@1.0.0'").get().c === 2)
ok(
	'上传发布默认私有',
	db.prepare('SELECT visibility FROM market_items WHERE id = ?').get('skill:upload-skill@1.0.0').visibility === 'private',
)
const rejects = async (label, fn, match) => {
	try {
		await fn()
		ok(label, false, '没有抛错')
	} catch (error) {
		ok(label, !match || error.message.includes(match), `错误信息不符：${error.message}`)
	}
}
await rejects(
	'上传含 ../ 的包会被拒绝',
	() =>
		publishSkillFromBundle({
			team: 'team-x',
			name: 'evil-skill',
			buffer: rawTar([
				{ name: 'SKILL.md', data: Buffer.from('x') },
				{ name: '../evil.md', data: Buffer.from('x') },
			]),
		}),
	'路径不安全',
)
ok('被拒绝的上传没有留下任何行', db.prepare("SELECT COUNT(*) c FROM market_items WHERE name = 'evil-skill'").get().c === 0)

// ---------- 阈值 ----------
ok('上传上限是 32 MB', BUNDLE_LIMITS.maxUpload === 32 * 1024 * 1024)

rmSync(root, { recursive: true, force: true })
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 条失败`}`)
process.exit(failed === 0 ? 0 : 1)
