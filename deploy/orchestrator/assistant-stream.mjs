/**
 * 钉钉 Stream 模式入站：由控制面主动连出去，不需要公网回调。
 *
 * 为什么单独做这条路：HTTP 回调要求平台能访问到 `https://<你的域名>/assistants/inbound/dingtalk`，
 * 本地开发/私有部署根本不可达。Stream 反过来——控制面用 AppKey + AppSecret 向钉钉网关
 * 注册一条长连接，消息从这条连接推下来，出站和以前一样走 sessionWebhook。
 *
 * 协议（官方文档「Stream 模式协议接入说明」）三步：
 *   1. POST /v1.0/gateway/connections/open → { endpoint, ticket }，ticket 90 秒有效、只能用一次；
 *   2. `wss://<endpoint>?ticket=...` 建长连；
 *   3. 每帧都要回执，否则平台认为客户端掉线。
 *
 * 三个坑：
 *  - **探活**（topic=ping）必须把 data 原样回传，改一个字节都会被判死；
 *  - **disconnect** 是服务端在做负载均衡，要立刻用**新 ticket** 重连，旧 ticket 不能复用；
 *  - 回调帧的 payload 里 robotCode 不一定等于 AppKey，所以按 clientId 兜底匹配助理。
 *
 * @module deploy/orchestrator/assistant-stream
 */
import { assistantSecretScope, findAssistantForEvent } from './assistants.mjs'
import { normalizeDingTalkEvent } from './assistant-channels.mjs'

/** 机器人消息的 Stream topic，固定值。 */
export const STREAM_TOPIC = '/v1.0/im/bot/messages/get'

/** 注册长连接的网关地址。 */
export const STREAM_GATEWAY = 'https://api.dingtalk.com/v1.0/gateway/connections/open'

/** 重连退避（毫秒）。断线不狂刷，但也别让群里等太久。 */
export const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000]

/**
 * 把网关返回的 endpoint 与一次性 ticket 拼成 WebSocket 地址。
 *
 * endpoint 自带路径（`/connect`），ticket 只能拼在 query 上。
 *
 * @param {string} endpoint 网关返回的 endpoint
 * @param {string} ticket 一次性票据
 * @returns {string} 可直连的 wss 地址
 */
export function streamUrl(endpoint, ticket) {
	const base = String(endpoint || '').split('?')[0]
	return `${base}?ticket=${encodeURIComponent(ticket)}`
}

/**
 * 调网关注册一条 Stream 连接。
 *
 * 每次重连都要重新调用：ticket 一次性、90 秒过期，缓存它只会换来一次握手失败。
 *
 * @param {object} input 参数
 * @param {string} input.clientId 应用 Client ID（原 AppKey）
 * @param {string} input.clientSecret 应用 Client Secret（原 AppSecret）
 * @param {typeof fetch} [input.fetchImpl] fetch 实现（自测注入）
 * @param {string} [input.ua] 客户端标识，排障时能在钉钉侧看到
 * @param {number} [input.timeoutMs] 注册超时
 * @returns {Promise<{endpoint:string,ticket:string}>} 连接信息
 */
export async function openConnection({ clientId, clientSecret, fetchImpl = fetch, ua = 'dsh-orchestrator/0.1', timeoutMs = 10_000 }) {
	if (!clientId || !clientSecret) throw new Error('缺少 Client ID / Client Secret')
	const response = await fetchImpl(STREAM_GATEWAY, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			clientId,
			clientSecret,
			// EVENT * 收事件（成员变动等），CALLBACK 才是机器人消息回调
			subscriptions: [
				{ type: 'EVENT', topic: '*' },
				{ type: 'CALLBACK', topic: STREAM_TOPIC },
			],
			ua,
		}),
		signal: AbortSignal.timeout(timeoutMs),
	})
	const text = await response.text()
	if (!response.ok) throw new Error(`注册 Stream 连接失败 ${response.status}：${text.slice(0, 200)}`)
	let body
	try {
		body = JSON.parse(text)
	} catch {
		throw new Error(`Stream 网关返回了非 JSON：${text.slice(0, 120)}`)
	}
	if (!body?.endpoint || !body?.ticket) throw new Error('Stream 网关没返回 endpoint / ticket')
	return { endpoint: body.endpoint, ticket: body.ticket }
}

/** 帧里的 data 是 JSON 字符串；解析失败返回 undefined，不要因此断连。 */
function parseData(data) {
	if (data && typeof data === 'object') return data
	try {
		return JSON.parse(String(data ?? ''))
	} catch {
		return undefined
	}
}

/**
 * 给一帧定性。纯函数，自测直接喂样例帧。
 *
 * @param {object} frame 已解析的帧
 * @returns {{kind:'ping'|'disconnect'|'callback'|'event'|'system'|'unknown',messageId:string,topic?:string,data?:any,payload?:object}}
 */
export function classifyFrame(frame) {
	const headers = frame?.headers || {}
	const topic = String(headers.topic || '')
	const messageId = String(headers.messageId || '')
	if (frame?.type === 'SYSTEM') {
		if (topic === 'ping') return { kind: 'ping', messageId, data: frame.data }
		if (topic === 'disconnect') return { kind: 'disconnect', messageId }
		return { kind: 'system', messageId, topic }
	}
	if (frame?.type === 'CALLBACK') return { kind: 'callback', messageId, topic, payload: parseData(frame.data) }
	if (frame?.type === 'EVENT') return { kind: 'event', messageId, topic, payload: parseData(frame.data) }
	return { kind: 'unknown', messageId, topic }
}

/**
 * 组装回执帧。messageId 必须与请求一致，否则平台会当成未回执并重推。
 *
 * @param {string} messageId 请求帧的 headers.messageId
 * @param {string|object} data 回执数据；字符串原样回传（探活要求字节一致）
 * @returns {string} 待发送的 JSON 文本
 */
export function ackFrame(messageId, data = {}) {
	return JSON.stringify({
		code: 200,
		headers: { messageId, contentType: 'application/json' },
		message: 'OK',
		data: typeof data === 'string' ? data : JSON.stringify(data),
	})
}

/**
 * 维护一条 Stream 长连接：建连 → 收帧 → 断线重连。
 *
 * 状态机有意做得很薄——所有「该不该连」的判断都在 manager 里，
 * 这里只负责「连上、回执、断了再连」。
 *
 * @param {object} deps 依赖
 * @param {string} deps.clientId 应用 Client ID
 * @param {string} deps.clientSecret 应用 Client Secret
 * @param {(payload:object)=>void|Promise<void>} deps.onPayload 机器人消息回调
 * @param {(message:string)=>void} [deps.log] 日志
 * @param {typeof WebSocket} [deps.WebSocketImpl] WebSocket 实现（自测注入）
 * @param {typeof fetch} [deps.fetchImpl] fetch 实现（自测注入）
 * @param {number[]} [deps.delays] 重连退避
 * @returns {{start:Function,stop:Function,readonly state:string}} 连接句柄
 */
export function createDingTalkStream({
	clientId,
	clientSecret,
	onPayload,
	log = () => {},
	WebSocketImpl = globalThis.WebSocket,
	fetchImpl = fetch,
	delays = RECONNECT_DELAYS,
}) {
	const tag = `stream ${String(clientId).slice(0, 6)}…`
	let socket = null
	let timer = null
	let stopped = true
	let attempt = 0
	let state = 'idle'

	const setState = (next) => {
		if (state === next) return
		state = next
		log(`${tag} ${next}`)
	}

	/** 把帧发回去。readyState 不是 OPEN 时静默丢弃，断开后本来就要重连。 */
	const send = (text) => {
		try {
			if (socket && socket.readyState === 1) socket.send(text)
		} catch (error) {
			log(`${tag} 回执失败：${error.message}`)
		}
	}

	const schedule = (reason) => {
		if (stopped || timer) return
		const wait = delays[Math.min(attempt, delays.length - 1)]
		attempt += 1
		log(`${tag} ${reason}，${Math.round(wait / 1000)}s 后重连`)
		timer = setTimeout(() => {
			timer = null
			connect()
		}, wait)
		timer.unref?.()
	}

	/**
	 * 处理一帧。回调帧先回执再跑业务：钉钉等回执超时会重推，
	 * 而 dsh 一轮几分钟，不能让它挂在回执里。
	 */
	const onFrame = (raw) => {
		let frame
		try {
			frame = JSON.parse(String(raw))
		} catch {
			log(`${tag} 收到非 JSON 帧，忽略`)
			return
		}
		const info = classifyFrame(frame)
		if (info.kind === 'ping') {
			send(ackFrame(info.messageId, info.data))
			return
		}
		if (info.kind === 'disconnect') {
			// 服务端要均衡负载：不用回执，立刻换新 ticket 重连
			log(`${tag} 平台要求断开，立即重连`)
			attempt = 0
			try {
				socket?.close()
			} catch {
				/* 已经关了就算了 */
			}
			connect()
			return
		}
		if (info.kind === 'callback') {
			send(ackFrame(info.messageId, { response: {} }))
			if (info.topic && info.topic !== STREAM_TOPIC) return
			Promise.resolve()
				.then(() => onPayload(info.payload))
				.catch((error) => log(`${tag} 处理消息失败：${error.message}`))
			return
		}
		if (info.kind === 'event') {
			send(ackFrame(info.messageId, { status: 'SUCCESS' }))
			return
		}
		// 未知 SYSTEM 帧也回执，避免平台反复重推
		if (info.messageId) send(ackFrame(info.messageId, {}))
	}

	async function connect() {
		if (stopped) return
		setState('connecting')
		let opened
		try {
			opened = await openConnection({ clientId, clientSecret, fetchImpl })
		} catch (error) {
			setState('error')
			schedule(`建连失败：${error.message}`)
			return
		}
		if (stopped) return
		let next
		try {
			next = new WebSocketImpl(streamUrl(opened.endpoint, opened.ticket))
		} catch (error) {
			setState('error')
			schedule(`WebSocket 建不起来：${error.message}`)
			return
		}
		socket = next
		next.addEventListener('open', () => {
			attempt = 0
			setState('connected')
		})
		next.addEventListener('message', (event) => onFrame(event.data))
		next.addEventListener('close', () => {
			socket = null
			if (stopped) return setState('stopped')
			setState('closed')
			schedule('连接被关闭')
		})
		next.addEventListener('error', () => {
			// error 之后一定会 close，重连交给 close，别在这里双触发
			setState('error')
		})
	}

	return {
		/** 开始连接（幂等）。 */
		start() {
			if (!stopped) return
			stopped = false
			attempt = 0
			connect()
		},
		/** 主动断开，不再重连。 */
		stop() {
			stopped = true
			if (timer) {
				clearTimeout(timer)
				timer = null
			}
			try {
				socket?.close()
			} catch {
				/* 忽略 */
			}
			socket = null
			setState('stopped')
		},
		/** 当前连接状态：idle/connecting/connected/closed/error/stopped。 */
		get state() {
			return state
		},
	}
}

/**
 * 按库里的助理起停 Stream 连接。
 *
 * 一个应用（clientId）只允许一条长连接：多开会让钉钉随机把消息推到其中一条，
 * 群里表现为「有时候回、有时候不回」。所以这里按 clientId 去重，不按助理去重。
 *
 * @param {object} deps 依赖
 * @param {import('node:sqlite').DatabaseSync} deps.db 数据库
 * @param {{handle:(event:object)=>Promise<object>}} deps.dispatcher 助理调度器
 * @param {(team:string,scope:string,key:string)=>string|undefined} deps.secret 取凭据
 * @param {(message:string)=>void} [deps.log] 日志
 * @param {typeof WebSocket} [deps.WebSocketImpl] WebSocket 实现（自测注入）
 * @param {typeof fetch} [deps.fetchImpl] fetch 实现（自测注入）
 * @returns {{reload:Function,stop:Function,readonly size:number,readonly states:object}} 管理器
 */
export function createStreamManager({ db, dispatcher, secret, log = () => {}, WebSocketImpl, fetchImpl }) {
	/** clientId → { stream, assistantId } */
	const running = new Map()

	/**
	 * 把一条 Stream 消息交给调度器。
	 *
	 * robotCode 兜底：不同版本的钉钉应用，回调里的 robotCode 有时是 AppKey、有时是 corpId 加后缀，
	 * 只靠它匹配会漏消息。已经连上的连接本身就代表某个应用，所以匹配不到时用本应用的助理兜底。
	 */
	const dispatch = async (assistantId, payload) => {
		const event = normalizeDingTalkEvent(payload)
		if (!event || !event.msgId) return
		let assistant = findAssistantForEvent(db, event)
		if (!assistant && assistantId) assistant = db.prepare('SELECT * FROM assistants WHERE id = ?').get(assistantId)
		if (!assistant) {
			log(`收到消息但没匹配到助理（robotKey=${event.robotKey || '空'}，msgId=${event.msgId}）`)
			return
		}
		// 只记元数据，不记正文：群消息内容不适合落到控制面日志里
		const sessionType = event.conversationType === 1 ? '单聊' : event.conversationType === 2 ? '群聊' : '未知'
		log(
			`收到钉钉消息 msgId=${event.msgId} 会话=${sessionType} 群=${event.conversationId || '单聊'} @=${event.mentioned} ` +
				`助理=${assistant.id} 正文=${String(event.text || '').length}字 回信地址=${event.replyUrl ? '临时 sessionWebhook（回原会话）' : '无'}`,
		)
		const result = await dispatcher.handle({ ...event, robotKey: assistant.robot_key || event.robotKey })
		log(`消息 ${event.msgId} → ${result.status}`)
		return result
	}

	/**
	 * 重新对齐「库里该连的」与「正在连的」：新增的连上、删掉/停用的断开。
	 *
	 * @returns {Promise<{connected:number,stopped:number}>} 本次变化
	 */
	async function reload() {
		const rows = db.prepare("SELECT * FROM assistants WHERE platform = 'dingtalk' AND enabled = 1").all()
		const wanted = new Map()
		for (const row of rows) {
			const scope = assistantSecretScope(row.id)
			let appKey
			let appSecret
			try {
				appKey = secret(row.team_id, scope, 'APP_KEY')
				appSecret = secret(row.team_id, scope, 'APP_SECRET')
			} catch (error) {
				log(`助理「${row.name}」读凭据失败：${error.message}`)
				continue
			}
			if (!appKey || !appSecret) continue
			wanted.set(appKey, { assistantId: row.id, appSecret, name: row.name })
		}

		let stopped = 0
		for (const [clientId, entry] of running) {
			if (wanted.has(clientId)) continue
			entry.stream.stop()
			running.delete(clientId)
			stopped += 1
			log(`已断开 Stream（clientId=${clientId.slice(0, 6)}…）`)
		}

		let connected = 0
		for (const [clientId, want] of wanted) {
			if (running.has(clientId)) continue
			const stream = createDingTalkStream({
				clientId,
				clientSecret: want.appSecret,
				onPayload: (payload) => dispatch(want.assistantId, payload),
				log,
				WebSocketImpl,
				fetchImpl,
			})
			running.set(clientId, { stream, assistantId: want.assistantId })
			stream.start()
			connected += 1
			log(`已为助理「${want.name}」建立 Stream 长连接（clientId=${clientId.slice(0, 6)}…）`)
		}
		return { connected, stopped }
	}

	return {
		reload,
		/** 断开所有连接（进程退出时用）。 */
		stop() {
			for (const entry of running.values()) entry.stream.stop()
			running.clear()
		},
		/** 当前连着的应用数。 */
		get size() {
			return running.size
		},
		/** 每个应用的连接状态，健康检查用。 */
		get states() {
			const out = {}
			for (const [clientId, entry] of running) out[clientId.slice(0, 6)] = entry.stream.state
			return out
		},
	}
}
