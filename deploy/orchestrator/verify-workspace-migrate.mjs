#!/usr/bin/env node
/**
 * `deploy/image/migrate-workspaces.mjs` 的本地验证：工作区登记收敛。
 *
 * 这段逻辑在容器**启动前**改 `storages/workspace.json`——写错一次就是「所有会话从侧栏消失」。
 * 所以计划器拆成纯函数，在宿主上用真 JSON 结构跑断言；`forgetDir` 用临时目录验
 * 「只删空目录」。
 *
 * 用法：node deploy/orchestrator/verify-workspace-migrate.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const MODULE = resolve(import.meta.dirname, '../image/migrate-workspaces.mjs')
const { planMigration, forgetDir } = await import(pathToFileURL(MODULE).href)

let passed = 0
let failed = 0
const check = (name, condition, detail) => {
	if (condition) {
		passed += 1
		console.log(`  ✓ ${name}`)
	} else {
		failed += 1
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
	}
}

/** 造一份和真库同构的 `workspace.json`。 */
const registryOf = (workspaces, extra = {}) => ({
	unit: { name: 'workspace', version: 2 },
	global: {
		initialized: true,
		workspaceIds: Object.keys(workspaces),
		archivedSessionIds: [],
		pinnedSessionIds: [],
		...extra,
	},
	tables: { workspaces },
})

const row = (path, title, sessionIds = []) => ({
	path,
	title,
	sessionIds,
	createdAt: '2026-11-04T14:12:20.252Z',
	updatedAt: '2026-11-08T12:57:16.949Z',
})

const ROOT = '/workspace'

// ---- 1. 根外面的旧工作区被摘掉 ----
{
	const old = registryOf({
		w1: row('/home/dsh/测试1', '测试1', ['s1', 's2']),
	})
	const plan = planMigration(old, { root: ROOT })
	check('旧工作区被移除', plan.removed.length === 1 && plan.removed[0].id === 'w1', JSON.stringify(plan.removed))
	check('它的会话进了归档名单', plan.archived.join(',') === 's1,s2', plan.archived.join(','))
	check('workspaceIds 同步去掉', plan.registry.global.workspaceIds.length === 0, JSON.stringify(plan.registry.global.workspaceIds))
	check('登记表里也没了', Object.keys(plan.registry.tables.workspaces).length === 0)
	check('initialized 置 false，交给 bootstrap 重建', plan.registry.global.initialized === false)
	check('needsBootstrap 为真', plan.needsBootstrap === true)
	check('确实算作有改动', plan.changed === true)
}

// ---- 2. 根工作区已存在时保留、不重跑 bootstrap ----
{
	const mixed = registryOf({
		w0: row(ROOT, '工作区', ['a']),
		w1: row('/home/dsh/测试1', '测试1', ['b']),
	})
	const plan = planMigration(mixed, { root: ROOT })
	check('根工作区被保留', Object.hasOwn(plan.registry.tables.workspaces, 'w0'))
	check('根工作区的会话没被归档', !plan.archived.includes('a'), plan.archived.join(','))
	check('根工作区在时 initialized 保持 true', plan.registry.global.initialized === true)
	check('根工作区在时不要求 bootstrap', plan.needsBootstrap === false)
}

// ---- 3. 幂等：第二次跑没有改动 ----
{
	const once = planMigration(registryOf({ w1: row('/home/dsh/测试1', '测试1', ['s1']) }), { root: ROOT })
	const twice = planMigration(once.registry, { root: ROOT })
	check('第二遍不再改动', twice.changed === false)
	check('第二遍不改 registry', twice.registry === once.registry)
}

// ---- 4. 前缀陷阱：/workspace-evil 不算在根内 ----
{
	const tricky = registryOf({
		bad: row('/workspace-evil/x', 'evil'),
		good: row(join(ROOT, 'proj'), 'proj', ['p']),
		nested: row(join(ROOT, 'a/b'), 'ab'),
	})
	const plan = planMigration(tricky, { root: ROOT })
	const left = Object.keys(plan.registry.tables.workspaces)
	check('/workspace-evil 被摘掉（不能靠 startsWith 裸判）', !left.includes('bad'), left.join(','))
	check('根下的子工作区保留', left.includes('good') && left.includes('nested'), left.join(','))
	check('保留的行字段原样不动', plan.registry.tables.workspaces.good?.createdAt === '2026-11-04T14:12:20.252Z')
}

// ---- 5. 归档名单去重、其他字段不动 ----
{
	const withArchive = registryOf({ w1: row('/home/dsh/x', 'x', ['s1', 's2']) }, { archivedSessionIds: ['s1', 'z'] })
	const plan = planMigration(withArchive, { root: ROOT })
	const archived = plan.registry.global.archivedSessionIds
	check('已在归档名单里的不重复', archived.filter((id) => id === 's1').length === 1, archived.join(','))
	check('原有归档项保留', archived.includes('z'), archived.join(','))
	check('新会话也进来', archived.includes('s2'), archived.join(','))
	check('pinnedSessionIds 不动', Array.isArray(plan.registry.global.pinnedSessionIds))
	check('unit 段原样保留', plan.registry.unit?.version === 2)
}

// ---- 6. pendingMutation 会被清掉 ----
{
	const pending = registryOf({ w1: row('/home/dsh/x', 'x') }, { pendingMutation: { operation: 'delete', workspaceId: 'w9' } })
	const plan = planMigration(pending, { root: ROOT })
	check('pendingMutation 被清空', plan.registry.global.pendingMutation === undefined)
	check('序列化后不会留下 null 字段', !JSON.stringify(plan.registry).includes('pendingMutation'))
}

// ---- 7. 空登记表不用动 ----
{
	const empty = { unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: {} } }
	const plan = planMigration(empty, { root: ROOT })
	check('空表时视为无改动', plan.changed === false)
}

// ---- 8. 坏数据不炸 ----
{
	const broken = { global: { workspaceIds: null }, tables: { workspaces: { w1: { path: null } } } }
	const plan = planMigration(broken, { root: ROOT })
	check('path 为 null 的记录也被摘掉', plan.removed.length === 1)
	check('workspaceIds 非数组时退化成空', Array.isArray(plan.registry.global.workspaceIds) && plan.registry.global.workspaceIds.length === 0)
}

// ---- 9. forgetDir：只删空目录 ----
{
	const sandbox = mkdtempSync(join(tmpdir(), 'wsmigrate-'))
	const root = join(sandbox, 'workspace')
	const emptyOld = join(sandbox, 'empty-old')
	const fullOld = join(sandbox, 'full-old')
	const insideRoot = join(root, 'proj')
	for (const dir of [root, emptyOld, fullOld, insideRoot]) mkdirSync(dir, { recursive: true })
	writeFileSync(join(fullOld, 'keep.txt'), 'x')

	forgetDir(emptyOld, root)
	forgetDir(fullOld, root)
	forgetDir(root, root)
	forgetDir(insideRoot, root)

	check('空旧目录被删掉', !existsSync(emptyOld))
	check('非空旧目录保留', existsSync(join(fullOld, 'keep.txt')))
	check('根本身不动', existsSync(root))
	check('根内的目录不动', existsSync(insideRoot))
	forgetDir('/does/not/exist', root)
	check('不存在的路径不抛错', true)
	rmSync(sandbox, { recursive: true, force: true })
}

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
