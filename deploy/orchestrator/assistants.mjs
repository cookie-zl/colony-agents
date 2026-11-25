/**
 * 助理：一个 IM 机器人 + 每群一条 dsh 会话。
 *
 * 隔离语义（这是整个模块的核心）：
 *   - 一个机器人只有一份配置（UNIQUE platform+robot_key），避免同一机器人被两份配置抢消息；
 *   - 对话的唯一键是「机器人 + 群」：`(assistant_id, conversation_id)`，一个群一条线程一条 session；
 *   - 一条 session 只属一条线程（UNIQUE session_id），headless 各写各的会话目录，天然隔离；
 *   - 同一线程的消息必须串行（会话目录里有 session.lock，两个进程同时跑会抢锁）；
 *   - 不同群可以并行，但要过全局并发闸门——群数比机器人涨得快，别把 2 GiB 的容器打满。
 *
 * 所有外部 IO（docker exec、HTTP 发送、密钥读取、时钟）都注入，自测不需要 docker 也不需要联网。
 *
 * @module deploy/orchestrator/assistants
 */
import { randomUUID } from 'node:crypto'

/** 钉钉单条消息上限 4000 字符，飞书更小；取一个两边都安全的保守值。 */
export const MAX_REPLY_CHARS = 3000

/**
 * 默认全局并发：不同群最多同时跑 2 个 headless 进程。
 *
 * 注意这个数字是**按群**算的，不是按机器人：一个机器人被拉进 10 个群，
 * 10 个群同时 @ 就是 10 个待跑任务。2 GiB 的容器上 2~3 是安全值。
 */
export const DEFAULT_CONCURRENCY = 2

/**
 * 代理（助理）的工作目录。
 *
 * 和用户自己的 `/workspace` 分开：助理的会话、产物都落在 `/workspace/agents`，
 * 侧栏里是独立一个「代理工作区」分组，不会把用户自己的会话列表挤乱。
 * 仍然在 `/workspace` 之下，所以还是持久挂载，容器重建不丢。
 */
export const AGENT_WORKSPACE = process.env.DSH_AGENT_WORKSPACE || '/workspace/agents'

/** headless 单轮默认超时。群里不能干等，超时要回执并把流水标成 timeout。 */
export const DEFAULT_TIMEOUT_MS = 180_000

const iso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

/** 平台显示名，只用于给人看的地方（首轮 prompt 的来源标记、面板文案）。 */
const PLATFORM_LABELS = { dingtalk: '钉钉', feishu: '飞书' }

/**
 * @param {string} platform 平台标识
 * @returns {string} 中文平台名
 */
export function platformLabel(platform) {
	return PLATFORM_LABELS[platform] ?? String(platform ?? '')
}

/**
 * 线程的显示名。平台没给群名时退化成会话 id 尾部——至少能区分是哪个群。
 *
 * @param {{title?:string|null, conversation_id?:string}} thread 线程行
 * @returns {string} 可读名称
 */
export function threadLabel(thread) {
	if (thread?.title) return String(thread.title)
	const cid = String(thread?.conversation_id ?? '')
	if (!cid) return '未分群对话'
	return `群 ${cid.length > 8 ? `…${cid.slice(-6)}` : cid}`
}

/**
 * 整体替换某个助理的群白名单。传空数组 = 不限群。
 *
 * 为什么是「整体替换」而不是增删单条：配置界面就是一组勾选，替换语义和界面对得上，
 * 也不会出现「删了 A 结果 B 也被删」这种增量 diff 的坑。
 *
 * @param {import('node:sqlite').DatabaseSync} db 数据库
 * @param {string} assistantId 助理 id
 * @param {Array<string|{conversationId?:string,title?:string}>} channels 群列表
 * @param {string} [by] 操作者
 * @returns {void}
 */
export function setChannels(db, assistantId, channels, by = 'console') {
	const at = iso()
	// HTTP body 里可能直接给「逗号分隔的一串」；不先规范化的话，for..of 会按字符拆
	const list = Array.isArray(channels) ? channels : typeof channels === 'string' ? channels.split(/[,，\s]+/) : []
	db.exec('BEGIN')
	try {
		db.prepare('DELETE FROM assistant_channels WHERE assistant_id = ?').run(assistantId)
		const insert = db.prepare(
			`INSERT OR IGNORE INTO assistant_channels (assistant_id, conversation_id, title, added_by, added_at)
			 VALUES (?,?,?,?,?)`,
		)
		for (const channel of list) {
			const cid = String(typeof channel === 'string' ? channel : channel?.conversationId ?? '').trim()
			if (!cid) continue
			insert.run(assistantId, cid, typeof channel === 'string' ? null : channel?.title ?? null, by, at)
		}
		db.exec('COMMIT')
	} catch (error) {
		db.exec('ROLLBACK')
		throw error
	}
}

/**
 * 某个助理的群白名单。空数组 = 不限群。
 *
 * @param {import('node:sqlite').DatabaseSync} db 数据库
 * @param {string} assistantId 助理 id
 * @returns {Array<{conversation_id:string,title:string|null}>} 白名单行
 */
export function listChannels(db, assistantId) {
	return db
		.prepare('SELECT conversation_id, title FROM assistant_channels WHERE assistant_id = ? ORDER BY added_at')
		.all(assistantId)
}

/**
 * 新建助理。凭据不在这里写：由调用方用 assistantSecretScope(id) 存进 team_secrets。
 *
 * `conversationId` 是「只服务这一个群」的简写，等价于只传一个元素的 channels；
 * 不传就是不限群（机器人被拉进哪个群都回答）。
 *
 * @param {import('node:sqlite').DatabaseSync} db 数据库
 * @param {{team:string,name:string,platform:'dingtalk'|'feishu',robotKey:string,
 *          conversationId?:string|null,systemPrompt?:string|null,by:string}} input 助理定义
 * @returns {string} 助理 id
 */
export function createAssistant(db, input) {
	if (!['dingtalk', 'feishu'].includes(input.platform)) throw new Error(`不支持的平台：${input.platform}`)
	if (!input.robotKey?.trim()) throw new Error('robotKey 不能为空（钉钉 robotCode / 飞书 app_id）')
	const id = `as-${randomUUID().slice(0, 8)}`
	const at = iso()
	db.prepare(
		`INSERT INTO assistants
		   (id, team_id, name, platform, robot_key, system_prompt, enabled, created_by, created_at, updated_at)
		 VALUES (?,?,?,?,?,?,1,?,?,?)`,
	).run(id, input.team, input.name, input.platform, input.robotKey.trim(), input.systemPrompt ?? null, input.by, at, at)
	if (input.conversationId) setChannels(db, id, [{ conversationId: input.conversationId }], input.by)
	return id
}

/** 团队密钥的 scope：一个助理一个命名空间，互不串。 */
export function assistantSecretScope(assistantId) {
	return `assistant:${assistantId}`
}

/**
 * 凭据字段 → team_secrets 里的 key。
 *
 * 写（assistant-http 的 saveCredentials）和读（列表里的「配没配」）都从这里取，
 * 免得两处各写一份、加字段时只改一边。
 *
 * @type {Record<string, string>}
 */
export const CREDENTIAL_KEYS = {
	appKey: 'APP_KEY',
	appSecret: 'APP_SECRET',
	agentId: 'AGENT_ID',
	outboundWebhook: 'OUTBOUND_WEBHOOK',
	signSecret: 'SIGN_SECRET',
	verifyToken: 'VERIFY_TOKEN',
}

/**
 * 列出某团队的助理。不返回任何凭据，只回「配没配」。
 *
 * 额外带三个列表页要用的字段：`channels`（群白名单）、`threads`（已经聊起来的群数）、
 * `threadList`（每个群的摘要：id / 群 id / 群名 / 轮数 / 最近活跃）。
 * 面板要在助理行里直接摊开「这个机器人服务了哪几个群」，所以摘要一次带出来，
 * 不让它逐个助理再打一次接口。
 *
 * `conversation_id` 这个字段是为了兼容老面板而保留的「首个白名单群」——
 * 一个机器人现在可以服务多个群，别再用它判断「绑定关系」。
 *
 * @param {import('node:sqlite').DatabaseSync} db 数据库
 * @param {string} team 团队 id
 * @returns {Array<object>} 助理列表，每项多一个 `credentials` 布尔表
 */
export function listAssistants(db, team) {
	const probe = db.prepare('SELECT 1 FROM team_secrets WHERE team_id = ? AND scope = ? AND key = ?')
	// 一次查完整个团队的线程再按助理分组：助理数 × 群数通常几十行，比每条助理各查一次干净
	const threadsByAssistant = new Map()
	for (const row of db
		.prepare(
			`SELECT t.id, t.assistant_id, t.conversation_id, t.title, t.session_id, t.last_active_at,
			        (SELECT COUNT(*) FROM assistant_messages m WHERE m.thread_id = t.id) AS message_count
			   FROM assistant_threads t
			  WHERE t.team_id = ?
			  ORDER BY t.last_active_at DESC`,
		)
		.all(team)) {
		const list = threadsByAssistant.get(row.assistant_id) ?? []
		list.push({
			id: row.id,
			conversation_id: row.conversation_id,
			title: row.title,
			has_session: Boolean(row.session_id),
			message_count: Number(row.message_count),
			last_active_at: row.last_active_at,
		})
		threadsByAssistant.set(row.assistant_id, list)
	}
	return db
		.prepare('SELECT * FROM assistants WHERE team_id = ? ORDER BY created_at DESC')
		.all(team)
		// 只查「有没有这一行」，不解密：读密钥会触发 KEK 初始化，列表页不需要这个副作用
		.map((row) => {
			const scope = assistantSecretScope(row.id)
			const credentials = {}
			for (const [field, key] of Object.entries(CREDENTIAL_KEYS)) {
				credentials[field] = Boolean(probe.get(team, scope, key))
			}
			const channels = listChannels(db, row.id)
			const threadList = threadsByAssistant.get(row.id) ?? []
			return {
				...row,
				credentials,
				hasOutbound: credentials.outboundWebhook,
				channels,
				threads: threadList.length,
				threadList,
				conversation_id: channels[0]?.conversation_id ?? null,
			}
		})
}

/**
 * 按 id 取一个助理。
 *
 * @param {import('node:sqlite').DatabaseSync} db 数据库
 * @param {string} id 助理 id
 * @returns {object|undefined} 助理行
 */
export function getAssistant(db, id) {
	return db.prepare('SELECT * FROM assistants WHERE id = ?').get(id)
}

/**
 * 定点更新助理；只接受白名单字段，避免调用方误改唯一键。
 *
 * 群白名单有两种写法：`channels`（数组，整体替换）与 `conversationId`（单值，老面板在用）。
 * 两者都不传时不动白名单——「没提」和「清空」必须能区分开，否则一次改名就会把白名单清掉。
 *
 * @param {import('node:sqlite').DatabaseSync} db 数据库
 * @param {string} id 助理 id
 * @param {{name?:string,systemPrompt?:string,enabled?:boolean,by?:string,
 *          channels?:Array<string|{conversationId?:string,title?:string}>,
 *          conversationId?:string|null}} patch 待改字段
 * @returns {object|undefined} 更新后的助理行
 */
export function updateAssistant(db, id, patch) {
	const sets = []
	const args = []
	if (patch.name !== undefined) { sets.push('name = ?'); args.push(patch.name) }
	if (patch.systemPrompt !== undefined) { sets.push('system_prompt = ?'); args.push(patch.systemPrompt) }
	if (patch.enabled !== undefined) { sets.push('enabled = ?'); args.push(patch.enabled ? 1 : 0) }
	if (patch.channels !== undefined) setChannels(db, id, patch.channels, patch.by ?? 'console')
	else if (patch.conversationId !== undefined) {
		setChannels(db, id, patch.conversationId ? [{ conversationId: patch.conversationId }] : [], patch.by ?? 'console')
	}
	if (!sets.length) {
		// 只改白名单时也得留下「动过」的时间戳，否则列表按 updated_at 排序看不出变化
		if (patch.channels !== undefined || patch.conversationId !== undefined) {
			db.prepare('UPDATE assistants SET updated_at = ? WHERE id = ?').run(iso(), id)
		}
		return getAssistant(db, id)
	}
	sets.push('updated_at = ?')
	args.push(iso(), id)
	db.prepare(`UPDATE assistants SET ${sets.join(', ')} WHERE id = ?`).run(...args)
	return getAssistant(db, id)
}

/**
 * 删除助理。线程、白名单、流水都有外键，先删子表；密钥由调用方决定是否一起清。
 *
 * @param {import('node:sqlite').DatabaseSync} db 数据库
 * @param {string} id 助理 id
 * @returns {boolean} 是否真的删掉了
 */
export function deleteAssistant(db, id) {
	// node:sqlite 的 DatabaseSync 没有 better-sqlite3 的 db.transaction()，用显式事务包住几条 DELETE。
	db.exec('BEGIN')
	try {
		db.prepare('DELETE FROM assistant_messages WHERE assistant_id = ?').run(id)
		db.prepare('DELETE FROM assistant_threads WHERE assistant_id = ?').run(id)
		db.prepare('DELETE FROM assistant_channels WHERE assistant_id = ?').run(id)
		const deleted = db.prepare('DELETE FROM assistants WHERE id = ?').run(id).changes > 0
		db.exec('COMMIT')
		return deleted
	} catch (error) {
		db.exec('ROLLBACK')
		throw error
	}
}

/**
 * 把一条归一化事件匹配到助理。
 *
 * 匹配只按「平台 + 机器人」，群白名单是**准入**而不是路由：
 * 白名单为空（没配）= 机器人被拉进哪个群都处理；配了就只认列出来的群。
 * 具体分到哪条会话由 resolveThread 决定，那是另一层。
 *
 * @param {import('node:sqlite').DatabaseSync} db 数据库
 * @param {{platform:string,robotKey:string,conversationId?:string}} event 归一化事件
 * @returns {object|undefined} 命中的助理
 */
export function findAssistantForEvent(db, event) {
	return db
		.prepare(
			`SELECT * FROM assistants a
			  WHERE a.platform = ? AND a.robot_key = ? AND a.enabled = 1
			    AND (NOT EXISTS (SELECT 1 FROM assistant_channels c WHERE c.assistant_id = a.id)
			         OR EXISTS (SELECT 1 FROM assistant_channels c
			                     WHERE c.assistant_id = a.id AND c.conversation_id = ?))
			  LIMIT 1`,
		)
		.get(event.platform, event.robotKey, String(event.conversationId ?? ''))
}

/**
 * 幂等写入一条消息流水。UNIQUE(assistant_id, platform, msg_id) 冲突即视为重复推送。
 *
 * @param {import('node:sqlite').DatabaseSync} db 数据库
 * @param {{assistantId:string,threadId?:string|null,platform:string,msgId:string,conversationId?:string,
 *          senderId?:string,senderName?:string,inbound:string,status:string}} input 消息
 * @returns {{id:string,inserted:boolean}} 流水 id 与是否新插入
 */
export function insertMessage(db, input) {
	const id = `am-${randomUUID().slice(0, 12)}`
	const result = db
		.prepare(
			`INSERT OR IGNORE INTO assistant_messages
			   (id, assistant_id, thread_id, platform, msg_id, conversation_id, sender_id, sender_name, inbound, status, created_at)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		)
		.run(
			id,
			input.assistantId,
			input.threadId ?? null,
			input.platform,
			input.msgId,
			input.conversationId ?? null,
			input.senderId ?? null,
			input.senderName ?? null,
			input.inbound,
			input.status,
			iso(),
		)
	return { id, inserted: result.changes > 0 }
}

/**
 * 更新流水状态与结果。
 *
 * @param {import('node:sqlite').DatabaseSync} db 数据库
 * @param {string} id 流水 id
 * @param {{status?:string,outbound?:string,thinking?:string,usage?:string,error?:string,elapsedMs?:number}} patch 待改字段
 * @returns {void}
 */
export function updateMessage(db, id, patch) {
	const sets = []
	const args = []
	for (const [column, value] of Object.entries({
		status: patch.status,
		outbound: patch.outbound,
		thinking: patch.thinking,
		usage: patch.usage,
		error: patch.error,
		elapsed_ms: patch.elapsedMs,
	})) {
		if (value === undefined) continue
		sets.push(`${column} = ?`)
		args.push(value)
	}
	if (!sets.length) return
	args.push(id)
	db.prepare(`UPDATE assistant_messages SET ${sets.join(', ')} WHERE id = ?`).run(...args)
}

/**
 * 取某助理最近的消息流水（门户查看用）。传 threadId 就只看某个群的对话。
 *
 * @param {import('node:sqlite').DatabaseSync} db 数据库
 * @param {string} assistantId 助理 id
 * @param {number} [limit] 条数
 * @param {string|null} [threadId] 只看某条群线程
 * @returns {Array<object>} 流水
 */
export function listMessages(db, assistantId, limit = 50, threadId = null) {
	if (threadId) {
		return db
			.prepare('SELECT * FROM assistant_messages WHERE assistant_id = ? AND thread_id = ? ORDER BY created_at DESC LIMIT ?')
			.all(assistantId, threadId, limit)
	}
	return db
		.prepare('SELECT * FROM assistant_messages WHERE assistant_id = ? ORDER BY created_at DESC LIMIT ?')
		.all(assistantId, limit)
}

/* ------------------------------ 群线程 ------------------------------ */

/**
 * 取某条群线程（不创建）。找不到返回 undefined。
 *
 * @param {import('node:sqlite').DatabaseSync} db 数据库
 * @param {string} assistantId 助理 id
 * @param {string} [conversationId] 群会话 id；空串表示兜底线程
 * @returns {object|undefined} 线程行
 */
export function findThread(db, assistantId, conversationId = '') {
	return db
		.prepare('SELECT * FROM assistant_threads WHERE assistant_id = ? AND conversation_id = ?')
		.get(assistantId, String(conversationId ?? ''))
}

/**
 * 取或建一个群的线程。「一个群一条对话」的落点就是这里。
 *
 * 并发安全：两个回调同时进同一个新群时，先 INSERT OR IGNORE 再查，
 * 最终都会拿到同一行（唯一键 assistant_id + conversation_id 兜住）。
 *
 * @param {import('node:sqlite').DatabaseSync} db 数据库
 * @param {object} assistant 助理行
 * @param {string} [conversationId] 群会话 id
 * @param {string|null} [title] 群名（平台给了才传），后到时补写
 * @returns {object} 线程行
 */
export function resolveThread(db, assistant, conversationId = '', title = null) {
	const cid = String(conversationId ?? '')
	const existing = findThread(db, assistant.id, cid)
	if (existing) {
		// 群名可能只出现在部分回调里：第一次没有、后面有了就补上，别让面板一直显示 id 尾巴
		if (title && !existing.title) {
			db.prepare('UPDATE assistant_threads SET title = ? WHERE id = ?').run(title, existing.id)
			existing.title = title
		}
		return existing
	}
	const at = iso()
	db.prepare(
		`INSERT OR IGNORE INTO assistant_threads
		   (id, assistant_id, team_id, platform, conversation_id, title, session_id, created_at, last_active_at)
		 VALUES (?,?,?,?,?,?,NULL,?,?)`,
	).run(`at-${randomUUID().slice(0, 10)}`, assistant.id, assistant.team_id, assistant.platform, cid, title ?? null, at, at)
	return findThread(db, assistant.id, cid)
}

/**
 * 列出某个助理的所有群线程，活跃的在前。
 *
 * `message_count` / `last_message_at` 走子查询而不是 join：一个助理的线程数是几十的量级，
 * 子查询看得更清楚；等真的到几百条再改成聚合视图。
 *
 * @param {import('node:sqlite').DatabaseSync} db 数据库
 * @param {string} assistantId 助理 id
 * @returns {Array<object>} 线程列表
 */
export function listThreads(db, assistantId) {
	return db
		.prepare(
			`SELECT t.*,
			        (SELECT COUNT(*) FROM assistant_messages m WHERE m.thread_id = t.id) AS message_count,
			        (SELECT MAX(m.created_at) FROM assistant_messages m WHERE m.thread_id = t.id) AS last_message_at
			   FROM assistant_threads t
			  WHERE t.assistant_id = ?
			  ORDER BY t.last_active_at DESC`,
		)
		.all(assistantId)
}

/**
 * 让某个群「重新开始对话」：只断开会话绑定，历史流水与线索都留着。
 *
 * 只置空 session_id 而不删线程：群里下一条 @ 会新建一条 dsh 会话，
 * 但「这个群以前问过什么」还要能查——删线程等于把排查依据一起删了。
 *
 * @param {import('node:sqlite').DatabaseSync} db 数据库
 * @param {string} threadId 线程 id
 * @returns {boolean} 是否找到并重置
 */
export function resetThread(db, threadId) {
	return db
		.prepare('UPDATE assistant_threads SET session_id = NULL, last_active_at = ? WHERE id = ?')
		.run(iso(), threadId).changes > 0
}

/**
 * 去掉消息里的 @ 占位符，得到真正要交给模型的 prompt。
 * 钉钉是「@机器人名」，飞书是 `@_user_1` 这类占位符。
 *
 * @param {string} text 原始文本
 * @param {string[]} [hints] 需要额外清除的名字/占位符
 * @returns {string} 清洗后的文本
 */
export function cleanMention(text, hints = []) {
	let out = String(text ?? '')
	for (const hint of hints) {
		if (!hint) continue
		out = out.split(hint).join(' ')
	}
	out = out.replace(/@_\w+/g, ' ').replace(/@[\w\u4e00-\u9fa5.-]{1,32}/g, ' ')
	// hints 先把名字抹掉会留下孤立的 @，最后再收一次，别把它喂给模型
	return out.replace(/@\s*/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * 按字符数分片，长回复逐片发。带 (i/n) 前缀，群里能看出顺序。
 *
 * @param {string} text 待发文本
 * @param {number} [limit] 单片上限
 * @returns {string[]} 分片数组；空文本返回空数组
 */
export function splitText(text, limit = MAX_REPLY_CHARS) {
	const body = String(text ?? '').trim()
	if (!body) return []
	const parts = []
	for (let i = 0; i < body.length; i += limit) parts.push(body.slice(i, i + limit))
	return parts.map((part, i) => (parts.length > 1 ? `(${i + 1}/${parts.length})\n${part}` : part))
}

/**
 * 解析 headless --json 的事件流，取出会话 id、思考过程、最终回复与 token 用量。
 * 首轮不带 --session-id 时会输出 type:'session'，从那里拿到新会话 id 回写。
 *
 * 事件形状（实测）：
 *   {"type":"session","sessionId":"..."}
 *   {"type":"thinking","text":"..."}         ← 模型的思考过程
 *   {"type":"text","text":"..."}             ← 可见回复，可能多段
 *   {"type":"status","phase":"step_end","usage":{inputTokens,outputTokens,reasoningTokens}}
 *   {"type":"final","text":"..."}
 *
 * @param {string} stdout JSONL 文本
 * @returns {{sessionId?:string,text:string,thinking:string,usage?:object}} 解析结果
 */
export function parseHeadlessOutput(stdout) {
	let sessionId
	let usage
	const texts = []
	const thoughts = []
	for (const line of String(stdout ?? '').split('\n')) {
		if (!line.trim().startsWith('{')) continue
		let row
		try { row = JSON.parse(line) } catch { continue }
		if (row.type === 'session' && row.sessionId) sessionId = row.sessionId
		if (row.type === 'text' && typeof row.text === 'string') texts.push(row.text)
		if (row.type === 'thinking' && typeof row.text === 'string') thoughts.push(row.text)
		// 取最后一次 step_end 的用量：一轮里可能有多个 step（工具调用），最后一次才是整轮的
		if (row.type === 'status' && row.phase === 'step_end' && row.usage) usage = row.usage
	}
	return {
		...(sessionId ? { sessionId } : {}),
		text: texts.join('\n\n').trim(),
		thinking: thoughts.join('\n\n').trim(),
		...(usage ? { usage } : {}),
	}
}

/**
 * 组装 docker exec 参数。sessionId 为空 = 首轮，让 headless 新建会话。
 *
 * `-w` 把进程 cwd 钉在代理工作区：dsh 用 cwd 决定会话归属，
 * 不指定的话助理会话会混进用户自己的 `/workspace` 里。
 *
 * @param {{team:string,sessionId?:string|null,prompt:string,profile?:string,cwd?:string}} input 调用参数
 * @returns {{args:string[],container:string}} docker exec 参数与容器名
 */
export function headlessCommand({ team, sessionId = null, prompt, profile = 'headless', cwd = AGENT_WORKSPACE }) {
	const container = `dsh-${team}-dsh-1`
	const args = ['exec']
	if (cwd) args.push('-w', cwd)
	args.push(container, 'dsh', '--profile', profile, '--json')
	if (sessionId) args.push('--session-id', sessionId)
	args.push(prompt)
	return { args, container }
}

/** 全局并发闸门：不同助理之间抢名额，同一助理的串行由队列保证。 */
export function createSemaphore(max = DEFAULT_CONCURRENCY) {
	let active = 0
	const waiting = []
	const release = () => {
		active -= 1
		waiting.shift()?.()
	}
	return {
		/** 占一个名额，满了就排队。 */
		async acquire() {
			if (active >= max) await new Promise((done) => waiting.push(done))
			active += 1
			return release
		},
		/** 当前在跑的数量，仅用于观测。 */
		get active() { return active },
	}
}

/**
 * 把 headless 的长堆栈压成一句能给群里看的话。
 *
 * headless 的失败信息是「headless 退出码 1：<堆栈>」加最后一行 `dsh: xxx`，
 * 直接丢进群里既看不懂也没必要。取最后那段，再按长度截断。
 *
 * @param {string} message 原始错误
 * @param {number} [limit] 最大字符数
 * @returns {string} 可读的一句话
 */
export function shortError(message, limit = 120) {
	const text = String(message ?? '').replace(/\s+/g, ' ').trim()
	if (!text) return '未知错误'
	const tail = text.split('dsh: ').pop()
	const picked = tail && tail !== text ? tail : text
	return picked.length > limit ? `${picked.slice(0, limit)}…` : picked
}

/**
 * 创建助理调度器。所有 IO 注入，自测可以完全离线。
 *
 * @param {object} deps 依赖
 * @param {import('node:sqlite').DatabaseSync} deps.db 数据库
 * @param {(args:string[],timeoutMs:number)=>Promise<string>} deps.exec docker exec 实现，返回 stdout
 * @param {(url:string,body:object)=>Promise<{ok:boolean,body?:string}>} deps.post HTTP POST 实现
 * @param {(assistant:object,event:object,text:string)=>Promise<boolean>} [deps.sendNative] 平台原生发送（返回 true = 已发出）
 * @param {(team:string,scope:string,key:string)=>string|undefined} [deps.secret] 取凭据
 * @param {(platform:string,url:string,text:string,event:object)=>object} [deps.buildReply] 组装平台回复体
 * @param {(event:object)=>object|undefined} [deps.lookup] 事件→助理（默认查库）
 * @param {number} [deps.concurrency] 全局并发
 * @param {number} [deps.timeoutMs] 单轮超时
 * @param {()=>number} [deps.clock] 计时
 * @returns {{handle:(event:object)=>Promise<object>, queues:number}} 调度器
 */
export function createAssistantDispatcher({
	db,
	exec,
	post,
	sendNative = null,
	secret = () => undefined,
	buildReply = (platform, url, text) => ({ text }),
	lookup = (event) => findAssistantForEvent(db, event),
	concurrency = DEFAULT_CONCURRENCY,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	clock = () => Date.now(),
}) {
	const sem = createSemaphore(concurrency)
	const tails = new Map()

	/**
	 * 把任务挂到该**线程**的队列尾：同一个群严格串行、不同群互不排队。
	 *
	 * 队列键必须细到线程而不是机器人：一个机器人服务多个群，
	 * 按机器人排队会让 A 群的长任务把 B 群堵住，而两者本来就该是两条独立会话。
	 */
	const enqueue = (threadId, task) => {
		const previous = tails.get(threadId) ?? Promise.resolve()
		const next = previous.then(task, task).catch(() => {})
		tails.set(threadId, next)
		// 队列跑完就删掉 Map 项，否则每条线程会永久留一条已完成的 promise
		next.finally(() => { if (tails.get(threadId) === next) tails.delete(threadId) })
		return next
	}

	/** 取回复地址：优先回调里带的短期地址，没有就用助理配置的长期 webhook。 */
	const replyUrlFor = (assistant, event) =>
		event.replyUrl || secret(assistant.team_id, assistantSecretScope(assistant.id), 'OUTBOUND_WEBHOOK')

	/**
	 * 失败/超时后在群里回一句，别让提问的人对着空气等。
	 *
	 * 这是 E6 的核心：以前失败只写流水，群里完全没动静，用户不知道是没收到、在跑、还是挂了。
	 * 没有可用通道（模拟消息 / 没配 webhook）就只记流水——那种情况下也发不出去。
	 *
	 * @param {object} assistant 助理行
	 * @param {object} event 归一化事件
	 * @param {{isTimeout:boolean,error:any,elapsedMs:number}} detail 失败详情
	 * @returns {Promise<void>}
	 */
	const notifyFailure = async (assistant, event, { isTimeout, error, elapsedMs }) => {
		const seconds = Math.max(1, Math.round(elapsedMs / 1000))
		const note = isTimeout
			? `（这条跑了 ${seconds} 秒还没答完，已中止。可以把问题拆小一点再问一次。）`
			: `（这条没处理成功：${shortError(error?.message ?? error)}。可以稍后重试，或到「助理 → 消息流水」看详情。）`
		try {
			await deliverText(assistant, event, note)
		} catch {
			// 连兜底提示都发不出去就只能留流水，别把原始错误覆盖掉
		}
	}

	/**
	 * 发一段文本：优先平台原生通道（钉钉 OpenAPI），没有或失败再回落 webhook。
	 *
	 * 原生通道解决的是「长任务」：`sessionWebhook` 只有约 1.5 小时，而 OpenAPI 用
	 * appKey/appSecret 换 token（2 小时、自动续），跑多久都能把结果发出去。
	 * 每次分片独立尝试：第一片用原生通道成功，后面几片也走同一条路。
	 *
	 * @param {object} assistant 助理行
	 * @param {object} event 归一化事件
	 * @param {string} text 本片文本
	 * @returns {Promise<void>}
	 */
	const deliverText = async (assistant, event, text) => {
		if (sendNative) {
			try {
				if (await sendNative(assistant, event, text)) return
			} catch (nativeError) {
				// 原生通道失败不致命：还有消息自带的 sessionWebhook / 长期 webhook
				event.nativeSendError = shortError(nativeError?.message)
			}
		}
		const url = replyUrlFor(assistant, event)
		if (!url) {
			throw new Error(
				event.nativeSendError
					? `主动发送失败（${event.nativeSendError}），且没有可用的回落地址`
					: '没有可用的出站通道：这条不是真实群消息（不带 sessionWebhook），且未配置出站 Webhook。' +
						'群里 @ 机器人时会自动回原群；想让「测试发送」也落到群里，请给助理配一个群自定义机器人 Webhook。',
			)
		}
		await post(url, buildReply(event.platform, url, text, event))
	}

	/** 跑一轮：过闸门 → headless → 回写这条线程的会话 → 分片发回。 */
	const run = async (assistant, thread, event, messageId) => {
		const started = clock()
		// 提出来：发送失败时也要把模型已经生成的内容留在流水里，
		// 否则「点了测试却只看到一句报错」根本没法判断是没答出来还是没发出去。
		let answer = ''
		let thinking = ''
		let usage
		updateMessage(db, messageId, { status: 'running' })
		const release = await sem.acquire()
		try {
			// 首轮 = 这条**线程**还没有会话，不是这个机器人还没会话：不同群各自起步。
			const firstTurn = !thread.session_id
			// 人设与来源标记只在首轮拼进 prompt：
			//  - 人设：dsh 的会话是持久的，首轮建立口径后模型会带着走；每条都拼会让侧栏会话
			//    变成「一大段人设 + 一句话」，看起来不像正常对话。
			//  - 来源：侧栏里一个机器人的多个群会话同名，首句带上「钉钉 · 某群」才分得清。
			const prompt = [
				firstTurn ? `[来源：${platformLabel(thread.platform)} · ${threadLabel(thread)}]` : '',
				firstTurn ? assistant.system_prompt?.trim() : '',
				event.text,
			]
				.filter(Boolean)
				.join('\n\n')
			const { args } = headlessCommand({ team: assistant.team_id, sessionId: thread.session_id, prompt })
			const stdout = await exec(args, timeoutMs)
			const parsed = parseHeadlessOutput(stdout)
			thinking = parsed.thinking
			usage = parsed.usage
			if (parsed.sessionId && !thread.session_id) {
				db.prepare('UPDATE assistant_threads SET session_id = ?, last_active_at = ? WHERE id = ? AND session_id IS NULL')
					.run(parsed.sessionId, iso(), thread.id)
				thread.session_id = parsed.sessionId
			}
			answer = parsed.text || '（本轮没有产出文本回复）'
			for (const part of splitText(answer)) {
				await deliverText(assistant, event, part)
			}
			updateMessage(db, messageId, {
				status: 'done',
				outbound: answer,
				thinking: thinking || undefined,
				usage: usage ? JSON.stringify(usage) : undefined,
				elapsedMs: clock() - started,
			})
			return { status: 'done', assistantId: assistant.id, threadId: thread.id, messageId }
		} catch (error) {
			const isTimeout = /timeout|超时/i.test(String(error?.message))
			const elapsedMs = clock() - started
			// 只要模型已经答出来了就留档：发送失败 ≠ 没生成，流水里要能分辨这两种情况
			updateMessage(db, messageId, {
				status: isTimeout ? 'timeout' : 'failed',
				error: String(error?.message ?? error),
				outbound: answer || undefined,
				thinking: thinking || undefined,
				usage: usage ? JSON.stringify(usage) : undefined,
				elapsedMs,
			})
			// 群里给个交代：沉默是最难排查的状态
			await notifyFailure(assistant, event, { isTimeout, error, elapsedMs })
			return { status: isTimeout ? 'timeout' : 'failed', assistantId: assistant.id, threadId: thread.id, messageId, error: String(error?.message ?? error) }
		} finally {
			// 失败也要刷新活跃时间：面板按它排序，卡住的群不该沉到底部
			db.prepare('UPDATE assistant_threads SET last_active_at = ? WHERE id = ?').run(iso(), thread.id)
			release()
		}
	}

	return {
		/** 当前还挂着队列的线程数，仅用于观测。 */
		get queues() { return tails.size },
		/** 当前正在跑的 headless 进程数，仅用于观测。 */
		get active() { return sem.active },
		/**
		 * 处理一条归一化入站事件。非 @ / 停用 / 无匹配助理 / 重复消息一律不跑 dsh。
		 *
		 * @param {{platform:string,robotKey:string,msgId:string,mentioned:boolean,text:string,
		 *          replyUrl?:string,conversationId?:string,conversationTitle?:string,
		 *          senderId?:string,senderName?:string}} event 归一化事件
		 * @returns {Promise<object>} 处理结果
		 */
		async handle(event) {
			const assistant = lookup(event)
			if (!assistant) return { status: 'no_assistant' }
			const willRun = Boolean(event.mentioned) && Boolean(event.text?.trim())
			// 只有真要跑的消息才建线程：群里的闲聊不该长出一条空会话。
			// 已经在聊的群仍然把流水挂到原线程上，按群查历史不会断。
			const thread = willRun
				? resolveThread(db, assistant, event.conversationId, event.conversationTitle)
				: findThread(db, assistant.id, event.conversationId)
			const { id: messageId, inserted } = insertMessage(db, {
				assistantId: assistant.id,
				threadId: thread?.id ?? null,
				platform: event.platform,
				msgId: event.msgId,
				conversationId: event.conversationId,
				senderId: event.senderId,
				senderName: event.senderName,
				inbound: event.text ?? '',
				status: willRun ? 'queued' : 'ignored',
			})
			if (!inserted) return { status: 'duplicate', messageId }
			if (!willRun) return { status: 'ignored', messageId, threadId: thread?.id }
			return enqueue(thread.id, () => run(assistant, thread, event, messageId))
		},
	}
}
