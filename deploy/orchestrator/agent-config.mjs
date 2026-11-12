/**
 * agent 参数（profile 用户层）的卷外副本：收集与注入。
 *
 * 为什么需要：
 *   1. dsh 把「UI 改的模型 / preset / 工具开关」写进 `profiles/web/cordis.patch.yml`，
 *      而 entrypoint 的 `refresh` 每次启动都会重铺 profile —— 卷内靠 `profile-patch.mjs`
 *      叠回来，但**卷本身是可丢的**（归档 `down -v`、换节点）；
 *   2. 归档恢复出来的新卷里只有会话，没有配置，用户一打开发现模型回到默认。
 *
 * 所以配置要像会话一样有一份卷外副本：卷内 `effective.json` 是现场，库里 `team_agent_config`
 * 是权威历史。这和 WorkBuddy 云端「Manifest 存平台、进沙箱时应用」是同一个分工——
 * 配置不跟着沙箱走，跟着团队走。
 *
 * 时序：
 *   capture  睡前 / 定时扫描 → 读卷里 effective.json → 入库（同样的内容不产生新版本）
 *   apply    restore 之后、唤醒之前 → 把库里最新一版写到卷里 inject.json → 容器启动时消费一次
 *
 * @module deploy/orchestrator/agent-config
 */
import { latestAgentConfig, saveAgentConfig } from './db.mjs'
import { createVolumeIo } from './sessions.mjs'

const DSH_HOME = process.env.CONSOLE_DSH_HOME || '/home/dsh/.dsh'
const KEEP_DIR = '.profile-keep'

/**
 * 把卷里的用户层收进库。
 *
 * @param {{team:string, db:object, io?:object}} input
 *   `io` 可注入（校验脚本用本地目录），默认按容器状态选择 exec / --volumes-from
 * @returns {Promise<{skipped?:string, revision?:number, unchanged?:boolean}>}
 */
export async function captureAgentConfig({ team, db, io = null }) {
	const volume = io ?? (await createVolumeIo({ team, root: DSH_HOME }))
	// effective.json 是上次「启动合并」的产物，运行期间用户接着改它不会更新。
	// 所以先让容器里的 node 现算一次（那边有 yaml，能按 id 比出差异），再读。
	// 算不出来（老镜像没有这个脚本）就退回读现状——比完全不入库强。
	try {
		await volume.run('node /opt/dsh/profile-patch.mjs export || true')
	} catch (error) {
		console.error(`console: ${team} 现算 agent 用户层失败，退回读现状：${error.message}`)
	}
	const buffer = await volume.readAll(`${KEEP_DIR}/effective.json`)
	if (!buffer) return { skipped: 'no-effective' }
	let rows
	try {
		rows = JSON.parse(buffer.toString('utf8'))
	} catch {
		return { skipped: 'bad-json' }
	}
	return saveAgentConfig(db, { team, rows, source: 'ui' })
}

/**
 * 把库里最新一版写进卷，等下一次容器启动时叠加。
 *
 * 只写不删：`profile-patch.mjs` 合并完会自己删掉 inject.json——留着会让之后每次启动
 * 都用旧快照，把用户在 UI 里的新改动顶掉。
 *
 * @param {{team:string, db:object, io?:object}} input
 * @returns {Promise<{skipped?:string, revision?:number, rows?:number}>}
 */
export async function applyAgentConfig({ team, db, io = null }) {
	const latest = latestAgentConfig(db, team)
	if (!latest) return { skipped: 'empty' }
	const volume = io ?? (await createVolumeIo({ team, root: DSH_HOME }))
	await volume.write(`${KEEP_DIR}/inject.json`, Buffer.from(`${JSON.stringify(latest.rows, null, 2)}\n`))
	return { revision: latest.revision, rows: latest.rows.length }
}
