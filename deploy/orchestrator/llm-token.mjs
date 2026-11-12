#!/usr/bin/env node
/**
 * 打印（必要时生成）某团队的模型网关 token，给 team-up.sh / 运维脚本用。
 *
 * 和 market-token.mjs 同一套理由：team-up.sh 可能在控制面没起的时候单独拉起实例，
 * 这时也得能拿到 token，所以直接读同一个 SQLite，而不是要求控制面在线。
 * 生成规则只允许有一处实现——db.mjs 的 ensureLlmToken。
 *
 *   node deploy/orchestrator/llm-token.mjs team-a          # 打印 token
 *   node deploy/orchestrator/llm-token.mjs team-a --json   # {"team":"team-a","token":"...","baseUrl":"..."}
 *
 * 注意这枚 token **不是** API Key：它只能调到控制面的 /llm/<team>，
 * 换取的是「代发一次模型请求」，拿不到真密钥，吊销也不影响别人。
 */
import { openDb, ensureLlmToken } from './db.mjs'

// 必须先接管再 openDb：db.mjs 在开库时会 console.log（例如「回填 N 条分享的 item_id」），
// 那行会混进 stdout，被 team-up.sh 的 $(...) 当成 token 塞进容器——实际发生过一次，
// 容器里的 DEEPSEEK_API_KEY 变成了中文日志。所以日志一律挤到 stderr，
// stdout 只留最后那一行 token。
const emit = process.stdout.write.bind(process.stdout)
console.log = (...args) => console.error(...args)
console.info = (...args) => console.error(...args)

const team = process.argv[2]
const asJson = process.argv.includes('--json')

if (!team) {
	console.error('用法：node deploy/orchestrator/llm-token.mjs <team> [--json]')
	process.exit(1)
}

const token = ensureLlmToken(openDb(), team)
const baseUrl = `http://host.docker.internal:${process.env.CONSOLE_PORT || 9700}/llm/${team}`
emit(`${asJson ? JSON.stringify({ team, token, baseUrl }) : token}\n`)
