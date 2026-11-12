/**
 * 钉钉 OpenAPI 主动发送：让回复不再依赖消息里那条 1.5 小时的 `sessionWebhook`。
 *
 * 为什么要这条路：
 *   - `sessionWebhook` 是「回复这一条消息」的临时地址，1~1.5 小时后失效，
 *     长任务（跑十几分钟、分片多条）很容易在发结果时才发现地址过期；
 *   - Stream 长连接只解决「收」，发必须另找通道。产品级实现都是
 *     「入站走长连接 / 出站走 OpenAPI」这一对，而不是拿临时地址硬撑。
 *
 * 用到的两个接口（都要 `x-acs-dingtalk-access-token`）：
 *   POST /v1.0/oauth2/accessToken              appKey + appSecret → accessToken（7200 秒）
 *   POST /v1.0/robot/groupMessages/send        robotCode + openConversationId + sampleText
 *   POST /v1.0/robot/oToMessages/batchSend     robotCode + userIds + sampleText（单聊）
 *
 * `robotCode` 对自建应用机器人通常就等于 Client ID（AppKey），所以直接用助理的 robot_key；
 * 万一某天不等，接口会回权限/机器人不存在，流水里能看到原始 code，不用猜。
 *
 * @module deploy/orchestrator/dingtalk-openapi
 */
import { shortError } from './assistants.mjs'

/** 换 token 的地址。 */
export const TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken'

/** 群聊发送地址。 */
export const GROUP_SEND_URL = 'https://api.dingtalk.com/v1.0/robot/groupMessages/send'

/** 单聊发送地址。 */
export const SINGLE_SEND_URL = 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend'

/** 文本消息的模板 key。 */
export const TEXT_MSG_KEY = 'sampleText'

/** 提前多久把 token 当过期（秒）。 */
const TOKEN_SKEW_MS = 5 * 60_000

/**
 * 解析钉钉的错误响应。钉钉 4xx 一般回 `{code, message}`，把 code 带出来才好排查。
 *
 * @param {Response} response 响应
 * @param {string} what 动作名
 * @returns {Promise<never>} 一定抛错
 */
async function failWith(response, what) {
	const text = await response.text().catch(() => '')
	let code = ''
	let message = text
	try {
		const body = JSON.parse(text)
		code = body.code || body.errcode || ''
		message = body.message || body.errmsg || text
	} catch {
		// 非 JSON 就把原文截一段
	}
	const error = new Error(`${what}失败 ${response.status}${code ? ` ${code}` : ''}：${shortError(message, 160)}`)
	error.status = response.status
	error.code = code
	throw error
}

/**
 * accessToken 缓存。一个 appKey 一个 token，过期前 5 分钟换新的。
 *
 * 钉钉的 token 有效期 7200 秒，但同一应用重复申请会把旧 token 顶掉；
 * 缓存不只是省一次请求，也是避免「两个助理互相把 token 顶下线」。
 *
 * @param {object} [deps] 依赖
 * @param {typeof fetch} [deps.fetchImpl] fetch 实现（自测注入）
 * @param {() => number} [deps.clock] 时钟
 * @returns {{get:Function,invalidate:Function,get size():number}} 缓存
 */
export function createTokenCache({ fetchImpl = fetch, clock = () => Date.now() } = {}) {
	const cache = new Map()

	/**
	 * 取 token，过期就换。
	 *
	 * @param {string} appKey Client ID
	 * @param {string} appSecret Client Secret
	 * @returns {Promise<string>} accessToken
	 */
	async function get(appKey, appSecret) {
		const hit = cache.get(appKey)
		if (hit && hit.expiresAt - TOKEN_SKEW_MS > clock()) return hit.token
		const response = await fetchImpl(TOKEN_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ appKey, appSecret }),
			signal: AbortSignal.timeout(10_000),
		})
		if (!response.ok) await failWith(response, '获取 accessToken')
		const body = await response.json().catch(() => ({}))
		if (!body.accessToken) throw new Error('获取 accessToken 失败：响应里没有 accessToken')
		const ttl = Number(body.expireIn) > 0 ? Number(body.expireIn) * 1000 : 7200 * 1000
		cache.set(appKey, { token: body.accessToken, expiresAt: clock() + ttl })
		return body.accessToken
	}

	return {
		get,
		/** token 被提前吊销时清掉，让下次重新换。 */
		invalidate(appKey) {
			cache.delete(appKey)
		},
		/** 缓存了几个应用，仅用于观测。 */
		get size() {
			return cache.size
		},
	}
}

/**
 * 发一条群文本消息。
 *
 * @param {object} input 参数
 * @param {string} input.token accessToken
 * @param {string} input.robotCode 机器人编码（自建应用一般 = AppKey）
 * @param {string} input.openConversationId 群会话 id（消息里的 conversationId）
 * @param {string} input.text 正文
 * @param {typeof fetch} [input.fetchImpl] fetch 实现
 * @returns {Promise<{ok:true,processQueryKey?:string}>} 结果
 */
export async function sendGroupText({ token, robotCode, openConversationId, text, fetchImpl = fetch }) {
	if (!openConversationId) throw new Error('发群消息缺少 openConversationId')
	const response = await fetchImpl(GROUP_SEND_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
		body: JSON.stringify({
			robotCode,
			openConversationId,
			msgKey: TEXT_MSG_KEY,
			// 钉钉要求 msgParam 是**字符串**形式的 JSON，直接传对象会被判参数错误
			msgParam: JSON.stringify({ content: text }),
		}),
		signal: AbortSignal.timeout(15_000),
	})
	if (!response.ok) await failWith(response, '发送群消息')
	const body = await response.json().catch(() => ({}))
	return { ok: true, ...(body.processQueryKey ? { processQueryKey: body.processQueryKey } : {}) }
}

/**
 * 发一条单聊文本消息。
 *
 * @param {object} input 参数
 * @param {string} input.token accessToken
 * @param {string} input.robotCode 机器人编码
 * @param {string} input.userId 接收人 staffId（消息里的 senderStaffId）
 * @param {string} input.text 正文
 * @param {typeof fetch} [input.fetchImpl] fetch 实现
 * @returns {Promise<{ok:true,processQueryKey?:string}>} 结果
 */
export async function sendSingleText({ token, robotCode, userId, text, fetchImpl = fetch }) {
	if (!userId) throw new Error('发单聊消息缺少 userId')
	const response = await fetchImpl(SINGLE_SEND_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
		body: JSON.stringify({
			robotCode,
			userIds: [userId],
			msgKey: TEXT_MSG_KEY,
			msgParam: JSON.stringify({ content: text }),
		}),
		signal: AbortSignal.timeout(15_000),
	})
	if (!response.ok) await failWith(response, '发送单聊消息')
	const body = await response.json().catch(() => ({}))
	return { ok: true, ...(body.processQueryKey ? { processQueryKey: body.processQueryKey } : {}) }
}

/**
 * 组合发送器：管 token 缓存，按会话类型选群/单聊接口，401 时换 token 重试一次。
 *
 * @param {object} [deps] 依赖
 * @param {typeof fetch} [deps.fetchImpl] fetch 实现（自测注入）
 * @param {() => number} [deps.clock] 时钟
 * @returns {{send:Function,tokens:object}} 发送器
 */
export function createDingTalkSender({ fetchImpl = fetch, clock = () => Date.now() } = {}) {
	const tokens = createTokenCache({ fetchImpl, clock })

	/**
	 * 发一条消息。
	 *
	 * @param {object} input 参数
	 * @param {string} input.appKey Client ID
	 * @param {string} input.appSecret Client Secret
	 * @param {string} input.robotCode 机器人编码
	 * @param {string} [input.conversationId] 群会话 id
	 * @param {number} [input.conversationType] 1 单聊 / 2 群聊
	 * @param {string} [input.userId] 单聊接收人
	 * @param {string} input.text 正文
	 * @returns {Promise<{ok:true,processQueryKey?:string}>} 结果
	 */
	async function send(input) {
		const { appKey, appSecret, robotCode, conversationId, conversationType, userId, text } = input
		if (!appKey || !appSecret) throw new Error('缺少 Client ID / Client Secret，无法主动发送')
		if (!robotCode) throw new Error('缺少 robotCode，无法主动发送')
		const single = Number(conversationType) === 1
		if (single && !userId) throw new Error('单聊消息缺少 senderStaffId')
		if (!single && !conversationId) throw new Error('群消息缺少 openConversationId')

		const deliver = async () => {
			const token = await tokens.get(appKey, appSecret)
			return single
				? sendSingleText({ token, robotCode, userId, text, fetchImpl })
				: sendGroupText({ token, robotCode, openConversationId: conversationId, text, fetchImpl })
		}

		try {
			return await deliver()
		} catch (error) {
			// 401 才值得重试：token 被别处顶掉是常见情况，参数错重试也没用
			if (error.status === 401) {
				tokens.invalidate(appKey)
				return deliver()
			}
			throw error
		}
	}

	return { send, tokens }
}
