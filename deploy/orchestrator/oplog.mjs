/**
 * @deprecated 操作日志已统一到库里的 `ops` 表（db.mjs 的 `appendOp` / `opsForTeam`）。
 *
 * 这个模块只保留 `read()` 的等价能力给 `migrate-db.mjs` 做一次性导入，**不要再在业务路径里
 * 调用它**。曾经 market.mjs 往这里写、db.mjs 往表里写，门户只读这里，导致「安装/卸载/启停」
 * 在页面上整段消失——两套日志比没有日志更糟。
 *
 * 包操作日志：谁在什么时候对哪个团队的技能/连接器做了什么。
 *
 * 和审计（auth 侧 audit/*.jsonl）分开放，是因为两者回答的问题不同：
 *   审计  = 「谁在什么时候访问了哪个团队」，偏安全，按天切、落容器挂载卷
 *   操作日志 = 「谁把这个技能装上/分享/启用了」，偏业务，按团队可查、落控制面
 *
 * 只留最近 500 条：它是流水不是账本。需要长期统计应该进指标或导出，
 * 不该让一个 JSON 文件无限长大。
 */
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { writeInPlace, HERE } from './store.mjs'

export const OPLOG_FILE = resolve(HERE, 'oplog.json')
const MAX = 500

const read = () => {
	try {
		const data = JSON.parse(readFileSync(OPLOG_FILE, 'utf8'))
		return Array.isArray(data.ops) ? data.ops : []
	} catch {
		return []
	}
}

/**
 * 记一条操作。
 *
 * @param {object} entry
 * @param {string} entry.team   被操作的团队（分享时是接收方，from/to 另记）
 * @param {string} entry.action install|uninstall|publish|share|enable|reject
 * @param {'skill'|'mcp'} entry.kind
 * @param {string} entry.name   包名
 * @param {string} [entry.by]   操作者账号；脚本调用是 make/console
 * @param {string} [entry.note] 操作者填的备注（分享说明等）
 * @param {string} [entry.from] 分享来源团队
 * @param {string} [entry.to]   分享目标团队
 * @param {string} [entry.detail] 自由文本，失败原因/补充说明
 */
export function appendOp(entry) {
	const list = read()
	list.unshift({
		id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
		at: new Date().toISOString(),
		by: entry.by || 'console',
		...entry,
	})
	mkdirSync(dirname(OPLOG_FILE), { recursive: true })
	writeInPlace(OPLOG_FILE, `${JSON.stringify({ ops: list.slice(0, MAX) }, null, 2)}\n`)
}

/** 团队视角的操作日志：本团队被操作的 + 本团队发起的分享。 */
export function opsView(team, limit = 40) {
	const all = read()
	const scoped = team ? all.filter((op) => op.team === team || op.from === team || op.to === team) : all
	return scoped.slice(0, limit)
}
