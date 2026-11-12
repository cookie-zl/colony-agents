/**
 * 钉钉 OpenAPI 主动发送的离线自测：不联网、不发真实消息。
 *
 * 重点：
 *   - token 必须缓存（同一应用重复申请会把旧 token 顶掉）；
 *   - `msgParam` 必须是**字符串**形式的 JSON，传对象会被钉钉判参数错误；
 *   - 群聊走 openConversationId、单聊走 userIds，别走错接口；
 *   - 401 时换 token 重试一次，其它 4xx 不重试。
 *
 * @module deploy/orchestrator/verify-openapi
 */
import {
	GROUP_SEND_URL,
	SINGLE_SEND_URL,
	TOKEN_URL,
	createDingTalkSender,
	createTokenCache,
	sendGroupText,
	sendSingleText,
} from './dingtalk-openapi.mjs'

let passed = 0
let failed = 0
const check = (name, ok, detail = '') => {
	if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
	else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** 记录调用的假 fetch；`groupStatus` 可以让群发送第一次返回 401。 */
function fakeFetch({ groupStatus = 200, tokenError = false } = {}) {
	const calls = []
	let groupCalls = 0
	const impl = async (url, init) => {
		calls.push({ url, headers: init.headers, body: JSON.parse(init.body) })
		if (url === TOKEN_URL) {
			if (tokenError) return json({ code: 'InvalidAuthentication', message: 'bad secret' }, 401)
			return json({ accessToken: `tok-${calls.filter((c) => c.url === TOKEN_URL).length}`, expireIn: 7200 })
		}
		if (url === GROUP_SEND_URL) {
			groupCalls += 1
			if (groupStatus === 401 && groupCalls === 1) return json({ code: 'InvalidAuthentication' }, 401)
			return json({ processQueryKey: 'pq-group' })
		}
		if (url === SINGLE_SEND_URL) return json({ processQueryKey: 'pq-single' })
		return json({ code: 'NotFound' }, 404)
	}
	impl.calls = calls
	return impl
}

console.log('token 缓存')
{
	const f = fakeFetch()
	const cache = createTokenCache({ fetchImpl: f })
	const a = await cache.get('key-1', 'sec-1')
	const b = await cache.get('key-1', 'sec-1')
	eq('同一应用复用 token', a === b, true)
	eq('只请求了一次 token 接口', f.calls.filter((c) => c.url === TOKEN_URL).length, 1)
	eq('请求体是 appKey/appSecret', f.calls[0].body, { appKey: 'key-1', appSecret: 'sec-1' })
	await cache.get('key-2', 'sec-2')
	eq('不同应用各自换 token', f.calls.filter((c) => c.url === TOKEN_URL).length, 2)

	const failing = fakeFetch({ tokenError: true })
	let message = ''
	try {
		await createTokenCache({ fetchImpl: failing }).get('k', 's')
	} catch (error) {
		message = error.message
	}
	check('换 token 失败抛错并带 code', /401/.test(message) && /InvalidAuthentication/.test(message), message)
}

console.log('\n发消息参数')
{
	const f = fakeFetch()
	await sendGroupText({ token: 't', robotCode: 'robot-1', openConversationId: 'cid-1', text: '你好', fetchImpl: f })
	const call = f.calls[0]
	eq('打到群发送接口', call.url, GROUP_SEND_URL)
	eq('带上 access token 头', call.headers['x-acs-dingtalk-access-token'], 't')
	eq('msgKey 是 sampleText', call.body.msgKey, 'sampleText')
	eq('robotCode 透传', call.body.robotCode, 'robot-1')
	eq('openConversationId 透传', call.body.openConversationId, 'cid-1')
	check('msgParam 是字符串形式的 JSON', typeof call.body.msgParam === 'string')
	eq('msgParam 解析后带 content', JSON.parse(call.body.msgParam), { content: '你好' })

	const single = fakeFetch()
	await sendSingleText({ token: 't', robotCode: 'robot-1', userId: 'staff-9', text: '单聊', fetchImpl: single })
	eq('单聊打到 batchSend', single.calls[0].url, SINGLE_SEND_URL)
	eq('单聊用 userIds 数组', single.calls[0].body.userIds, ['staff-9'])
	check('单聊也带内容', JSON.parse(single.calls[0].body.msgParam).content === '单聊')

	let message = ''
	try {
		await sendGroupText({ token: 't', robotCode: 'r', openConversationId: '', text: 'x', fetchImpl: fakeFetch() })
	} catch (error) {
		message = error.message
	}
	check('缺群 id 直接抛错', /openConversationId/.test(message), message)
}

console.log('\n发送器：按会话类型分流 + 401 重试')
{
	const f = fakeFetch()
	const sender = createDingTalkSender({ fetchImpl: f })
	await sender.send({ appKey: 'k', appSecret: 's', robotCode: 'r', conversationId: 'cid-9', conversationType: 2, text: '群' })
	await sender.send({ appKey: 'k', appSecret: 's', robotCode: 'r', conversationType: 1, userId: 'staff-1', text: '单聊' })
	eq('群聊只调群接口', f.calls.filter((c) => c.url === GROUP_SEND_URL).length, 1)
	eq('单聊只调单聊接口', f.calls.filter((c) => c.url === SINGLE_SEND_URL).length, 1)
	eq('两次发送共用一次 token', f.calls.filter((c) => c.url === TOKEN_URL).length, 1)
}

{
	const f = fakeFetch({ groupStatus: 401 })
	const sender = createDingTalkSender({ fetchImpl: f })
	const result = await sender.send({ appKey: 'k', appSecret: 's', robotCode: 'r', conversationId: 'cid-9', text: '重试' })
	eq('401 后重试成功', result.ok, true)
	eq('重新换了 token', f.calls.filter((c) => c.url === TOKEN_URL).length, 2)
	eq('群接口被调两次', f.calls.filter((c) => c.url === GROUP_SEND_URL).length, 2)
}

{
	let message = ''
	try {
		await createDingTalkSender({ fetchImpl: fakeFetch() }).send({ appKey: '', appSecret: '', robotCode: 'r', conversationId: 'c', text: 'x' })
	} catch (error) {
		message = error.message
	}
	check('缺凭据直接抛错', /Client ID/.test(message), message)
}

console.log(`\n${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
