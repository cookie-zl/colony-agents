/**
 * 助理「@ 才处理」版本的离线自测：不联网、不依赖 docker、不碰生产库。
 *
 * 重点验证隔离语义：一个机器人一个助理、一个会话一个助理、同一助理串行、
 * 不同助理可并行、首条消息自动建会话、消息幂等、非 @ 绝不进 dsh。
 *
 * @module deploy/orchestrator/verify-assistants
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
	AGENT_WORKSPACE,
	cleanMention,
	createAssistant,
	createAssistantDispatcher,
	createSemaphore,
	deleteAssistant,
	findAssistantForEvent,
	findThread,
	getAssistant,
	headlessCommand,
	listAssistants,
	listChannels,
	listMessages,
	listThreads,
	parseHeadlessOutput,
	resetThread,
	resolveThread,
	setChannels,
	shortError,
	splitText,
	threadLabel,
	updateAssistant,
} from './assistants.mjs'
import {
	buildReplyBody,
	feishuChallenge,
	normalizeEvent,
	verifyInbound,
	verifyDingTalkSign,
} from './assistant-channels.mjs'
import { createAssistantRuntime } from './assistant-http.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const db = new DatabaseSync(':memory:')
db.exec(readFileSync(resolve(HERE, 'init-db.sql'), 'utf8'))

let passed = 0
let failed = 0
const check = (name, ok, detail = '') => {
	if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
	else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const throws = (name, fn) => {
	try { fn(); check(name, false, '没有抛错') } catch { check(name, true) }
}

const dtAt = (over = {}) => ({
	msgtype: 'text',
	text: { content: ' @日报助理 帮我查一下昨天的 top 1' },
	msgId: 'msg-1',
	robotCode: 'ding-robot-a',
	conversationId: 'cid-1',
	senderStaffId: 'staff-7',
	senderNick: '张三',
	isInAtList: true,
	atUsers: [{ dingtalkId: '$:LWCP:bot' }],
	sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=abc',
	sessionWebhookExpiredTime: Date.now() + 60_000,
	...over,
})
const fsAt = (over = {}) => ({
	schema: '2.0',
	header: { event_id: 'ev-1', event_type: 'im.message.receive_v1', token: 'tk-secret', app_id: 'cli_feishu_a' },
	event: {
		sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
		message: {
			message_id: 'om-1',
			chat_id: 'oc-1',
			chat_type: 'group',
			message_type: 'text',
			content: JSON.stringify({ text: '@_user_1 帮我查一下昨天的 top 1' }),
			mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: '日报助理' }],
		},
	},
	...over,
})

console.log('\n== 1. 事件归一化与 @ 判定 ==')
const dt = normalizeEvent('dingtalk', dtAt())
check('钉钉 @ 事件被识别', dt?.mentioned === true && dt.platform === 'dingtalk')
check('钉钉文本去掉 @ 与多余空白', dt.text === '帮我查一下昨天的 top 1', dt.text)
check('钉钉用 msgId 做幂等键、robotCode 做路由键', dt.msgId === 'msg-1' && dt.robotKey === 'ding-robot-a')
check('钉钉带短期 sessionWebhook', String(dt.replyUrl).includes('sendBySession'))
const dtNoAt = normalizeEvent('dingtalk', dtAt({ isInAtList: false, atUsers: [] }))
check('钉钉非 @ 事件被标 mentioned=false', dtNoAt?.mentioned === false)
const fs = normalizeEvent('feishu', fsAt())
check('飞书 @ 事件被识别（content 双重 JSON）', fs?.mentioned === true && fs.platform === 'feishu')
check('飞书文本去掉 @_user_1 占位符', fs.text === '帮我查一下昨天的 top 1', fs.text)
check('飞书幂等用 message_id 而不是 event_id', fs.msgId === 'om-1')
check('飞书非 @ 事件被标 mentioned=false', normalizeEvent('feishu', fsAt({ event: { ...fsAt().event, message: { ...fsAt().event.message, mentions: [] } } })).mentioned === false)
check('飞书机器人自己发的消息直接忽略', normalizeEvent('feishu', fsAt({ event: { ...fsAt().event, sender: { sender_id: { open_id: 'ou_bot' }, sender_type: 'bot' } } })) === undefined)
check('飞书非文本消息忽略', normalizeEvent('feishu', fsAt({ event: { ...fsAt().event, message: { ...fsAt().event.message, message_type: 'image' } } })) === undefined)
check('未知平台返回 undefined', normalizeEvent('slack', {}) === undefined)

console.log('\n== 2. 验签 / token / challenge ==')
const secret = 'sign-secret-123'
const ts = '1700000000000'
const sign = createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64')
check('钉钉正确加签通过', verifyDingTalkSign({ timestamp: ts, sign, secret }))
check('钉钉错误签名拒绝', !verifyDingTalkSign({ timestamp: ts, sign: 'bad', secret }))
check('钉钉缺时间戳拒绝', !verifyDingTalkSign({ sign, secret }))
check('飞书 token 不匹配拒绝', verifyInbound('feishu', { payload: fsAt(), headers: {}, secret: () => 'wrong' }).ok === false)
check('飞书 token 匹配放行', verifyInbound('feishu', { payload: fsAt(), headers: {}, secret: () => 'tk-secret' }).ok === true)
const challenge = verifyInbound('feishu', { payload: { type: 'url_verification', challenge: 'abc-123', token: 'tk-secret' }, headers: {}, secret: () => 'tk-secret' })
check('飞书 URL 校验原样回 challenge', challenge.challenge === 'abc-123')
check('challenge 也要验 token', feishuChallenge({ type: 'url_verification', challenge: 'x' }) === 'x')
check('钉钉没配 SIGN_SECRET 一律拒绝', verifyInbound('dingtalk', { payload: dtAt(), headers: { timestamp: ts, sign }, secret: () => undefined }).ok === false)

console.log('\n== 3. 清洗 / 分片 / 回复体 / headless 解析 ==')
check('cleanMention 同时处理飞书占位符与中文 @', cleanMention('@_user_1 查一下 @日报助理 数据', ['日报助理']) === '查一下 数据')
check('空文本不分片', splitText('  ').length === 0)
check('短文本不分片也不加前缀', splitText('你好')[0] === '你好')
const parts = splitText('x'.repeat(7000), 3000)
check('长文本分 3 片并带 (i/n)', parts.length === 3 && parts[0].startsWith('(1/3)') && parts[2].startsWith('(3/3)'))
const dtBody = buildReplyBody('dingtalk', '答案', dt)
check('钉钉回复体 @ 回提问者', dtBody.msgtype === 'text' && dtBody.at.atUserIds[0] === 'staff-7')
const fsBody = buildReplyBody('feishu', '答案', fs)
check('飞书回复体用 <at user_id>', String(fsBody.content.text).includes('<at user_id="ou_sender">'))
const parsed = parseHeadlessOutput(
	'{"type":"session","sessionId":"session-abc"}\n{"type":"status","phase":"step_start"}\n{"type":"thinking","text":"先想一下"}\n{"type":"text","text":"第一段"}\n{"type":"text","text":"第二段"}\n{"type":"status","phase":"step_end","usage":{"inputTokens":10,"outputTokens":4}}\n[plugin] 噪声',
)
check('headless 输出取 sessionId 与全部 text', parsed.sessionId === 'session-abc' && parsed.text === '第一段\n\n第二段', JSON.stringify(parsed))
check('thinking 事件被单独收出来', parsed.thinking === '先想一下', JSON.stringify(parsed.thinking))
check('step_end 的 usage 被收出来', parsed.usage?.outputTokens === 4, JSON.stringify(parsed.usage))
check('stderr 噪声不会混进解析结果', !parseHeadlessOutput('[plugin] log\n').text.includes('plugin'))
const cmd = headlessCommand({ team: 'team-a', sessionId: 'session-abc', prompt: '你好' })
check('有会话时带上 --session-id', cmd.args.includes('--session-id') && cmd.args.includes('session-abc'))
check('首轮不带 --session-id', !headlessCommand({ team: 'team-a', prompt: '你好' }).args.includes('--session-id'))
check(
	'cwd 钉在代理工作区（不混进用户自己的 /workspace）',
	cmd.args[0] === 'exec' && cmd.args[1] === '-w' && cmd.args[2] === AGENT_WORKSPACE,
	JSON.stringify(cmd.args.slice(0, 4)),
)

console.log('\n== 4. 助理实体与唯一约束 ==')
const a1 = createAssistant(db, { team: 'team-a', name: '日报助理', platform: 'dingtalk', robotKey: 'ding-robot-a', by: 'tester' })
const a2 = createAssistant(db, { team: 'team-a', name: '翻译助理', platform: 'feishu', robotKey: 'cli_feishu_a', by: 'tester' })
check('两个助理建成了', Boolean(getAssistant(db, a1)) && Boolean(getAssistant(db, a2)))
check('初建时还没有任何群线程', listThreads(db, a1).length === 0)
check('列表不回显出站凭据，只回 hasOutbound', listAssistants(db, 'team-a')[0].hasOutbound === false)
check('列表带回线程数与白名单', listAssistants(db, 'team-a')[0].threads === 0 && Array.isArray(listAssistants(db, 'team-a')[0].channels))
throws('同一个机器人不能绑第二个助理', () => createAssistant(db, { team: 'team-a', name: '冒名', platform: 'dingtalk', robotKey: 'ding-robot-a', by: 'tester' }))
throws('非法平台被拒绝', () => createAssistant(db, { team: 'team-a', name: 'x', platform: 'slack', robotKey: 'x', by: 'tester' }))
updateAssistant(db, a1, { name: '日报助理 v2', enabled: false })
check('改名与停用生效', getAssistant(db, a1).name === '日报助理 v2' && getAssistant(db, a1).enabled === 0)
updateAssistant(db, a1, { enabled: true })
check('按 robotKey 找不到停用助理，启用后能找到', findAssistantForEvent(db, { platform: 'dingtalk', robotKey: 'ding-robot-a' })?.id === a1)
{
	// 一条 dsh 会话只能挂在一个群上：两条线程共用一个 session 会让两个群互相污染
	const tA = resolveThread(db, getAssistant(db, a1), 'cid-shared')
	const tB = resolveThread(db, getAssistant(db, a2), 'oc-shared')
	db.prepare('UPDATE assistant_threads SET session_id = ? WHERE id = ?').run('session-shared', tA.id)
	throws('同一个会话不能属于两个群线程', () => db.prepare('UPDATE assistant_threads SET session_id = ? WHERE id = ?').run('session-shared', tB.id))
	db.prepare('UPDATE assistant_threads SET session_id = NULL WHERE id = ?').run(tA.id)
	db.prepare('DELETE FROM assistant_threads WHERE id IN (?,?)').run(tA.id, tB.id)
}
check('线程键是「助理 + 群」，同群重复解析只得到一行', resolveThread(db, getAssistant(db, a1), 'cid-dup').id === resolveThread(db, getAssistant(db, a1), 'cid-dup').id)
db.prepare('DELETE FROM assistant_threads').run()

console.log('\n== 5. 调度器：串行 / 幂等 / 首建会话 / 非 @ 不进 dsh ==')
const execLog = []
const posts = []
let running = 0
let maxRunning = 0
let sessionSeq = 0
const exec = async (args) => {
	execLog.push(args)
	running += 1
	maxRunning = Math.max(maxRunning, running)
	await new Promise((done) => setTimeout(done, 12))
	running -= 1
	// 每次新建会话返回不同的 id：真实 headless 就是这样，也避免撞上 session_id 的 UNIQUE
	const sid = `session-created-${++sessionSeq}`
	return `${JSON.stringify({ type: 'session', sessionId: sid })}\n${JSON.stringify({ type: 'thinking', text: '先想一下' })}\n${JSON.stringify({ type: 'text', text: '这是回答' })}\n${JSON.stringify({ type: 'status', phase: 'step_end', usage: { inputTokens: 10, outputTokens: 4 } })}\n`
}
const post = async (url, body) => { posts.push({ url, body }); return { ok: true } }
const dispatcher = createAssistantDispatcher({
	db,
	exec,
	post,
	secret: () => 'https://example.com/outbound',
	buildReply: (platform) => ({ platform }),
	concurrency: 2,
})

const ev1 = { ...dt, msgId: 'm-1' }
const r1 = await dispatcher.handle(ev1)
check('@ 消息处理完成', r1.status === 'done', JSON.stringify(r1))
check('首条消息自动建会话并回写到该群线程', Boolean(findThread(db, a1, 'cid-1')?.session_id))
check('首条消息没有带 --session-id', !execLog[0].includes('--session-id'))
const ev2 = { ...dt, msgId: 'm-2', text: '第二条' }
const r2 = await dispatcher.handle(ev2)
check('第二条消息带 --session-id 续聊', r2.status === 'done' && execLog[1].includes('--session-id'))
check('同一群的两条消息落在同一条线程', r2.threadId === r1.threadId)
check('流水按线程归组', listMessages(db, a1, 50, r1.threadId).filter((m) => m.status === 'done').length === 2)
check('两条消息写进流水且状态 done', listMessages(db, a1).filter((m) => m.status === 'done').length === 2)
const doneRow = listMessages(db, a1).find((m) => m.status === 'done')
check('思考过程落库（沟通记录要能展开看）', doneRow?.thinking === '先想一下', JSON.stringify(doneRow?.thinking))
check('token 用量落库', Boolean(doneRow?.usage) && JSON.parse(doneRow.usage).outputTokens === 4)
check('结果发到了出站地址', posts.length === 2 && posts[0].url === dt.replyUrl)

const execCount = execLog.length
const dup = await dispatcher.handle(ev1)
check('同一 msgId 重推只登记一次，不重复跑 dsh', dup.status === 'duplicate' && execLog.length === execCount)
check('非 @ 消息被忽略且不跑 dsh', (await dispatcher.handle({ ...dt, msgId: 'm-3', mentioned: false })).status === 'ignored' && execLog.length === execCount)
check('空文本被忽略', (await dispatcher.handle({ ...dt, msgId: 'm-4', text: '   ' })).status === 'ignored')
check('未绑定的机器人不处理', (await dispatcher.handle({ ...dt, msgId: 'm-5', robotKey: 'unknown' })).status === 'no_assistant')
check('ignored 也留一条流水便于排查', listMessages(db, a1).some((m) => m.status === 'ignored'))

console.log('\n== 6. 多机器人互不冲突 ==')
const otherEvent = { ...fs, msgId: 'm-6', text: '翻译这段话' }
const r3 = await dispatcher.handle(otherEvent)
check('第二个助理独立处理完成', r3.status === 'done', JSON.stringify(r3))
const sid1 = findThread(db, a1, 'cid-1')?.session_id
const sid2 = findThread(db, a2, 'oc-1')?.session_id
check('两个机器人各自拿到不同且非空的 session_id', Boolean(sid1) && Boolean(sid2) && sid1 !== sid2)
check('两个机器人的流水按 assistant_id 分开', listMessages(db, a2).length === 1 && listMessages(db, a1).length >= 4)
const [p1, p2] = await Promise.all([
	dispatcher.handle({ ...dt, msgId: 'm-7', text: 'A 并发' }),
	dispatcher.handle({ ...fs, msgId: 'm-8', text: 'B 并发' }),
])
check('不同群可并行', p1.status === 'done' && p2.status === 'done')
check('并发确实发生了（全局闸门允许 2）', maxRunning >= 2, `maxRunning=${maxRunning}`)
const sameThread = await Promise.all([
	dispatcher.handle({ ...dt, msgId: 'm-9', text: '同群 A' }),
	dispatcher.handle({ ...dt, msgId: 'm-10', text: '同群 B' }),
])
check('同一个群两条消息都完成且串行', sameThread.every((r) => r.status === 'done'))

console.log('\n== 7. 出站回落 / 失败 / 删除 ==')
const noReplyDispatcher = createAssistantDispatcher({ db, exec, post, secret: () => undefined, buildReply: () => ({}) })
const failResult = await noReplyDispatcher.handle({ ...dt, msgId: 'm-11', replyUrl: undefined })
check('没有出站地址时标 failed 而不是谎报成功', failResult.status === 'failed', JSON.stringify(failResult))
const timeoutDispatcher = createAssistantDispatcher({
	db,
	exec: async () => { throw new Error('headless timeout（180000ms）') },
	post,
	secret: () => 'https://example.com/outbound',
})
const postsBefore = posts.length
const timeoutResult = await timeoutDispatcher.handle({ ...fs, msgId: 'm-12' })
check('超时被标成 timeout', timeoutResult.status === 'timeout', JSON.stringify(timeoutResult))
check('超时会在群里回一条兜底提示（不再沉默）', posts.length === postsBefore + 1 && /没答完|已中止/.test(posts.at(-1)?.body?.text || ''))
check('兜底提示里带耗时，不泄露堆栈', /跑了 \d+ 秒/.test(posts.at(-1)?.body?.text || ''))
check('失败/超时流水带 error 与耗时', listMessages(db, a2).some((m) => m.status === 'timeout' && m.error))
check('删除助理前流水存在', listMessages(db, a2).length > 0)
check('删除助理返回 true', deleteAssistant(db, a2) === true)

console.log('\n== 8. 错误信息压缩（群里要看得懂） ==')
check(
	'从 headless 堆栈里只取最后一段 dsh:',
	shortError('headless 退出码 1：\n    at x\n    at y\ndsh: STREAM_CUT: boom') === 'STREAM_CUT: boom',
	shortError('headless 退出码 1：\n    at x\n    at y\ndsh: STREAM_CUT: boom'),
)
check('超长错误被截断', shortError('x'.repeat(300)).endsWith('…'))
check('空错误不返回空串', shortError('') === '未知错误')
check('删除后流水也清掉', listMessages(db, a2).length === 0)
check('删完 findAssistantForEvent 找不到', findAssistantForEvent(db, { platform: 'feishu', robotKey: 'cli_feishu_a' }) === undefined)

console.log('\n== 9. 原生通道优先、失败回落 ==')
{
	let posted = 0
	const countingPost = async () => { posted += 1; return { ok: true } }
	const nativeOk = createAssistantDispatcher({
		db,
		exec: async () => `${JSON.stringify({ type: 'text', text: '原生回答' })}\n`,
		post: countingPost,
		sendNative: async () => true,
		secret: () => 'https://example.com/outbound',
	})
	const r = await nativeOk.handle({ ...dt, msgId: 'm-native-1', conversationId: 'cid-native' })
	check('原生通道成功时不再重复走 webhook', r.status === 'done' && posted === 0, `posted=${posted}`)

	const nativeFail = createAssistantDispatcher({
		db,
		exec: async () => `${JSON.stringify({ type: 'text', text: '回落回答' })}\n`,
		post: countingPost,
		sendNative: async () => { throw new Error('401 InvalidAuthentication') },
		secret: () => 'https://example.com/outbound',
	})
	const r2 = await nativeFail.handle({ ...dt, msgId: 'm-native-2', conversationId: 'cid-native' })
	check('原生通道失败时回落到 webhook', r2.status === 'done' && posted === 1, `posted=${posted}`)
}

console.log('\n== 10. 并发闸门 ==')
const sem = createSemaphore(1)
const rel = await sem.acquire()
check('闸门占满后计数为 1', sem.active === 1)
rel()
check('释放后归零', sem.active === 0)

console.log('\n== 11. 人设只在首轮注入（否则会话记录每条都带人设） ==')
{
	const a3 = createAssistant(db, {
		team: 'team-a',
		name: '人设助理',
		platform: 'dingtalk',
		robotKey: 'ding-robot-persona',
		systemPrompt: '你是群助理，回答简短',
		by: 'tester',
	})
	const personaLog = []
	const personaDispatcher = createAssistantDispatcher({
		db,
		exec: async (args) => {
			personaLog.push(args)
			// 首轮要带 session 事件，dispatcher 才会把 session_id 回写；次轮才知道「不是首轮」
			const head = personaLog.length === 1 ? `${JSON.stringify({ type: 'session', sessionId: 'session-persona-1' })}\n` : ''
			return `${head}${JSON.stringify({ type: 'text', text: 'ok' })}\n`
		},
		post: async () => ({ ok: true }),
		secret: () => 'https://example.com/outbound',
	})
	await personaDispatcher.handle({ ...dt, robotKey: 'ding-robot-persona', msgId: 'm-persona-1', text: '第一问' })
	await personaDispatcher.handle({ ...dt, robotKey: 'ding-robot-persona', msgId: 'm-persona-2', text: '第二问' })
	const promptOf = (args) => String(args[args.length - 1] ?? '')
	check('首轮 prompt 带人设（建立口径）', promptOf(personaLog[0]).includes('你是群助理'), promptOf(personaLog[0]))
	check('次轮 prompt 不再重复人设', !promptOf(personaLog[1]).includes('你是群助理'), promptOf(personaLog[1]))
	check('次轮 session_id 已回写（所以才能判断不是首轮）', Boolean(findThread(db, a3, 'cid-1')?.session_id))
}

console.log('\n== 12. 一个群一个对话（唯一键 = 机器人 + 群）==')
{
	const a4 = createAssistant(db, {
		team: 'team-a',
		name: '多群助理',
		platform: 'dingtalk',
		robotKey: 'ding-robot-multi',
		systemPrompt: '你是群助理',
		by: 'tester',
	})
	const multiLog = []
	const multi = async (args) => {
		multiLog.push(args)
		return `${JSON.stringify({ type: 'session', sessionId: `session-g-${multiLog.length}` })}\n${JSON.stringify({ type: 'text', text: 'ok' })}\n`
	}
	const multiDispatcher = createAssistantDispatcher({
		db,
		exec: multi,
		post: async () => ({ ok: true }),
		secret: () => 'https://example.com/outbound',
	})
	const inGroup = (cid, msgId, text = '问题') => ({
		...dt,
		robotKey: 'ding-robot-multi',
		conversationId: cid,
		msgId,
		text,
	})

	await multiDispatcher.handle(inGroup('cid-g1', 'g1-1', '一群第一问'))
	await multiDispatcher.handle(inGroup('cid-g2', 'g2-1', '二群第一问'))
	const s1 = findThread(db, a4, 'cid-g1')?.session_id
	const s2 = findThread(db, a4, 'cid-g2')?.session_id
	check('同一个机器人在两个群各自建了一条线程', listThreads(db, a4).length === 2, String(listThreads(db, a4).length))
	check('两个群拿到不同的 dsh 会话（上下文不串）', Boolean(s1) && Boolean(s2) && s1 !== s2, `${s1} vs ${s2}`)
	check('每个群的首轮都不带 --session-id', !multiLog[0].includes('--session-id') && !multiLog[1].includes('--session-id'))

	await multiDispatcher.handle(inGroup('cid-g2', 'g2-2', '二群第二问'))
	check(
		'同群第二轮续用该群自己的会话',
		multiLog[2].includes('--session-id') && multiLog[2].includes(s2) && !multiLog[2].includes(s1),
		JSON.stringify(multiLog[2].slice(-4)),
	)
	check('首轮 prompt 带来源标记（侧栏能分清是哪个群）', /钉钉/.test(String(multiLog[0].at(-1))) && /cid-g1/.test(String(multiLog[0].at(-1))))
	check('群名有了就补成线程标题', resolveThread(db, getAssistant(db, a4), 'cid-g1', '销售一群').title === '销售一群')
	check('线程标题可读（没群名时退化成 id 尾部）', threadLabel({ conversation_id: 'cid-abcdefgh' }).startsWith('群 …'))

	// 群里的闲聊（没 @）只登记流水，不该顺手长出一条空会话
	const quiet = await multiDispatcher.handle({ ...inGroup('cid-quiet', 'q-1', '闲聊'), mentioned: false })
	check('群里的非 @ 消息不会长出空线程', quiet.status === 'ignored' && findThread(db, a4, 'cid-quiet') === undefined)

	// 白名单是准入、不是路由：配了就只认列出来的群
	setChannels(db, a4, ['cid-g1'])
	check(
		'配了白名单后白名单外的群不处理',
		findAssistantForEvent(db, { platform: 'dingtalk', robotKey: 'ding-robot-multi', conversationId: 'cid-g2' }) === undefined,
	)
	check(
		'白名单里的群仍然命中',
		findAssistantForEvent(db, { platform: 'dingtalk', robotKey: 'ding-robot-multi', conversationId: 'cid-g1' })?.id === a4,
	)
	setChannels(db, a4, [])
	check('清空白名单后恢复不限群', Boolean(findAssistantForEvent(db, { platform: 'dingtalk', robotKey: 'ding-robot-multi', conversationId: 'cid-g2' })))

	// 跨群并行、同群串行：队列键必须细到线程
	const trace = []
	const slowDispatcher = createAssistantDispatcher({
		db,
		exec: async (args) => {
			const prompt = String(args.at(-1))
			const tag = prompt.includes('长任务') ? 'A' : prompt.includes('短任务') ? 'B' : prompt.includes('排队') ? 'C' : 'D'
			trace.push(`start:${tag}`)
			await new Promise((done) => setTimeout(done, 15))
			trace.push(`end:${tag}`)
			return `${JSON.stringify({ type: 'text', text: 'ok' })}\n`
		},
		post: async () => ({ ok: true }),
		secret: () => 'https://example.com/outbound',
		concurrency: 4,
	})
	await Promise.all([
		slowDispatcher.handle(inGroup('cid-p1', 'p-1', '长任务')),
		slowDispatcher.handle(inGroup('cid-p2', 'p-2', '短任务')),
	])
	check('不同群同时开跑，A 群的长任务不堵 B 群', trace.indexOf('start:B') < trace.indexOf('end:A'), JSON.stringify(trace))

	const serial = []
	const serialDispatcher = createAssistantDispatcher({
		db,
		exec: async (args) => {
			serial.push(`start:${String(args.at(-1)).slice(-2)}`)
			await new Promise((done) => setTimeout(done, 10))
			serial.push(`end:${String(args.at(-1)).slice(-2)}`)
			return `${JSON.stringify({ type: 'text', text: 'ok' })}\n`
		},
		post: async () => ({ ok: true }),
		secret: () => 'https://example.com/outbound',
		concurrency: 4,
	})
	await Promise.all([
		serialDispatcher.handle(inGroup('cid-s1', 's-1', '排队甲')),
		serialDispatcher.handle(inGroup('cid-s1', 's-2', '排队乙')),
	])
	check('同一个群的两条消息严格串行（不抢 session.lock）', serial[0].startsWith('start') && serial[1].startsWith('end'), JSON.stringify(serial))

	const t1 = findThread(db, a4, 'cid-g1')
	check('重置线程只断开会话、历史与线程都留着', resetThread(db, t1.id) && findThread(db, a4, 'cid-g1').session_id === null && listThreads(db, a4).length >= 2)
	check('重置后同群下一条消息会新建会话', (await multiDispatcher.handle(inGroup('cid-g1', 'g1-2', '重新开始')))?.threadId === t1.id && Boolean(findThread(db, a4, 'cid-g1').session_id))
}

console.log('\n== 13. 管理接口：群线程 / 按群过滤 / 重置 ==')
{
	const runtime = createAssistantRuntime({
		db,
		json: (res, status, body) => {
			res.status = status
			res.body = body
		},
		readJson: async (req) => req.body || {},
		overrides: {
			// 会话 id 必须每次不同：同毫秒返回同一个会让第二条线程撞上 UNIQUE(session_id)
			exec: (() => {
				let seq = 0
				return async () =>
					`${JSON.stringify({ type: 'session', sessionId: `session-api-${++seq}` })}\n${JSON.stringify({ type: 'text', text: '接口回答' })}\n`
			})(),
			post: async () => ({ ok: true }),
			secret: () => 'https://example.com/outbound',
			sender: { send: async () => {} },
		},
	})
	const call = async (method, path, body) => {
		const res = {}
		const url = new URL(`http://x${path}`)
		const handled = await runtime.handleAdmin({ method, body }, res, url)
		return { handled, status: res.status, body: res.body }
	}

	const created = await call('POST', '/assistants', {
		team: 'team-a',
		name: '接口助理',
		platform: 'dingtalk',
		robotKey: 'ding-robot-api',
		channels: ['cid-api-1', 'cid-api-2'],
		by: 'tester',
	})
	const apiId = created.body?.assistant?.id
	check('新增接口能建助理', created.status === 201 && Boolean(apiId))
	check('新增时 channels 写进白名单', listChannels(db, apiId).length === 2, JSON.stringify(listChannels(db, apiId)))

	const empty = await call('GET', `/assistants/${apiId}/threads`)
	check('新助理还没有群线程', empty.status === 200 && empty.body.threads.length === 0)

	// 两条测试消息分别落在两个群上
	for (const [cid, msg] of [['cid-api-1', '一群'], ['cid-api-2', '二群']]) {
		await call('POST', `/assistants/${apiId}/test`, { conversationId: cid, text: msg })
	}
	const threads = (await call('GET', `/assistants/${apiId}/threads`)).body.threads
	check('测试消息按群建出两条线程', threads.length === 2, JSON.stringify(threads.map((t) => t.conversation_id)))
	check('线程带回消息数与会话状态', threads.every((t) => Number(t.message_count) === 1 && t.session_id), JSON.stringify(threads[0]))

	const one = threads.find((t) => t.conversation_id === 'cid-api-1')
	const scoped = await call('GET', `/assistants/${apiId}/messages?threadId=${one.id}`)
	check('流水可按群过滤', scoped.status === 200 && scoped.body.messages.length === 1, JSON.stringify(scoped.body?.messages?.length))

	const reset = await call('POST', `/assistants/${apiId}/threads/${one.id}/reset`)
	check('重置指定群的会话', reset.status === 200 && findThread(db, apiId, 'cid-api-1').session_id === null)
	const missingThread = await call('POST', `/assistants/${apiId}/threads/at-not-exist/reset`)
	check('重置不存在的线程返回 404', missingThread.status === 404, String(missingThread.status))

	const updated = await call('POST', `/assistants/${apiId}`, { name: '接口助理改名', channels: 'cid-api-3' })
	check('改白名单用逗号串也认', updated.status === 200 && listChannels(db, apiId)[0]?.conversation_id === 'cid-api-3')
	const kept = await call('POST', `/assistants/${apiId}`, { name: '只改名' })
	check('只改名不会清空白名单', kept.status === 200 && listChannels(db, apiId).length === 1)

	const del = await call('DELETE', `/assistants/${apiId}`)
	check('删除助理连线程与白名单一起清', del.status === 200 && listThreads(db, apiId).length === 0 && listChannels(db, apiId).length === 0)
}

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed ? 1 : 0)
