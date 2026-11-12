/**
 * 钉钉 / 飞书入站事件适配层。
 *
 * 本轮只做「被 @ 才处理」：两个平台默认都只把 @ 机器人的消息推给应用，
 * 这里再显式判一次 mentioned，保证非 @ 消息绝不会进 dsh（将来开全量权限也不会误触发）。
 *
 * 出站统一走各自的自定义群机器人 webhook（单向 POST），不依赖 OpenAPI 的 tenant token，
 * 这样两个平台在调度器里是同一套接口：拿到一个 URL，POST 一个 body。
 *
 * @module deploy/orchestrator/assistant-channels
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { cleanMention } from './assistants.mjs'

/** 平台标识。新增平台时先在这里登记，再补一个 normalize 函数。 */
export const PLATFORMS = ['dingtalk', 'feishu']

/**
 * 常量时间比较，防时序侧信道。
 *
 * @param {string} a 待比较值
 * @param {string} b 期望值
 * @returns {boolean} 是否相等
 */
function safeEqual(a, b) {
	const left = Buffer.from(String(a ?? ''))
	const right = Buffer.from(String(b ?? ''))
	if (left.length !== right.length) return false
	return timingSafeEqual(left, right)
}

/**
 * 校验钉钉 HTTP 回调加签。stringToSign = timestamp + "\n" + secret。
 * Stream 模式由 SDK 自己做鉴权，不经过这里。
 *
 * @param {{timestamp?:string,sign?:string,secret?:string}} input 请求头与加签密钥
 * @returns {boolean} 签名是否有效
 */
export function verifyDingTalkSign({ timestamp, sign, secret }) {
	if (!timestamp || !sign || !secret) return false
	const expected = createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64')
	return safeEqual(sign, expected)
}

/**
 * 校验飞书事件的 Verification Token。
 *
 * @param {object} payload 事件体（v2.0 时 token 在 header 里）
 * @param {string} token 开放平台配置的 Verification Token
 * @returns {boolean} 是否匹配
 */
export function verifyFeishuToken(payload, token) {
	if (!token) return false
	return safeEqual(payload?.header?.token ?? payload?.token, token)
}

/**
 * 飞书 URL 校验：配置事件订阅地址时平台会发一次 challenge，必须原样回。
 *
 * @param {object} payload 请求体
 * @returns {string|undefined} challenge 值；不是校验请求时返回 undefined
 */
export function feishuChallenge(payload) {
	if (payload?.type !== 'url_verification') return undefined
	return payload.challenge
}

/**
 * 把钉钉机器人回调归一化成统一事件。
 *
 * @param {object} payload 钉钉原始回调体
 * @returns {object|undefined} 归一化事件；非文本消息返回 undefined
 */
export function normalizeDingTalkEvent(payload) {
	if (!payload || typeof payload !== 'object') return undefined
	const rawText = payload?.text?.content
	if (typeof rawText !== 'string') return undefined
	const atNames = (payload.atUsers ?? []).map((u) => u?.dingtalkId).filter(Boolean)
	const mentioned = payload.isInAtList === true || (payload.atUsers ?? []).length > 0
	return {
		platform: 'dingtalk',
		msgId: payload.msgId ?? '',
		robotKey: payload.robotCode ?? payload.chatbotCorpId ?? '',
		conversationId: payload.conversationId ?? undefined,
		// 1=单聊 / 2=群聊：排查「回复到底回哪儿了」时，光有 cid 看不出会话类型
		conversationType: Number(payload.conversationType) || undefined,
		senderId: payload.senderStaffId ?? payload.senderId ?? undefined,
		senderName: payload.senderNick ?? undefined,
		rawText,
		text: cleanMention(rawText, atNames),
		mentioned,
		// sessionWebhook 有过期时间，长任务跑完可能失效；调度器会在缺失时回落到配置的长期 webhook
		replyUrl: payload.sessionWebhook ?? undefined,
		replyUrlExpiresAt: payload.sessionWebhookExpiredTime ?? undefined,
	}
}

/**
 * 把飞书 im.message.receive_v1 事件归一化成统一事件。
 * content 是**双重序列化**的 JSON 字符串（"{"text":"..."}"），必须先 parse。
 *
 * @param {object} payload 飞书原始回调体
 * @returns {object|undefined} 归一化事件；非消息事件 / 机器人发的 / 非文本都返回 undefined
 */
export function normalizeFeishuEvent(payload) {
	if (!payload || typeof payload !== 'object') return undefined
	if (payload.header?.event_type && payload.header.event_type !== 'im.message.receive_v1') return undefined
	const message = payload.event?.message
	if (!message || message.message_type !== 'text') return undefined
	// 防机器人互聊死循环：自己发的、或其它机器人发的都不处理
	if (payload.event?.sender?.sender_type === 'bot') return undefined
	let content
	try { content = JSON.parse(message.content) } catch { return undefined }
	const rawText = content?.text
	if (typeof rawText !== 'string') return undefined
	const mentions = message.mentions ?? []
	const hints = mentions.flatMap((m) => [m?.key, m?.name]).filter(Boolean)
	return {
		platform: 'feishu',
		// 官方明确：幂等用 message_id，不要依赖 event_id
		msgId: message.message_id ?? '',
		robotKey: payload.header?.app_id ?? '',
		conversationId: message.chat_id ?? undefined,
		senderId: payload.event?.sender?.sender_id?.open_id ?? undefined,
		rawText,
		text: cleanMention(rawText, hints),
		mentioned: mentions.length > 0,
		replyUrl: undefined,
		replyMessageId: message.message_id ?? undefined,
	}
}

/**
 * 按平台归一化入站事件。
 *
 * @param {'dingtalk'|'feishu'} platform 平台
 * @param {object} payload 原始回调体
 * @returns {object|undefined} 归一化事件
 */
export function normalizeEvent(platform, payload) {
	if (platform === 'dingtalk') return normalizeDingTalkEvent(payload)
	if (platform === 'feishu') return normalizeFeishuEvent(payload)
	return undefined
}

/**
 * 组装出站消息体。两个平台都用自定义群机器人 webhook 的 text 格式。
 *
 * @param {'dingtalk'|'feishu'} platform 平台
 * @param {string} text 本片文本
 * @param {object} event 归一化事件（用于 @ 回提问者）
 * @returns {object} 待 POST 的 JSON body
 */
export function buildReplyBody(platform, text, event = {}) {
	if (platform === 'dingtalk') {
		return {
			msgtype: 'text',
			text: { content: text },
			...(event.senderId ? { at: { atUserIds: [event.senderId] } } : {}),
		}
	}
	const mention = event.senderId ? `<at user_id="${event.senderId}"></at> ` : ''
	return { msg_type: 'text', content: { text: `${mention}${text}` } }
}

/**
 * 校验入站请求的合法性。钉钉验加签，飞书验 token；密钥没配时一律拒绝（不放空）。
 *
 * @param {'dingtalk'|'feishu'} platform 平台
 * @param {{payload:object,headers:object,secret:(key:string)=>string|undefined}} input 请求与取密钥函数
 * @returns {{ok:boolean,reason?:string,challenge?:string}} 校验结果
 */
export function verifyInbound(platform, { payload, headers = {}, secret }) {
	if (platform === 'feishu') {
		if (!verifyFeishuToken(payload, secret('VERIFY_TOKEN'))) {
			return { ok: false, reason: 'feishu verification token 不匹配（或没配 VERIFY_TOKEN）' }
		}
		const challenge = feishuChallenge(payload)
		return challenge ? { ok: true, challenge } : { ok: true }
	}
	const ok = verifyDingTalkSign({
		timestamp: headers.timestamp ?? headers['x-dingtalk-timestamp'],
		sign: headers.sign ?? headers['x-dingtalk-sign'],
		secret: secret('SIGN_SECRET'),
	})
	return ok ? { ok: true } : { ok: false, reason: 'dingtalk 签名校验失败（或没配 SIGN_SECRET）' }
}
