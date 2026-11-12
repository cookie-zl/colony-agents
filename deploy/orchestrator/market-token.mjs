#!/usr/bin/env node
/**
 * 打印（必要时生成）某团队的市场 token，给 team-up.sh / 运维脚本用。
 *
 * 为什么不走 HTTP：team-up.sh 可能在控制面没起的时候单独拉起一个实例，
 * 这时候还得能拿到 token。直接读同一个 SQLite 更可靠，代价是这份逻辑不能有第二处实现
 * ——所以生成规则只在 db.mjs 的 ensureMarketToken 里。
 *
 *   node deploy/orchestrator/market-token.mjs team-a          # 打印 token
 *   node deploy/orchestrator/market-token.mjs team-a --json   # {"team":"team-a","token":"..."}
 */
import { openDb, ensureMarketToken } from './db.mjs'

// 同一处坑：db.mjs 开库时会 console.log，那行会被 $(...) 当成 token。
// stdout 只留 token，日志全部走 stderr。
const emit = process.stdout.write.bind(process.stdout)
console.log = (...args) => console.error(...args)
console.info = (...args) => console.error(...args)

const team = process.argv[2]
const asJson = process.argv.includes('--json')

if (!team) {
	console.error('用法：node deploy/orchestrator/market-token.mjs <team> [--json]')
	process.exit(1)
}

const token = ensureMarketToken(openDb(), team)
emit(`${asJson ? JSON.stringify({ team, token }) : token}\n`)
