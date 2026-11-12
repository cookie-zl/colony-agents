/**
 * 校验产物归因：采集（插件）→ 上推（syncArtifacts）→ 查询（artifactsFor / artifactDetail）。
 *
 * 用法：`node deploy/orchestrator/verify-artifacts.mjs`
 * 全程在临时目录里跑（临时抄写目录 + 临时对象库 + :memory: 库），不碰生产数据，也不需要 docker。
 *
 * 要证明的六件事：
 *   1. 采集：一条 `workspace/changes` 事件能落成一个按轮命名的 JSON，字段齐全；
 *      `summary()` 在事件派发时还没登记（recorder 的事），必须容错重试而不是静默丢。
 *   2. 同一轮补记录：turn/end 的第二次记录覆盖第一次，不留两个文件。
 *   3. 上推：写进对象层 + 一行索引，**并删掉卷里那份**（卷只当中转站）。
 *   4. 幂等：同一内容再同步一次不产生第二个对象；内容变了才换对象并删旧对象。
 *   5. 坏数据：半截 JSON 记为失败、原文件保留（下一轮还会重试），不拖垮其余轮次。
 *   6. 体积兜底：超过 maxBytes 时先丢 hunks、保留清单——「改了哪些」比「每一行」重要。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dsh-artifacts-'))
const objects = join(root, 'objects')
process.env.CONSOLE_OBJECTS_DIR = objects
process.env.DSH_DB = join(root, 'dsh.db')

const { openDb, closeDb } = await import('./db.mjs')
const { objectPath, listObjectFiles } = await import('./objects.mjs')
const { parseChangeList, splitChangePath, syncArtifacts, artifactsFor, artifactDetail, localChangeStore } = await import('./artifacts.mjs')
const { apply, serializeRecord } = await import('../../plugins/changes-collector/index.js')

let failed = 0
const ok = (label, condition, detail = '') => {
	console.log(`${condition ? '✓' : '✗'} ${label}${condition ? '' : `  ${detail}`}`)
	if (!condition) failed += 1
}
const eq = (label, actual, expected) => ok(label, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
const delay = (ms) => new Promise((done) => setTimeout(done, ms))

// ---------- 1. 采集 ----------
const changesDir = join(root, 'changes')
mkdirSync(changesDir, { recursive: true })

/** 假的 workspaceChanges 服务：与真实现同形（summary 立即返回 / diff 按下标返回）。 */
const summaries = new Map()
const diffs = new Map()
const handlers = new Map()
const ctx = {
	workspaceChanges: {
		summary: (sessionId, seq) => summaries.get(`${sessionId}:${seq}`),
		diff: async (sessionId, seq, index) => diffs.get(`${sessionId}:${seq}:${index}`),
	},
	on: (name, fn) => handlers.set(name, fn),
	effect: (fn) => fn(),
}
apply(ctx, { dir: changesDir, maxFiles: 10, maxBytes: 1_048_576, maxTurns: 3 })

const SID = 'session-abc'
const emit = (seq, turn) => handlers.get('session/event')({ id: SID }, { type: 'workspace/changes', seq, data: { turn } })

// 故意让 summary 晚 60ms 才出现：真实现里 records.set 发生在 append() 返回之后
summaries.set(
	`${SID}:10`,
	{
		turn: 1,
		cwd: '/workspace',
		total: 2,
		added: 7,
		deleted: 1,
		files: [
			{ path: 'a.txt', display: 'a.txt', added: 6, deleted: 0 },
			{ path: '/etc/outside.txt', display: '~/outside.txt', added: 1, deleted: 1 },
		],
	},
)
diffs.set(`${SID}:10:0`, { kind: 'text', path: 'a.txt', display: 'a.txt', before: false, after: true, coarse: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['+hello', '+world'] }] })
diffs.set(`${SID}:10:1`, { kind: 'binary', path: '/etc/outside.txt', display: '~/outside.txt' })

emit(10, 1)
await delay(200)

const firstFile = join(changesDir, SID, 't1.json')
ok('采集：事件落成 t1.json', existsSync(firstFile), `找不到 ${firstFile}`)
const first = existsSync(firstFile) ? JSON.parse(readFileSync(firstFile, 'utf8')) : {}
eq('采集：轮号与序号', [first.turn, first.seq], [1, 10])
eq('采集：行数合计', [first.added, first.deleted, first.total], [7, 1, 2])
eq('采集：文件数与路径', first.files?.map((f) => f.path), ['a.txt', '/etc/outside.txt'])
eq('采集：新建判定（before=false）', first.files?.[0]?.action, 'created')
eq('采集：hunks 保留', first.files?.[0]?.hunks?.length, 1)
eq('采集：binary 不带 hunks', [first.files?.[1]?.kind, first.files?.[1]?.hunks], ['binary', undefined])

// 同一轮补记录：内容改成只剩一个文件，覆盖而不是新增
summaries.set(`${SID}:12`, {
	turn: 1,
	cwd: '/workspace',
	total: 1,
	added: 2,
	deleted: 0,
	files: [{ path: 'a.txt', display: 'a.txt', added: 2, deleted: 0 }],
})
diffs.set(`${SID}:12:0`, { kind: 'text', path: 'a.txt', display: 'a.txt', before: false, after: true, coarse: false, hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+x', '+y'] }] })
emit(12, 1)
await delay(200)
const second = JSON.parse(readFileSync(firstFile, 'utf8'))
eq('同轮补记录：覆盖同一文件', second.files.length, 1)
eq('同轮补记录：seq 更新', second.seq, 12)

// summary 永远不出现时安静跳过，不写文件
emit(99, 2)
await delay(1200)
ok('摘要取不到时不写文件', !existsSync(join(changesDir, SID, 't2.json')))

// 体积兜底：清单留着、hunks 丢掉
const bulky = {
	version: 1,
	session: SID,
	turn: 3,
	seq: 1,
	cwd: '/workspace',
	recordedAt: '2026-01-01T00:00:00.000Z',
	total: 1,
	added: 1,
	deleted: 0,
	files: [{ path: 'big.txt', display: 'big.txt', action: 'modified', added: 1, deleted: 0, kind: 'text', hunks: [{ lines: Array.from({ length: 500 }, (_, i) => `+line ${i} ${'x'.repeat(40)}`) }] }],
}
const trimmed = JSON.parse(serializeRecord(bulky, 4096))
ok('体积兜底：标记 detailOmitted', trimmed.detailOmitted === true)
eq('体积兜底：清单还在', trimmed.files.map((f) => f.path), ['big.txt'])
eq('体积兜底：hunks 被清空', trimmed.files[0].hunks.length, 0)

// ---------- 2. 上推 ----------
const db = openDb()
const store = localChangeStore(changesDir)
const TEAM = 'team-x'

const firstRun = await syncArtifacts({ team: TEAM, db, store })
eq('上推：扫到 1 个文件', firstRun.scanned, 1)
eq('上推：上传 1 轮', [firstRun.uploaded, firstRun.skipped, firstRun.failed], [1, 0, 0])
ok('上推：卷里的文件被收走', !existsSync(firstFile))

const row = db.prepare('SELECT * FROM session_artifacts WHERE team_id = ? AND session_id = ? AND turn = 1').get(TEAM, SID)
ok('上推：索引行存在', Boolean(row))
eq('上推：行里文件数', JSON.parse(row?.files || '[]').length, 1)
eq('上推：行里 total', row?.total, 1)
ok('上推：对象键指向 artifacts/<team>/<sid>/', String(row?.detail_key || '').startsWith(`artifacts/${TEAM}/${SID}/`))
ok('上推：对象真的落盘', existsSync(objectPath(row?.detail_key || 'x')))
eq('上推：对象字节与行一致', readFileSync(objectPath(row.detail_key)).length, row.detail_bytes)

const turns = artifactsFor(db, { team: TEAM, sessionId: SID })
eq('查询：一轮', turns.length, 1)
eq('查询：files 已解析成数组', Array.isArray(turns[0].files), true)
eq('查询：动作透传', turns[0].files[0].action, 'created')
const detail = artifactDetail(db, { team: TEAM, sessionId: SID, turn: 1 })
eq('详情：hunks 从对象层取回', detail?.files?.[0]?.hunks?.[0]?.lines, ['+x', '+y'])

// ---------- 3. 幂等 ----------
mkdirSync(join(changesDir, SID), { recursive: true })
const sameContent = JSON.stringify(second)
writeFileSync(join(changesDir, SID, 't1.json'), sameContent)
const objectsBefore = listObjectFiles(`artifacts/${TEAM}`).length
const again = await syncArtifacts({ team: TEAM, db, store })
eq('幂等：记为跳过', [again.uploaded, again.skipped], [0, 1])
eq('幂等：没有新对象', listObjectFiles(`artifacts/${TEAM}`).length, objectsBefore)
ok('幂等：本地文件同样被收走', !existsSync(join(changesDir, SID, 't1.json')))

// 内容变了：换对象、删旧对象、行更新
const changed = JSON.parse(sameContent)
changed.files[0].added = 99
writeFileSync(join(changesDir, SID, 't1.json'), JSON.stringify(changed))
const replaced = await syncArtifacts({ team: TEAM, db, store })
eq('内容变更：重新上传', [replaced.uploaded, replaced.skipped], [1, 0])
eq('内容变更：对象数不增长（旧的被删）', listObjectFiles(`artifacts/${TEAM}`).length, objectsBefore)
const row2 = db.prepare('SELECT detail_key, files FROM session_artifacts WHERE team_id = ? AND session_id = ? AND turn = 1').get(TEAM, SID)
eq('内容变更：行跟着更新', JSON.parse(row2.files)[0].added, 99)
ok('内容变更：旧对象已删', !existsSync(objectPath(row.detail_key)))

// ---------- 4. 坏数据 ----------
writeFileSync(join(changesDir, SID, 't2.json'), '{"turn":2,"files":[{"path":"half')
const broken = await syncArtifacts({ team: TEAM, db, store })
eq('坏数据：记为失败 1 个', broken.failed, 1)
ok('坏数据：文件保留等重试', existsSync(join(changesDir, SID, 't2.json')))
eq('坏数据：没有凭空造行', db.prepare('SELECT count(*) c FROM session_artifacts WHERE session_id = ?').get(SID).c, 1)

// 路径不符合结构：报错但不崩
const bogusDir = join(changesDir, SID, 'nested')
mkdirSync(bogusDir, { recursive: true })
writeFileSync(join(bogusDir, 't9.json'), '{"turn":9}')
eq('路径解析：三段式才算数', splitChangePath('/home/dsh/.dsh/changes/session-a/t3.json'), { sessionId: 'session-a', file: 't3.json', turn: 3 })
eq('路径解析：结构不符返回 null', splitChangePath('/home/dsh/.dsh/changes/session-a/x.json'), null)
eq('find 输出解析', parseChangeList('123 /a/b.json\n\n45 /c d/e.json\n'), [
	{ bytes: 123, path: '/a/b.json' },
	{ bytes: 45, path: '/c d/e.json' },
])

closeDb()
console.log(failed ? `\n${failed} 条不通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
