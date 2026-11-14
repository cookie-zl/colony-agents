/**
 * 助理的 HTTP 层：入站回调 + 管理接口 + headless 调用。
 *
 * 单独成文件的原因：console.mjs 已经接近 1900 行，而且入站回调必须排在
 * console-token 校验**之前**（钉钉/飞书不可能带我们的私有头），走自己的验签。
 *
 * 两个容易踩的点：
 *  - 平台回调要求几秒内返回 200，否则重推。所以「验签 + 幂等登记」同步做完就立刻回，
 *    dsh 执行与发消息留在后台（dispatcher.handle 的同步部分正好是登记，第一个 await 才让出）。
 *  - headless --json 的事件流在 stdout，插件日志在 stderr。runtime.mjs 的 run() 会把两者
 *    合并并截断到 4 万字符，首帧 type:'session' 可能丢，所以这里用 spawn 分开收集。
 *
 * @module deploy/orchestrator/assistant-http
 */
import { spawn } from 'node:child_process'
import { REPO } from './store.mjs'
import { dockerEnv } from './runtime.mjs'
import { deleteSecret, getSecret, putSecret } from './secrets.mjs'
import {
	CREDENTIAL_KEYS,
	assistantSecretScope,
	createAssistant,
	createAssistantDispatcher,
	deleteAssistant,
	getAssistant,
	listAssistants,
	listChannels,
	listMessages,
	listThreads,
	resetThread,
	setChannels,
	updateAssistant,
} from './assistants.mjs'
import {
	buildReplyBody,
	normalizeEvent,
	verifyInbound,
} from './assistant-channels.mjs'
import { createDingTalkSender } from './dingtalk-openapi.mjs'

/** 凭据字段名 → team_secrets 里的 key。空值不写，避免把已配的覆盖掉。 */
const SECRET_KEYS = CREDENTIAL_KEYS

/**
 * 跑一次 headless，只收 stdout；超时杀进程并抛带 timeout 字样的错（调度器据此标 timeout）。
 *
 * @param {string[]} args docker exec 参数
 * @param {number} timeoutMs 超时毫秒
 * @returns {Promise<string>} stdout
 */
export function runHeadless(args, timeoutMs) {
	return new Promise((done, fail) => {
		const child = spawn('docker', args, { cwd: REPO, env: dockerEnv() })
		let out = ''
		let err = ''
		child.stdout.on('data', (chunk) => { out += chunk.toString() })
		child.stderr.on('data', (chunk) => { err += chunk.toString() })
		const timer = setTimeout(() => {
			child.kill('SIGKILL')
			fail(new Error(`headless timeout（${timeoutMs}ms）`))
		}, timeoutMs)
		child.once('error', (error) => { clearTimeout(timer); fail(error) })
		child.once('exit', (code) => {
			clearTimeout(timer)
			if (code === 0) return done(out)
			return fail(new Error(`headless 退出码 ${code}：${err.slice(-400)}`))
		})
	})
}

/**
 * 发一条出站消息。控制面在宿主上，请求 IM 公网地址；出错交给调用方记流水。
 *
 * @param {string} url webhook 地址
 * @param {object} body 平台消息体
 * @returns {Promise<{ok:boolean,body?:string}>} 结果
 */
export async function postReply(url, body) {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		// 出站不能无限等：webhook 卡住会一直占着助手的串行队列和全局闸门
		signal: AbortSignal.timeout(10_000),
	})
	const text = await response.text()
	if (!response.ok || /"errcode"\s*:\s*(?!0)\d+/.test(text)) {
		throw new Error(`发送失败 ${response.status}：${text.slice(0, 200)}`)
	}
	return { ok: true, body: text }
}

/** 入站路径：`/assistants/inbound/<platform>`。 */
export function inboundPlatform(pathname) {
	const match = pathname.match(/^\/assistants\/inbound\/(dingtalk|feishu)$/)
	return match ? match[1] : null
}

/** 从原始回调体里抠出机器人标识，用于定位助理。 */
function robotKeyOf(platform, payload) {
	if (platform === 'feishu') return payload?.header?.app_id ?? payload?.app_id ?? ''
	return payload?.robotCode ?? payload?.chatbotCorpId ?? ''
}

/**
 * 创建助理 HTTP 运行时。
 *
 * @param {object} deps 依赖
 * @param {import('node:sqlite').DatabaseSync} deps.db 数据库
 * @param {(res:object,status:number,body:object)=>void} deps.json 响应辅助
 * @param {(req:object,limit?:number)=>Promise<object>} deps.readJson 请求体读取
 * @param {object} [deps.overrides] 自测用的 IO 替换（exec/post/clock 等）
 * @returns {{handleInbound:Function,handleAdmin:Function,dispatcher:object}} 运行时
 */
export function createAssistantRuntime({ db, json, readJson, overrides = {} }) {
	// overrides.secret 只给自测用：默认读库里的加密凭据，测试不建 KEK 也能跑完整链路
	const secret = overrides.secret ?? ((team, scope, key) => getSecret(db, { team, scope, key }))
	/** 统一返回：写完响应并告诉调用方「这条路由已处理」。 */
	const reply = (res, status, body) => { json(res, status, body); return true }

	// 钉钉主动发送：用助理自己的 Client ID / Secret 换 token，不依赖 sessionWebhook
	const sender = overrides.sender ?? createDingTalkSender({ fetchImpl: overrides.fetchImpl })

	const dispatcher = createAssistantDispatcher({
		db,
		exec: overrides.exec ?? runHeadless,
		post: overrides.post ?? postReply,
		secret,
		buildReply: (platform, _url, text, event) => buildReplyBody(platform, text, event),
		/**
		 * 钉钉走 OpenAPI 主动发送。返回 false 表示「这个平台/这条消息没有原生通道」，
		 * 调度器会回落到 sessionWebhook 或助理配置的长期 webhook。
		 */
		sendNative: async (assistant, event, text) => {
			if (assistant.platform !== 'dingtalk') return false
			// 没有群会话 id（模拟消息、测试）就发不了 OpenAPI，交给回落逻辑给出可读的报错
			if (!event.conversationId) return false
			const scope = assistantSecretScope(assistant.id)
			const appKey = secret(assistant.team_id, scope, 'APP_KEY')
			const appSecret = secret(assistant.team_id, scope, 'APP_SECRET')
			if (!appKey || !appSecret) return false
			await sender.send({
				appKey,
				appSecret,
				robotCode: assistant.robot_key,
				conversationId: event.conversationId,
				conversationType: event.conversationType,
				userId: event.senderId,
				text,
			})
			return true
		},
		timeoutMs: overrides.timeoutMs,
		clock: overrides.clock,
	})

	/** 把新建/编辑时提交的凭据写进 team_secrets（只写非空值）。 */
	const saveCredentials = (assistant, credentials) => {
		if (!credentials || typeof credentials !== 'object') return
		const scope = assistantSecretScope(assistant.id)
		for (const [field, key] of Object.entries(SECRET_KEYS)) {
			const value = credentials[field]
			if (typeof value === 'string' && value.trim()) {
				putSecret(db, { team: assistant.team_id, scope, key, value: value.trim() })
			}
		}
	}

	/**
	 * 处理平台入站回调。此路由**不走 console-token**，靠平台自己的签名/token 校验。
	 *
	 * @param {object} req 请求
	 * @param {object} res 响应
	 * @param {'dingtalk'|'feishu'} platform 平台
	 * @returns {Promise<void>}
	 */
	async function handleInbound(req, res, platform) {
		if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
		let payload
		try {
			payload = await readJson(req, 256 * 1024)
		} catch (error) {
			return json(res, 400, { error: `bad body: ${error.message}` })
		}
		const robotKey = robotKeyOf(platform, payload)
		const assistant = db
			.prepare('SELECT * FROM assistants WHERE platform = ? AND robot_key = ?')
			.get(platform, robotKey)
		if (!assistant) return json(res, 404, { error: 'unknown robot' })
		if (!assistant.enabled) return json(res, 200, { ignored: 'assistant disabled' })

		const scope = assistantSecretScope(assistant.id)
		const verdict = verifyInbound(platform, {
			payload,
			headers: req.headers,
			secret: (key) => secret(assistant.team_id, scope, key),
		})
		if (!verdict.ok) return json(res, 401, { error: verdict.reason })
		if (verdict.challenge) return json(res, 200, { challenge: verdict.challenge })

		const event = normalizeEvent(platform, payload)
		if (!event || !event.msgId) return json(res, 200, { ignored: 'non-text or missing msgId' })

		// handle 的同步部分完成「查助理 + 幂等登记 + 入队」；第一个 await 之后才真正跑 dsh。
		// 先拿到 promise 再回 200，既满足平台快速响应，又保证重推时幂等键已经落库。
		const pending = dispatcher.handle(event)
		json(res, 200, { accepted: true, assistantId: assistant.id, msgId: event.msgId })
		pending.catch((error) => console.error(`console: 助理 ${assistant.id} 处理失败：${error.message}`))
	}

	/**
	 * 管理接口（走 console-token）：助理 CRUD、流水、测试发送。
	 *
	 * @param {object} req 请求
	 * @param {object} res 响应
	 * @param {URL} url 已解析的 URL
	 * @returns {Promise<boolean>} 是否处理了（false 表示不是助理路由）
	 */
	async function handleAdmin(req, res, url) {
		const pathname = url.pathname
		if (pathname === '/assistants') {
			if (req.method === 'GET') {
				return reply(res, 200, { assistants: listAssistants(db, String(url.searchParams.get('team') || '')) })
			}
			if (req.method === 'POST') {
				const body = await readJson(req)
				const id = createAssistant(db, {
					team: String(body.team || ''),
					name: String(body.name || '新助理'),
					platform: body.platform,
					robotKey: String(body.robotKey || ''),
					conversationId: body.conversationId || null,
					systemPrompt: body.systemPrompt ?? null,
					by: String(body.by || 'console'),
				})
				// channels 是「多群白名单」，conversationId 只是它的单值简写；两个都传时以数组为准。
				// 字符串（逗号分隔）也收：面板与门户发过来的就是这种形态，setChannels 内部会拆。
				if (body.channels !== undefined) setChannels(db, id, body.channels, String(body.by || 'console'))
				saveCredentials(getAssistant(db, id), body.credentials)
				changed()
				return reply(res, 201, { assistant: getAssistant(db, id) })
			}
		}

		const resetMatch = pathname.match(/^\/assistants\/([^/]+)\/threads\/([^/]+)\/reset$/)
		if (resetMatch && req.method === 'POST') {
			const [, id, threadId] = resetMatch
			if (!getAssistant(db, id)) return reply(res, 404, { error: 'not found' })
			const ok = resetThread(db, threadId)
			return reply(res, ok ? 200 : 404, ok ? { reset: true, threadId } : { error: 'thread not found' })
		}

		const threadsMatch = pathname.match(/^\/assistants\/([^/]+)\/threads$/)
		if (threadsMatch && req.method === 'GET') {
			const [, id] = threadsMatch
			if (!getAssistant(db, id)) return reply(res, 404, { error: 'not found' })
			return reply(res, 200, { threads: listThreads(db, id) })
		}

		const messagesMatch = pathname.match(/^\/assistants\/([^/]+)\/messages$/)
		if (messagesMatch && req.method === 'GET') {
			const [, id] = messagesMatch
			return reply(res, 200, {
				messages: listMessages(db, id, 50, url.searchParams.get('threadId') || null),
			})
		}

		const testMatch = pathname.match(/^\/assistants\/([^/]+)\/test$/)
		if (testMatch && req.method === 'POST') {
			const [, id] = testMatch
			const assistant = getAssistant(db, id)
			if (!assistant) return reply(res, 404, { error: 'not found' })
			const body = await readJson(req)
			// 带 conversationId 就真的发到那个群（走 OpenAPI），不带就只跑 dsh、把结果留在流水里。
			// 测试消息也会落到那个群的线程上——否则「测试」和「群里真问」会聊成两条会话。
			const conversationId =
				String(body.conversationId || '').trim() || listChannels(db, id)[0]?.conversation_id || undefined
			const event = {
				platform: assistant.platform,
				robotKey: assistant.robot_key,
				msgId: `test-${Date.now()}`,
				conversationId,
				conversationType: Number(body.conversationType) || (conversationId ? 2 : undefined),
				senderId: body.userId ? String(body.userId) : undefined,
				text: String(body.text || '你好，请用一句话介绍你自己。'),
				mentioned: true,
				replyUrl: undefined,
			}
			const result = await dispatcher.handle(event)
			reply(res, 200, { result, message: listMessages(db, id, 1)[0] })
			return true
		}

		const baseMatch = pathname.match(/^\/assistants\/([^/]+)$/)
		if (!baseMatch) return false
		const id = baseMatch[1]
		const assistant = getAssistant(db, id)
		if (!assistant) return reply(res, 404, { error: 'not found' })
		if (req.method === 'POST') {
			const body = await readJson(req)
			const updated = updateAssistant(db, id, body)
			saveCredentials(updated, body.credentials)
			changed()
			return reply(res, 200, { assistant: updated })
		}
		if (req.method === 'DELETE') {
			const scope = assistantSecretScope(id)
			for (const key of Object.values(SECRET_KEYS)) {
				deleteSecret(db, { team: assistant.team_id, scope, key })
			}
			const deleted = deleteAssistant(db, id)
			changed()
			return reply(res, 200, { deleted })
		}
		return reply(res, 405, { error: 'method not allowed' })
	}

	const runtime = {
		handleInbound,
		handleAdmin,
		dispatcher,
		/**
		 * 助理增删改之后触发。console 挂上它来重连/断开钉钉 Stream——
		 * 放回调而不是在控制面里挨个插桩，是因为「凭据写没写进去」只有这层知道。
		 *
		 * @type {null|(()=>void)}
		 */
		onChange: null,
	}

	/** 通知外部状态变了。回调炸了不能影响已经写好的数据，所以在这里兜住。 */
	function changed() {
		try {
			runtime.onChange?.()
		} catch (error) {
			console.error(`console: 助理变更回调失败：${error.message}`)
		}
	}

	return runtime
}
