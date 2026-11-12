/**
 * 校验「密钥不出控制面」这条链路：信封加密 + 网关转发。
 *
 * 用法：`node deploy/orchestrator/verify-gateway.mjs`
 * 退出码非 0 表示有断言失败。全程在临时目录与临时端口上跑，不碰真实库、不发真实请求。
 *
 * 要证明的五件事：
 *   1. 加密往返无损，且 AAD（团队/scope/key）不匹配、密文被改一个字节，都必须解不开；
 *   2. 库里存的是密文——扫一遍表里所有字节，找不到明文 key；
 *   3. 网关只认本团队的 token，跨团队、无 token、吊销后的 token 全部 401；
 *   4. 转发时上游收到的是**真 key**，而客户端手里只有 token；
 *   5. SSE 不被缓冲——上游分两段发、中间停 200ms，客户端必须先收到第一段。
 *      这条是网关最容易写错的地方：一旦攒包，模型就不再逐字输出。
 */
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'dsh-gateway-'))
// 必须在 import 之前设好：db.mjs 与 secrets.mjs 都在模块加载时确定路径
process.env.DSH_DB = join(tmp, 'dsh.db')
process.env.DSH_KEK_PATH = join(tmp, 'secret.key')

const { openDb, ensureLlmToken, rotateLlmToken, teamOfLlmToken } = await import('./db.mjs')
const { seal, open, putSecret, getSecret, listSecrets, deleteSecret, KEK_PATH } = await import('./secrets.mjs')
const { handleLlmGateway, parseGatewayPath } = await import('./llm-gateway.mjs')

const db = openDb()
const REAL_KEY = 'sk-verify-abcdefghijklmnopqrstuvwxyz0123456789'
let passed = 0
let failed = 0

/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail = '') {
	if (ok) {
		passed += 1
		console.log(`  ✓ ${name}`)
	} else {
		failed += 1
		console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
	}
}

console.log('信封加密')
{
	const blob = seal(REAL_KEY, 'team-a\u0000llm:deepseek\u0000DEEPSEEK_API_KEY')
	check('解密能拿回原文', open(blob, 'team-a\u0000llm:deepseek\u0000DEEPSEEK_API_KEY') === REAL_KEY)
	check('密文里不含明文', !blob.includes(Buffer.from(REAL_KEY)))
	check('头部有版本字节', blob[0] === 0x01)

	let aadRejected = false
	try {
		open(blob, 'team-b\u0000llm:deepseek\u0000DEEPSEEK_API_KEY')
	} catch {
		aadRejected = true
	}
	check('换团队（AAD 不匹配）解不开', aadRejected)

	const tampered = Buffer.from(blob)
	tampered[tampered.length - 1] ^= 0xff
	let tamperRejected = false
	try {
		open(tampered, 'team-a\u0000llm:deepseek\u0000DEEPSEEK_API_KEY')
	} catch {
		tamperRejected = true
	}
	check('密文被改一个字节就解不开（GCM 完整性）', tamperRejected)

	const truncated = blob.subarray(0, blob.length - 4)
	let truncRejected = false
	try {
		open(truncated, 'team-a\u0000llm:deepseek\u0000DEEPSEEK_API_KEY')
	} catch {
		truncRejected = true
	}
	check('截断的密文解不开', truncRejected)
}

console.log('主密钥文件')
{
	const mode = statSync(KEK_PATH).mode & 0o777
	check('权限是 0600', mode === 0o600, `实际 0${mode.toString(8)}`)
	check('长度 32 字节', readFileSync(KEK_PATH).length === 32)
}

console.log('库里的密钥')
{
	putSecret(db, { team: 'team-a', scope: 'llm:deepseek', key: 'DEEPSEEK_API_KEY', value: REAL_KEY })
	check('读回明文', getSecret(db, { team: 'team-a', scope: 'llm:deepseek', key: 'DEEPSEEK_API_KEY' }) === REAL_KEY)
	check('别的团队读不到', getSecret(db, { team: 'team-b', scope: 'llm:deepseek', key: 'DEEPSEEK_API_KEY' }) === undefined)

	// 直接翻库文件：明文 key 不能出现（这一条比「接口不回明文」更硬）
	const raw = readFileSync(join(tmp, 'dsh.db'))
	check('库文件里搜不到明文 key', !raw.includes(Buffer.from(REAL_KEY)))

	const listed = listSecrets(db, 'team-a')
	check('列表只回名字', listed.length === 1 && listed[0].key === 'DEEPSEEK_API_KEY' && !JSON.stringify(listed).includes(REAL_KEY))

	putSecret(db, { team: 'team-a', scope: 'llm:deepseek', key: 'DEEPSEEK_API_KEY', value: 'sk-rotated-0000000000000000' })
	check('覆盖写生效', getSecret(db, { team: 'team-a', scope: 'llm:deepseek', key: 'DEEPSEEK_API_KEY' }) === 'sk-rotated-0000000000000000')
	putSecret(db, { team: 'team-a', scope: 'llm:deepseek', key: 'DEEPSEEK_API_KEY', value: REAL_KEY })
}

console.log('网关 token')
let tokenA
let tokenB
{
	tokenA = ensureLlmToken(db, 'team-a')
	tokenB = ensureLlmToken(db, 'team-b')
	check('team-a token 有前缀', tokenA.startsWith('gl_team-a_'), tokenA)
	check('同团队重复取是同一枚', ensureLlmToken(db, 'team-a') === tokenA)
	check('反查得到团队', teamOfLlmToken(db, tokenA) === 'team-a')
	check('跨团队反查得到的是自己', teamOfLlmToken(db, tokenB) === 'team-b')
	check('乱码 token 反查为空', teamOfLlmToken(db, 'gl_team-a_forged') === undefined)

	const rotated = rotateLlmToken(db, 'team-a')
	check('轮换后是新 token', rotated !== tokenA)
	check('旧 token 当场失效', teamOfLlmToken(db, tokenA) === undefined)
	check('新 token 可用', teamOfLlmToken(db, rotated) === 'team-a')
	tokenA = rotated
}

console.log('路径解析')
{
	check('正常路径', JSON.stringify(parseGatewayPath('/llm/team-a/v1/messages')) === JSON.stringify({ team: 'team-a', rest: '/v1/messages' }))
	check('带查询串由调用方拼接', parseGatewayPath('/llm/team-a/v1/files/abc')?.rest === '/v1/files/abc')
	check('拒绝非 /v1 前缀', parseGatewayPath('/llm/team-a/admin') === undefined)
	check('拒绝路径穿越', parseGatewayPath('/llm/team-a/v1/../../etc') === undefined)
	check('拒绝双斜杠', parseGatewayPath('/llm/team-a//v1/messages') === undefined)
	check('团队名非法字符被拒', parseGatewayPath('/llm/Team_A/v1/messages') === undefined)
}

console.log('网关转发（本地假上游）')
{
	let receivedKey = null
	let receivedPath = null
	const upstream = createServer((req, res) => {
		receivedKey = req.headers['x-api-key'] || null
		receivedPath = req.url
		if (req.url.includes('/v1/messages')) {
			// 分两段发、中间停 200ms：如果网关攒包，客户端不会先收到第一段
			res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
			res.write('event: message_start\ndata: {"type":"message_start"}\n\n')
			setTimeout(() => {
				res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
				res.end()
			}, 200)
			return
		}
		res.writeHead(401, { 'content-type': 'application/json' })
		res.end(JSON.stringify({ error: 'unexpected path' }))
	})
	await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
	const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`

	const gateway = createServer(async (req, res) => {
		const handled = await handleLlmGateway(req, res, { db, upstream: upstreamUrl })
		if (!handled) {
			res.writeHead(404)
			res.end()
		}
	})
	await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
	const base = `http://127.0.0.1:${gateway.address().port}`

	const call = async (path, headers = {}) => {
		const res = await fetch(`${base}${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body: JSON.stringify({ model: 'deepseek-flash', messages: [] }),
		})
		return { status: res.status, text: await res.text() }
	}

	const noToken = await call('/llm/team-a/v1/messages')
	check('没有 token → 401', noToken.status === 401, `实际 ${noToken.status}`)

	const crossTeam = await call('/llm/team-a/v1/messages', { 'x-api-key': tokenB })
	check('拿 team-b 的 token 调 team-a → 401', crossTeam.status === 401, `实际 ${crossTeam.status}`)
	check('跨团队被拒时上游一次都没被调', receivedKey === null)

	deleteSecret(db, { team: 'team-a', scope: 'llm:deepseek', key: 'DEEPSEEK_API_KEY' })
	const noKey = await call('/llm/team-a/v1/messages', { 'x-api-key': tokenA })
	check('团队没配 key → 401 且说明是凭据缺失', noKey.status === 401 && noKey.text.includes('missing_credential'), noKey.text.slice(0, 80))
	putSecret(db, { team: 'team-a', scope: 'llm:deepseek', key: 'DEEPSEEK_API_KEY', value: REAL_KEY })

	// SSE：记录第一段到达时间
	const started = Date.now()
	const streamRes = await fetch(`${base}/llm/team-a/v1/messages`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-api-key': tokenA },
		body: JSON.stringify({ model: 'deepseek-flash', messages: [] }),
	})
	const reader = streamRes.body.getReader()
	const first = await reader.read()
	const firstAt = Date.now() - started
	const firstText = new TextDecoder().decode(first.value)
	let rest = ''
	while (true) {
		const chunk = await reader.read()
		if (chunk.done) break
		rest += new TextDecoder().decode(chunk.value)
	}
	check('上游收到的是真 key', receivedKey === REAL_KEY, `实际 ${String(receivedKey).slice(0, 12)}…`)
	check('上游收到的是 /v1/messages', receivedPath === '/v1/messages', String(receivedPath))
	check('第一段 SSE 先到（未被缓冲）', firstText.includes('message_start') && firstAt < 180, `${firstAt}ms`)
	check('第二段也到了', `${firstText}${rest}`.includes('message_stop'))
	check(
		'响应头保留了 event-stream',
		String(streamRes.headers.get('content-type') || '').includes('text/event-stream'),
		String(streamRes.headers.get('content-type')),
	)
	check('SSE 明确禁用了中间层缓冲', streamRes.headers.get('x-accel-buffering') === 'no')

	const bad = await call('/llm/team-a/admin', { 'x-api-key': tokenA })
	check('非 /v1 路径 → 400', bad.status === 400, `实际 ${bad.status}`)

	await new Promise((resolve) => gateway.close(resolve))
	await new Promise((resolve) => upstream.close(resolve))
}

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} 条通过，${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
