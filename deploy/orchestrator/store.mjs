/**
 * 控制面的持久化层：团队注册表、运维态、节点表、快照。
 *
 * 三份数据各管一件事，边界不要混：
 *   accounts.json  谁属于哪个团队、团队入口是什么（账号服务与它共用，是事实来源）
 *   state.json     lastSeen / asleep，纯缓存，随时可由容器真实状态重建
 *   nodes.json     机器（节点）清单与资源预算，新建团队时按它调度
 *
 * accounts.json 是以「单文件 bind mount」挂进每个容器的，写它**必须原地覆盖**：
 * rename 会换 inode，已运行容器里的挂载点当场变成悬空路径，账号服务直接崩。
 */
import { DatabaseSync } from 'node:sqlite'
import {
	readFileSync,
	writeFileSync,
	copyFileSync,
	unlinkSync,
	mkdirSync,
	readdirSync,
	existsSync,
	statSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO = resolve(HERE, '../..')
export const ACCOUNTS = resolve(REPO, 'deploy/auth/accounts.json')
export const STATE_FILE = resolve(HERE, 'state.json')
export const NODES_FILE = resolve(HERE, 'nodes.json')
export const BACKUP_DIR = resolve(HERE, 'backups')
/** 归档目录。可被环境变量指走：校验脚本要在临时目录里跑「上传失败降级」这条路径。 */
export const ARCHIVE_DIR = process.env.CONSOLE_ARCHIVE_DIR || resolve(HERE, 'archives')
/** 团队级模型凭据。单独一个文件、0600、不进版本库：它是密钥，不该跟注册表混在一起。 */

/**
 * 原地覆盖写：保持 inode 不变，已挂载它的容器不会悬空。
 *
 * 先写同目录临时文件再复制内容，是为了避免写到一半崩溃留下半个 JSON
 * ——半个 JSON 会让账号服务读失败，届时全站登录都会受影响。
 */
export function writeInPlace(file, text) {
	const tmp = `${file}.tmp-${process.pid}`
	writeFileSync(tmp, text)
	try {
		copyFileSync(tmp, file)
	} finally {
		// 清理临时文件失败不该让写入本身报错：内容已经落盘，残留一个 tmp 是无害的，
		// 但抛出去会让调用方误以为数据没写进去（在带安全删除钩子的环境里就会这样）
		try {
			unlinkSync(tmp)
		} catch {
			/* 忽略 */
		}
	}
}

/**
 * 清扫上次进程留下的临时文件。
 *
 * writeInPlace 每次都在 finally 里删，但「进程被 kill」「文件系统不让删」
 * 这两种情况下会留下 `xxx.json.tmp-<pid>`。它们不影响正确性（真身已经写完），
 * 却会混进 git status，也让人怀疑数据是不是写了一半。
 *
 * 只删一小时以前的：正在写的临时文件存活时间以毫秒计，绝不会被误伤。
 *
 * @param {string} dir 要扫的目录
 * @returns {number} 删掉的文件数
 */
export function pruneTmp(dir, olderThanMs = 3600_000) {
	if (!existsSync(dir)) return 0
	let removed = 0
	for (const name of readdirSync(dir)) {
		if (!/\.tmp-\d+$/.test(name)) continue
		const path = join(dir, name)
		try {
			if (Date.now() - statSync(path).mtimeMs < olderThanMs) continue
			unlinkSync(path)
			removed += 1
		} catch {
			/* 删不掉不影响任何事情 */
		}
	}
	return removed
}

const readJsonFile = (file) => JSON.parse(readFileSync(file, 'utf8'))

/** 团队注册表（accounts.json）。读失败直接抛：这是事实来源，不能带着坏数据继续跑。 */
export function registry() {
	return readJsonFile(ACCOUNTS)
}

/** 覆盖写团队注册表（`accounts.json`，事实来源）。 */
export function saveRegistry(data) {
	writeInPlace(ACCOUNTS, `${JSON.stringify(data, null, 2)}\n`)
}

/**
 * 运维态：谁最后活跃、谁睡着及原因。
 *
 * 只是缓存——真实状态永远以容器为准。控制面重启、容器被手工删掉之后
 * 这里一定和现实对不上，所以要用 reconcile() 定期以容器为基准纠正它。
 */
export function loadState() {
	try {
		const raw = readJsonFile(STATE_FILE)
		return { lastSeen: raw.lastSeen || {}, asleep: raw.asleep || {} }
	} catch {
		return { lastSeen: {}, asleep: {} }
	}
}

let stateTimer = null
/** 合并写运维态：同一轮多次变更只落一次盘，避免频繁同步 IO。 */
export function saveStateSoon(state) {
	if (stateTimer) return
	stateTimer = setTimeout(() => {
		stateTimer = null
		try {
			writeInPlace(STATE_FILE, `${JSON.stringify({ lastSeen: state.lastSeen, asleep: state.asleep }, null, 2)}\n`)
		} catch (error) {
			console.error('console: 写 state.json 失败', error.message)
		}
	}, 3000)
}

/**
 * 节点清单。文件不存在时按「本机单节点」补齐，让本地跑法零配置。
 *
 * 云上多机时把每个节点写进来：provider 决定用 compose 还是 helm 起实例，
 * cpuBudget / memBudgetGB 是**可用总量**（不是物理核数），调度时按它扣减。
 */
export function loadNodes() {
	if (!existsSync(NODES_FILE)) {
		const seed = {
			nodes: [
				{
					id: 'local',
					label: '本机 OrbStack',
					provider: 'compose',
					domain: 'localhost',
					portBase: Number(process.env.CONSOLE_PORT_BASE || 8082),
					portMax: Number(process.env.CONSOLE_PORT_MAX || 8180),
					cpuBudget: Number(process.env.CONSOLE_CPU_BUDGET || 8),
					memBudgetGB: Number(process.env.CONSOLE_MEM_BUDGET_GB || 8),
				},
			],
		}
		mkdirSync(HERE, { recursive: true })
		writeInPlace(NODES_FILE, `${JSON.stringify(seed, null, 2)}\n`)
		return seed
	}
	return readJsonFile(NODES_FILE)
}

/** 覆盖写节点配额表（CPU / 内存预算）。 */
export function saveNodes(data) {
	writeInPlace(NODES_FILE, `${JSON.stringify(data, null, 2)}\n`)
}


/**
 * 给三份配置拍快照。accounts.json 曾被一次误写搞坏过——没有快照时那是全站故障。
 *
 * @param {string} reason 记在文件名之外，方便日志里看出这次快照的触发原因
 * @returns {string[]} 本次写出的快照文件（绝对路径）
 */
export function snapshot(reason = 'auto') {
	mkdirSync(BACKUP_DIR, { recursive: true })
	const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
	const written = []
	for (const [name, file] of [
		['accounts', ACCOUNTS],
		['state', STATE_FILE],
		['nodes', NODES_FILE],
		// 市场台账与分享流水不进注册表，但它们记着「谁装了什么、谁把什么给了谁」，
		// 丢了只能靠翻容器卷重建。跟配置一起拍，恢复时才有完整的一套。
		['packages', resolve(HERE, 'packages.json')],
		['shares', resolve(HERE, 'shares.json')],
		// 操作日志跟着一起拍：它是「谁改过什么」的唯一记录，重建不了。
		// inbox 里的待接收内容不拍——那是可重新投递的运行态数据，体积也不可控。
		['oplog', resolve(HERE, 'oplog.json')],
	]) {
		if (!existsSync(file)) continue
		const dest = join(BACKUP_DIR, `${name}-${stamp}.json`)
		copyFileSync(file, dest)
		written.push(dest)
	}

	// 技能/连接器/分享/日志现在以 SQLite 为事实来源，必须一起拍，否则「恢复」只恢复了一半。
	// 用 VACUUM INTO 而不是 copyFile：WAL 模式下直接拷贝会漏掉尚未 checkpoint 的事务，
	// 拿到的可能是几秒前、甚至写了一半的状态。VACUUM INTO 产出的是一致快照。
	const dbFile = resolve(HERE, 'dsh.db')
	if (existsSync(dbFile)) {
		const dest = join(BACKUP_DIR, `db-${stamp}.db`)
		try {
			const conn = new DatabaseSync(dbFile)
			conn.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
			conn.close()
			written.push(dest)
		} catch (error) {
			// 拍不上就大声说：以为有备份、实际没有，比没有备份更危险
			console.error(`console: 数据库快照失败 → ${error.message}`)
		}
	}

	console.log(`console: 已快照（${reason}）→ ${BACKUP_DIR}`)
	pruneSnapshots()
	return written
}

/** 上一次清理的时间：快照每小时一次，每次全量 readdir + stat 几千个文件是纯浪费。 */
let lastPrune = 0

/**
 * 每类快照只留最近 N 份，别让备份自己把磁盘吃满。
 *
 * 两处防卡死（实测踩过：目录里 2914 个文件时，这个函数把事件循环按住几十秒，
 * 控制面 `curl /health` 连续 45 秒无响应）：
 *   1. 十分钟内只跑一次——快照频率远高于「需要清理」的频率；
 *   2. 单次最多删 20 个，删不完留到下一轮；失败聚合成一条日志。
 *      逐条 console.error 同步写终端，两千条就能顶住整个进程。
 *
 * @param {number} [keep] 每类保留份数
 * @param {number} [limit] 单次删除上限
 */
export function pruneSnapshots(keep = 24, limit = 20) {
	const now = Date.now()
	if (now - lastPrune < 10 * 60_000) return
	lastPrune = now
	if (!existsSync(BACKUP_DIR)) return
	const groups = new Map()
	for (const name of readdirSync(BACKUP_DIR)) {
		const match = name.match(/^(accounts|state|nodes|packages|shares|oplog|db)-(.+)\.(json|db)$/)
		if (!match) continue
		if (!groups.has(match[1])) groups.set(match[1], [])
		try {
			groups.get(match[1]).push({ name, at: statSync(join(BACKUP_DIR, name)).mtimeMs })
		} catch {
			/* 刚被别的进程删掉：不参与本轮排序 */
		}
	}
	let removed = 0
	let failed = 0
	let firstError = ''
	for (const list of groups.values()) {
		list.sort((a, b) => b.at - a.at)
		for (const stale of list.slice(keep)) {
			if (removed >= limit) break
			try {
				unlinkSync(join(BACKUP_DIR, stale.name))
				removed += 1
			} catch (error) {
				failed += 1
				if (!firstError) firstError = error.message
			}
		}
	}
	if (removed) console.log(`console: 清理旧快照 ${removed} 个`)
	// 删除被策略拦住时不要安静：下一轮还会再试，但运维要知道目录正在长大
	if (failed) console.error(`console: 清理旧快照失败 ${failed} 个（首个：${firstError}）`)
}

/** 从快照恢复 accounts.json。恢复前会先把当前文件再存一份，避免「恢复」变成不可逆操作。 */
export function restoreSnapshot(file) {
	if (!existsSync(file)) throw new Error(`快照不存在：${file}`)
	snapshot('before-restore')
	copyFileSync(file, ACCOUNTS)
	return file
}
