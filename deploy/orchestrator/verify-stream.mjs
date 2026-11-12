/**
 * 钉钉 Stream 入站的离线自测：不联网、不开真 WebSocket、不碰生产库。
 *
 * 重点是三件平台会「默默判死」的事：
 *   - 探活帧的 data 必须原样回传；
 *   - 每帧都要带同一个 messageId 回执；
 *   - disconnect 之后必须换新 ticket 重连（旧 ticket 一次性）。
 *
 * @module deploy/orchestrator/verify-stream
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
	STREAM_GATEWAY,
	STREAM_TOPIC,
	ackFrame,
	classifyFrame,
	createDingTalkStream,
	createStreamManager,
	openConnection,
	streamUrl,
} from './assistant-stream.mjs'
import { createAssistant, createAssistantDispatcher } from './assistants.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const db = new DatabaseSync(':memory:')
db.exec(readFileSync(resolve(HERE, 'init-db.sql'), 'utf8'))

let passed = 0
let failed = 0
const check = (name, ok, detail = '') => {
	if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
	else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)
/** 让出事件循环，等 connect() 里的 await fetch 落定。 */
const flush = () => new Promise((done) => setImmediate(done))

/** 假 WebSocket：记录 URL、手动触发 open/message/close，回执进 sent。 */
class FakeSocket {
	static instances = []
	constructor(url) {
		this.url = url
		this.readyState = 0
		this.listeners = {}
		this.sent = []
		FakeSocket.instances.push(this)
	}
	addEventListener(type, fn) {
		;(this.listeners[type] ||= []).push(fn)
	}
	emit(type, event = {}) {
		for (const fn of this.listeners[type] || []) fn(event)
	}
	open() {
		this.readyState = 1
		this.emit('open')
	}
	message(frame) {
		this.emit('message', { data: typeof frame === 'string' ? frame : JSON.stringify(frame) })
	}
	send(text) {
		this.sent.push(text)
	}
	close() {
		if (this.readyState === 3) return
		this.readyState = 3
		this.emit('close')
	}
}

/** 假网关：固定返回 endpoint/ticket，并记录调用次数与请求体。 */
function fakeGateway({ fail = false, body = {} } = {}) {
	const calls = []
	const impl = async (url, init) => {
		calls.push({ url, body: JSON.parse(init.body) })
		if (fail) return new Response('{"code":"InvalidAuthentication"}', { status: 401 })
		return new Response(JSON.stringify({ endpoint: 'wss://wss-open.example.com:443/connect', ticket: `t-${calls.length}`, ...body }), { status: 200 })
	}
	impl.calls = calls
	return impl
}

const pingFrame = (messageId = 'm-ping', opaque = '{"opaque":"abc123"}') => ({
	specVersion: '1.0',
	type: 'SYSTEM',
	headers: { topic: 'ping', messageId, contentType: 'application/json', time: '1700000000000' },
	data: opaque,
})

const botFrame = (messageId = 'm-msg') => ({
	specVersion: '1.0',
	type: 'CALLBACK',
	headers: { topic: STREAM_TOPIC, messageId, contentType: 'application/json' },
	data: JSON.stringify({
		msgId: 'msg-stream-1',
		robotCode: 'dingexample0000000001',
		conversationId: 'cid-stream',
		senderStaffId: 'staff-1',
		senderNick: '张三',
		isInAtList: true,
		atUsers: [{ dingtalkId: '$:LWCP:bot' }],
		text: { content: ' @日报助理 昨天花了多少' },
		sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=x',
	}),
})

console.log('Stream 地址与网关')
eq('ticket 拼在 query 上', streamUrl('wss://x/connect', 'a b'), 'wss://x/connect?ticket=a%20b')
eq('endpoint 自带 query 时丢掉旧参数', streamUrl('wss://x/connect?foo=1', 't'), 'wss://x/connect?ticket=t')

{
	const gateway = fakeGateway()
	const opened = await openConnection({ clientId: 'key-1', clientSecret: 'sec-1', fetchImpl: gateway })
	eq('返回 endpoint', opened.endpoint, 'wss://wss-open.example.com:443/connect')
	eq('返回 ticket', opened.ticket, 't-1')
	eq('打的是网关地址', gateway.calls[0].url, STREAM_GATEWAY)
	eq('同时订阅事件与机器人回调', gateway.calls[0].body.subscriptions, [
		{ type: 'EVENT', topic: '*' },
		{ type: 'CALLBACK', topic: STREAM_TOPIC },
	])
	eq('带上 clientId', gateway.calls[0].body.clientId, 'key-1')
	check('带上 clientSecret', gateway.calls[0].body.clientSecret === 'sec-1')
	check('ua 不是空', typeof gateway.calls[0].body.ua === 'string' && gateway.calls[0].body.ua.length > 0)
}

{
	let message = ''
	try {
		await openConnection({ clientId: '', clientSecret: 'x', fetchImpl: fakeGateway() })
	} catch (error) {
		message = error.message
	}
	check('缺 clientId 直接抛错', /Client ID/.test(message), message)
}

{
	let message = ''
	try {
		await openConnection({ clientId: 'k', clientSecret: 's', fetchImpl: fakeGateway({ fail: true }) })
	} catch (error) {
		message = error.message
	}
	check('网关 4xx 抛错并带状态码', /401/.test(message), message)
}

{
	let message = ''
	try {
		await openConnection({ clientId: 'k', clientSecret: 's', fetchImpl: fakeGateway({ body: { endpoint: '' } }) })
	} catch (error) {
		message = error.message
	}
	check('缺 ticket 视为失败', /endpoint|ticket/.test(message), message)
}

console.log('\n帧分类与回执')
eq('ping 帧', classifyFrame(pingFrame()).kind, 'ping')
eq('disconnect 帧', classifyFrame({ type: 'SYSTEM', headers: { topic: 'disconnect', messageId: 'd1' } }).kind, 'disconnect')
eq('回调帧', classifyFrame(botFrame()).kind, 'callback')
eq('事件帧', classifyFrame({ type: 'EVENT', headers: { topic: '*' } }).kind, 'event')
eq('未知帧', classifyFrame({ type: 'WHAT', headers: {} }).kind, 'unknown')
eq('回调帧 data 已解析', classifyFrame(botFrame()).payload.msgId, 'msg-stream-1')
eq('坏 data 不炸', classifyFrame({ type: 'CALLBACK', headers: {}, data: 'not-json' }).payload, undefined)

{
	const ack = JSON.parse(ackFrame('m-1', { response: {} }))
	eq('回执 code=200', ack.code, 200)
	eq('回执带回 messageId', ack.headers.messageId, 'm-1')
	eq('回执 contentType 固定', ack.headers.contentType, 'application/json')
	eq('回执 data 是 JSON 字符串', ack.data, '{"response":{}}')
	const pingAck = JSON.parse(ackFrame('m-2', '{"opaque":"abc"}'))
	eq('探活回执原样回传', pingAck.data, '{"opaque":"abc"}')
}

console.log('\n长连接生命周期')
{
	FakeSocket.instances = []
	const gateway = fakeGateway()
	const got = []
	const stream = createDingTalkStream({
		clientId: 'dingexample0000',
		clientSecret: 'sec',
		fetchImpl: gateway,
		WebSocketImpl: FakeSocket,
		onPayload: (payload) => got.push(payload),
	})
	stream.start()
	await flush()
	eq('启动后建了一条连接', FakeSocket.instances.length, 1)
	eq('连的是网关给的地址', FakeSocket.instances[0].url, 'wss://wss-open.example.com:443/connect?ticket=t-1')
	const socket = FakeSocket.instances[0]
	socket.open()
	eq('状态 connected', stream.state, 'connected')

	// 未 open 前回执会被丢掉（readyState 不是 1），这里 open 之后再喂
	socket.message(pingFrame('m-ping', '{"opaque":"o1"}'))
	const pingAck = JSON.parse(socket.sent.at(-1))
	eq('探活回执 messageId 一致', pingAck.headers.messageId, 'm-ping')
	eq('探活回执 data 字节一致', pingAck.data, '{"opaque":"o1"}')

	socket.message(botFrame('m-bot'))
	const botAck = JSON.parse(socket.sent.at(-1))
	eq('消息帧先回执', botAck.headers.messageId, 'm-bot')
	await flush()
	eq('回调交给了业务层', got.length, 1)
	eq('业务拿到的是解析后的 payload', got[0]?.conversationId, 'cid-stream')

	const before = gateway.calls.length
	socket.message({ type: 'SYSTEM', headers: { topic: 'disconnect', messageId: 'm-d' } })
	await flush()
	eq('disconnect 立刻换新 ticket 重连', gateway.calls.length, before + 1)
	eq('新建了连接', FakeSocket.instances.length, 2)
	eq('新连接用新 ticket', FakeSocket.instances[1].url.includes('ticket=t-2'), true)

	stream.stop()
	eq('stop 之后状态 stopped', stream.state, 'stopped')
	const afterStop = FakeSocket.instances.length
	FakeSocket.instances[1].open()
	FakeSocket.instances[1].close()
	await flush()
	eq('stop 之后 close 不再重连', FakeSocket.instances.length, afterStop)
}

console.log('\nmanager：按 clientId 去重')
{
	db.exec('DELETE FROM assistants')
	db.exec('DELETE FROM team_secrets')
	FakeSocket.instances = []
	const secrets = new Map()
	const secret = (team, scope, key) => secrets.get(`${team}|${scope}|${key}`)
	const dispatcher = createAssistantDispatcher({
		db,
		exec: async () => '',
		post: async () => ({ ok: true }),
		secret,
		clock: () => 0,
	})
	const manager = createStreamManager({ db, dispatcher, secret, log: () => {}, WebSocketImpl: FakeSocket, fetchImpl: fakeGateway() })

	await manager.reload()
	eq('没有助理就不连', manager.size, 0)

	const id = createAssistant(db, { team: 'team-a', name: '日报助理', platform: 'dingtalk', robotKey: 'dingexample0000000001', by: 'test' })
	secrets.set(`team-a|assistant:${id}|APP_KEY`, 'dingexample0000000001')
	secrets.set(`team-a|assistant:${id}|APP_SECRET`, 'sec-1')
	await manager.reload()
	await flush()
	eq('配好凭据就连上', manager.size, 1)
	eq('建了一条长连接', FakeSocket.instances.length, 1)
	eq('还没握手时状态是 connecting', manager.states['dingexample0000000001'.slice(0, 6)], 'connecting')

	await manager.reload()
	eq('重复 reload 不会重复连', FakeSocket.instances.length, 1)

	// 消息从长连接进来：robotCode 与助理不一致时用 clientId 兜底
	const socket = FakeSocket.instances[0]
	socket.open()
	socket.message(botFrame('m-1'))
	await flush()
	const row = db.prepare('SELECT * FROM assistant_messages WHERE msg_id = ?').get('msg-stream-1')
	check('消息落进了流水', Boolean(row), '没找到流水')
	eq('流水挂在正确的助理上', row?.assistant_id, id)

	db.prepare('UPDATE assistants SET enabled = 0 WHERE id = ?').run(id)
	await manager.reload()
	eq('停用后断开连接', manager.size, 0)

	db.prepare('UPDATE assistants SET enabled = 1 WHERE id = ?').run(id)
	secrets.delete(`team-a|assistant:${id}|APP_SECRET`)
	await manager.reload()
	eq('凭据被删就不连', manager.size, 0)

	manager.stop()
}

console.log(`\n${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
