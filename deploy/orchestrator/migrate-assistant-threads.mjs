/**
 * 助理结构升级：从「一机器人一对话」到「一群一对话」，并对账。
 *
 * 真正的数据搬移在 `db.mjs: migrateAssistantsToThreads()` 里，`openDb()` 一开库就做完了
 * ——因为它必须在服务启动前完成，不能依赖有人记得跑脚本。这个脚本做两件事：
 *   1. 打开库（迁移随之发生），把那句 `db: 助理结构升级完成` 显式打出来；
 *   2. 打印对账：多少机器人、多少群线程、有多少流水还没挂上线程。
 *
 *   node deploy/orchestrator/migrate-assistant-threads.mjs
 *
 * 可重复跑：迁移函数检测到 legacy 列已不存在就直接返回，脚本只做对账。
 *
 * @module deploy/orchestrator/migrate-assistant-threads
 */
import { DB_PATH, closeDb, openDb } from './db.mjs'

const db = openDb()

const count = (sql, ...args) => Number(db.prepare(sql).get(...args)?.n ?? 0)

const robots = count('SELECT COUNT(*) AS n FROM assistants')
const threads = count('SELECT COUNT(*) AS n FROM assistant_threads')
const withSession = count('SELECT COUNT(*) AS n FROM assistant_threads WHERE session_id IS NOT NULL')
const channels = count('SELECT COUNT(*) AS n FROM assistant_channels')
const orphanMessages = count('SELECT COUNT(*) AS n FROM assistant_messages WHERE thread_id IS NULL')
const danglingThreads = count(
	`SELECT COUNT(*) AS n FROM assistant_threads t
	  WHERE NOT EXISTS (SELECT 1 FROM assistants a WHERE a.id = t.assistant_id)`,
)

console.log('\n对账：')
console.log(`  机器人配置：${robots}`)
console.log(`  群线程：${threads}（其中 ${withSession} 条已经建了 dsh 会话）`)
console.log(`  群白名单：${channels} 行${channels === 0 ? '（不限群）' : ''}`)
console.log(`  未挂线程的流水：${orphanMessages}${orphanMessages ? '（老消息或多群机器人的历史，预期内）' : ''}`)
console.log(`  孤儿线程（应为 0）：${danglingThreads}`)

if (danglingThreads > 0) {
	console.log('\n⚠️  有线程指向不存在的机器人，说明删除助理时漏删了子表；请按 id 核对后手工清理。')
	for (const row of db
		.prepare(
			`SELECT t.id, t.assistant_id, t.conversation_id FROM assistant_threads t
			  WHERE NOT EXISTS (SELECT 1 FROM assistants a WHERE a.id = t.assistant_id)`,
		)
		.all())
		console.log(`    ${row.id}  assistant=${row.assistant_id}  conversation=${row.conversation_id}`)
}

for (const row of db
	.prepare(
		`SELECT a.name, a.platform, COUNT(t.id) AS threads, SUM(t.session_id IS NOT NULL) AS sessions
		   FROM assistants a LEFT JOIN assistant_threads t ON t.assistant_id = a.id
		  GROUP BY a.id ORDER BY a.created_at`,
	)
	.all()) {
	console.log(`  ${row.platform}/${row.name}：${Number(row.threads)} 个群，${Number(row.sessions ?? 0)} 条会话`)
}

console.log(`\n库：${DB_PATH}`)
closeDb()
process.exit(danglingThreads > 0 ? 1 : 0)
