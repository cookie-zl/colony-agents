#!/usr/bin/env node
/**
 * 启动前补建历史会话的工作目录。
 *
 * 为什么需要：会话日志存在卷里（`$DSH_HOME/sessions/`），但会话的 cwd 是容器里的
 * 绝对路径，落在**可写层**。容器一重建（发版、删容器唤起），`/home/dsh/xxx` 这类目录
 * 就没了；dsh 的 workspace 索引发现 `cwd does not resolve`，会把这个会话从工作区里
 * 过滤掉——日志明明在，用户却打不开。
 *
 * 这里在 dsh 启动之前读 `storages/workspace.json`，把里面登记过的路径全部 mkdir 回来。
 * 目录是空的（产物回不来，那属于产物持久化 S6），但会话本身恢复可用。
 *
 * 它补的是「登记里写了什么」，不判断路径该不该存在——摘旧登记是 `migrate-workspaces.mjs`
 * 的职责（见 docs/19）。两者顺序不能反：先摘、后补，否则刚摘掉的目录又被建回来。
 *
 * 失败一律不阻止启动：这是兜底，不是主流程。
 *
 * @module deploy/image/prepare-workspaces
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME || '/home/dsh/.dsh'
const REGISTRY = join(HOME, 'storages/workspace.json')
const log = (msg) => console.error(`prepare-workspaces: ${msg}`)

if (!existsSync(REGISTRY)) {
	log('没有 workspace 索引，跳过')
	process.exit(0)
}

let paths = []
try {
	const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'))
	const table = registry?.tables?.workspaces ?? {}
	for (const row of Object.values(table)) if (typeof row?.path === 'string') paths.push(row.path)
} catch (error) {
	log(`读 workspace 索引失败：${error.message}`)
	process.exit(0)
}

let made = 0
for (const path of new Set(paths)) {
	// 只处理容器内的绝对路径：相对路径 dsh 会按自己的规则解析，不该我们插手
	if (!path.startsWith('/')) continue
	try {
		if (existsSync(path)) continue
		mkdirSync(path, { recursive: true })
		made += 1
		log(`补建 ${path}`)
	} catch (error) {
		log(`补建 ${path} 失败：${error.message}`)
	}
}
if (!made) log(`${paths.length} 个工作目录都在，无需补建`)
