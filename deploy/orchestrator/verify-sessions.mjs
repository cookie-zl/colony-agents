/**
 * 校验会话存算分离：增量上传、收缩自愈、崩溃重建、校验失败必须报错。
 *
 * 用法：`node deploy/orchestrator/verify-sessions.mjs`
 * 全程在临时目录里跑（临时卷 + 临时对象库 + 临时库），不碰任何生产数据，也不需要 docker。
 *
 * 要证明的五件事：
 *   1. 增量：第二次同步只推新增字节，不是整文件重传；
 *   2. 闲置兜底：尾巴小于阈值也不会永远不传（否则卷一丢就少一段）；
 *   3. 收缩自愈：dsh 截掉撕裂尾部后，越界分段被删、游标回退、后续仍能续上；
 *   4. 重建：卷整个清空后，按分段能拼出字节完全一致的文件；
 *   5. 坏数据必须报错：分段被改/被删时不能「静悄悄给出一个坏文件」。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dsh-sessions-'))
process.env.CONSOLE_OBJECTS_DIR = join(root, 'objects')
process.env.DSH_DB = join(root, 'dsh.db')

const { openDb, closeDb } = await import('./db.mjs')
const { objectPath, keyFromDiskPath } = await import('./objects.mjs')
const { createLocalIo, listSegments, parseListOutput, restoreTeam, syncTeam, listTeamSessions } = await import('./sessions.mjs')

let failed = 0
const check = (label, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected)
	console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`}`)
	if (!ok) failed += 1
}
const ok = (label, condition, detail = '') => {
	console.log(`${condition ? '✓' : '✗'} ${label}${condition ? '' : `  ${detail}`}`)
	if (!condition) failed += 1
}
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex')

const TEAM = 'team-x'
const MIN = 64 * 1024
const payload = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 256))
const volDir = join(root, 'vol')
const logPath = (id, gen = 3, project = '--workspace--') => `${project}/${id}/session.v${gen}.jsonl.zstd`
const writeSession = (id, buffer, { gen = 3, project = '--workspace--', ageMs = 0 } = {}) => {
	const file = join(volDir, logPath(id, gen, project))
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, buffer)
	if (ageMs) {
		const when = new Date(Date.now() - ageMs)
		utimesSync(file, when, when)
	}
	return file
}

const db = openDb()

/* ---------- 1. 清单解析：只认规范代里数字最大的那一份 ---------- */
const bigBuffer = payload(MIN * 3, 7)
writeSession('sessA', bigBuffer.subarray(0, 1024), { gen: 2 })
writeSession('sessA', bigBuffer)
const smallBuffer = payload(1024, 3)
// 一小时没动过 → 走「闲置强制上传」分支，尾巴不足阈值也要落
writeSession('sessB', smallBuffer, { project: '_no-cwd_', ageMs: 3600_000 })

const io = createLocalIo(volDir)
const entries = parseListOutput(await io.list(), volDir)
check('清单里两个会话各一条（同目录多代只留一份）', entries.length, 2)
const entryA = entries.find((e) => e.id === 'sessA')
const entryB = entries.find((e) => e.id === 'sessB')
check('选中 v3 而不是 v2', entryA.generation, 3)
check('v3 的字节数正确', entryA.bytes, bigBuffer.length)
check('项目名与 cwd 解析', [entryA.project, entryA.cwd], ['--workspace--', 'workspace'])
check('_no-cwd_ 不瞎猜 cwd', entryB.cwd, null)

/* ---------- 2. 第一次同步 ---------- */
const first = await syncTeam({ team: TEAM, db, io, minSegmentBytes: MIN })
check('第一次同步两个会话都成功', first.failed, 0)
check('A 推了整段（增量 ≥ 阈值）', first.results.find((r) => r.id === 'sessA').added, bigBuffer.length)
check('B 靠闲置兜底也推上去了（增量 < 阈值）', first.results.find((r) => r.id === 'sessB').added, smallBuffer.length)
check('A 只有 1 个分段', listSegments(TEAM, 'sessA').length, 1)
check('分段偏移从 0 开始', listSegments(TEAM, 'sessA')[0].offset, 0)

/* ---------- 3. 增量：第二次只推新增的 10 KB，且不足阈值时先攒着 ---------- */
const grown = Buffer.concat([bigBuffer, payload(10 * 1024, 11)])
writeFileSync(join(volDir, logPath('sessA')), grown)
const second = await syncTeam({ team: TEAM, db, io, minSegmentBytes: MIN })
const secondA = second.results.find((r) => r.id === 'sessA')
check('小尾巴没立刻上传', secondA.added, 0)
check('待传字节数记在结果里', secondA.pending, 10 * 1024)
check('分段数没变', listSegments(TEAM, 'sessA').length, 1)

/* ---------- 4. 强制同步（休眠/归档前必须做）：把尾巴补上 ---------- */
const forced = await syncTeam({ team: TEAM, db, io, force: true, minSegmentBytes: MIN })
const forcedA = forced.results.find((r) => r.id === 'sessA')
check('强制同步只推了增量部分', forcedA.added, 10 * 1024)
const segsA = listSegments(TEAM, 'sessA')
check('现在两个分段', segsA.length, 2)
check('第二段接着第一段末尾', segsA[1].offset, bigBuffer.length)
const total = segsA.reduce((sum, s) => sum + s.bytes, 0)
check('分段字节数之和 = 文件大小', total, grown.length)

/* ---------- 5. 收缩自愈：dsh 截掉撕裂尾部 ---------- */
const shrunk = grown.subarray(0, bigBuffer.length + 5 * 1024)
writeFileSync(join(volDir, logPath('sessA')), shrunk)
const third = await syncTeam({ team: TEAM, db, io, minSegmentBytes: MIN })
const thirdA = third.results.find((r) => r.id === 'sessA')
check('越界分段被删掉 1 个', thirdA.dropped, 1)
check('剩 1 个分段', listSegments(TEAM, 'sessA').length, 1)
await syncTeam({ team: TEAM, db, io, force: true, minSegmentBytes: MIN })
check('续上后仍是 2 个分段', listSegments(TEAM, 'sessA').length, 2)
check('续上的分段从第一段末尾开始', listSegments(TEAM, 'sessA')[1].offset, bigBuffer.length)

/* ---------- 6. 重建：卷整个没了也能拼回来 ---------- */
rmSync(volDir, { recursive: true, force: true })
const emptyIo = createLocalIo(volDir)
const restored = await restoreTeam({ team: TEAM, db, io: emptyIo })
check('两个会话都重建了', restored.restored.filter((r) => r.bytes).length, 2)
const rebuilt = readFileSync(join(volDir, logPath('sessA')))
check('重建文件字节与收缩后完全一致', sha(rebuilt), sha(shrunk))
check('重建大小一致', rebuilt.length, shrunk.length)
check('B 的字节一致', sha(readFileSync(join(volDir, '_no-cwd_/sessB/session.v3.jsonl.zstd'))), sha(smallBuffer))

/* ---------- 7. 卷里已有文件时不覆盖（它可能比对象层更新） ---------- */
const newer = Buffer.concat([shrunk, Buffer.from('NEWER-LOCAL-BYTES')])
writeFileSync(join(volDir, logPath('sessA')), newer)
const again = await restoreTeam({ team: TEAM, db, io: emptyIo })
check('已有会话被跳过，不覆盖', again.restored.filter((r) => r.id === 'sessA').length, 0)
check('本地新内容原样保留', readFileSync(join(volDir, logPath('sessA'))).length, newer.length)

/* ---------- 8. 坏数据必须报错 ---------- */
const segOne = listSegments(TEAM, 'sessB')[0]
const objectFile = objectPath(segOne.key)
const original = readFileSync(objectFile)
const corrupted = Buffer.from(original)
corrupted[10] = corrupted[10] ^ 0xff
writeFileSync(objectFile, corrupted)
rmSync(join(volDir, '_no-cwd_'), { recursive: true, force: true })
const corruptRun = await restoreTeam({ team: TEAM, db, io: emptyIo, only: 'sessB' })
const corruptError = corruptRun.restored.find((r) => r.id === 'sessB')?.error || ''
ok('分段被改 → 恢复必须失败', /校验失败/.test(corruptError), `实际：${corruptError || '没报错'}`)
ok('失败时不落半成品文件', !existsSync(join(volDir, '_no-cwd_/sessB/session.v3.jsonl.zstd')), '文件被写出来了')
writeFileSync(objectFile, original)

const segsA2 = listSegments(TEAM, 'sessA')
rmSync(objectPath(segsA2[0].key), { force: true })
rmSync(join(volDir, '--workspace--'), { recursive: true, force: true })
const gapRun = await restoreTeam({ team: TEAM, db, io: emptyIo, only: 'sessA' })
const gapError = gapRun.restored.find((r) => r.id === 'sessA')?.error || ''
ok('缺一段 → 恢复必须失败（不能拼出错位文件）', /分段不连续/.test(gapError), `实际：${gapError || '没报错'}`)
check('失败计数传回调用方', gapRun.failed, 1)

/* ---------- 9. 索引与「消失」标记 ---------- */
rmSync(join(volDir, '--workspace--'), { recursive: true, force: true })
await syncTeam({ team: TEAM, db, io: emptyIo })
const rows = listTeamSessions(db, TEAM)
const rowA = rows.find((r) => r.id === 'sessA')
ok('卷里没了 → missing_at 被标记', Boolean(rowA?.missing_at), `missing_at=${rowA?.missing_at}`)
check('索引里仍有两条（记录不删）', rows.length, 2)
check('侧栏能直接读到同步进度', typeof rows[0].uploaded_bytes, 'number')

/* ---------- 10. 对象键可逆：列出来的键能用来删 ---------- */
// 落盘路径是「倒数第二级插了两位分片」的形式，反推必须还原成同一个键，
// 否则「按列出来的结果去删」永远删不到东西，而且看起来一切正常
const keyParts = segOne.key.split('/')
const withShard = [...keyParts.slice(0, -1), 'ab', keyParts.at(-1)].join('/')
check('分片目录不参与对象键', keyFromDiskPath(withShard), segOne.key)
check('反推出的键真的能删到对象', existsSync(objectPath(keyFromDiskPath(withShard))), true)

closeDb()
rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
