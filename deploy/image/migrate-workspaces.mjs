#!/usr/bin/env node
/**
 * migrate-workspaces —— 把工作区登记收敛到 `${root}` 一个根上，不兼容旧登记。
 *
 * 为什么需要：dsh 的 `workspaceRegistry.bootstrap()` **只在 `initialized === false` 时跑一次**，
 * 它按会话 cwd 分组自动建工作区。团队第一次用（11-04）在 `/home/dsh/测试1` 建了工作区之后
 * `initialized` 就永久为 true，于是后来落在 `/workspace` 的会话再也没人给它们建归属，
 * 侧栏里只能堆在「未分组」——而那个桶不能新建会话、不能改名、不能拖。
 *
 * 这里做的事：把 `storages/workspace.json` 里 `path` 不在 `${root}` 下的工作区全部删掉，
 * 它们的会话 id 一并塞进 `archivedSessionIds`（侧栏默认不显示，但不删日志），
 * 然后把 `initialized` 置回 false —— 下一次 dsh 启动时 bootstrap 会按 cwd 重建一个
 * `${root}` 工作区，并把 cwd 正好是 `${root}` 的会话自动挂进去。
 *
 * 三条硬约束：
 *  1. **不搬文件**。旧目录里的东西按「以当前版本为准」的口径直接放弃；目录只在**确认为空**时
 *     `rmdir`，非空一律保留并只打日志——rmdir 删不掉有内容的目录，这是刻意选它的原因。
 *  2. **不删会话日志**。只加进 `archivedSessionIds`，`sessions/` 一个字节不动。
 *  3. **可关、可重复**。`DSH_MIGRATE_WORKSPACES=0` 整个跳过；跑过之后没有违规记录，第二次
 *     启动直接返回「无需迁移」。原文件只在首次改动时备份成 `workspace.json.bak`，不覆盖。
 *
 * @module deploy/image/migrate-workspaces
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = process.env.DSH_HOME || '/home/dsh/.dsh'
const REGISTRY = process.env.DSH_WORKSPACE_REGISTRY || join(HOME, 'storages/workspace.json')
const ROOT = resolve(process.env.DSH_WORKSPACE_ROOT || '/workspace')
const log = (message) => console.error(`migrate-workspaces: ${message}`)

/**
 * 判断一个路径是否落在根目录内（含根本身）。
 *
 * @param {string} root 已解析的根目录
 * @param {unknown} path 登记表里的 path
 * @returns {boolean} true 表示这个工作区可以留下
 */
function inside(root, path) {
	if (typeof path !== 'string' || path === '') return false
	const absolute = resolve(path)
	return absolute === root || absolute.startsWith(root + sep)
}

/**
 * 算出迁移计划，纯函数，不碰文件系统（校验脚本直接测它）。
 *
 * @param {object} registry 解析后的 `workspace.json`
 * @param {{root?: string}} [options] `root` 默认 `/workspace`
 * @returns {{registry: object, removed: Array<{id: string, path: unknown, title: unknown, sessionIds: string[]}>,
 *            archived: string[], needsBootstrap: boolean, changed: boolean}}
 */
export function planMigration(registry, options = {}) {
	const root = resolve(options.root ?? ROOT)
	const global = { ...(registry?.global ?? {}) }
	const tables = { ...(registry?.tables ?? {}) }
	const workspaces = { ...(tables?.workspaces ?? {}) }

	const removed = []
	const archived = new Set(Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : [])
	let hasRootWorkspace = false

	for (const [id, record] of Object.entries(workspaces)) {
		if (inside(root, record?.path)) {
			if (resolve(String(record.path)) === root) hasRootWorkspace = true
			continue
		}
		const sessionIds = Array.isArray(record?.sessionIds) ? record.sessionIds : []
		removed.push({ id, path: record?.path, title: record?.title, sessionIds: [...sessionIds] })
		for (const sessionId of sessionIds) archived.add(sessionId)
		delete workspaces[id]
	}

	const before = Array.isArray(global.workspaceIds) ? global.workspaceIds : []
	const dropped = new Set(removed.map((row) => row.id))
	const workspaceIds = before.filter((id) => !dropped.has(id))
	const changed = removed.length > 0 || workspaceIds.length !== before.length
	if (!changed) {
		return { registry, removed: [], archived: [], needsBootstrap: false, changed: false }
	}

	const next = {
		...registry,
		global: {
			...global,
			workspaceIds,
			archivedSessionIds: [...archived],
			// pendingMutation 留着会让 dsh 的 recoverPendingMutation 报「登记表不一致」
			pendingMutation: undefined,
			// 没有根工作区时交给 bootstrap 重建：它会按 cwd 把会话挂回去
			initialized: hasRootWorkspace ? global.initialized === true : false,
		},
		tables: { ...tables, workspaces },
	}
	return { registry: next, removed, archived: [...archived], needsBootstrap: !hasRootWorkspace, changed: true }
}

/**
 * 清掉一个已经作废的旧工作目录。
 *
 * 只删**空目录**：`rmdir` 对非空目录会抛 `ENOTEMPTY`，等于天然的保险。
 *
 * @param {string} path 旧工作区的登记路径
 * @param {string} root 当前根目录，用来兜住「别把根删了」
 */
export function forgetDir(path, root = ROOT) {
	if (typeof path !== 'string' || !path.startsWith('/')) return
	const absolute = resolve(path)
	if (absolute === '/' || absolute === root || absolute.startsWith(root + sep)) return
	if (!existsSync(absolute)) return
	try {
		if (!statSync(absolute).isDirectory()) return
		if (readdirSync(absolute).length > 0) {
			log(`${absolute} 里还有文件，保留不动（内容已不属于任何工作区）`)
			return
		}
		rmdirSync(absolute)
		log(`已删除空的旧工作目录 ${absolute}`)
	} catch (error) {
		log(`处理旧目录 ${absolute} 失败：${error.message}`)
	}
}

/**
 * 原子写：先写临时文件再 rename，避免 dsh 读到半截 JSON。
 *
 * @param {string} target 目标文件
 * @param {string} text 完整内容
 */
function writeAtomic(target, text) {
	const temp = `${target}.tmp`
	writeFileSync(temp, text)
	renameSync(temp, target)
}

function main() {
	if (process.env.DSH_MIGRATE_WORKSPACES === '0') {
		log('DSH_MIGRATE_WORKSPACES=0，跳过')
		return
	}
	if (!existsSync(REGISTRY)) {
		log(`没有 ${REGISTRY}，跳过`)
		return
	}

	let parsed
	try {
		parsed = JSON.parse(readFileSync(REGISTRY, 'utf8'))
	} catch (error) {
		log(`解析失败，保持原样不动：${error.message}`)
		return
	}

	const plan = planMigration(parsed, { root: ROOT })
	if (!plan.changed) {
		log(`工作区登记已全部在 ${ROOT} 下，无需迁移`)
		return
	}

	const backup = `${REGISTRY}.bak`
	if (!existsSync(backup)) {
		copyFileSync(REGISTRY, backup)
		log(`原登记已备份到 ${backup}`)
	}

	for (const row of plan.removed) forgetDir(row.path, ROOT)

	writeAtomic(REGISTRY, `${JSON.stringify(plan.registry, null, 2)}\n`)
	const names = plan.removed.map((row) => `${row.title ?? '?'}(${row.path})`).join(', ')
	log(`移除 ${plan.removed.length} 个旧工作区：${names}`)
	log(`归档 ${plan.archived.length} 个会话（日志保留，侧栏默认隐藏）`)
	if (plan.needsBootstrap) log(`会把 initialized 置 false，下次启动由 dsh 重建 ${ROOT} 工作区`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
