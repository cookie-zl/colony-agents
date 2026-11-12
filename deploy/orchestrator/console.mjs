/**
 * 本地控制面：把「新建团队」「休眠/唤醒」「对账」「归档」变成 HTTP 动作，
 * 背后真的去操作容器。
 *
 * 为什么必须在容器外：容器是 dsh 进程的宿主，dsh 里的插件管不了自己的宿主
 * （时序问题，不是权限问题）。所以这一层只能是一个独立的、持有容器权限的进程。
 *
 * 本地形态 = 宿主上的 node 进程（docker CLI 在 PATH 里）；
 * 云上形态 = 同一个接口，runtime.mjs 里把 provider 换成 helm，本文件不用改。
 *
 *   团队生命周期
 *     POST /teams       { id, name, desc, owner, cpus?, memory? } → 建容器并返回入口
 *     GET  /teams                                                  → 注册表里的团队
 *     POST /archive     { team, reason? }                          → 卷打包后删容器删卷
 *     POST /restore     { team }                                   → 从归档恢复并起实例
 *
 *   运行时
 *     POST /touch       { team }        → 记一次「有人来了」（账号服务在 verify 里调）
 *     GET  /wake-state?team=            → 醒着还是睡着（账号服务据此决定要不要拦）
 *     POST /wake        { team }        → 异步唤醒（幂等）
 *     POST /sleep       { team }        → 立刻休眠
 *     GET  /state                       → 全部实例的活跃度、配额、节点
 *
 *   运维
 *     GET  /reconcile   → 只报告容器与注册表的漂移（不修）
 *     POST /reconcile   → 修复：缺失的重建、多余的报孤儿、state 以容器为准
 *     GET  /nodes       → 节点清单与余量
 *     GET  /metrics     → Prometheus 文本格式
 *     POST /snapshot    → 立刻给三份配置拍快照
 *
 *   会话与产物
 *     GET  /sessions?team=                  → 侧栏列表（纯查库）
 *     POST /sessions/sync   { team, force? } → 会话日志 + 产物归因一起上推
 *     POST /sessions/restore { team, sessionId? } → 按对象层重建会话文件
 *     GET  /sessions/:id/artifacts?team=     → 该会话每轮改了哪些文件（纯查库）
 *     GET  /sessions/:id/artifacts/:turn?team= → 某一轮的完整记录（含 hunks，读对象层）
 *
 *   技能与连接器（市场在 deploy/market/，团队侧落在各自的卷里）
 *     GET  /market                  → 市场索引（?team= 时带该团队已装版本）
 *     GET  /packages?team=          → 已装清单 + 来源 + 分享流水 + 待接收 + 操作日志
 *     POST /market/install          { team, kind, name, env?, by? }
 *     POST /market/uninstall        { team, kind, name, by? }
 *     POST /market/publish          { team, kind, name, version, visibility, by? }
 *     POST /market/upload?team=&name=&version=&visibility=  body=tar.gz 原始字节 → 发布多文件包
 *     POST /market/share            { from, to, kind, name, note?, by? } → 投递到 inbox，默认不生效
 *     POST /market/share/enable     { id, team, env?, by? }             → 接收方启用，此时才写卷
 *     POST /market/share/reject     { id, team, by? }
 *     GET  /shares?team=            → 分享流水 + 该团队的待接收项
 *     GET  /market/token?team=      → 该团队的只读市场 token（给 dsh 容器用，可吊销）
 *
 *   市场只读接口（给 dsh 里的 provider 插件，鉴权用每团队一枚的 market token，不是 console-token）
 *     GET  /market/skills                      → { team, rev, items[] } 本团队已启用的技能目录
 *     GET  /market/skills/:name/:version       → text/plain 技能正文
 *     GET  /market/skills/:name/:version/bundle → application/gzip 整包（多文件技能物化用）
 *
 *   助理（一个机器人 ↔ 一个 dsh 会话；@ 才处理）
 *     POST /assistants/inbound/dingtalk        → 钉钉回调，**不走 console-token**，验加签
 *     POST /assistants/inbound/feishu          → 飞书回调，**不走 console-token**，验 token（含 challenge）
 *     GET  /assistants?team=                    → 助理列表（不回凭据）
 *     POST /assistants                         → 新建并写凭据（team_secrets 加密）
 *     POST /assistants/:id                     → 改名 / 人设 / 绑定群 / 启停 / 换凭据
 *     DELETE /assistants/:id                   → 删除（连流水与凭据一起清）
 *     GET  /assistants/:id/messages            → 消息流水（幂等键、状态、耗时）
 *     POST /assistants/:id/test                → 模拟一条 @ 消息，跑完整链路（联调用）
 *
 * 鉴权：请求头 X-Console-Token 必须等于本目录的 console-token 文件
 * （/health、模型网关、市场只读接口、助理入站回调除外，各自有独立校验）。
 * 端口默认只监听本机可达地址（容器经 host.docker.internal 访问）。
 */
import http from 'node:http'
import net from 'node:net'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

import {
	HERE,
	REPO,
	registry,
	saveRegistry,
	loadState,
	saveStateSoon,
	loadNodes,
	snapshot,
	pruneTmp,
} from './store.mjs'
import {
	containerState,
	allStates,
	projectList,
	volumeList,
	statsMap,
	run,
	waitHealthy,
	memoryGB,
	provision,
	sleepInstance,
	wakeInstance,
	archiveInstance,
	restoreInstance,
} from './runtime.mjs'
import { objectExists, statObject } from './objects.mjs'
import { listTeamSessions, restoreTeam as restoreSessions, syncTeam as syncSessions, sessionVolumeExists } from './sessions.mjs'
import { syncArtifacts, artifactsFor, artifactDetail } from './artifacts.mjs'
import { captureAgentConfig, applyAgentConfig } from './agent-config.mjs'
import { createReloadWaiter } from './reload.mjs'
import { handleLlmGateway, LLM_SCOPE, LLM_KEY } from './llm-gateway.mjs'
import { deleteSecret, getSecret, listSecrets, putSecret } from './secrets.mjs'
import {
	marketView,
	listTeamSkills,
	listTeamMcp,
	installSkill,
	installMcp,
	uninstallSkill,
	uninstallMcp,
	publishSkill,
	publishMcp,
	publishSkillFromBundle,
	marketSlugs,
	installDefaults,
	shareAsset,
	sharesView,
	pendingShares,
	enableShare,
	rejectShare,
	ledgerView,
	skillMode,
} from './market.mjs'
import { renderMetrics, METRICS_CONTENT_TYPE } from './metrics.mjs'
// 操作日志只有一处来源（库）。别再引 oplog.mjs：它读的是已经停写的 oplog.json。
import {
	openDb,
	visibleSkills,
	marketRev,
	skillBodyForTeam,
	skillBundleForTeam,
	bundleInfoMap,
	teamOfMarketToken,
	ensureMarketToken,
	ensureLlmToken,
	rotateLlmToken,
	setSkillEnabled,
	opsForTeam,
	latestAgentConfig,
	saveAgentConfig,
	agentConfigHistory,
} from './db.mjs'
import { resolveWorkspace } from './workspace.mjs'
import { BUNDLE_LIMITS, buildTarGz, filesDigest } from './bundle.mjs'
import { createAssistantRuntime, inboundPlatform } from './assistant-http.mjs'
import { createStreamManager } from './assistant-stream.mjs'

const TOKEN_FILE = resolve(HERE, 'console-token')
/** 账号服务从这里读每个团队的 dsh token（目录挂载，写单个文件不影响其他团队） */
const TOKEN_DIR = resolve(REPO, 'deploy/auth/tokens')

const cfg = {
	port: Number(process.env.CONSOLE_PORT || 9700),
	host: process.env.CONSOLE_HOST || '0.0.0.0',
	// 休眠策略的全局默认值；每个团队可以在注册表里用 policy 覆盖
	autoSleep: (process.env.CONSOLE_AUTOSLEEP || '1') !== '0',
	idleMs: Number(process.env.CONSOLE_IDLE_MS || 30 * 60_000),
	scanMs: Number(process.env.CONSOLE_SCAN_MS || 5 * 60_000),
	cpuMax: Number(process.env.CONSOLE_CPU_MAX || 2),
	minUptimeMs: Number(process.env.CONSOLE_MIN_UPTIME_MS || 5 * 60_000),
	// 单个团队默认配额；节点预算不够时会拒绝创建，而不是让它们抢同一块内存
	defaultCpus: Number(process.env.CONSOLE_DEFAULT_CPUS || 1.5),
	defaultMemory: process.env.CONSOLE_DEFAULT_MEMORY || '2g',
	// 归档阈值：这么久没有任何访问、且容器不是运行中，就打包回收磁盘。0 表示关闭
	archiveAfterMs: Number(process.env.CONSOLE_ARCHIVE_AFTER_MS || 30 * 24 * 3600_000),
	archiveScanMs: Number(process.env.CONSOLE_ARCHIVE_SCAN_MS || 6 * 3600_000),
	// 对账：容器被手工删掉、或注册表与容器不一致时，靠它自愈
	reconcile: (process.env.CONSOLE_RECONCILE || '1') !== '0',
	reconcileMs: Number(process.env.CONSOLE_RECONCILE_MS || 10 * 60_000),
	snapshotMs: Number(process.env.CONSOLE_SNAPSHOT_MS || 3600_000),
	metricsCacheMs: Number(process.env.CONSOLE_METRICS_CACHE_MS || 5000),
	// 会话同步：把卷里的会话日志增量推到对象层。这是「容器可丢」的前提，
	// 关掉它等于回到「卷是唯一副本」，只在校验脚本里会关
	sessionSync: (process.env.CONSOLE_SESSION_SYNC || '1') !== '0',
	sessionSyncMs: Number(process.env.CONSOLE_SESSION_SYNC_MS || 5 * 60_000),
	// agent 参数（profile 用户层）入库：跟着会话同步一起跑。关掉等于「配置只活在卷里」，
	// 卷一丢（归档 down -v / 换节点）用户配的模型和开关就没了
	agentConfigSync: (process.env.CONSOLE_AGENT_CONFIG_SYNC || '1') !== '0',
	// 产物归因：把容器里抄下来的轮级变更摘要收进库。关掉等于「改了哪些文件」
	// 只在那一台 Host 的内存里活着——会话日志本身只记轮号（见 docs/20）
	artifactSync: (process.env.CONSOLE_ARTIFACT_SYNC || '1') !== '0',
}

const consoleToken = readFileSync(TOKEN_FILE, 'utf8').trim()
if (consoleToken.length < 16) {
	console.error(`console: ${TOKEN_FILE} 太短，删掉重新执行 make console 会重新生成`)
	process.exit(1)
}

/** 累计动作次数，给 /metrics 用。counter 语义：只增不减，进程重启归零是允许的。 */
const counters = { reconcile: 0, rebuild: 0, archive: 0, wake: 0, sleep: 0, snapshot: 0, create: 0, install: 0, publish: 0 }

// ---------- 配额与节点调度 ----------

/** 一个团队的配额，缺省取全局默认值。 */
function quotaOf(team = {}) {
	const cpus = Number(team.quota?.cpus ?? cfg.defaultCpus)
	const memory = String(team.quota?.memory ?? cfg.defaultMemory)
	return { cpus, memory, memGB: memoryGB(memory) }
}

/** 某节点上已分配的配额。归档过的团队不占额度——它的容器和卷都已经回收了。 */
function usedQuota(data, nodeId) {
	let cpu = 0
	let memGB = 0
	for (const team of Object.values(data.teams)) {
		if ((team.node || 'local') !== nodeId) continue
		if (team.archived) continue
		const quota = quotaOf(team)
		cpu += quota.cpus
		memGB += quota.memGB
	}
	return { cpu, memGB }
}

/**
 * 挑一个放得下的节点：按「剩余比例」而不是绝对余量排序。
 *
 * 用剩余比例是为了让大机器多接活、小机器少接，避免 8 核的机器被 2 核的
 * 机器先填满后还继续往上堆。两者都放不下时返回 null，由调用方报具体余量。
 */
function pickNode(data, quota, nodes) {
	const ranked = []
	for (const node of nodes.nodes) {
		const used = usedQuota(data, node.id)
		const cpuLeft = Number(node.cpuBudget) - used.cpu
		const memLeft = Number(node.memBudgetGB) - used.memGB
		if (cpuLeft + 1e-9 < quota.cpus || memLeft + 1e-9 < quota.memGB) continue
		ranked.push({
			node,
			cpuLeft,
			memLeft,
			score: cpuLeft / Number(node.cpuBudget) + memLeft / Number(node.memBudgetGB),
		})
	}
	ranked.sort((a, b) => b.score - a.score)
	return ranked[0] || null
}

/** 预算不足时把每个节点的占用摊开说清楚，别只回一句「资源不足」。 */
function budgetError(data, nodes, quota) {
	const detail = nodes.nodes
		.map((node) => {
			const used = usedQuota(data, node.id)
			return `${node.id} ${used.cpu}/${node.cpuBudget} 核、${used.memGB.toFixed(1)}/${node.memBudgetGB} GB`
		})
		.join('；')
	return new Error(`所有节点都放不下（需要 ${quota.cpus} 核 / ${quota.memGB} GB）。当前占用：${detail}。可以归档闲置团队，或调大 nodes.json 的预算`)
}

/** 端口是否空闲（只看本机回环，Caddy 只绑 127.0.0.1）。 */
function portFree(port) {
	return new Promise((done) => {
		const socket = net.createConnection({ host: '127.0.0.1', port })
		const finish = (free) => {
			socket.destroy()
			done(free)
		}
		socket.setTimeout(400)
		socket.once('connect', () => finish(false))
		socket.once('timeout', () => finish(false))
		socket.once('error', () => finish(true))
	})
}

/** 从节点的端口段里找第一个既没登记也没被占用的端口。 */
async function allocatePort(data, node) {
	const used = new Set(
		Object.values(data.teams)
			.filter((t) => (t.node || 'local') === node.id && t.port)
			.map((t) => Number(t.port)),
	)
	const base = Number(node.portBase)
	const max = Number(node.portMax ?? base + 100)
	for (let port = base; port <= max; port += 1) {
		if (used.has(port)) continue
		if (await portFree(port)) return port
	}
	throw new Error(`节点 ${node.id} 没有空闲端口（${base}-${max} 都被占了）`)
}

// ---------- 运维态 ----------

const state = loadState()

// 唤醒是幂等的：多个浏览器同时点进来只会拉起一次
const waking = new Map()
// 正在被改动（创建/休眠/唤醒/归档）的实例，定时器不碰
const busy = new Set()

// 创建是重活：串行执行，避免两个请求抢同一个端口或互相覆盖注册表
let queue = Promise.resolve()
const serial = (task) => {
	const next = queue.then(task, task)
	queue = next.catch(() => {})
	return next
}

// ---------- 动作 ----------

function wakeTeam(team) {
	const inflight = waking.get(team)
	if (inflight) return inflight
	const task = (async () => {
		const before = await containerState(team)
		if (before.running && before.health === 'healthy') return { woke: false }
		const node = nodeOf(team)
		console.log(`console: 唤醒 ${team}（当前 ${before.health}）`)
		// 先把卷里缺的会话从对象层补回来，再让 dsh 起来。
		// 顺序反了就是「dsh 先扫一个空的 sessions/，侧栏全空」——用户看到的是历史丢了。
		// 只在卷已存在时做：卷不存在意味着这是新建或归档过，会走 provision/restore 那条路，
		// 这里凭空 `-v` 一个卷会把它建成 root 所有，dsh 用户写不进去。
		if (cfg.sessionSync && (await sessionVolumeExists(team))) {
			try {
				const back = await restoreSessions({ team })
				if (back.restored.length) console.log(`console: 唤醒前补回 ${back.restored.length} 个会话（${team}）`)
				if (back.failed) console.error(`console: ${team} 有 ${back.failed} 个会话补回失败`)
			} catch (error) {
				// 补不回来也要让它起来：宁可这次少几个历史，也别整个团队进不去
				console.error(`console: 唤醒前补会话失败 ${team}`, error.message)
			}
		}
		await wakeInstance({ team, node })
		delete state.asleep[team]
		saveStateSoon(state)
		counters.wake += 1
		return { woke: true }
	})().finally(() => waking.delete(team))
	waking.set(team, task)
	return task
}

/** 团队登记的节点。找不到时退化成默认 compose 节点，让旧注册表继续可用。 */
function nodeOf(teamId) {
	const team = registry().teams[teamId]
	const nodes = loadNodes()
	const id = team?.node || 'local'
	return nodes.nodes.find((n) => n.id === id) || { id: 'local', provider: 'compose', portBase: 8082, portMax: 8180 }
}

/**
 * 改团队的休眠策略。
 *
 * 为什么要有这个接口：`policy` 一直只能手改 `accounts.json`——写错一个字段没有任何校验，
 * 团队侧也看不到自己是什么策略。「一两个团队长期在线」是个正当需求，得能配。
 *
 * 只允许改 autoSleep 与 idleMs 两项：配额（quota）改起来要重算节点预算，属于另一条路。
 *
 * @param {string} teamId
 * @param {{autoSleep?:boolean, idleMs?:number}} input
 * @returns {Promise<{team:string, policy:object}>}
 */
async function setTeamPolicy(teamId, input) {
	return serial(async () => {
		const data = registry()
		const team = data.teams[teamId]
		if (!team) throw new Error(`团队 ${teamId} 不存在`)
		const policy = {
			autoSleep: team.policy?.autoSleep !== false,
			idleMs: Number(team.policy?.idleMs ?? cfg.idleMs),
		}
		if ('autoSleep' in input) {
			if (typeof input.autoSleep !== 'boolean') throw new Error('autoSleep 必须是布尔值')
			policy.autoSleep = input.autoSleep
		}
		if ('idleMs' in input) {
			const value = Number(input.idleMs)
			// 太短会在用户眼皮底下反复醒睡；太长等于事实上的常驻，不如直接 autoSleep=false
			if (!Number.isFinite(value) || value < 5 * 60_000 || value > 30 * 24 * 3600_000) {
				throw new Error('idleMs 必须在 5 分钟（300000）到 30 天之间')
			}
			policy.idleMs = Math.round(value)
		}
		data.teams[teamId].policy = policy
		saveRegistry(data)
		console.log(`console: ${teamId} 策略改为 autoSleep=${policy.autoSleep} idleMs=${human(policy.idleMs)}`)
		return { team: teamId, policy }
	})
}

async function sleepTeam(team, reason) {
	busy.add(team)
	try {
		// 睡前把尾巴强制推上去。睡着了 CPU/IO 归零，下一次访问可能在几天后；
		// 这期间如果容器被重建、卷被清，没推上去的那一段就永久没了。
		if (cfg.sessionSync) {
			try {
				const synced = await syncSessions({ team, force: true })
				if (synced.uploadedBytes) console.log(`console: 睡前同步 ${team} ${synced.uploadedBytes} 字节会话数据`)
				if (synced.failed) console.error(`console: ${team} 有 ${synced.failed} 个会话同步失败，休眠继续`)
			} catch (error) {
				// 同步失败不该阻止休眠：睡不着的代价（内存白占）比丢一小段尾巴更确定
				console.error(`console: 睡前同步失败 ${team}`, error.message)
			}
		}
		// agent 参数跟着一起收：卷里只有「最近一次启动合并后的用户层」，睡着了就没人再写了。
		// 和会话同步同源同理由——睡下之后可能几天没人访问。
		if (cfg.agentConfigSync) {
			try {
				const saved = await captureAgentConfig({ team, db: openDb() })
				if (saved?.revision && !saved.unchanged) console.log(`console: ${team} agent 参数入库 r${saved.revision}`)
			} catch (error) {
				console.error(`console: ${team} agent 参数入库失败`, error.message)
			}
		}
		await sleepInstance({ team, node: nodeOf(team) })
		state.asleep[team] = { since: new Date().toISOString(), reason }
		saveStateSoon(state)
		counters.sleep += 1
		console.log(`console: 休眠 ${team}（${reason}）`)
	} finally {
		busy.delete(team)
	}
}

/** 建团队：算配额 → 选节点 → 分配口 → 写注册表 → 真起容器 → 回填入口。 */
async function createTeam({ id, name, desc, owner, cpus, memory }) {
	return serial(async () => {
		const data = registry()
		if (data.teams[id]) throw new Error(`团队 ${id} 已存在`)
		if (!data.users[owner]) throw new Error(`用户 ${owner} 不存在`)

		const nodes = loadNodes()
		const quota = quotaOf({ quota: { cpus: cpus ?? cfg.defaultCpus, memory: memory ?? cfg.defaultMemory } })
		const fit = pickNode(data, quota, nodes)
		if (!fit) throw budgetError(data, nodes, quota)

		const node = fit.node
		const port = node.provider === 'helm' ? null : await allocatePort(data, node)
		data.teams[id] = {
			name,
			desc,
			host: node.provider === 'helm' ? `${id}.${node.domain}` : `${id}.localhost`,
			port,
			node: node.id,
			owner,
			// 团队内的角色表：同一个人可以是 A 组 owner、B 组普通成员，
			// 所以角色挂在团队上而不是账号上。建团队的人默认是 owner。
			roles: { [owner]: 'owner' },
			quota: { cpus: quota.cpus, memory: quota.memory },
			policy: { autoSleep: true, idleMs: cfg.idleMs },
			desired: 'running',
			createdBy: owner,
			createdAt: new Date().toISOString(),
		}
		data.users[owner].teams = [...new Set([...(data.users[owner].teams || []), id])]
		saveRegistry(data)

		try {
			const ready = await provision({ team: id, node, port, quota })
			const after = registry()
			after.teams[id].url = ready.url
			saveRegistry(after)
			state.lastSeen[id] = Date.now()
			saveStateSoon(state)
			counters.create += 1

			// 新团队默认包：默认什么都不装，配了才装。失败不回滚团队（见 installDefaults 注释）
			let pkg = { installed: [], failed: [] }
			try {
				pkg = await installDefaults(id)
				if (pkg.needsRestart) await restartDsh(id)
			} catch (error) {
				console.error(`console: ${id} 装默认包失败`, error.message)
			}
			if (pkg.installed.length || pkg.failed.length) {
				console.log(`console: ${id} 默认包 installed=${pkg.installed.length} failed=${pkg.failed.length}`)
			}

			snapshot(`create:${id}`)
			return {
				id,
				name,
				port,
				url: ready.url,
				node: node.id,
				quota: { cpus: quota.cpus, memory: quota.memory },
				packages: pkg,
			}
		} catch (error) {
			// 建失败就把注册表回滚，别让门户里留一个点不开的卡片；容器留着方便排查
			const rollback = registry()
			delete rollback.teams[id]
			if (rollback.users[owner]) {
				rollback.users[owner].teams = (rollback.users[owner].teams || []).filter((t) => t !== id)
			}
			saveRegistry(rollback)
			throw new Error(`${error.message}\n（注册表已回滚；容器如需清理：./deploy/compose/team-up.sh destroy ${id}）`)
		}
	})
}

/**
 * 对账：让「注册表 / 运维态 / 真实容器」三边一致。
 *
 * fix=false 只报告，fix=true 才动手。分开的原因是：重建容器是重操作，
 * 排查问题时需要一个「只看不动」的视角。
 */
/**
 * 对齐 dsh token：容器里的真实 token 与账号服务持有的副本。
 *
 * 为什么需要这个：dsh 每次启动随机生成 token，只打印在日志里。正常起停都走 team-up.sh
 * （会顺手 sync），但容器崩溃后自动重启、或有人手工 docker restart 就绕过了这一步。
 * 结果是「登录成功 → 跳转 → 401」，页面上没有任何提示，只有账号服务日志里能找到线索。
 *
 * 先读尾部日志判断副本是否还有效；不匹配再读全量——启动那一行通常在最前面，
 * 而日志随运行时间增长，每次都读全量太浪费。
 */
async function syncTokens(report, live, fix) {
	for (const [team, st] of Object.entries(live)) {
		if (!st.running) continue
		const file = resolve(TOKEN_DIR, team)
		let current = ''
		try {
			current = readFileSync(file, 'utf8').trim()
		} catch {
			/* 没同步过 */
		}

		const tail = await run('docker', ['logs', '--tail', '2000', st.container], 30_000)
		let all = tail.out
		if (current && all.includes(`token=${current}`)) continue
		const full = await run('docker', ['logs', st.container], 60_000)
		if (full.code === 0) all = full.out

		const matches = all.match(/token=([A-Za-z0-9_-]+)/g)
		if (!matches?.length) continue
		const latest = matches[matches.length - 1].slice('token='.length)
		if (latest === current) continue

		report.tokenDrift.push({ team, hadFile: Boolean(current) })
		if (!fix) continue
		try {
			mkdirSync(TOKEN_DIR, { recursive: true })
			writeFileSync(file, latest)
			report.tokenFixed.push(team)
			console.log(`console: 已对齐 ${team} 的 dsh token（原副本已失效）`)
		} catch (error) {
			report.failed.push({ team, error: `写 token 失败：${error.message}` })
		}
	}
}

async function reconcile({ fix = false, cleanupVolumes = false } = {}) {
	const data = registry()
	const nodes = loadNodes()
	const live = await allStates()
	const report = {
		mode: fix ? 'fix' : 'dry-run',
		checked: 0,
		missing: [],
		rebuilt: [],
		failed: [],
		orphans: [],
		orphanVolumes: [],
		volumesRemoved: [],
		stateFixed: [],
		tokenDrift: [],
		tokenFixed: [],
	}

	for (const [id, team] of Object.entries(data.teams)) {
		report.checked += 1
		if (team.archived) continue

		const st = live[id]
		if (!st?.exists) {
			report.missing.push(id)
			if (!fix) continue
			// 被显式 down 掉的不拉起：那是人的决定，不是故障
			if (team.desired === 'down') continue
			const outcome = await rebuildOne(id, nodes, report)
			if (outcome) report.rebuilt.push(id)
			continue
		}

		// 漂移修正：state.json 只是缓存，容器才是事实
		if (st.running && state.asleep[id]) {
			delete state.asleep[id]
			report.stateFixed.push(id)
		} else if (!st.running && !state.asleep[id]) {
			state.asleep[id] = { since: new Date().toISOString(), reason: 'reconciled（容器确实已停）' }
			report.stateFixed.push(id)
		}
	}

	// 反方向：state 里记着注册表已经没有的团队（团队被删、或早期版本留下的记录）。
	// state 是缓存、注册表才是事实，直接清掉，别让它一直参与 idle 计算与指标。
	const data2 = registry()
	for (const id of Object.keys(state.lastSeen)) {
		if (data2.teams[id]) continue
		delete state.lastSeen[id]
		delete state.asleep[id]
		report.stateFixed.push(`pruned:${id}`)
	}

	// 容器在跑但注册表里没有它 → 孤儿。只报告，不自动删——
	// 里面可能有别人正在用的会话，删错了无法恢复。
	for (const project of await projectList()) {
		const id = project.slice(4)
		if (!data2.teams[id]) report.orphans.push({ team: id, project })
	}

	// 卷级孤儿：项目已经没了（或被改名），卷还在占盘。这是磁盘被慢慢吃满的主因
	for (const { volume, project, kind } of await volumeList()) {
		const id = project.replace(/^dsh-/, '')
		const known = data2.teams[id]
		if (known && !known.archived) continue
		report.orphanVolumes.push({ volume, team: id, kind })
	}

	if (fix && cleanupVolumes) {
		for (const { volume } of report.orphanVolumes) {
			// 有容器（含已停止的）挂着它就不能删：docker volume rm 会失败，
			// 但更糟的是「删成功一半」之后那个容器再也起不来。先查一遍再动手。
			const holders = await run('docker', ['ps', '-a', '--filter', `volume=${volume}`, '--format', '{{.Names}}'], 15_000)
			if (holders.code === 0 && holders.out.trim()) {
				report.failed.push({ volume, error: `仍被容器使用：${holders.out.trim().split('\n').join(', ')}` })
				continue
			}
			const removed = await run('docker', ['volume', 'rm', volume], 30_000)
			if (removed.code === 0) report.volumesRemoved.push(volume)
			else report.failed.push({ volume, error: removed.out.trim().slice(-300) })
		}
	}

	// token 漂移：dsh 每次启动都随机生成 token，账号服务靠 deploy/auth/tokens/<team>
	// 把它换成 dsh Cookie。容器崩溃自动重启、手工 docker restart 都不经过 team-up.sh，
	// 那份副本就过期了——表现是「登录成功但进不去首页」，用户看不出原因。
	await syncTokens(report, live, fix)

	if (report.stateFixed.length) saveStateSoon(state)
	if (fix) {
		counters.reconcile += 1
		snapshot('reconcile')
	}
	return report
}

/** 重建单个团队。端口被占就换一个并写回注册表，避免「修好了但入口还是错的」。 */
async function rebuildOne(teamId, nodes, report) {
	try {
		const team = registry().teams[teamId]
		const node = nodes.nodes.find((n) => n.id === (team.node || 'local'))
		if (!node) throw new Error(`节点 ${team.node} 不在 nodes.json 里`)
		const quota = quotaOf(team)
		let port = team.port
		if (node.provider !== 'helm' && (!port || !(await portFree(port)))) {
			port = await allocatePort(registry(), node)
			const patch = registry()
			patch.teams[teamId].port = port
			patch.teams[teamId].host = `${teamId}.localhost`
			saveRegistry(patch)
			console.log(`console: ${teamId} 原端口不可用，改分配到 ${port}`)
		}
		console.log(`console: 对账发现 ${teamId} 容器缺失，开始重建（端口 ${port ?? 'ingress'}）`)
		await provision({ team: teamId, node, port, quota })
		counters.rebuild += 1
		return true
	} catch (error) {
		report.failed.push({ team: teamId, error: error.message })
		console.error(`console: 重建 ${teamId} 失败`, error.message)
		return false
	}
}

/** 归档：打包 → 删容器 → 删卷 → 包进对象层，注册表留一条可恢复的记录。 */
async function archiveTeam(teamId, reason = 'manual') {
	const data = registry()
	const team = data.teams[teamId]
	if (!team) throw new Error(`团队 ${teamId} 不存在`)
	if (team.archived) return { skipped: 'already-archived', archived: team.archived.key || team.archived.file }

	busy.add(teamId)
	try {
		const stored = await archiveInstance({ team: teamId, node: nodeOf(teamId), reason })
		const after = registry()
		// stored 有两种形态：对象层三元组（key/digest/bytes）或降级后的本机 file。
		// 一起摊进来，恢复时按有没有 key 分流，老记录（只有 file）也还能用。
		after.teams[teamId] = {
			...after.teams[teamId],
			archived: { at: new Date().toISOString(), ...stored, reason },
			desired: 'down',
		}
		saveRegistry(after)
		delete state.asleep[teamId]
		saveStateSoon(state)
		counters.archive += 1
		const where = stored.key ? `对象 ${stored.key}（${stored.bytes} 字节）` : `本机文件 ${stored.file}`
		console.log(`console: 已归档 ${teamId} → ${where}`)
		// archived 保持「一个字符串」的旧形态给调用方（Makefile 直接 curl，auth 只关心成功否），
		// 结构化字段另放，免得改坏已有读取方
		return {
			archived: stored.key || stored.file,
			key: stored.key,
			digest: stored.digest,
			bytes: stored.bytes,
			file: stored.file,
			degraded: stored.degraded,
		}
	} finally {
		busy.delete(teamId)
	}
}

/** 从归档恢复：把卷解出来，再按注册表里的配额与入口重新起实例。 */
async function restoreTeam(teamId) {
	return serial(async () => {
		const data = registry()
		const team = data.teams[teamId]
		if (!team) throw new Error(`团队 ${teamId} 不存在`)
		if (!team.archived) throw new Error(`团队 ${teamId} 没有归档记录`)

		const source = team.archived
		// 新版记录只有对象键，老记录只有本机文件。缺哪个就查哪个，
		// 报错里带上具体标识，否则「归档不存在」这句话在两种形态下都无法定位。
		if (source.key) {
			if (!objectExists(source.key)) throw new Error(`归档对象不存在：${source.key}`)
			// 顺手校验大小：对象被截断时 tar 解到一半才报错，先拦下来更好定位
			const meta = statObject(source.key)
			if (source.bytes && meta && meta.bytes !== source.bytes) {
				throw new Error(`归档对象大小不符：记录 ${source.bytes} 字节，实际 ${meta.bytes} 字节（${source.key}）`)
			}
		} else if (source.file) {
			if (!existsSync(source.file)) throw new Error(`归档文件不存在：${source.file}`)
		} else {
			throw new Error(`团队 ${teamId} 的归档记录里既没有对象键也没有文件路径`)
		}

		const node = nodeOf(teamId)
		const quota = quotaOf(team)
		const port = node.provider === 'helm' ? null : team.port || (await allocatePort(data, node))
		const ready = await restoreInstance({
			team: teamId,
			node,
			port,
			quota,
			source,
			// 解包完、容器起来之前：把库里最新一版 agent 参数写回卷，让新容器合并时用上
			beforeStart: async () => {
				if (!cfg.agentConfigSync) return
				try {
					const applied = await applyAgentConfig({ team: teamId, db: openDb() })
					if (applied?.revision) console.log(`console: 恢复时注入 ${teamId} 的 agent 参数 r${applied.revision}`)
				} catch (error) {
					console.error(`console: 注入 ${teamId} 的 agent 参数失败`, error.message)
				}
			},
		})

		const after = registry()
		delete after.teams[teamId].archived
		after.teams[teamId].desired = 'running'
		after.teams[teamId].port = port
		after.teams[teamId].url = ready.url
		// 老注册表可能没有这两项（配额与策略是后加的），恢复时顺手补齐
		after.teams[teamId].quota ||= { cpus: quota.cpus, memory: quota.memory }
		after.teams[teamId].policy ||= { autoSleep: true, idleMs: cfg.idleMs }
		after.teams[teamId].restoredAt = new Date().toISOString()
		saveRegistry(after)
		state.lastSeen[teamId] = Date.now()
		saveStateSoon(state)
		console.log(`console: 已恢复 ${teamId}（端口 ${port ?? 'ingress'}）`)
		return { restored: teamId, port }
	})
}

// ---------- 技能与连接器 ----------

/**
 * 装/卸包都要写团队的卷，而写卷要用 docker exec——容器停着就没有进程可 exec。
 * 所以这里先把实例叫醒，装完保持醒着（用户下一步多半就是去用它）。
 */
async function ensureAwake(team) {
	const st = await containerState(team)
	if (st.running) return { woke: false }
	if (!st.exists) throw new Error(`团队 ${team} 的容器不存在，先在对账里重建`)
	await wakeTeam(team)
	return { woke: true }
}

/**
 * 让 dsh 重新读配置。
 *
 * 两种力度，选错了只有两个后果：白等 35 秒，或者「看起来成功了但没生效」。
 *
 *   reload   —— `docker restart`：只重启进程，容器不重建。5 秒级。
 *               用在**只改了 profile 配置**的场景（装/卸连接器、改 agent 参数）。
 *               cordis.patch.yml 是启动时读的，重启进程就够了。
 *   recreate —— `compose up --force-recreate`：重建容器。40 秒级。
 *               必须用它的场景：改了 env（环境变量只在创建容器时注入）、换镜像、改挂载。
 *               用 restart 顶替会**沿用旧 env**，比如改团队模型 key 会静默不生效。
 *
 * 卷不动，所以会话、技能、凭据都还在。
 *
 * @param {string} team 团队 id
 * @param {'reload'|'recreate'} [mode] 重载力度，默认 recreate（保守）
 */
async function restartDsh(team, mode = 'recreate') {
	const node = nodeOf(team)
	if (node.provider === 'helm') {
		const result = await run('kubectl', ['-n', 'ai-tools', 'rollout', 'restart', `deploy/dsh-${team}`], 120_000)
		if (result.code !== 0) throw new Error(`rollout restart 失败：${result.out.slice(-500)}`)
		// kubectl rollout restart 会重建 Pod，环境变量从 Deployment 来，改 values 后需要 helm upgrade
		return
	}
	const t = registry().teams[team]
	if (!t) throw new Error(`团队 ${team} 不在注册表里`)
	if (!t.port) throw new Error(`团队 ${team} 没有登记端口，无法重建实例`)
	if (mode === 'reload') {
		const restarted = await run('docker', ['restart', `dsh-${team}-dsh-1`], 120_000)
		if (restarted.code !== 0) {
			// 容器不见了/被手工删了：退回重建，这比重启失败更有用
			console.error(`console: ${team} restart 失败，退回重建：${restarted.out.slice(-200)}`)
		} else {
			await waitHealthy(t.port, 90_000)
			delete state.asleep[team]
			saveStateSoon(state)
			return
		}
	}
	await provision({ team, node, port: t.port, quota: quotaOf(t) })
	delete state.asleep[team]
	saveStateSoon(state)
}

/** 等一小会儿。装包后的「已生效」探测要按固定间隔轮询。 */
const delay = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * 等一次 profile 改动真正生效。
 *
 * 判据（stdio 子进程 / HMR 窗口 + 配置树）与「有多确定」的语义都在 reload.mjs，
 * 这里只把它接上 docker：容器名固定是 `dsh-<team>-dsh-1`。
 */
const waitPatchApplied = createReloadWaiter({
	exec: (args, timeoutMs) => run('docker', args, timeoutMs),
	delay,
})

/**
 * 装/卸连接器后的「落地」流程。
 *
 * 改动写在团队的 `cordis.patch.yml` 里，web 组合包开着 HMR，改完 2 秒级就重组生效——
 * 不需要重建容器（那是 40 秒 + 把用户踢下线）。只有热重载确实没生效时才退回
 * `docker restart`（5 秒），而不是一上来就重建。
 *
 * 返回体里 `restartRequired` 一律置 false：调用方（门户）据此决定要不要提示
 * 「正在重启」，这个字段的语义是「还需要重启吗」，不是「我们刚才做了什么」。
 *
 * @param {string} team 团队 id
 * @param {object} result market.mjs 的返回值
 * @returns {Promise<object>} 带 reload 结果的对象
 */
async function applyPackageChange(team, result) {
	if (!result?.restartRequired) return result
	const reload = await waitPatchApplied(team, result.probe, result.expect || 'present')
	if (reload.applied) {
		console.log(`console: ${team} 配置热重载生效（${reload.basis}，${reload.waitedMs}ms）`)
		return { ...result, restartRequired: false, reload }
	}
	console.log(`console: ${team} 热重载未在窗口内生效，退回重启进程`)
	await restartDsh(team, 'reload')
	return { ...result, restartRequired: false, reload: { ...reload, fallback: 'restart' } }
}

/**
 * 一个团队的包全景：已装的（读卷，休眠时退回台账）+ 市场里有什么（标出是否已装）。
 */
async function packagesView(team) {
	const [skills, mcps] = await Promise.all([listTeamSkills(team), listTeamMcp(team)])
	const view = await marketView(team)
	return {
		team,
		installed: {
			skills: skills.skills,
			mcp: mcps.mcp,
			stale: skills.stale || mcps.stale,
			// detail 给面板用：一行一个已装项，带 enabled/version/source。
			// 门户只读上面的名字数组，面板要画启停按钮，才需要这一层。
			detail: { skills: skills.detail || [], mcp: mcps.detail || [] },
		},
		// origins 让门户能标出「这个包是别人分享进来的」——分享不进市场，只有台账知道
		origins: ledgerView(team),
		shares: sharesView(team).slice(0, 20),
		// 待接收：分享默认不生效，接收方在这里看到「谁给的、备注是什么」，点启用才写卷
		pending: pendingShares(team),
		ops: opsForTeam(openDb(), team, 40),
		...(skills.error ? { skillError: skills.error } : {}),
		...(mcps.error ? { mcpError: mcps.error } : {}),
		market: view.market,
		updatedAt: view.updatedAt,
	}
}

// ---------- HTTP ----------

const json = (res, status, body) => {
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
	res.end(`${JSON.stringify(body, null, 2)}\n`)
}

async function readJson(req, limit = 16 * 1024) {
	let size = 0
	const chunks = []
	for await (const chunk of req) {
		size += chunk.length
		if (size > limit) throw new Error('body too large')
		chunks.push(chunk)
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

// 懒创建：openDb() 会跑 schema 初始化，别在模块加载阶段就触发。
let assistantRuntime = null
const assistants = () => (assistantRuntime ??= createAssistantRuntime({ db: openDb(), json, readJson }))

/** 钉钉 Stream 长连接管理器，进程内只允许一个。 */
let streamManager = null

/**
 * 起钉钉 Stream 入站通道。
 *
 * 走这条路就不需要公网回调：控制面用 AppKey/AppSecret 主动连钉钉网关，
 * 消息从长连接推下来，出站仍走 sessionWebhook 或配置的群机器人。
 *
 * 启动失败只记日志不退出：控制面还要负责容器调度，不能被 IM 连接拖死。
 *
 * @returns {object} 管理器实例
 */
function startAssistantStreams() {
	if (streamManager) return streamManager
	const runtime = assistants()
	streamManager = createStreamManager({
		db: openDb(),
		dispatcher: runtime.dispatcher,
		secret: (team, scope, key) => getSecret(openDb(), { team, scope, key }),
		log: (message) => console.log(`console: ${message}`),
	})
	// 助理增删改（尤其是刚填完凭据）立刻生效，不用重启控制面
	runtime.onChange = () => {
		streamManager.reload().catch((error) => console.error(`console: Stream 重载失败：${error.message}`))
	}
	streamManager.reload().catch((error) => console.error(`console: Stream 启动失败：${error.message}`))
	return streamManager
}

/**
 * 读原始字节（上传包用）。体积上限单独给，不走 readJson 的 16 KB。
 *
 * 超限时**边读边断开**：不能等收完再判断，那样一个 1 GB 的 body 也已经落到内存里了。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Buffer>}
 */
async function readBytes(req, limit) {
	let size = 0
	const chunks = []
	for await (const chunk of req) {
		size += chunk.length
		if (size > limit) {
			req.destroy()
			throw Object.assign(new Error(`包体积超过上限 ${limit} 字节`), { status: 413 })
		}
		chunks.push(chunk)
	}
	return Buffer.concat(chunks)
}

let metricsCache = { at: 0, body: '' }

/**
 * 市场只读接口：dsh 里的 provider 插件用它拉「本团队可见的技能」。
 *
 * 身份**只**从 `Authorization: Bearer` 推导，不接受 `?team=`。理由：允许传 team 的话，
 * team-c 的容器改一个 query 参数就能读到 team-a 的私有技能——那就是上一轮分享功能
 * 特意堵掉的越权路径。token 是每团队一枚、只读、可吊销的，拿不到 console-token 的权限。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 */
async function handleMarketApi(req, res, url) {
	const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
	const db = openDb()
	const team = teamOfMarketToken(db, token)
	if (!team) return json(res, 401, { error: 'market token 无效或已吊销' })

	if (url.pathname === '/market/skills') {
		if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
		const rows = visibleSkills(db, team)
		const bundles = bundleInfoMap(
			db,
			rows.map((r) => r.item_id),
		)
		return json(res, 200, {
			team,
			// rev 只随「装了哪个版本 / 开没开」变，不随正文变：插件据此决定要不要 invalidate
			rev: marketRev(db, team),
			items: rows.map((r) => {
				const info = bundles.get(r.item_id) || { count: 0, size: 0, hasBundle: false }
				return {
					name: r.name,
					version: r.version,
					title: r.title,
					description: r.description,
					whenToUse: r.when_to_use || undefined,
					rank: r.rank,
					digest: r.digest,
					// 定锚：列表看到的版本和后面 get() 拿到正文的版本必须是同一个
					locator: `${r.name}@${r.version}`,
					// 插件据此决定「拉纯文本」还是「拉 bundle 物化落盘」。
					// 只有单个 SKILL.md 的包不打 tar：700 字节打成 gz 只会更慢。
					bundle: { hasBundle: info.hasBundle, size: info.size, count: info.count, digest: r.digest },
				}
			}),
		})
	}

	const rest = url.pathname.slice('/market/skills/'.length).split('/').filter(Boolean)
	if (rest.length === 3 && rest[2] === 'bundle') {
		if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
		const [name, version] = rest.map(decodeURIComponent)
		const found = skillBundleForTeam(db, team, name, version)
		// 与读正文同一条闸门、同样不区分 404 的原因
		if (!found) return json(res, 404, { error: 'not found' })
		const tar = buildTarGz(found.files)
		res.writeHead(200, {
			'Content-Type': 'application/gzip',
			'Content-Length': tar.length,
			'Cache-Control': 'no-store',
			// 客户端解开后自己算一遍清单摘要，对不上就丢弃——这样传输中被改过的包进不了缓存。
			// 两个都发：digest 是包的版本指纹（缓存键用），manifest 是文件清单指纹（校验用）。
			'X-Dsh-Digest': found.digest || '',
			'X-Dsh-Manifest': filesDigest(found.files),
			'X-Dsh-Files': String(found.files.length),
		})
		return res.end(tar)
	}
	if (rest.length !== 2) return json(res, 404, { error: 'not found' })
	if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
	const [name, version] = rest.map(decodeURIComponent)
	const body = skillBodyForTeam(db, team, name, version)
	// 没装 / 没启用 / 版本对不上，三种情况都回 404，不区分：区分等于告诉对方这个包存在
	if (!body) return json(res, 404, { error: 'not found' })
	res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
	return res.end(body.content)
}

/** 组装 Prometheus 指标。docker stats 有 1~2 秒开销，缓存几秒，别让抓取打穿控制面。 */
async function buildMetrics() {
	if (metricsCache.body && Date.now() - metricsCache.at < cfg.metricsCacheMs) return metricsCache.body
	const data = registry()
	const nodes = loadNodes()
	const live = await allStates()
	const stats = await statsMap(Object.keys(data.teams).map((id) => `dsh-${id}-dsh-1`))
	const rows = {}
	for (const [id, team] of Object.entries(data.teams)) {
		const st = live[id] || { exists: false, running: false, health: 'missing' }
		const stat = stats[`dsh-${id}-dsh-1`]
		const quota = quotaOf(team)
		rows[id] = {
			running: st.running,
			health: st.health,
			cpu: st.running ? stat?.cpu ?? 0 : 0,
			memBytes: st.running ? stat?.memBytes ?? 0 : 0,
			idleSec: state.lastSeen[id] ? Math.round((Date.now() - state.lastSeen[id]) / 1000) : null,
			asleepSince: state.asleep[id]?.since || null,
			quota,
			node: team.node || 'local',
			archived: Boolean(team.archived),
		}
	}
	const quota = { cpuUsed: 0, cpuBudget: 0, memUsedGB: 0, memBudgetGB: 0 }
	for (const node of nodes.nodes) {
		const used = usedQuota(data, node.id)
		quota.cpuUsed += used.cpu
		quota.cpuBudget += Number(node.cpuBudget)
		quota.memUsedGB += used.memGB
		quota.memBudgetGB += Number(node.memBudgetGB)
	}
	metricsCache = { at: Date.now(), body: renderMetrics({ teams: rows, quota, counters }) }
	return metricsCache.body
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, 'http://console')
	try {
		if (url.pathname === '/health') return json(res, 200, { ok: true })

		// 模型网关：鉴权用「每团队一枚的网关 token」，不是 console-token，
		// 所以必须排在下面那层校验之前，否则容器根本进不来。
		if (url.pathname === '/llm' || url.pathname.startsWith('/llm/')) {
			const handled = await handleLlmGateway(req, res, {
				db: openDb(),
				upstream: process.env.DSH_LLM_UPSTREAM,
				onAudit: (entry) => {
					// 只记元信息，绝不记 body：里面是用户的对话内容
					if (entry.status >= 400) {
						console.log(
							`console: 网关 ${entry.team} ${entry.path} → ${entry.status}` +
								`${entry.reason ? `（${entry.reason}）` : ''}${entry.ms ? ` ${entry.ms}ms` : ''}`,
						)
					}
				},
			})
			if (handled) return
		}

		// 市场只读接口走「每团队一枚的 market token」，必须在 console-token 校验之前：
		// 反过来会让插件持有能建团队/删团队的凭证，最小权限就破了。
		if (url.pathname === '/market/skills' || url.pathname.startsWith('/market/skills/')) {
			return await handleMarketApi(req, res, url)
		}

		// 助理入站回调：钉钉/飞书不会带 X-Console-Token，必须排在下面那层校验之前，
		// 由 assistant-http.mjs 自己做加签/token 校验（密钥没配一律拒绝）。
		const inbound = inboundPlatform(url.pathname)
		if (inbound) return await assistants().handleInbound(req, res, inbound)

		// Prometheus 只会发 Authorization: Bearer，grafana-agent 之类也走这个；
		// 自定义头 X-Console-Token 留给 curl / 账号服务用。两种都认。
		const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
		const provided = req.headers['x-console-token'] || bearer
		if (provided !== consoleToken) return json(res, 401, { error: 'unauthorized' })

		// 助理管理接口走 console-token。放在最前面，避免 /assistants/:id 被后面的
		// 通用路由（如 /sessions/:id/...）误匹配。
		if (url.pathname.startsWith('/assistants')) {
			if (await assistants().handleAdmin(req, res, url)) return
		}

		if (url.pathname === '/teams' && req.method === 'GET') {
			return json(res, 200, { teams: registry().teams })
		}

		if (url.pathname === '/nodes' && req.method === 'GET') {
			const data = registry()
			const nodes = loadNodes()
			return json(res, 200, {
				nodes: nodes.nodes.map((node) => {
					const used = usedQuota(data, node.id)
					return {
						...node,
						used: { cpus: used.cpu, memGB: Number(used.memGB.toFixed(2)) },
						free: {
							cpus: Number((Number(node.cpuBudget) - used.cpu).toFixed(2)),
							memGB: Number((Number(node.memBudgetGB) - used.memGB).toFixed(2)),
						},
						teams: Object.keys(data.teams).filter((id) => (data.teams[id].node || 'local') === node.id),
					}
				}),
			})
		}

		// 账号服务在每次 verify 里调，只更新一个时间戳；节流在调用侧做
		if (url.pathname === '/touch' && req.method === 'POST') {
			const body = await readJson(req)
			const team = String(body.team || '')
			if (!registry().teams[team]) return json(res, 404, { error: `团队 ${team} 不在注册表里` })
			state.lastSeen[team] = Date.now()
			delete state.asleep[team]
			saveStateSoon(state)
			return json(res, 200, { ok: true })
		}

		if (url.pathname === '/wake-state' && req.method === 'GET') {
			const team = String(url.searchParams.get('team') || '')
			if (!registry().teams[team]) return json(res, 404, { error: `团队 ${team} 不在注册表里` })
			const st = await containerState(team)
			return json(res, 200, {
				team,
				running: st.running,
				health: st.health,
				asleep: !st.running,
				waking: waking.has(team),
			})
		}

		// 异步唤醒：立刻返回，调用方靠 /wake-state 轮询。别让 HTTP 请求挂 60 秒。
		if (url.pathname === '/wake' && req.method === 'POST') {
			const body = await readJson(req)
			const team = String(body.team || '')
			if (!registry().teams[team]) return json(res, 404, { error: `团队 ${team} 不在注册表里` })
			const st = await containerState(team)
			if (st.running && st.health === 'healthy') {
				delete state.asleep[team]
				state.lastSeen[team] = Date.now()
				saveStateSoon(state)
				return json(res, 200, { status: 'ready' })
			}
			if (waking.has(team)) return json(res, 202, { status: 'waking' })
			wakeTeam(team).catch((error) => console.error(`console: 唤醒 ${team} 失败`, error.message))
			return json(res, 202, { status: 'waking' })
		}

		if (url.pathname === '/sleep' && req.method === 'POST') {
			const body = await readJson(req)
			const team = String(body.team || '')
			if (!registry().teams[team]) return json(res, 404, { error: `团队 ${team} 不在注册表里` })
			await sleepTeam(team, String(body.reason || 'manual'))
			return json(res, 200, { status: 'asleep' })
		}

		if (url.pathname === '/state' && req.method === 'GET') {
			const data = registry()
			const live = await allStates()
			const rows = {}
			for (const [id, team] of Object.entries(data.teams)) {
				const st = live[id] || { exists: false, running: false, health: 'missing', startedAt: 0 }
				const policy = team.policy || {}
				rows[id] = {
					running: st.running,
					health: st.health,
					node: team.node || 'local',
					quota: quotaOf(team),
					idlePolicySec: Math.round(Number(policy.idleMs ?? cfg.idleMs) / 1000),
					autoSleep: policy.autoSleep !== false,
					archived: team.archived
						? {
								at: team.archived.at,
								// 新记录是对象键，老记录是本机文件；两个都给出来，调用方按需要取
								key: team.archived.key || null,
								bytes: team.archived.bytes ?? null,
								file: team.archived.file || null,
							}
						: null,
					lastSeen: state.lastSeen[id] ? new Date(state.lastSeen[id]).toISOString() : null,
					idleSec: state.lastSeen[id] ? Math.round((Date.now() - state.lastSeen[id]) / 1000) : null,
					asleep: !st.running,
					sleptSince: state.asleep[id]?.since || null,
					busy: busy.has(id),
					waking: waking.has(id),
				}
			}
			return json(res, 200, {
				policy: {
					autoSleep: cfg.autoSleep,
					idleSec: Math.round(cfg.idleMs / 1000),
					scanSec: Math.round(cfg.scanMs / 1000),
					cpuMax: cfg.cpuMax,
					minUptimeSec: Math.round(cfg.minUptimeMs / 1000),
					archiveAfterSec: Math.round(cfg.archiveAfterMs / 1000),
					reconcileSec: Math.round(cfg.reconcileMs / 1000),
				},
				counters,
				teams: rows,
			})
		}

		if (url.pathname === '/metrics' && req.method === 'GET') {
			res.writeHead(200, { 'Content-Type': METRICS_CONTENT_TYPE, 'Cache-Control': 'no-store' })
			return res.end(await buildMetrics())
		}

		if (url.pathname === '/reconcile') {
			if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
			if (req.method === 'GET') return json(res, 200, await reconcile({ fix: false }))
			// 删孤儿卷是不可逆操作，必须显式传 cleanupVolumes 才做
			const body = await readJson(req).catch(() => ({}))
			const report = await serial(() => reconcile({ fix: true, cleanupVolumes: Boolean(body.cleanupVolumes) }))
			return json(res, 200, report)
		}

		if (url.pathname === '/archive' && req.method === 'POST') {
			const body = await readJson(req)
			const team = String(body.team || '')
			const result = await archiveTeam(team, String(body.reason || 'manual'))
			return json(res, 200, result)
		}

		if (url.pathname === '/restore' && req.method === 'POST') {
			const body = await readJson(req)
			const result = await restoreTeam(String(body.team || ''))
			return json(res, 200, result)
		}

		if (url.pathname === '/snapshot' && req.method === 'POST') {
			const written = snapshot('manual')
			counters.snapshot += 1
			return json(res, 200, { files: written })
		}

		// ---------- 会话 ----------

		// 侧栏列表：只查表，不碰卷。容器睡着、卷丢了都照样能列出来
		if (url.pathname === '/sessions' && req.method === 'GET') {
			const team = String(url.searchParams.get('team') || '')
			if (!registry().teams[team]) return json(res, 404, { error: `团队 ${team} 不在注册表里` })
			const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500)
			return json(res, 200, { team, sessions: listTeamSessions(openDb(), team, limit) })
		}

		if (url.pathname === '/sessions/sync' && req.method === 'POST') {
			const body = await readJson(req)
			const team = String(body.team || '')
			if (!registry().teams[team]) return json(res, 404, { error: `团队 ${team} 不在注册表里` })
			// 卷不存在时不要硬读：`docker run -v` 会把卷建出来，而且是 root 所有的
			if (!(await sessionVolumeExists(team))) return json(res, 409, { error: `团队 ${team} 没有会话卷` })
			const synced = await syncSessions({ team, force: Boolean(body.force) })
			// 手动同步把产物一起收：产物与会话日志是同一条链上的两段，
			// 只推日志会让「第几轮」有、而「改了哪些文件」还留在卷里
			const artifacts = cfg.artifactSync ? await syncArtifacts({ team }) : null
			return json(res, 200, { ...synced, ...(artifacts ? { artifacts } : {}) })
		}

		if (url.pathname === '/sessions/restore' && req.method === 'POST') {
			const body = await readJson(req)
			const team = String(body.team || '')
			if (!registry().teams[team]) return json(res, 404, { error: `团队 ${team} 不在注册表里` })
			if (!(await sessionVolumeExists(team))) return json(res, 409, { error: `团队 ${team} 没有会话卷` })
			const result = await restoreSessions({
				team,
				force: Boolean(body.force),
				only: body.sessionId ? String(body.sessionId) : null,
			})
			return json(res, 200, result)
		}

		// 产物归因：某一轮改了哪些文件。索引在库，容器睡着、卷不在本机都能查；
		// 带轮号才去对象层取 hunks（那一步才有 IO）
		const artifactRoute = url.pathname.match(/^\/sessions\/([^/]+)\/artifacts(?:\/(\d+))?$/)
		if (artifactRoute && req.method === 'GET') {
			const team = String(url.searchParams.get('team') || '')
			if (!registry().teams[team]) return json(res, 404, { error: `团队 ${team} 不在注册表里` })
			const sessionId = decodeURIComponent(artifactRoute[1])
			const db = openDb()
			if (artifactRoute[2]) {
				const detail = artifactDetail(db, { team, sessionId, turn: Number(artifactRoute[2]) })
				if (!detail) return json(res, 404, { error: `没有第 ${artifactRoute[2]} 轮的记录` })
				return json(res, 200, { team, sessionId, ...detail })
			}
			const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500)
			return json(res, 200, { team, sessionId, turns: artifactsFor(db, { team, sessionId, limit }) })
		}

		// ---------- 团队策略 ----------

		// 常驻不休眠、放宽闲置窗口都走这里；改完下一轮扫描（默认 5 分钟）生效
		if (url.pathname === '/policy' && req.method === 'POST') {
			const body = await readJson(req)
			const team = String(body.team || '')
			if (!registry().teams[team]) return json(res, 404, { error: `团队 ${team} 不在注册表里` })
			try {
				return json(res, 200, await setTeamPolicy(team, body))
			} catch (error) {
				return json(res, 400, { error: error.message })
			}
		}

		// ---------- agent 参数 ----------

		// 团队级 agent 参数（profile 用户层）：库是权威历史，卷里是现场。
		// 只读库，不碰卷——容器睡着也能查，这也是「用户配了什么」的唯一可信来源
		if (url.pathname === '/agent-config' && req.method === 'GET') {
			const team = String(url.searchParams.get('team') || '')
			if (!registry().teams[team]) return json(res, 404, { error: `团队 ${team} 不在注册表里` })
			const db = openDb()
			const latest = latestAgentConfig(db, team)
			return json(res, 200, {
				team,
				revision: latest?.revision ?? null,
				rows: latest?.rows ?? [],
				source: latest?.source ?? null,
				updatedAt: latest?.created_at ?? null,
				history: agentConfigHistory(db, team, 10),
			})
		}

		// 覆盖一版：写库 + 写卷里的 inject.json，下一次容器启动时生效（运行中的容器不重启不改）
		if (url.pathname === '/agent-config' && req.method === 'POST') {
			const body = await readJson(req)
			const team = String(body.team || '')
			if (!registry().teams[team]) return json(res, 404, { error: `团队 ${team} 不在注册表里` })
			if (!Array.isArray(body.rows)) return json(res, 400, { error: 'rows 必须是数组（patch 条目，元素形如 {id, config}）' })
			const db = openDb()
			const saved = saveAgentConfig(db, { team, rows: body.rows, source: 'api', by: body.by ? String(body.by) : null })
			// 卷不在就别硬写：`docker run -v` 会把卷建出来，而且是 root 所有的
			let applied = { skipped: 'no-volume' }
			if (await sessionVolumeExists(team)) {
				try {
					applied = await applyAgentConfig({ team, db })
				} catch (error) {
					applied = { error: error.message }
				}
			}
			return json(res, 200, { ...saved, applied, note: '下一次实例启动时生效' })
		}

		// 从卷里收一次（平时由睡前同步做，这里给运维一个手动入口）
		if (url.pathname === '/agent-config/capture' && req.method === 'POST') {
			const body = await readJson(req)
			const team = String(body.team || '')
			if (!registry().teams[team]) return json(res, 404, { error: `团队 ${team} 不在注册表里` })
			if (!(await sessionVolumeExists(team))) return json(res, 409, { error: `团队 ${team} 没有卷` })
			return json(res, 200, await captureAgentConfig({ team, db: openDb() }))
		}

		// ---------- 技能与连接器 ----------

		if (url.pathname === '/packages' && req.method === 'GET') {
			const team = String(url.searchParams.get('team') || '')
			if (!registry().teams[team]) return json(res, 404, { error: `团队 ${team} 不在注册表里` })
			// 只读，不进 serial 队列：面板刷新不该排在别人装包后面
			return json(res, 200, await packagesView(team))
		}

		if (url.pathname === '/market' && req.method === 'GET') {
			const team = String(url.searchParams.get('team') || '')
			// 市场目录也以表为准：发布的版本、可见性、有没有装，都从 market_current 推出来
			const pkgs = team ? await packagesView(team) : null
			const view = pkgs ? { market: pkgs.market, updatedAt: pkgs.updatedAt } : await marketView('')
			return json(res, 200, {
				items: view.market,
				updatedAt: view.updatedAt,
				slugs: { skills: marketSlugs('skill'), mcp: marketSlugs('mcp') },
				installed: pkgs?.installed || null,
			})
		}

		if (url.pathname === '/market/token' && req.method === 'GET') {
			const team = String(url.searchParams.get('team') || '')
			if (!registry().teams[team]) return json(res, 404, { error: `团队 ${team} 不在注册表里` })
			return json(res, 200, { team, token: ensureMarketToken(openDb(), team) })
		}

		// 网关 token：团队实例启动时取一枚，塞进容器当 apiKey 用。
		// 注意路径不能写成 /llm/token——那会被网关解析成「team=token」而 400。
		if (url.pathname === '/llm-token' && req.method === 'GET') {
			const team = String(url.searchParams.get('team') || '')
			if (!registry().teams[team]) return json(res, 404, { error: `团队 ${team} 不在注册表里` })
			return json(res, 200, { team, token: ensureLlmToken(openDb(), team) })
		}

		if (url.pathname === '/llm-token' && req.method === 'POST') {
			const body = await readJson(req)
			const team = String(body.team || '')
			if (!registry().teams[team]) return json(res, 404, { error: `团队 ${team} 不在注册表里` })
			// 轮换后必须重启实例，否则容器里还是旧 token，下一次请求就会 401
			const token = rotateLlmToken(openDb(), team)
			await serial(() => restartDsh(team))
			return json(res, 200, { team, token, restarted: true })
		}

		// 装了但不想让模型看见 = 停用。和「分享过来默认关闭」是同一个标志位，不另做一套语义。
		if (url.pathname === '/market/toggle' && req.method === 'POST') {
			const body = await readJson(req)
			const team = String(body.team || '')
			const name = String(body.name || '')
			const enabled = body.enabled !== false
			if (!registry().teams[team]) return json(res, 404, { error: `团队 ${team} 不在注册表里` })
			if (!name) return json(res, 400, { error: '缺少 name' })
			const result = await serial(async () =>
				setSkillEnabled(openDb(), {
					team,
					name,
					enabled,
					by: body.by,
					workspaceDir: await resolveWorkspace(team),
					force: Boolean(body.force),
				}),
			)
			return json(res, 200, { team, name, enabled, ...result })
		}

		if (url.pathname === '/market/install' && req.method === 'POST') {
			const body = await readJson(req)
			const team = String(body.team || '')
			const kind = String(body.kind || 'skill')
			const name = String(body.name || '')
			if (!registry().teams[team]) return json(res, 404, { error: `团队 ${team} 不在注册表里` })
			if (!name) return json(res, 400, { error: '缺少 name' })

			const result = await serial(async () => {
				// 表驱动的技能不需要容器活着：改一行就生效，休眠/归档的团队也能装
				const awake = kind === 'skill' && skillMode() === 'db' ? { woke: false } : await ensureAwake(team)
				const installed =
					kind === 'mcp'
						? await installMcp(team, name, body.env || {}, { by: body.by })
						: await installSkill(team, name, { by: body.by, force: body.force })
				// 连接器写在 profile 里 → 等热重载；等不到才退回重启进程（不再一上来就重建容器）
				const applied = await applyPackageChange(team, installed)
				return { ...applied, woke: awake.woke }
			})
			counters.install += 1
			console.log(`console: ${team} 装上了 ${kind} ${name}`)
			return json(res, 200, result)
		}

		if (url.pathname === '/market/uninstall' && req.method === 'POST') {
			const body = await readJson(req)
			const team = String(body.team || '')
			const kind = String(body.kind || 'skill')
			const name = String(body.name || '')
			if (!registry().teams[team]) return json(res, 404, { error: `团队 ${team} 不在注册表里` })
			const result = await serial(async () => {
				if (!(kind === 'skill' && skillMode() === 'db')) await ensureAwake(team)
				const removed = kind === 'mcp' ? await uninstallMcp(team, name, { by: body.by }) : await uninstallSkill(team, name, { by: body.by })
				return await applyPackageChange(team, removed)
				return removed
			})
			counters.install += 1
			console.log(`console: ${team} 卸掉了 ${kind} ${name}`)
			return json(res, 200, result)
		}

		// 分享：团队 A 的某个包投递给团队 B。不进市场，不改可见性。
		// 投递 ≠ 生效：内容先落到 inbox，接收方启用后才写进它的卷。
		// 权限在账号服务那侧判（owner 只能给「自己也在其中」的团队，管理员不限）；
		// 控制面只认「团队存在、名字合法、两边不是同一个」，方便脚本直接调。
		if (url.pathname === '/market/share' && req.method === 'POST') {
			const body = await readJson(req)
			const from = String(body.from || '')
			const to = String(body.to || '')
			const kind = String(body.kind || 'skill')
			const name = String(body.name || '')
			const teams = registry().teams
			if (!teams[from]) return json(res, 404, { error: `团队 ${from} 不在注册表里` })
			if (!teams[to]) return json(res, 404, { error: `目标团队 ${to} 不在注册表里` })
			if (from === to) return json(res, 400, { error: '不能分享给同一个团队' })
			if (!name) return json(res, 400, { error: '缺少 name' })

			// 源团队不必醒着（docker cp 能读停止容器的文件系统），目标团队也不必——
			// 投递只写宿主上的 inbox，等它启用时再唤醒。
			const result = await serial(() =>
				shareAsset(from, to, kind, name, { by: body.by, version: body.version, note: body.note }),
			)
			counters.install += 1
			console.log(`console: ${from} 把 ${kind} ${name} 投递给 ${to}（待接收，操作者 ${body.by || 'console'}）`)
			return json(res, 200, result)
		}

		// 接收方启用 / 拒收一条分享
		if (url.pathname === '/market/share/enable' && req.method === 'POST') {
			const body = await readJson(req)
			const id = String(body.id || '')
			if (!id) return json(res, 400, { error: '缺少 id' })
			const result = await serial(async () => {
				const record = sharesView().find((s) => s.id === id)
				if (!record) throw new Error('分享记录不存在')
				// 写卷前必须醒着；表模式下技能启用只改一行，不叫醒任何容器
				const tableOnly = record.kind === 'skill' && skillMode() === 'db'
				const awake = tableOnly ? { woke: false } : await ensureAwake(record.to)
				const enabled = await enableShare(id, { by: body.by, env: body.env || {}, expectTeam: body.team, force: body.force })
				const applied = await applyPackageChange(record.to, enabled)
				return { ...applied, woke: awake.woke }
			})
			counters.install += 1
			console.log(`console: ${result.to} 启用了来自 ${result.from} 的 ${result.enabled} ${result.name}（操作者 ${body.by || 'console'}）`)
			return json(res, 200, result)
		}

		if (url.pathname === '/market/share/reject' && req.method === 'POST') {
			const body = await readJson(req)
			const id = String(body.id || '')
			if (!id) return json(res, 400, { error: '缺少 id' })
			const result = await serial(() => rejectShare(id, { by: body.by, expectTeam: body.team }))
			counters.install += 1
			console.log(`console: ${result.to} 拒收了来自 ${result.from} 的 ${result.rejected} ${result.name}`)
			return json(res, 200, result)
		}

		if (url.pathname === '/shares' && req.method === 'GET') {
			const team = String(url.searchParams.get('team') || '')
			const list = sharesView(team || null)
			return json(res, 200, {
				shares: list,
				pending: team ? list.filter((s) => s.to === team && s.status === 'pending') : [],
			})
		}

		/**
		 * 上传发布：body 直接是 tar.gz 字节，元信息走 query。
		 *
		 * 为什么不走 multipart：客户端用 `fetch(url, {body: file})` 一行就能发，
		 * 而 multipart 要在控制面手写 boundary 解析——多出来的几百行解析代码
		 * 正是最容易出越界问题的地方。这里只认一种格式，错了就明确报错。
		 */
		if (url.pathname === '/market/upload' && req.method === 'POST') {
			const team = String(url.searchParams.get('team') || '')
			const name = String(url.searchParams.get('name') || '')
			if (!registry().teams[team]) return json(res, 404, { error: `团队 ${team} 不在注册表里` })
			if (!name) return json(res, 400, { error: '缺少 name' })
			const buffer = await readBytes(req, BUNDLE_LIMITS.maxUpload)
			const result = await serial(() =>
				publishSkillFromBundle({
					team,
					name,
					buffer,
					version: url.searchParams.get('version') || undefined,
					visibility: url.searchParams.get('visibility') || undefined,
					by: url.searchParams.get('by') || undefined,
					note: url.searchParams.get('note') || undefined,
				}),
			)
			counters.publish += 1
			console.log(`console: ${team} 上传发布了 skill ${name}（${result.files} 个文件）`)
			return json(res, 200, result)
		}

		if (url.pathname === '/market/publish' && req.method === 'POST') {
			const body = await readJson(req)
			const team = String(body.team || '')
			const kind = String(body.kind || 'skill')
			const name = String(body.name || '')
			if (!registry().teams[team]) return json(res, 404, { error: `团队 ${team} 不在注册表里` })
			if (!name) return json(res, 400, { error: '缺少 name' })
			const meta = {
				version: String(body.version || '1.0.0'),
				title: body.title ? String(body.title) : undefined,
				desc: body.desc ? String(body.desc) : undefined,
				tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
				visibility: body.visibility === 'public' ? 'public' : 'private',
				env: Array.isArray(body.env) ? body.env : undefined,
				by: body.by ? String(body.by) : undefined,
				note: body.note ? String(body.note) : undefined,
			}
			const result = await serial(() =>
				kind === 'mcp' ? publishMcp(team, name, meta) : publishSkill(team, name, meta),
			)
			counters.publish += 1
			console.log(`console: ${team} 发布了 ${kind} ${name}（${meta.visibility}）`)
			return json(res, 200, result)
		}

		if (url.pathname === '/secrets' && req.method === 'GET') {
			const team = String(url.searchParams.get('team') || '')
			if (!registry().teams[team]) return json(res, 404, { error: `团队 ${team} 不在注册表里` })
			const rows = listSecrets(openDb(), team)
			const entry = rows.find((row) => row.scope === LLM_SCOPE && row.key === LLM_KEY)
			// 只回「配没配」，永远不回明文：这个接口会被门户和脚本调用，不该成为取密钥的入口
			return json(res, 200, {
				team,
				configured: Boolean(entry),
				updatedAt: entry?.updated_at || null,
				source: entry ? 'team' : 'global',
				keys: rows.map((row) => ({ scope: row.scope, key: row.key, updatedAt: row.updated_at })),
			})
		}

		// 改团队级模型凭据：加密入库即可生效——网关每次请求现查表，
		// 所以这里**不再重启实例**（以前要重启是因为 key 得在容器启动时注入）。
		if (url.pathname === '/secrets' && req.method === 'POST') {
			const body = await readJson(req)
			const team = String(body.team || '')
			const key = String(body.deepseekApiKey || '').trim()
			if (!registry().teams[team]) return json(res, 404, { error: `团队 ${team} 不在注册表里` })
			const db = openDb()
			if (key) {
				if (!/^[\w.-]{8,}$/.test(key)) return json(res, 400, { error: '这个值看起来不像 API Key（至少 8 位，只含字母数字和 . _ -）' })
				putSecret(db, { team, scope: LLM_SCOPE, key: LLM_KEY, value: key })
			} else {
				// 空值 = 清除团队级配置，请求会回落成「凭据缺失」
				deleteSecret(db, { team, scope: LLM_SCOPE, key: LLM_KEY })
			}
			console.log(`console: ${team} 模型凭据已${key ? '更新（加密入库）' : '清除'}`)
			return json(res, 200, { team, configured: Boolean(key), restarted: false })
		}

		if (url.pathname === '/teams' && req.method === 'POST') {
			const body = await readJson(req)
			const id = String(body.id || '').trim().toLowerCase()
			const name = String(body.name || '').trim() || id
			const desc = String(body.desc || '').trim()
			const owner = String(body.owner || '').trim()

			if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(id)) return json(res, 400, { error: '团队标识只能用小写字母/数字/连字符，2-31 位' })
			if (registry().teams[id]) return json(res, 409, { error: `团队 ${id} 已存在` })

			const team = await createTeam({
				id,
				name,
				desc,
				owner,
				cpus: body.cpus ? Number(body.cpus) : undefined,
				memory: body.memory ? String(body.memory) : undefined,
			})
			console.log(`console: 已创建 ${team.id} → ${team.url}（${team.node}，${team.quota.cpus} 核 / ${team.quota.memory}）`)
			// 建团队就发一枚市场 token：容器起来时环境变量里要有它，否则第一次拉技能会 401
			ensureMarketToken(openDb(), team.id)
			return json(res, 201, { team })
		}

		return json(res, 404, { error: 'not found' })
	} catch (error) {
		// 授权类拒绝（403）不是服务器故障：混进 500 里会让 metrics 的错误率误报，调用方也分不清
		// 「你没权限」和「我坏了」。错误对象自带 status 时以它为准。
		// code / detail 一并透出：前端要靠 SHADOWED 区分「装不上」和「装了也不生效」，
		// 并且需要 shadow 里的具体路径才能告诉用户去改哪个文件。
		const status = Number(error.status) || 500
		if (status >= 500) console.error('console: 失败', url.pathname, error.message)
		return json(res, status, {
			error: error.message,
			...(error.code ? { code: error.code } : {}),
			...(error.detail ? { detail: error.detail } : {}),
		})
	}
})

/** 把毫秒说成人话：45 秒 / 1.5 分钟。日志里别出现 0.08333 分钟。 */
const human = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60_000)} 分钟`)

server.listen(cfg.port, cfg.host, () => {
	console.log(`console: listen=${cfg.host}:${cfg.port} repo=${HERE}`)
	console.log('console: 容器通过 http://host.docker.internal:%d 访问本服务', cfg.port)
	console.log(
		`console: 单团队默认配额 ${cfg.defaultCpus} 核 / ${cfg.defaultMemory}；归档阈值 ${human(cfg.archiveAfterMs)}；对账每 ${human(cfg.reconcileMs)}`,
	)
	if (cfg.autoSleep) {
		console.log(
			`console: 自动休眠已开启 → 默认闲置 ${human(cfg.idleMs)}、且 CPU < ${cfg.cpuMax}%、且已运行超过 ${human(cfg.minUptimeMs)}，每 ${human(cfg.scanMs)} 扫一次（团队可用 policy 覆盖）`,
		)
	} else {
		console.log('console: 自动休眠已关闭（CONSOLE_AUTOSLEEP=0）')
	}
	// 上次被 kill 时留下的 tmp-<pid> 先扫掉，别让它一直混在目录里
	const swept = pruneTmp(HERE)
	if (swept) console.log(`console: 清掉 ${swept} 个陈旧的临时文件`)
	startAssistantStreams()
	snapshot('startup')
})

/**
 * 会话日志在窗口内有没有被写过。
 *
 * 比 CPU 更贴近事实：dsh 每一步都 checkpoint（模型请求前、工具执行前、每步边界），
 * 只要这一轮在推进，日志文件就一直在长。反过来，等模型、等审批、等用户回话的
 * 阶段 CPU 会掉到 1% 上下——只看 CPU 会把这种长任务当成闲置杀掉。
 *
 * 查不到就当活跃：多占一会儿内存的代价，远小于在长任务中途把实例停掉。
 *
 * @param {string} team
 * @param {number} windowMs 回看窗口，一般取这个团队的 idleMs
 * @returns {Promise<boolean>}
 */
async function sessionRecentlyActive(team, windowMs) {
	const minutes = Math.max(1, Math.ceil(windowMs / 60_000))
	const container = `dsh-${team}-dsh-1`
	const result = await run(
		'docker',
		['exec', container, 'sh', '-c', `find /home/dsh/.dsh/sessions -name 'session*.zstd' -mmin -${minutes} 2>/dev/null | head -n 1`],
		15_000,
	)
	if (result.code !== 0) {
		console.error(`console: 查 ${team} 的会话活跃度失败，按活跃处理：${result.out.slice(-200)}`)
		return true
	}
	return result.out.trim().length > 0
}

/**
 * 扫一遍所有实例，把真正闲置的停掉。
 *
 * 四条判据缺一不可，其中两条是防误杀的：
 *   ① 闲置时长   —— 没有 HTTP 请求（按团队 policy 覆盖）
 *   ② CPU        —— WebSocket 建立后长时间静默时 ① 会误判，agent 正在跑工具时 CPU 不会低
 *   ③ 最小存活   —— 刚唤醒的不睡，否则来回摆动
 *   ④ 正在被改动 —— 创建/唤醒/归档过程中的不碰
 */
async function scanOnce() {
	if (!cfg.autoSleep) return
	const data = registry()
	const teams = Object.entries(data.teams).filter(([, t]) => !t.archived && t.policy?.autoSleep !== false)
	if (!teams.length) return
	const stats = await statsMap(teams.map(([id]) => `dsh-${id}-dsh-1`))
	for (const [team, meta] of teams) {
		if (busy.has(team) || waking.has(team)) continue
		const st = await containerState(team)
		if (!st.running) continue

		const idleMs = Number(meta.policy?.idleMs ?? cfg.idleMs)
		const seen = state.lastSeen[team]
		if (!seen) {
			// 控制面刚起来、还没有任何请求进来：当作刚刚活跃，给一个完整的闲置窗口
			state.lastSeen[team] = Date.now()
			saveStateSoon(state)
			continue
		}
		if (Date.now() - seen < idleMs) continue
		if (Date.now() - st.startedAt < cfg.minUptimeMs) continue

		const usage = stats[`dsh-${team}-dsh-1`]?.cpu ?? 0
		if (usage >= cfg.cpuMax) {
			console.log(`console: ${team} 的 HTTP 已静默但 CPU 为 ${usage}%，判断仍在干活，不睡`)
			continue
		}

		// CPU 低不代表没人用：等模型响应、等审批、等用户回话时 CPU 本来就在 1% 上下。
		// 会话日志最近还有写入，说明这一轮确实在跑，不能睡（docs/16 记的那个坑）。
		if (await sessionRecentlyActive(team, idleMs)) {
			console.log(`console: ${team} 的 HTTP 已静默、CPU ${usage}%，但会话日志仍在写入，判断在跑，不睡`)
			continue
		}

		try {
			await sleepTeam(team, `idle ${Math.round((Date.now() - seen) / 60_000)}min`)
		} catch (error) {
			console.error(`console: 休眠 ${team} 失败`, error.message)
		}
	}
}

/**
 * 归档扫描：长期没人访问且容器已经停着的团队，把卷打包收起来再删掉。
 *
 * 只处理「容器不在跑」的：还在跑的说明有人在用，不能动。
 * 归档后注册表留一条记录，门户上显示成「已归档」，点一下就能恢复。
 */
async function scanArchivable() {
	if (!cfg.archiveAfterMs) return
	const data = registry()
	for (const [id, team] of Object.entries(data.teams)) {
		if (team.archived || busy.has(id)) continue
		const seen = state.lastSeen[id]
		if (!seen || Date.now() - seen < cfg.archiveAfterMs) continue
		const st = await containerState(id)
		if (st.running) continue
		try {
			await archiveTeam(id, `idle ${Math.round((Date.now() - seen) / 86400_000)}d`)
		} catch (error) {
			console.error(`console: 归档 ${id} 失败`, error.message)
		}
	}
}

/**
 * 会话同步扫描：把还有容器的团队的会话日志增量推到对象层。
 *
 * 只处理「容器存在」的（跑着或停着都能读，靠 `--volumes-from`），容器不存在的跳过——
 * 那种情况卷也可能已经没了，起一个容器去读只会把卷凭空建出来。
 * 归档的团队也跳过：它的卷已经打包进对象层了，不需要再逐会话同步。
 */
async function scanSessions() {
	// 三个开关独立：关掉会话同步不等于连配置也不收了（配置很小，收一次只读一个文件）
	if (!cfg.sessionSync && !cfg.agentConfigSync && !cfg.artifactSync) return
	const data = registry()
	for (const [id, team] of Object.entries(data.teams)) {
		if (team.archived || busy.has(id) || waking.has(id)) continue
		const st = await containerState(id)
		if (!st.exists) continue
		if (cfg.sessionSync) {
			try {
				const result = await syncSessions({ team: id })
				if (result.uploadedBytes) console.log(`console: 会话同步 ${id} +${result.uploadedBytes} 字节 / ${result.sessions} 个会话`)
				if (result.failed) console.error(`console: 会话同步 ${id} 有 ${result.failed} 个会话失败`)
			} catch (error) {
				console.error(`console: 会话同步 ${id} 失败`, error.message)
			}
		}
		// agent 参数跟会话同步一起收：长驻不休眠的团队永远不会触发「睡前同步」，
		// 只靠休眠时收等于永远不收。内容没变不会产生新版本，重复跑没有副作用。
		if (cfg.agentConfigSync) {
			try {
				const saved = await captureAgentConfig({ team: id, db: openDb() })
				if (saved?.revision && !saved.unchanged) console.log(`console: ${id} agent 参数入库 r${saved.revision}`)
			} catch (error) {
				console.error(`console: ${id} agent 参数入库失败`, error.message)
			}
		}
		// 产物归因：容器里的 changes-collector 已经把每轮的摘要与 diff 抄进卷，
		// 这里收进库 + 对象层，然后删掉卷里那份。收走即删，卷只当中转站。
		if (cfg.artifactSync) {
			try {
				const result = await syncArtifacts({ team: id })
				if (result.uploaded) console.log(`console: 产物归因 ${id} +${result.uploaded} 轮 / ${result.scanned} 个文件`)
				if (result.failed) console.error(`console: 产物归因 ${id} 有 ${result.failed} 个文件失败：${result.errors[0]}`)
			} catch (error) {
				console.error(`console: 产物归因 ${id} 失败`, error.message)
			}
		}
	}
}

const scanner = setInterval(() => {
	scanOnce().catch((error) => console.error('console: 扫描失败', error.message))
}, cfg.scanMs)
scanner.unref()

const reconciler = setInterval(() => {
	if (!cfg.reconcile) return
	serial(() => reconcile({ fix: true }))
		.then((report) => {
			if (report.missing.length || report.orphans.length || report.failed.length) {
				console.log(
					`console: 对账结果 缺失=${report.missing.join(',') || '无'} 重建=${report.rebuilt.join(',') || '无'} 孤儿=${report.orphans.map((o) => o.team).join(',') || '无'}`,
				)
			}
		})
		.catch((error) => console.error('console: 对账失败', error.message))
}, cfg.reconcileMs)
reconciler.unref()

const archiver = setInterval(() => {
	scanArchivable().catch((error) => console.error('console: 归档扫描失败', error.message))
}, cfg.archiveScanMs)
archiver.unref()

const sessionSyncer = setInterval(() => {
	scanSessions().catch((error) => console.error('console: 会话同步扫描失败', error.message))
}, cfg.sessionSyncMs)
sessionSyncer.unref()

const snapshotter = setInterval(() => {
	try {
		snapshot('periodic')
		counters.snapshot += 1
	} catch (error) {
		console.error('console: 快照失败', error.message)
	}
}, cfg.snapshotMs)
snapshotter.unref()

process.on('SIGTERM', () => {
	try {
		streamManager?.stop()
	} catch {
		// 断开 Stream 失败不该阻止退出：ticket 一次性，进程没了连接也会被服务端回收
	}
	try {
		snapshot('shutdown')
	} catch {
		// 关停阶段的快照失败不值得阻止退出
	}
	process.exit(0)
})
