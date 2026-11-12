/**
 * 模型网关：把「真 API Key」留在控制面，容器里只给一枚可吊销的团队 token。
 *
 * 为什么必须做成网关而不是把 key 注入容器：
 *   dsh 与 agent 子进程同 uid，密钥一旦进容器，`/proc/<pid>/environ` 或凭据文件
 *   就一定能被读到——env scrub 只挡住「子进程继承」，挡不住直接读主进程。
 *   唯一能真正隔离的做法是密钥不进去，让请求出来。
 *
 * 协议：dsh 的 baseURL 根是 Anthropic Messages（`https://api.deepseek.com/anthropic`），
 * 端点只有 `/v1/messages` 与 `/v1/files`。所以这里是**纯反向代理**，不做任何格式转换：
 *     容器 → /llm/<team>/v1/messages （x-api-key = 团队 token）
 *          → 换成真 key → 转发 upstream → SSE 原样回传
 *
 * 三个容易写错的点，都在下面显式处理了：请求体要流式（图片 base64 可能几十 MB）、
 * 响应体不能缓冲（SSE 一缓冲就没有「逐字输出」）、hop-by-hop 头必须剥掉。
 */
import { Readable } from 'node:stream'
import { getSecret } from './secrets.mjs'
import { teamOfLlmToken } from './db.mjs'

/** 团队密钥在 team_secrets 里的坐标。scope 带协议名，将来接别的 provider 不会撞。 */
export const LLM_SCOPE = 'llm:deepseek'
export const LLM_KEY = 'DEEPSEEK_API_KEY'

const DEFAULT_UPSTREAM = 'https://api.deepseek.com/anthropic'

/**
 * 逐跳头（hop-by-hop）不能透传：它们描述的是「这一跳」的连接，转发出去会让上游
 * 按错误的连接语义回应。`host` 必须换成上游的，`content-length` 要重算。
 */
const DROP_REQUEST_HEADERS = new Set([
	'host',
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'content-length',
	'accept-encoding', // 让上游按自己的压缩策略来，我们原样回传，不在中间解码
])

const DROP_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length'])

/** 允许透传的路径前缀。只放 /v1/，防止被当成通用代理打出别的接口。 */
const ALLOWED_PREFIX = '/v1/'

/**
 * 从 `/llm/<team>/v1/messages` 里拆出团队与上游路径。
 *
 * @param {string} pathname
 * @returns {{team:string, rest:string}|undefined}
 */
export function parseGatewayPath(pathname) {
	const match = /^\/llm\/([a-z0-9][a-z0-9-]{0,31})(\/.*)?$/.exec(pathname)
	if (!match) return undefined
	const rest = match[2] || '/'
	// 路径穿越与双斜杠都不接受：宁可 400，也不要让上游收到一个被规范化过的怪路径
	if (!rest.startsWith(ALLOWED_PREFIX) || rest.includes('..') || rest.includes('//')) return undefined
	return { team: match[1], rest }
}

/**
 * 客户端带的 token。dsh 用 `x-api-key`，脚本/curl 常用 Bearer，两种都认。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
function tokenOf(req) {
	const direct = req.headers['x-api-key']
	if (typeof direct === 'string' && direct) return direct
	const auth = String(req.headers.authorization || '')
	return auth.replace(/^Bearer\s+/i, '')
}

/**
 * 处理一次网关请求。调用方已在路由最前面分流，这里只管鉴权、取密钥、转发。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{db:import('node:sqlite').DatabaseSync, upstream?:string, onAudit?:(e:object)=>void}} ctx
 * @returns {Promise<boolean>} 是否由本模块处理（false = 交给后面的路由）
 */
export async function handleLlmGateway(req, res, ctx) {
	const url = new URL(req.url, 'http://console')
	const parsed = parseGatewayPath(url.pathname)
	if (!parsed) {
		// /llm 开头但路径不对：明确拒绝，不要落到 console-token 那一层让人以为缺权限
		if (url.pathname === '/llm' || url.pathname.startsWith('/llm/')) {
			writeJson(res, 400, { error: '网关路径必须是 /llm/<team>/v1/{messages,files}' })
			return true
		}
		return false
	}

	const { team, rest } = parsed
	const provided = tokenOf(req)
	const owner = teamOfLlmToken(ctx.db, provided)
	if (!owner || owner !== team) {
		// 不区分「token 无效」与「token 不属于这个团队」，避免被用来探测团队是否存在
		writeJson(res, 401, { error: '网关 token 无效或不属于该团队' })
		ctx.onAudit?.({ team, path: rest, status: 401, reason: 'unauthorized' })
		return true
	}

	const apiKey = getSecret(ctx.db, { team, scope: LLM_SCOPE, key: LLM_KEY })
	if (!apiKey) {
		// dsh 会把这个 401 呈现成凭据缺失，正是我们想要的：团队没配 key 就明确说没配
		writeJson(res, 401, { error: `团队 ${team} 还没有配置模型凭据`, type: 'missing_credential' })
		ctx.onAudit?.({ team, path: rest, status: 401, reason: 'no-key' })
		return true
	}

	const upstream = String(ctx.upstream || process.env.DSH_LLM_UPSTREAM || DEFAULT_UPSTREAM).replace(/\/+$/, '')
	const started = Date.now()
	const abort = new AbortController()
	// 客户端断开（用户关页面/发版重建）就掐断上游，否则一次没人读的流会把连接吊满 300 秒
	res.on('close', () => {
		if (!res.writableEnded) abort.abort()
	})

	const headers = new Headers()
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined) continue
		if (DROP_REQUEST_HEADERS.has(name.toLowerCase())) continue
		if (name.toLowerCase() === 'x-api-key' || name.toLowerCase() === 'authorization') continue
		headers.set(name, Array.isArray(value) ? value.join(',') : value)
	}
	headers.set('x-api-key', apiKey)

	let upstreamRes
	try {
		upstreamRes = await fetch(`${upstream}${rest}${url.search}`, {
			method: req.method,
			headers,
			// 流式请求体：图片走 base64 内联时有几十 MB，不能先读进内存
			body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Readable.toWeb(req),
			duplex: 'half',
			signal: abort.signal,
			redirect: 'manual',
		})
	} catch (error) {
		const aborted = abort.signal.aborted
		if (!aborted) {
			console.error(`console: 网关转发 ${team} ${rest} 失败`, error.message)
			writeJson(res, 502, { error: `上游不可达：${error.message}` })
		}
		ctx.onAudit?.({ team, path: rest, status: aborted ? 499 : 502, ms: Date.now() - started })
		return true
	}

	const outHeaders = {}
	for (const [name, value] of upstreamRes.headers) {
		if (DROP_RESPONSE_HEADERS.has(name.toLowerCase())) continue
		outHeaders[name] = value
	}
	// SSE 必须显式声明并关掉所有缓冲：中间的代理（含 Caddy）看到 x-accel-buffering 才不攒包
	if (String(upstreamRes.headers.get('content-type') || '').includes('text/event-stream')) {
		outHeaders['cache-control'] = 'no-cache, no-transform'
		outHeaders['x-accel-buffering'] = 'no'
	}
	res.writeHead(upstreamRes.status, outHeaders)

	if (!upstreamRes.body) {
		res.end()
		ctx.onAudit?.({ team, path: rest, status: upstreamRes.status, ms: Date.now() - started })
		return true
	}

	try {
		// 不缓冲、不聚合：Readable.fromWeb 直接接上，pipe 自带背压
		await new Promise((resolve, reject) => {
			const body = Readable.fromWeb(upstreamRes.body)
			body.on('error', reject)
			res.on('error', reject)
			res.on('finish', resolve)
			body.pipe(res)
		})
	} catch (error) {
		// 头部已发出，只能断开；记一笔便于分辨「用户取消」与「上游断流」
		if (!abort.signal.aborted) console.error(`console: 网关回传 ${team} ${rest} 中断`, error.message)
		res.destroy()
	}
	ctx.onAudit?.({ team, path: rest, status: upstreamRes.status, ms: Date.now() - started })
	return true
}

/** 网关自己的错误响应。不依赖 console.mjs 里的 json()，避免循环 import。 */
function writeJson(res, status, payload) {
	if (res.headersSent) {
		res.destroy()
		return
	}
	const body = JSON.stringify(payload)
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
	res.end(body)
}
