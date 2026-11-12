/**
 * 校验「名称唯一 + id 关联」这套规则，跑在临时库上，不碰生产数据。
 *
 * 用法：`node deploy/orchestrator/verify-ownership.mjs`
 * 退出码非 0 表示有断言失败。
 */
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
process.env.DSH_DB = join(dir, 'test.db')

const { openDb, upsertItem, setCurrent, currentItem, itemByVersion, mountSkill, skillBodyForTeam, insertShare, teamSkillRows } =
	await import('./db.mjs')

const db = openDb()
let failed = 0
const check = (label, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected)
	console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`}`)
	if (!ok) failed += 1
}
const throws = (label, fn, matcher) => {
	try {
		fn()
		console.log(`✗ ${label}  期望抛错，实际通过了`)
		failed += 1
	} catch (error) {
		const ok = matcher ? matcher(error) : true
		console.log(`${ok ? '✓' : '✗'} ${label}  → ${error.status || ''} ${error.message}`)
		if (!ok) failed += 1
	}
}

const pkg = (name, version, visibility = 'public', ownerTeam = 'team-a') => ({
	kind: 'skill',
	name,
	version,
	title: name,
	description: `${name} 的摘要`,
	// 正文不再存在 market_items 里，而是 market_item_files 的一行——所以造数据要连文件一起给
	files: [{ path: 'SKILL.md', data: `# ${name}@${version}` }],
	visibility,
	ownerTeam,
	createdBy: ownerTeam,
	status: 'published',
})

/* ---------- 1. 名称先到先得 ---------- */
upsertItem(db, pkg('alpha', '1.0.0'))
setCurrent(db, 'skill', 'alpha', '1.0.0')
check('team-a 占住 alpha', currentItem(db, 'skill', 'alpha').owner_team, 'team-a')

throws(
	'team-b 发同名包（应 409）',
	() => upsertItem(db, pkg('alpha', '1.0.0', 'public', 'team-b')),
	(e) => e.status === 409,
)
throws(
	'team-b 发同名新版本（应 409）',
	() => upsertItem(db, pkg('alpha', '2.0.0', 'public', 'team-b')),
	(e) => e.status === 409,
)

const up = upsertItem(db, pkg('alpha', '1.1.0'))
setCurrent(db, 'skill', 'alpha', '1.1.0')
check('team-a 自己发新版本', currentItem(db, 'skill', 'alpha').version, '1.1.0')
check('新版本仍是 team-a 的', currentItem(db, 'skill', 'alpha').owner_team, 'team-a')
check('旧版本正文仍在（历史版本不丢）', itemByVersion(db, 'skill', 'alpha', '1.0.0').version, '1.0.0')
check('返回的 id 是版本定锚', up, 'skill:alpha@1.1.0')

/* ---------- 2. current 指针不能指向不存在的版本 ---------- */
throws(
	'setCurrent 指向未发布的版本（应 409）',
	() => setCurrent(db, 'skill', 'alpha', '9.9.9'),
	(e) => e.status === 409,
)
check('指针未被改坏', currentItem(db, 'skill', 'alpha').version, '1.1.0')

/* ---------- 3. 授权按 item_id，不按名字 ---------- */
upsertItem(db, pkg('secret', '1.0.0', 'private', 'team-a'))
check('team-b 装私有包（应 403）', (() => {
	try {
		mountSkill(db, { team: 'team-b', name: 'secret', version: '1.0.0', enabled: true, by: 'test' })
		return 'allowed'
	} catch (e) {
		return e.status
	}
})(), 403)

const share = insertShare(db, {
	id: 's1',
	from: 'team-a',
	to: 'team-b',
	kind: 'skill',
	itemId: 'skill:secret@1.0.0',
	name: 'secret',
	version: '1.0.0',
	by: 'test',
})
check('分享记下了 item_id', share.itemId, 'skill:secret@1.0.0')

mountSkill(db, { team: 'team-b', name: 'secret', version: '1.0.0', enabled: true, shareId: 's1', source: 'share', sourceTeam: 'team-a', by: 'test' })
check('凭分享挂载成功', teamSkillRows(db, 'team-b').find((r) => r.name === 'secret')?.version, '1.0.0')
check('正文可读', skillBodyForTeam(db, 'team-b', 'secret', '1.0.0').content, '# secret@1.0.0')

// 分享指向别的包时，同一 shareId 不能复用——这是把三元组换成 item_id 的全部意义
insertShare(db, { id: 's2', from: 'team-a', to: 'team-b', kind: 'skill', itemId: 'skill:alpha@1.1.0', name: 'secret', version: '1.0.0', by: 'test' })
check('shareId 与包不匹配时的授权（应 403）', (() => {
	try {
		mountSkill(db, { team: 'team-c', name: 'secret', version: '1.0.0', enabled: true, shareId: 's2', by: 'test' })
		return 'allowed'
	} catch (e) {
		return e.status
	}
})(), 403)

/* ---------- 4. 名字唯一但不影响「不同 kind 同名」 ---------- */
upsertItem(db, { ...pkg('alpha', '1.0.0'), kind: 'mcp', config: JSON.stringify({ spec: { command: 'x' }, env: [] }) })
setCurrent(db, 'mcp', 'alpha', '1.0.0')
check('mcp:alpha 与 skill:alpha 互不干扰', Boolean(currentItem(db, 'mcp', 'alpha')), true)

console.log(`\n${failed ? `✗ ${failed} 条断言失败` : '✓ 全部通过'}`)
rmSync(dir, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
