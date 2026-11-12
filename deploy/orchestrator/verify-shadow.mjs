/**
 * 校验「同名本地技能遮蔽」这道关：跑在临时库 + 临时工作区上，不碰生产数据。
 *
 * 用法：`node deploy/orchestrator/verify-shadow.mjs`
 * 退出码非 0 表示有断言失败。
 *
 * 要证明的四件事：
 *   1. 工作区里有同名技能时，装市场包会被 409 挡住，并且报错里带得出具体路径；
 *   2. force 能强装，且返回值带回 shadow（门户据此提示「装了也不生效」）；
 *   3. `<name>/SKILL.md` 和 `<name>.md` 两种形态、以及一层子目录里的副本都能检出；
 *   4. 停用时不做检测（停用不需要知道有没有遮蔽）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dsh-shadow-'))
process.env.DSH_DB = join(root, 'test.db')
const workspace = join(root, 'workspace-team-a')

const { openDb, upsertItem, setCurrent, mountSkill, setSkillEnabled } = await import('./db.mjs')
const { findShadow } = await import('./workspace.mjs')

const db = openDb()
let failed = 0
const check = (label, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected)
	console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`}`)
	if (!ok) failed += 1
}
const throws = (label, fn, matcher) => {
	try {
		const value = fn()
		console.log(`✗ ${label}  期望抛错，实际通过了 ${JSON.stringify(value)}`)
		failed += 1
	} catch (error) {
		const ok = matcher ? matcher(error) : true
		console.log(`${ok ? '✓' : '✗'} ${label}  → ${error.status || ''} ${error.code || ''} ${error.message}`)
		if (!ok) failed += 1
	}
}

const pkg = (name, version = '1.0.0') => ({
	kind: 'skill',
	name,
	version,
	title: name,
	description: `${name} 的摘要`,
	content: `# ${name}`,
	visibility: 'public',
	ownerTeam: '_system',
	createdBy: '_system',
	status: 'published',
})

/** 在工作区里造一个目录包形态的技能。 */
const putDir = (rel, name) => {
	mkdirSync(join(workspace, rel, name), { recursive: true })
	writeFileSync(join(workspace, rel, name, 'SKILL.md'), `# ${name}\n`)
}
/** 单文件形态：`<root>/<name>.md`。 */
const putFile = (rel, name) => {
	mkdirSync(join(workspace, rel), { recursive: true })
	writeFileSync(join(workspace, rel, `${name}.md`), `# ${name}\n`)
}

for (const name of ['alpha', 'beta', 'gamma', 'delta']) {
	upsertItem(db, pkg(name))
	setCurrent(db, 'skill', name, '1.0.0')
}

/* ---------- 1. 干净的 workspace：装得进去 ---------- */
mkdirSync(workspace, { recursive: true })
check('无同名技能时 findShadow 为空', findShadow(workspace, 'alpha'), [])
check(
	'无同名技能时可以安装',
	mountSkill(db, { team: 'team-a', name: 'alpha', version: '1.0.0', enabled: true, workspaceDir: workspace, by: 'test' }).changed,
	true,
)

/* ---------- 2. 目录包形态：被挡住 ---------- */
putDir('.dsh/skills', 'beta')
const hits = findShadow(workspace, 'beta')
check('检出 .dsh/skills 目录包', hits.length, 1)
check('检出内容 rank=100', hits[0].rank, 100)
check('检出形态', hits[0].shape, 'directory')

throws(
	'目录包遮蔽时安装被 409 挡住',
	() => mountSkill(db, { team: 'team-b', name: 'beta', version: '1.0.0', enabled: true, workspaceDir: workspace, by: 'test' }),
	(error) => error.status === 409 && error.code === 'SHADOWED' && Array.isArray(error.detail?.shadow),
)

check(
	'被挡住时没有写进 team_skills',
	db.prepare('SELECT COUNT(*) AS n FROM team_skills WHERE name = ?').get('beta').n,
	0,
)

/* ---------- 3. force 强装：写进去，但如实回报 shadow ---------- */
const forced = mountSkill(db, {
	team: 'team-b',
	name: 'beta',
	version: '1.0.0',
	enabled: true,
	workspaceDir: workspace,
	force: true,
	by: 'test',
})
check('force 后写入成功', forced.changed, true)
check('force 后仍回报 shadow', forced.shadow.length, 1)
check(
	'force 在 ops 里留了遮蔽备注',
	db.prepare("SELECT note FROM ops WHERE name = 'beta' AND action = 'install' ORDER BY id DESC").get()?.note?.includes('遮蔽'),
	true,
)

/* ---------- 4. 单文件形态 + 一层子目录 ---------- */
putFile('.agents/skills', 'gamma')
check('检出 .agents/skills 单文件', findShadow(workspace, 'gamma')[0]?.shape, 'file')
check('单文件 rank=200', findShadow(workspace, 'gamma')[0]?.rank, 200)

putDir('proj/.dsh/skills', 'delta')
const nested = findShadow(workspace, 'delta')
check('检出子目录里的副本', nested.length, 1)
check('子目录副本路径正确', nested[0].path.endsWith('proj/.dsh/skills/delta'), true)

/* ---------- 5. 停用不检测，启用要检测 ---------- */
mountSkill(db, { team: 'team-c', name: 'gamma', version: '1.0.0', enabled: false, by: 'test' })
check(
	'停用时不做遮蔽检测',
	setSkillEnabled(db, { team: 'team-c', name: 'gamma', enabled: false, workspaceDir: workspace, by: 'test' }).enabled,
	false,
)
throws(
	'启用时被遮蔽则 409',
	() => setSkillEnabled(db, { team: 'team-c', name: 'gamma', enabled: true, workspaceDir: workspace, by: 'test' }),
	(error) => error.status === 409 && error.code === 'SHADOWED',
)
check(
	'被挡住的启用没有改标志位',
	db.prepare('SELECT enabled FROM team_skills WHERE team_id = ? AND name = ?').get('team-c', 'gamma').enabled,
	0,
)

/* ---------- 6. 不传 workspaceDir 的老调用保持不变 ---------- */
check(
	'不传 workspaceDir 时跳过检测（兼容旧调用）',
	mountSkill(db, { team: 'team-a', name: 'gamma', version: '1.0.0', enabled: true, by: 'test' }).changed,
	true,
)

rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
