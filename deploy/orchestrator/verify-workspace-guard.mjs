#!/usr/bin/env node
/**
 * `plugins/workspace-guard` 的本地验证：路径归一化、目录预建、卸载还原。
 *
 * 这个插件决定「用户的产物落在持久挂载里还是一层用完就丢的可写层」，判断错一次就是
 * 一次静默的数据丢失，所以不靠肉眼看、也不靠上容器试，直接在宿主上用一个假注册表跑断言。
 *
 * 用法：node deploy/orchestrator/verify-workspace-guard.mjs
 */
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGIN = resolve(import.meta.dirname, '../../plugins/workspace-guard/index.js')
const { apply } = await import(pathToFileURL(PLUGIN).href)

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

/**
 * 假的工作区实体：`setTitle` 是 dsh 的 WorkspaceEntity 上真实存在的方法。
 */
function makeRow(path, title) {
	const row = {
		path,
		title,
		async setTitle(next) {
			row.title = next
		},
	}
	return row
}

/**
 * 假的 `ctx.workspaceRegistry`：方法放在原型上，才能验证「卸载后回到原型实现」。
 */
class FakeRegistry {
	rows = []

	async create(path, title) {
		// 真实现的语义：同一 path 直接返回已有实体，且**不改 title**
		const existing = this.rows.find((row) => row.path === path)
		if (existing !== undefined) return existing
		const row = makeRow(path, title ?? basename(path))
		this.rows.push(row)
		return row
	}

	async resolveByPath(path) {
		return this.rows.find((row) => row.path === path)
	}

	async initializeDefault(resolveDirectory) {
		this.rows.push({ path: await resolveDirectory(), title: 'default' })
		return this.rows.at(-1)
	}

	list() {
		return this.rows
	}
}

const root = mkdtempSync(join(tmpdir(), 'wsguard-'))
const registry = new FakeRegistry()
// 模拟 dsh 的 bootstrap 已经按目录末段建过一个根工作区：ensureRoot 应当复用它并改名
registry.rows.push(makeRow(root, basename(root)))
// ctx.effect 的返回值由 apply 丢掉，所以要在这里把卸载函数接住。
// 插件可能注册多个 effect（接管注册表 + 补登记轮询），必须全部收起来——
// 只留最后一个会让「卸载后还原」的断言假失败。
const disposers = []
const ctx = {
	workspaceRegistry: registry,
	effect: (fn) => {
		const off = fn()
		disposers.push(off)
		return off
	},
}
apply(ctx, { root })

console.log(`root = ${root}`)

// ---- 0. 启动时把根目录登记成工作区（ensureRoot 是异步的，给一个 tick）----
await new Promise((done) => setTimeout(done, 20))
const rootRow = registry.rows.find((row) => row.path === root)
check('启动时复用/建立根工作区', rootRow !== undefined, JSON.stringify(rootRow))
check('自动生成的英文名被改成中文', rootRow?.title === '工作区', String(rootRow?.title))
check('根工作区只登记一次', registry.rows.filter((row) => row.path === root).length === 1)

// ---- 1. 路径归一化 ----
const created = await registry.create('/home/dsh/测试1')
check('建在 /home/dsh 的工作区被搬到 <root>/<name>', created.path === join(root, '测试1'), created.path)
check('目录被真的建出来了', existsSync(join(root, '测试1')) && statSync(join(root, '测试1')).isDirectory())
check('标题仍然是用户给的名字', created.title === '测试1', created.title)

const already = await registry.create(join(root, 'ok'), 'ok')
check('已经在 root 里的路径原样放行（幂等，不套两层）', already.path === join(root, 'ok'), already.path)

const relative = await registry.create('some/rel/project')
check('相对路径解析后也只取最后一段', relative.path === join(root, 'project'), relative.path)

const slash = await registry.create('/')
check('根路径不会拼成 <root>/workspace', slash.path === root, slash.path)

const empty = await registry.create('')
check('空路径退回 root 本身', empty.path === root, empty.path)

const traversal = await registry.create('/etc/../../../tmp/x')
check('.. 穿越被解析掉，不留残余', traversal.path === join(root, 'x'), traversal.path)

// ---- 2. 反查 ----
const found = await registry.resolveByPath('/home/dsh/测试1')
check('按原路径反查能找到被搬走的工作区', found?.path === join(root, '测试1'), JSON.stringify(found))
const missing = await registry.resolveByPath('/nope/whatever')
check('反查未登记路径时返回 undefined 而不是抛错', missing === undefined, String(missing))

// ---- 3. 首次使用 ----
const firstUse = await registry.initializeDefault(async () => '/home/dsh/Documents/deepseek-harness/default-workspace')
check('首次使用的工作区也落在 root 下', firstUse.path === join(root, 'default-workspace'), firstUse.path)

registry.rows = []
const fallback = await registry.initializeDefault(async () => {
	throw new Error('system Documents directory is unavailable')
})
check('系统目录查不到时退回 <root>/default-workspace', fallback.path === join(root, 'default-workspace'), fallback.path)

// ---- 4. 卸载 ----
for (const off of disposers) off?.()
check('卸载后 create 回到原型实现', registry.create === FakeRegistry.prototype.create)
check('卸载后 resolveByPath 回到原型实现', registry.resolveByPath === FakeRegistry.prototype.resolveByPath)
check('卸载后没有残留的自有属性', !Object.hasOwn(registry, 'create') && !Object.hasOwn(registry, 'resolveByPath'))

// ---- 5. 降级 ----
// 故意给一个残缺的注册表（dsh 升级换了 API 就是这种情形）
const degraded = { list: () => [] }
let threw = false
try {
	apply({ workspaceRegistry: degraded, effect: (fn) => fn() }, { root })
} catch {
	threw = true
}
check('注册表缺方法时只降级，不抛错', !threw)
check('降级时没有改动注册表', !Object.hasOwn(degraded, 'create') && !Object.hasOwn(degraded, 'resolveByPath'))

rmSync(root, { recursive: true, force: true })

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
