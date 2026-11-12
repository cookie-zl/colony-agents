/**
 * 技能与连接器市场：团队私有 → 市场 → 另一个团队。
 *
 * 为什么建在控制面而不是 dsh 插件里：
 *   市场要跨团队搬运东西，而 dsh 一个实例只看得见自己的卷。插件运行在某个团队的进程里，
 *   拿不到别的团队的卷，也拿不到宿主上的市场目录。控制面是唯一同时看得见「所有团队」和
 *   「市场仓库」的地方，所以打包/解包/投放都放在这里。
 *
 * 两类产物的落点不一样，这是 dsh 的既有设计，不是我们的选择：
 *
 *   skill  → $DSH_HOME/skills/<name>/      卷内。skill-filesystem 在 rank 400 扫它，
 *                                           并且 watch 目录，装完立刻出现在会话目录里。
 *   mcp    → $DSH_HOME/cordis.patch.yml    卷内。配置层优先级：bundles → profile/cordis.patch.yml
 *                                           → $DSH_HOME/cordis.patch.yml → --patch。
 *                                           写在这里能压过镜像烘焙的 profile，且不会被
 *                                           DSH_PROFILE_SEED=refresh 冲掉；改完要重启 dsh 才加载。
 *
 * 所以「新团队初始化时这些都是空的」在 skill 上已经成立，在 MCP 上原本不成立——
 * 以前 MCP 只能写进镜像里的 profile，全团队共用一份。改成写卷之后才真正隔离。
 *
 * 市场仓库在 deploy/market/，可以直接进 git：包是普通目录，改动看得见 diff。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, cpSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { REPO, HERE, writeInPlace } from './store.mjs'
import { run, runStdin } from './runtime.mjs'
import { resolveWorkspace } from './workspace.mjs'
import { readTarGz, walkSkillDir } from './bundle.mjs'
import {
	appendOp as appendOpDb,
	openDb,
	upsertItem,
	setCurrent,
	currentItem,
	itemByVersion,
	itemBundleFiles,
	mountSkill,
	unmountSkill,
	mountMcp,
	unmountMcp,
	teamSkillRows,
	teamMcpRows,
	marketCatalog,
	insertShare,
	patchShare,
	listShares,
	nowIso,
} from './db.mjs'

export const MARKET_DIR = resolve(REPO, 'deploy/market')
export const MARKET_INDEX = join(MARKET_DIR, 'index.json')
export const MARKET_SKILLS = join(MARKET_DIR, 'packages/skills')
export const MARKET_MCPS = join(MARKET_DIR, 'packages/mcp')

/**
 * 操作日志一律落库。调用方只传业务字段，连接在这里取——原来这里有两条写路径
 * （db.mjs 写表、market.mjs 写 oplog.json），门户只读后者，导致「安装/卸载/启停」
 * 在页面上全都不见了。一个动作只能有一条日志。
 *
 * @param {object} entry
 */
const appendOp = (entry) => appendOpDb(openDb(), entry)

/** 安装台账：谁装了什么、哪个版本、从哪来。卷是事实，这里只是索引，reconcile 会对账。 */
export const LEDGER_FILE = resolve(HERE, 'packages.json')

/**
 * 分享台账：哪个团队把哪个包直接给了哪个团队。
 *
 * 市场里没有这条记录——分享刻意不经过市场（不改可见性、不落包），
 * 但流转本身必须留痕：事后要能回答「这个包是谁塞进来的」。
 */
export const SHARES_FILE = resolve(HERE, 'shares.json')

/**
 * 分享暂存区：分享过来的包先躺在这里，接收方点了「启用」才写进卷。
 *
 * 为什么不直接写卷：分享是跨团队的写入，默认生效等于「别人能改我的配置」。
 * 暂存让接收方保留最终决定权——包到了但没启用，对 dsh 完全不可见
 * （skill 不在 skills 目录、mcp 不在 cordis.patch.yml），这就是「默认关闭」。
 *
 * 放在控制面（不是团队卷）是因为它比实例活得久：接收方可以过几天再启用，
 * 期间源团队被归档也不影响。
 */
export const SHARE_INBOX = resolve(HERE, 'inbox')

/** 容器内的固定路径。DSH_HOME 由镜像定为 /home/dsh/.dsh，不随团队变化。 */
const DSH_HOME = process.env.DSH_CONTAINER_HOME || '/home/dsh/.dsh'
const SKILL_ROOT = `${DSH_HOME}/skills`
const MCP_PATCH = `${DSH_HOME}/cordis.patch.yml`

const containerOf = (team) => `dsh-${team}-dsh-1`

/**
 * skill 的事实来源在哪。
 *
 *   db     （默认）表是唯一事实，卷里的 skills/ 只可能是手工放进去的本地技能。
 *          dsh 通过 market-skill 插件向控制面拉目录，所以休眠/归档的团队也能装、也能改。
 *   volume 旧路径：docker exec 把目录写进卷，由 dsh-skill-filesystem 扫出来。
 *          留着是为了出问题时能一键回退，不是长期共存方案（两套事实必漂移）。
 *
 * 连接器不受这个开关影响：它本质是进程，配置必须渲染进 cordis.patch.yml。
 */
const SKILL_MODE = process.env.MARKET_SKILL_MODE === 'volume' ? 'volume' : 'db'

/** 技能是否已经切成「表是事实来源」。控制面据此决定还要不要唤醒容器去写卷。 */
export const skillMode = () => SKILL_MODE

// ---------- 基础读写 ----------

const readJson = (file, fallback) => {
	try {
		return JSON.parse(readFileSync(file, 'utf8'))
	} catch {
		return fallback
	}
}

/** 市场索引。文件不存在时返回空集而不是抛错——空市场是合法状态。 */
export function marketIndex() {
	const data = readJson(MARKET_INDEX, { version: 1, items: [] })
	return { version: 1, updatedAt: data.updatedAt || null, items: Array.isArray(data.items) ? data.items : [] }
}

/** 覆盖写市场索引；`updatedAt` 由这里生成，整文件原子替换。 */
export function saveMarketIndex(data) {
	mkdirSync(MARKET_DIR, { recursive: true })
	writeInPlace(MARKET_INDEX, `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), items: data.items }, null, 2)}\n`)
}

/** 团队已装包账本。文件不存在时返回空账本，不是错误。 */
export function ledger() {
	const data = readJson(LEDGER_FILE, { teams: {} })
	return { teams: data.teams || {} }
}

/** 覆盖写已装包账本（只保留 teams 字段）。 */
export function saveLedger(data) {
	writeInPlace(LEDGER_FILE, `${JSON.stringify({ teams: data.teams }, null, 2)}\n`)
}

const teamLedger = (team) => {
	const all = ledger()
	return all.teams[team] || { skills: {}, mcp: {} }
}

const setTeamLedger = (team, next) => {
	const all = ledger()
	all.teams[team] = next
	saveLedger(all)
}

/**
 * 团队台账视图：给门户判断「这个包是从哪来的」。
 *
 * `from` 有两种取值：`market` / `<团队id>`（市场发布者）、`share:<团队id>`（直接分享）。
 * 前者体现在市场卡片上，后者只能靠台账——因为分享不进市场。
 */
export function ledgerView(team) {
	if (SKILL_MODE === 'db') {
		// 来源在表里：source=share 时 source_team 就是「谁给的」，不用再回 packages.json 猜
		const db = openDb()
		const skills = {}
		for (const row of teamSkillRows(db, team)) {
			skills[row.name] = {
				version: row.version,
				at: row.installed_at,
				from: row.source === 'share' && row.source_team ? `share:${row.source_team}` : row.source,
			}
		}
		const mcp = {}
		for (const row of teamMcpRows(db, team)) {
			mcp[row.name] = {
				version: row.version,
				at: row.installed_at,
				from: row.source === 'share' && row.source_team ? `share:${row.source_team}` : row.source,
			}
		}
		return { skills, mcp }
	}
	const led = teamLedger(team)
	return { skills: led.skills || {}, mcp: led.mcp || {} }
}

// ---------- 分享台账 ----------

/**
 * 分享流水：表是唯一事实。
 *
 * `shares.json` 已经退役（迁移脚本把它灌进了 `shares` 表），文件留在原地当备份，
 * 不再读写——两处都写必然漂移，而「谁把包塞进来的」这种事后追责问题最不能容忍漂移。
 */
export function shares() {
	return listShares(openDb())
}

const newShareId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

/**
 * 记一条分享。
 *
 * `status` 是这条记录的核心：
 *   pending   已投递，接收方还没启用——对 dsh 不可见
 *   enabled   接收方已启用（表模式下挂进 team_skills / 连接器写进 patch）
 *   rejected  接收方拒收
 *
 * `item_id` 在这里按 kind+name+version 反查一次补齐：授权判断只认 id，
 * 但调用方手里往往只有名字。手写的连接器块不在市场里，反查为空是合法状态。
 */
function recordShare(entry) {
	const id = entry.id || newShareId()
	const db = openDb()
	const itemId =
		entry.itemId ||
		db.prepare('SELECT id FROM market_items WHERE kind = ? AND name = ? AND version = ?').get(entry.kind, entry.name, entry.version)?.id ||
		null
	return insertShare(db, { ...entry, id, itemId })
}

/** 改一条分享的状态。 */
function updateShare(id, patch) {
	return patchShare(openDb(), id, patch)
}

const shareStatus = (item) => item.status || 'enabled'
const statusLabel = (record) =>
	({ pending: '待接收', enabled: '已启用', rejected: '已拒收' })[shareStatus(record)] || shareStatus(record)

/** 删一条暂存内容；团队目录空了就一起删，别在 inbox 下留一串空壳。 */
function dropInbox(team, id) {
	rmSync(join(SHARE_INBOX, team, id), { recursive: true, force: true })
	try {
		const teamDir = join(SHARE_INBOX, team)
		if (readdirSync(teamDir).length === 0) rmSync(teamDir, { recursive: true, force: true })
	} catch {
		/* 目录本来就不在，忽略 */
	}
}

/** 某个团队视角的分享记录：发出的 + 收到的。 */
export function sharesView(team) {
	const all = shares().map((s) => ({ ...s, status: shareStatus(s) }))
	if (!team) return all
	return all.filter((s) => s.from === team || s.to === team)
}

/** 待接收的分享：只给接收方看，且只有 pending 的。 */
export function pendingShares(team) {
	return sharesView(team).filter((s) => s.to === team && s.status === 'pending')
}

// ---------- SKILL.md frontmatter ----------

/**
 * 只解析顶层 `key: value` 与 `key: [a, b]`。
 *
 * 不引 YAML 库是刻意的：这里只读 name / description / whenToUse 三个标量，
 * 引一个解析器会让人以为它能处理任意 frontmatter，反而更容易踩坑。
 * 解析不出来时返回空对象，让调用方用目录名兜底。
 */
export function parseFrontmatter(text) {
	const match = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/)
	if (!match) return {}
	const out = {}
	for (const line of match[1].split(/\r?\n/)) {
		const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/)
		if (!kv) continue
		let value = kv[2].trim()
		if (/^['"].*['"]$/.test(value)) value = value.slice(1, -1)
		out[kv[1]] = value
	}
	return out
}

/** 读市场里某个 skill 包的元信息（SKILL.md 未必存在，缺失时用目录名）。 */
function skillMeta(dir, name) {
	const file = join(dir, 'SKILL.md')
	const fm = existsSync(file) ? parseFrontmatter(readFileSync(file, 'utf8')) : {}
	return {
		name: fm.name || name,
		title: fm.name || name,
		desc: fm.description || fm.whenToUse || '',
	}
}

/**
 * 把一个值序列化成 YAML 标量。
 *
 * `@` 和反引号是 YAML 的保留起始符，`-` `?` `:` 开头也可能被当成指示符——
 * 这些一律加引号。踩过一次：`- @modelcontextprotocol/server-filesystem` 裸写
 * 会让整个 patch 解析失败，进而 dsh 起不来。
 */
const yamlScalar = (value) => {
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	const text = String(value ?? '')
	const plainOk = /^[A-Za-z0-9_/][A-Za-z0-9._/@:+-]*$/.test(text) && !/^(true|false|null|yes|no|on|off|~)$/i.test(text)
	return plainOk ? text : JSON.stringify(text)
}

const yamlBlock = (obj, indent) => {
	const pad = ' '.repeat(indent)
	return Object.entries(obj)
		.filter(([, v]) => v !== undefined && v !== null && v !== '')
		.map(([k, v]) => {
			if (v && typeof v === 'object' && !Array.isArray(v)) return `${pad}${k}:\n${yamlBlock(v, indent + 2)}`
			if (Array.isArray(v)) {
				if (!v.length) return `${pad}${k}: []`
				return `${pad}${k}:\n${v.map((item) => `${pad}  - ${yamlScalar(item)}`).join('\n')}`
			}
			return `${pad}${k}: ${yamlScalar(v)}`
		})
		.join('\n')
}

// ---------- 团队侧：列、装、卸 ----------

/**
 * 团队当前装了哪些 skill。
 *
 * 容器睡着时 `docker exec` 不可用，此时退回台账并标记 stale——
 * 面板上显示「台账值，实例休眠中未校验」，比直接报错或假装成功都诚实。
 */
export async function listTeamSkills(team) {
	if (SKILL_MODE === 'db') {
		// 表是事实来源：不再进容器 ls，休眠/归档的团队也能准确回答「装了什么」
		const rows = teamSkillRows(openDb(), team)
		return { skills: rows.map((r) => r.name), detail: rows, stale: false }
	}
	const name = containerOf(team)
	const result = await run('docker', ['exec', name, 'sh', '-c', `ls -1 ${SKILL_ROOT} 2>/dev/null`], 15_000)
	const led = teamLedger(team)
	if (result.code !== 0) {
		return { skills: Object.keys(led.skills || {}), stale: true, error: result.out.trim().slice(-200) }
	}
	const onDisk = result.out.split('\n').map((s) => s.trim()).filter(Boolean)
	return { skills: onDisk, stale: false }
}

/**
 * 读团队装了哪些连接器，返回 [{name, version, id}] 与带 enabled 的 detail。
 *
 * 两个来源都要看，缺一不可：
 *   - 台账（`team_mcps` 表）：唯一知道「开没开、从哪来」的地方，容器休眠时也读得到；
 *   - 卷里的标记块：历史数据没有全部迁进表（team-a 的 filesystem 就是一例），
 *     只信表会让已装的连接器在面板上凭空消失。
 * 合并规则：以台账为准，卷里出现但台账没有的补一条，enabled 记为 true（能写进配置本身就说明是开着的）。
 */
export async function listTeamMcp(team) {
	const byName = new Map()
	if (SKILL_MODE === 'db') {
		for (const r of teamMcpRows(openDb(), team)) {
			byName.set(r.name, {
				name: r.name,
				version: r.version,
				id: `mcp-market-${r.name}`,
				enabled: r.enabled !== 0,
				source: r.source === 'share' && r.source_team ? `share:${r.source_team}` : r.source,
			})
		}
	}
	const name = containerOf(team)
	const result = await run('docker', ['exec', name, 'cat', MCP_PATCH], 15_000)
	const led = teamLedger(team)
	if (result.code !== 0) {
		// 休眠时只能用台账。台账是 name -> {...} 的映射，直接 Object.values 会丢掉 name，
		// 门户那一行就会显示成空名字，这里补回去。
		for (const [n, value] of Object.entries(led.mcp || {})) {
			if (!byName.has(n)) byName.set(n, { name: n, version: value.version || '', id: `mcp-market-${n}`, enabled: true, source: value.from || '' })
		}
		return { mcp: [...byName.values()].map(({ name, version, id }) => ({ name, version, id })), detail: [...byName.values()], stale: true, error: result.out.trim().slice(-200) }
	}
	// 标记行形如 `# >>> market:mcp:filesystem v1.0.0 由市场安装...`
	const re = /^# >>> market:mcp:(\S+)\s+v?(\S+)?/gm
	let m
	// id 与 mcpBlock 生成时保持同一规则：mcp-market-<name>。
	// 用 mcp-<name> 会让面板显示一个实际不存在的行 id，排障时按它去 grep 找不到东西。
	while ((m = re.exec(result.out))) {
		if (byName.has(m[1])) continue
		byName.set(m[1], { name: m[1], version: m[2] || '', id: `mcp-market-${m[1]}`, enabled: true, source: 'disk' })
	}
	const detail = [...byName.values()]
	return { mcp: detail.map(({ name, version, id }) => ({ name, version, id })), detail, stale: false }
}

/**
 * 把一个本地的 skill 目录铺进团队卷里。
 *
 * 只接受 /^[A-Za-z0-9._-]+$/ 的名字：这个值会拼进 `rm -rf` 的路径里，
 * 带 `..` 或 `/` 就能删到别的目录去。名字来自市场目录或团队卷，
 * 理论上已经安全，但这里是唯一把外部输入拼进 shell 的地方，必须自己兜住。
 */
async function pushSkillDir(team, name, src) {
	if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`包名不合法：${name}`)
	const container = containerOf(team)
	const exists = await run('docker', ['inspect', '--format', '{{.State.Status}}', container], 10_000)
	if (exists.code !== 0) throw new Error(`团队 ${team} 的容器不存在，先创建实例`)
	// COPYFILE_DISABLE：macOS 的 tar 默认把每个文件的 AppleDouble 元数据打成 `._xxx`，
	// 装进卷之后会和真实文件混在一起出现在技能目录里。这个环境变量让 libarchive 不打它们。
	const tar = await runStdin('bash', ['-c', `cd ${JSON.stringify(src)} && COPYFILE_DISABLE=1 tar czf - .`], '', 60_000)
	// 先清目录再铺，避免旧版残留文件混进新版
	if (tar.code !== 0) throw new Error(`打包失败：${tar.out.slice(-400)}`)
	const write = await runStdin(
		'docker',
		['exec', '-i', container, 'sh', '-c', `rm -rf ${SKILL_ROOT}/${name} && mkdir -p ${SKILL_ROOT}/${name} && tar xzf - -C ${SKILL_ROOT}/${name}`],
		tar.buffer,
		60_000,
	)
	if (write.code !== 0) throw new Error(`写入容器失败：${write.out.slice(-400)}`)
}

/** 从市场装一个 skill 到团队：表里挂一条，dsh 下次拉目录就能看到。 */
export async function installSkill(team, name, meta = {}) {
	if (SKILL_MODE === 'db') {
		const db = openDb()
		// 装「当前发布的版本」而不是市场索引里的字符串：两者不一致时以表为准
		const cur = currentItem(db, 'skill', name)
		if (!cur) throw new Error(`市场里没有已发布的 skill「${name}」`)
		// 装 = 立刻启用，和旧路径「写完卷就对模型可见」保持一致
		const result = mountSkill(db, {
			team,
			name,
			version: cur.version,
			enabled: true,
			source: 'market',
			by: meta.by,
			// 工作区路径由这里解析后传进去：db.mjs 不碰 docker，也不猜目录
			workspaceDir: await resolveWorkspace(team),
			force: Boolean(meta.force),
		})
		return { installed: 'skill', name, version: cur.version, ...result }
	}
	const src = join(MARKET_SKILLS, name)
	if (!existsSync(src)) throw new Error(`市场里没有 skill「${name}」`)
	await pushSkillDir(team, name, src)

	const entry = marketIndex().items.find((i) => i.kind === 'skill' && i.name === name)
	const led = teamLedger(team)
	led.skills = { ...(led.skills || {}), [name]: { version: entry?.version || '0.0.0', at: new Date().toISOString(), from: entry?.owner || 'market' } }
	setTeamLedger(team, led)
	appendOp({ team, action: 'install', kind: 'skill', name, by: meta.by, note: meta.note, detail: `从市场安装 v${entry?.version || '0.0.0'}` })
	return { installed: 'skill', name }
}

/** 卸载团队技能：移除挂载与卷内副本，不动市场里的包本体。 */
export async function uninstallSkill(team, name, meta = {}) {
	if (SKILL_MODE === 'db') {
		const db = openDb()
		const previous = teamSkillRows(db, team).find((r) => r.name === name)
		if (!previous) throw new Error(`团队 ${team} 没装 skill「${name}」`)
		unmountSkill(db, { team, name, by: meta.by })
		return { removed: 'skill', name, version: previous.version }
	}
	const result = await run('docker', ['exec', containerOf(team), 'sh', '-c', `rm -rf ${SKILL_ROOT}/${name}`], 30_000)
	if (result.code !== 0) throw new Error(`删除失败：${result.out.slice(-400)}`)
	const led = teamLedger(team)
	const previous = led.skills?.[name]
	if (led.skills) delete led.skills[name]
	setTeamLedger(team, led)
	appendOp({
		team,
		action: 'uninstall',
		kind: 'skill',
		name,
		by: meta.by,
		detail: previous?.from?.startsWith('share:') ? `卸载分享自 ${previous.from.slice(6)} 的技能` : '卸载',
	})
	return { removed: 'skill', name }
}

/**
 * 标记行前缀。origin 只影响注释文案，不影响匹配——blockRe 只认
 * `# >>> market:mcp:<name> v...` 这一段，所以市场装的和分享来的块
 * 卸载、重装、发布走的是同一套逻辑。
 */
const marker = (name, origin = '由市场安装') => ({
	open: (version) => `# >>> market:mcp:${name} v${version || '0.0.0'} ${origin}，勿手改本块`,
	close: `# <<< market:mcp:${name}`,
})

/**
 * 匹配某个连接器的整段标记块（含首尾标记行）。
 *
 * 版本号必须用 `\S*` 而不是把 `.*?` 拼进字符串再转义——转义会把通配符变成字面量，
 * 结果是「装了新版替换不掉旧块」，两个同名 serverName 撞在一起 dsh 只加载第一个。
 */
const blockRe = (name) =>
	new RegExp(`# >>> market:mcp:${escapeRe(name)} v\\S*[^\\n]*\\n[\\s\\S]*?^# <<< market:mcp:${escapeRe(name)}$`, 'm')

/**
 * 生成一个 MCP 条目块。
 *
 * 用 id 前缀 mcp-market- 而不是 mcp-<name>：dsh 允许团队手写自己的 mcp-<name>，
 * 装市场包时不能因为撞 id 就把人家手写的行顶掉。serverName 仍然用原名，
 * 因为模型看到的工具名是 mcp__<serverName>__<tool>，名字必须稳定。
 *
 * 导出是为了能单测：这是唯一把结构化配置变成 YAML 的地方，
 * 缩进/引号错一个字符就会让整个实例起不来。
 */
export function renderMcpBlock(pkg, env, origin) {
	const spec = { ...pkg.spec }
	if (spec.env) {
		const resolved = {}
		for (const [key, value] of Object.entries(spec.env)) {
			const given = env?.[key]
			resolved[key] = given !== undefined && given !== '' ? given : String(value).replace(/^\$\{(.+)\}$/, '')
		}
		spec.env = resolved
	}
	// 缩进必须比 config: 深一级（config 在 6，它的子键在 8）。
	// 少一级 dsh 不会报错，只会把 serverName 当成行属性、config 当空对象，
	// 结果是「装上了但不生效」，排查时很难想到是缩进。
	const body = yamlBlock({ serverName: pkg.name, ...spec }, 8)
	const { open, close } = marker(pkg.name, origin)
	return `${open(pkg.version)}
- insert:
    - id: mcp-market-${pkg.name}
      name: "@deepseek-ai/dsh-mcp-client"
      config:
${body}
${close}
`
}

/**
 * 把一段标记块并进现有配置：同名块替换、没有则追加，块外的内容一个字都不动。
 *
 * 纯函数，单独抽出来是为了能测「重复安装会不会叠出两个块」这种问题——
 * 叠了之后 dsh 只认第一个，表现为「升级了但还是跑旧版」，很难查。
 */
export function mergeMcpBlock(existing, mcpName, block) {
	const text = existing || ''
	const pattern = blockRe(mcpName)
	if (pattern.test(text)) return text.replace(pattern, block.trimEnd())
	// `[]` 是「一个条目都没有」的等价写法（空文件 dsh 不接受，见 writeAndValidatePatch），
	// 追加前必须把它当成空，否则会拼出「[] 后面又跟一个 - insert」的非法 YAML
	const isEmptyArray = /^\[\s*\]$/.test(text.trim())
	const head = isEmptyArray ? '' : text.replace(/\s*$/, '')
	return head ? `${head}\n\n${block}` : block
}

/** 把标记块写进团队卷里的 cordis.patch.yml：已存在则替换，不存在则追加，永不碰人工内容。 */
async function writeMcpPatch(team, mcpName, block) {
	const container = containerOf(team)
	const current = await run('docker', ['exec', container, 'cat', MCP_PATCH], 15_000)
	const existing = current.code === 0 ? current.out : ''
	const next = mergeMcpBlock(existing, mcpName, block)
	const write = await runStdin('docker', ['exec', '-i', container, 'sh', '-c', `cat > ${MCP_PATCH}`], next, 30_000)
	if (write.code !== 0) throw new Error(`写 cordis.patch.yml 失败：${write.out.slice(-400)}`)
	// 原内容一并交回：调用方校验失败时要靠它回滚
	return { previous: existing, next }
}

/** 用 dsh 自己解析一遍配置。它是唯一权威的判据——我们自己生成的东西也不能例外。 */
async function validatePatch(team) {
	const result = await run('docker', ['exec', containerOf(team), 'dsh', '--profile', 'web', '--dump-config'], 90_000)
	return { ok: result.code === 0, detail: result.out.slice(-900) }
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 生成「热重载有没有真的生效」的探测线索。
 *
 * stdio 连接器在宿主上就是一个子进程，argv 里有包名与脚本路径——数到它，就等于
 * `mcp-client` 真的被加载并完成了 spawn。控制面据此判定生效（`console.mjs`
 * 的 `waitPatchApplied`），不必靠「等固定秒数」猜。
 *
 * 只取**够长且不以 `/` 开头**的片段：`/workspace` 这种太通用，会和张三李四的
 * 进程撞上，误判成「已经加载」比不判更糟。http/sse 连接器没有子进程可数，
 * 返回空数组，由调用方走「等 HMR 窗口 + 校验配置树」那一档。
 *
 * @param {object} spec 连接器 spec（command / args / transport）
 * @returns {string[]} 命令行片段
 */
export function probeTokens(spec) {
	if (!spec) return []
	const transport = spec.transport || 'stdio'
	if (transport !== 'stdio') return []
	return [spec.command, ...(spec.args || [])]
		.filter((value) => typeof value === 'string')
		.map((value) => value.trim())
		.filter((value) => value.length >= 10 && !value.startsWith('-') && !value.startsWith('/'))
}

/**
 * 把 team 的 `cordis.patch.yml` 写成新内容，返回写前的内容（调用方失败时靠它回滚）。
 *
 * **两层收尾，缺一层就会让实例起不来**：
 *   1. 归一化：dsh 要求这个文件是「顶层 YAML 数组」。卸掉最后一个连接器后剩下的
 *      只有空白或注释，YAML 解析成 null，启动时报
 *      `patches ... must be a top-level YAML array of loader patch entries`，
 *      容器直接进重启循环。所以空内容一律写成 `[]`。
 *   2. 校验：让 dsh 自己 `--dump-config` 解析一遍。缩进错、引号错、只剩注释，
 *      都只有它能判。装的时候一直有这一步，卸载漏了——这就是会「一卸就挂」的原因。
 *
 * @param {string} team 团队 id
 * @param {string} next 新内容
 * @param {string} previous 写前的内容（校验失败要恢复到它）
 * @param {string} action 失败信息里的动作名（装 / 卸）
 */
/**
 * 规范化 patch 文件内容：dsh 要求它是「顶层 YAML 数组」。
 *
 * 卸掉最后一个连接器后剩下的只有空白，YAML 解析成 null，dsh 启动时报
 * `patches ... must be a top-level YAML array`，容器进重启循环。
 * `[]` 是「一个条目都没有」的合法写法，也是唯一安全的空值。
 *
 * @param {string} text 待写入的内容
 * @returns {string} 可直接写入文件的内容
 */
export function normalizePatchText(text) {
	return String(text ?? '').trim() === '' ? '[]\n' : text
}

async function writeAndValidatePatch(team, next, previous, action) {
	const text = normalizePatchText(next)
	const container = containerOf(team)
	const write = await runStdin('docker', ['exec', '-i', container, 'sh', '-c', `cat > ${MCP_PATCH}`], text, 30_000)
	if (write.code !== 0) throw new Error(`写 cordis.patch.yml 失败：${write.out.slice(-400)}`)

	const check = await validatePatch(team)
	if (!check.ok) {
		await restorePatch(team, previous)
		throw new Error(`${action}后配置没通过 dsh 校验，已回滚；实例未受影响。\n${check.detail}`)
	}
}

/**
 * 从 `market_items` 的一行还原连接器包描述。
 *
 * 表里 `config` 存的就是 `{spec, env}`，与 volume 模式的 `packages/mcp/<name>.json`
 * 同一个形状——渲染函数只认这个结构，两边不用各写一份。
 *
 * @returns {{name:string, version:string, spec:object, env:Array<object>}}
 */
function mcpPkgFromRow(row) {
	const cfg = row.config ? JSON.parse(row.config) : {}
	if (!cfg.spec) throw new Error(`连接器「${row.name}」的市场记录缺少 spec，无法渲染`)
	return {
		name: row.name,
		version: row.version,
		title: row.title,
		desc: row.description,
		visibility: row.visibility,
		owner: row.owner_team,
		publishedAt: row.published_at,
		spec: cfg.spec,
		env: cfg.env || [],
	}
}

/** 安装 MCP 连接器：写 `cordis.patch.yml`，返回控制面判定热重载用的进程探针令牌。 */
export async function installMcp(team, name, env = {}, meta = {}) {
	const db = openDb()
	// 表和目录都能给出包描述。表优先：它才是「市场里有什么」的事实来源，
	// 目录只是 volume 模式的存量与镜像烘焙包。
	const row = SKILL_MODE === 'db' ? currentItem(db, 'mcp', name) : undefined
	const pkg = row ? mcpPkgFromRow(row) : readJson(join(MARKET_MCPS, `${name}.json`), null)
	if (!pkg) throw new Error(`市场里没有连接器「${name}」`)
	const missing = (pkg.env || []).filter((e) => e.required && !env[e.key])
	if (missing.length) throw new Error(`缺少必填参数：${missing.map((e) => e.key).join(', ')}`)

	const block = renderMcpBlock(pkg, env)
	const { previous } = await writeMcpPatch(team, name, block)

	// 写完立刻让 dsh 解析一次。这一步不是保险，是必需的：
	// cordis.patch.yml 是启动时读的顶层配置，一个缩进错误就能让进程起不来，
	// 而容器 restart 之后只会一直重启，用户看到的是整台实例挂掉。
	const check = await validatePatch(team)
	if (!check.ok) {
		await restorePatch(team, previous)
		throw new Error(`连接器「${name}」的配置没通过 dsh 校验，已回滚；实例未受影响。\n${check.detail}`)
	}

	// 渲染成功才记账：顺序反过来会留下「表里装了、卷里没有」的假记录。
	// mountMcp 内部过 canMount（私有包必须有分享才能装），并写 ops；
	// 表里没有这个包（手写块/volume）时才退回本地台账。
	if (row) {
		mountMcp(db, { team, name, version: row.version, enabled: true, source: 'market', by: meta.by })
	} else {
		const led = teamLedger(team)
		led.mcp = { ...(led.mcp || {}), [name]: { version: pkg.version || '0.0.0', at: new Date().toISOString(), id: `mcp-market-${name}` } }
		setTeamLedger(team, led)
		appendOp({ team, action: 'install', kind: 'mcp', name, by: meta.by, note: meta.note, detail: `从市场安装 v${pkg.version || '0.0.0'}` })
	}
	// 写在 profile 里的改动由 HMR 热重载（web 组合包默认开启），控制面拿到 probe 后会
	// 等它真的加载出来；等不到才退回重启。restartRequired 仍为 true 表示「默认顺序是
	// 先热重载、失败再重启」，而不是「一定要重建容器」。
	return {
		installed: 'mcp',
		name,
		version: pkg.version,
		restartRequired: true,
		expect: 'present',
		probe: { id: `mcp-market-${pkg.name}`, tokens: probeTokens(pkg.spec) },
	}
}

/** 把 cordis.patch.yml 恢复成安装前的内容；原本没有这个文件就删掉，别留一个空壳。 */
async function restorePatch(team, previous) {
	const container = containerOf(team)
	if (previous === null || previous === undefined || previous === '') {
		await run('docker', ['exec', container, 'rm', '-f', MCP_PATCH], 15_000)
		return
	}
	await runStdin('docker', ['exec', '-i', container, 'sh', '-c', `cat > ${MCP_PATCH}`], previous, 30_000)
}

/** 卸载 MCP 连接器；空 patch 归一成 `[]`，否则 dsh 会 fatal 重启循环。 */
export async function uninstallMcp(team, name, meta = {}) {
	const db = openDb()
	const mounted = SKILL_MODE === 'db' ? teamMcpRows(db, team).find((r) => r.name === name) : undefined
	const container = containerOf(team)
	const current = await run('docker', ['exec', container, 'cat', MCP_PATCH], 15_000)
	if (current.code !== 0) throw new Error(`读不到 cordis.patch.yml：${current.out.slice(-300)}`)
	const pattern = blockRe(name)
	if (!pattern.test(current.out)) {
		// 卷里没有块但表里有记录：清掉记录即可，这不是错误，是残留
		if (!mounted) throw new Error(`团队 ${team} 没有装连接器「${name}」`)
		unmountMcp(db, { team, name, by: meta.by })
		return { removed: 'mcp', name, version: mounted.version, restartRequired: false }
	}
	const next = current.out.replace(pattern, '\n')
	await writeAndValidatePatch(team, next, current.out, `卸载连接器「${name}」`)

	// 探测线索尽量从市场记录里取（表里才有 spec）；取不到就只留 id，
	// 让调用方走「等 HMR 窗口 + 看配置树里这一行还在不在」那一档
	const row = SKILL_MODE === 'db' ? currentItem(db, 'mcp', name) : undefined
	const probe = { id: `mcp-market-${name}`, tokens: row ? probeTokens(mcpPkgFromRow(row).spec) : [] }

	if (mounted) {
		// 先删卷里的块、再删表记录：反了会留下「表里没装、卷里还开着」的幽灵连接器
		unmountMcp(db, { team, name, by: meta.by })
		return { removed: 'mcp', name, version: mounted.version, restartRequired: true, expect: 'absent', probe }
	}

	const led = teamLedger(team)
	const previous = led.mcp?.[name]
	if (led.mcp) delete led.mcp[name]
	setTeamLedger(team, led)
	appendOp({
		team,
		action: 'uninstall',
		kind: 'mcp',
		name,
		by: meta.by,
		detail: previous?.from?.startsWith('share:') ? `卸载分享自 ${previous.from.slice(6)} 的连接器` : '卸载',
	})
	return { removed: 'mcp', name, restartRequired: true, expect: 'absent', probe }
}

// ---------- 分享：团队 → 团队 ----------

/**
 * 把一个团队的东西直接给另一个团队。
 *
 * 为什么要有这条路径，而不是「发到市场再让对方装」：
 *   市场是「可见性」模型——发布之后要么公开给所有人，要么只有自己可见。
 *   但最常见的诉求是「就这一个包，给那几个团队」，不该逼着人先公开再收回。
 *   所以分享是点对点的：不落市场目录、不改 index.json、对方市场里看不到它，
 *   只在对方卷里多一个包 + 在对方台账里记一条 `from: share:<源团队>`。
 *
 * 两件必须守住的事：
 *   1. 不带密钥。源团队 patch 里的 env 已经是解析后的真实值，原样搬过去等于
 *      把 A 团队的 token 送给 B 团队。这里只搬结构，env 的键名单独返回，
 *      由接收方自己填。
 *   2. 只搬市场块。团队手写在 cordis.patch.yml 里的其他 MCP 是它自己的东西，
 *      不该因为「分享 filesystem」就跟着走（publishMcp 用同样的规则）。
 */

/**
 * 把 skill 暂存到接收方的 inbox，不写它的卷。
 *
 * 休眠中的源团队也能分享：docker cp 不需要进程活着。
 * 返回 status=pending，接收方在门户里点「启用」才真正落进 skills 目录。
 */
export async function shareSkill(from, to, name, meta = {}) {
	if (from === to) throw new Error('不能分享给同一个团队')
	if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`包名不合法：${name}`)
	const id = newShareId()

	if (SKILL_MODE === 'db') {
		// 表驱动之后分享不用搬文件：内容本来就在 market_items 里按版本存着，
		// 分享只需记一行「谁的哪一版给了谁」，接收方启用时按 item_id 挂上即可。
		const mounted = teamSkillRows(openDb(), from).find((r) => r.name === name)
		if (!mounted) throw new Error(`团队 ${from} 里没有技能「${name}」`)
		const version = meta.version || mounted.version
		if (!itemByVersion(openDb(), 'skill', name, version)) throw new Error(`市场里没有 ${name}@${version} 的正文`)
		const record = recordShare({ id, from, to, kind: 'skill', name, version, by: meta.by, note: meta.note })
		appendOp({
			team: to,
			action: 'share',
			kind: 'skill',
			name,
			by: meta.by,
			note: meta.note,
			from,
			to,
			detail: `已投递 v${version}，待接收方启用（默认不生效）`,
		})
		return { staged: 'skill', id: record.id, name, from, to, version, status: 'pending', note: record.note || '' }
	}

	const dir = join(SHARE_INBOX, to, id)
	mkdirSync(dir, { recursive: true })
	const cp = await run('docker', ['cp', `${containerOf(from)}:${SKILL_ROOT}/${name}`, join(dir, 'pkg')], 60_000)
	if (cp.code !== 0) {
		rmSync(dir, { recursive: true, force: true })
		throw new Error(`团队 ${from} 里没有技能「${name}」（或者实例已归档）：${cp.out.trim().slice(-300)}`)
	}

	const version = meta.version || teamLedger(from).skills?.[name]?.version || '1.0.0'
	const record = recordShare({ id, from, to, kind: 'skill', name, version, by: meta.by, note: meta.note })
	appendOp({
		team: to,
		action: 'share',
		kind: 'skill',
		name,
		by: meta.by,
		note: meta.note,
		from,
		to,
		detail: '已投递，待接收方启用（默认不生效）',
	})
	return { staged: 'skill', id: record.id, name, from, to, version, status: 'pending', note: record.note || '' }
}

/**
 * 从源团队的块里剥出「可以外传的部分」：结构全留，env 的取值全删。
 *
 * 这是分享和发布最大的安全边界——源团队块里的 env 是已经解析过的真实值，
 * 原样搬过去就是把 A 团队的 token 交给 B 团队。键名要单独交回去，
 * 因为接收方还得知道有哪几个参数要自己填。
 *
 * @returns {{spec: object, envKeys: string[]}}
 */
export function stripShareSecrets(blockText) {
	const spec = parseMcpBlock(blockText)
	if (!spec.serverName) throw new Error('解析出的配置缺少 serverName')
	const envKeys = Object.keys(spec.env || {})
	// 键名必须留下、值必须清空：接收方启用时要照着这些键填自己的凭据。
	// 直接删掉整个 env 会让 renderMcpBlock 生成不出 env 段，接收方连要填什么都不知道。
	if (envKeys.length) spec.env = Object.fromEntries(envKeys.map((key) => [key, '']))
	return { spec, envKeys }
}

/**
 * 连接器：从源团队的块里取干净结构，存进接收方的 inbox（mcp.json），不写它的配置。
 *
 * 存的是「结构 + env 键名」，不是渲染好的 YAML：启用那一刻要用接收方填的凭据
 * 重新渲染一次，提前渲染会把空值烤进块里。
 */
export async function shareMcp(from, to, name, meta = {}) {
	if (from === to) throw new Error('不能分享给同一个团队')
	const id = newShareId()
	const dir = join(SHARE_INBOX, to, id)
	const staging = join(MARKET_DIR, '.staging', `share-mcp-${from}-${name}-${Date.now()}`)
	mkdirSync(staging, { recursive: true })
	mkdirSync(dir, { recursive: true })
	try {
		const cp = await run('docker', ['cp', `${containerOf(from)}:${MCP_PATCH}`, join(staging, 'cordis.patch.yml')], 60_000)
		if (cp.code !== 0) {
			throw new Error(`团队 ${from} 的实例不可读（可能已归档）：${cp.out.trim().slice(-300)}`)
		}
		const text = readFileSync(join(staging, 'cordis.patch.yml'), 'utf8')
		const found = text.match(blockRe(name))
		if (!found) throw new Error(`团队 ${from} 没有装连接器「${name}」（只分享市场/分享块，手写的配置不外传）`)

		const { spec, envKeys } = stripShareSecrets(found[0])
		const version = meta.version || teamLedger(from).mcp?.[name]?.version || '1.0.0'
		writeInPlace(join(dir, 'mcp.json'), `${JSON.stringify({ serverName: spec.serverName, spec, envKeys, version }, null, 2)}\n`)

		const record = recordShare({ id, from, to, kind: 'mcp', name: spec.serverName, version, by: meta.by, note: meta.note, envKeys })
		appendOp({
			team: to,
			action: 'share',
			kind: 'mcp',
			name: spec.serverName,
			by: meta.by,
			note: meta.note,
			from,
			to,
			detail: envKeys.length ? `已投递，待接收方启用并补填：${envKeys.join(', ')}` : '已投递，待接收方启用（默认不生效）',
		})
		return { staged: 'mcp', id: record.id, name: spec.serverName, from, to, version, envKeys, status: 'pending', note: record.note || '' }
	} catch (error) {
		rmSync(dir, { recursive: true, force: true })
		throw error
	} finally {
		rmSync(staging, { recursive: true, force: true })
	}
}

/**
 * 接收方启用一条分享：这一刻才把内容写进它的卷。
 *
 * 连接器写完照样要过 dsh 自己的 --dump-config；失败回滚并保留 pending，
 * 让人可以改凭据再试，而不是「点一下失败、记录也废了」。
 */
export async function enableShare(id, meta = {}) {
	const record = shares().find((s) => s.id === id)
	if (!record) throw new Error('分享记录不存在')
	// expectTeam 由控制面从请求体带下来：开了这条校验，门户就算被改表单也写不进别人的卷
	if (meta.expectTeam && record.to !== meta.expectTeam) throw new Error('这条分享不属于该团队')
	const status = shareStatus(record)
	if (status !== 'pending') throw new Error(`这条分享当前是「${status}」，只有待接收的可以启用`)
	// 授权按 item_id 判（见 db.mjs 的 canMount）。历史记录里可能没有它——那说明这条分享
	// 记的是「某个没进过市场的包」，硬挂等于跳过授权，只能让对方重新分享一次。
	if (SKILL_MODE === 'db' && !record.itemId) {
		throw Object.assign(
			new Error(`这条分享没有绑定具体的包版本（市场里查不到 ${record.kind}「${record.name}@${record.version}」），请让对方重新分享一次`),
			{ status: 409 },
		)
	}
	const dir = join(SHARE_INBOX, record.to, record.id)
	// db 模式下技能正文在表里，不依赖 inbox；只有连接器（以及 volume 模式的技能）才要暂存内容
	if (record.kind === 'skill' && SKILL_MODE !== 'db' && !existsSync(dir)) {
		throw new Error('分享内容已不在暂存区（可能被清理），请让对方重新分享')
	}
	if (record.kind !== 'skill' && !existsSync(dir)) {
		throw new Error('分享内容已不在暂存区（可能被清理），请让对方重新分享')
	}

	let restartRequired = false
	if (record.kind === 'skill') {
		if (SKILL_MODE === 'db') {
			// 启用才挂上，正好对上「分享默认关闭」：pending 期间对模型完全不可见
			mountSkill(openDb(), {
				team: record.to,
				name: record.name,
				version: record.version,
				enabled: true,
				source: 'share',
				sourceTeam: record.from,
				shareId: record.id,
				by: meta.by,
				// 别人塞过来的同名包也照样查：本地已有同名的，启用了也白启用
				workspaceDir: await resolveWorkspace(record.to),
				force: Boolean(meta.force),
			})
		} else {
			await pushSkillDir(record.to, record.name, join(dir, 'pkg'))
			const led = teamLedger(record.to)
			led.skills = {
				...(led.skills || {}),
				[record.name]: { version: record.version, at: new Date().toISOString(), from: `share:${record.from}` },
			}
			setTeamLedger(record.to, led)
		}
	} else {
		const pkg = readJson(join(dir, 'mcp.json'), null)
		if (!pkg?.spec) throw new Error('暂存的连接器描述已损坏，请让对方重新分享')
		const serverName = pkg.serverName || record.name
		const block = renderMcpBlock(
			{ name: serverName, version: pkg.version || record.version, spec: pkg.spec },
			meta.env || {},
			`由 ${record.from} 分享`,
		)
		const { previous } = await writeMcpPatch(record.to, serverName, block)
		const check = await validatePatch(record.to)
		if (!check.ok) {
			await restorePatch(record.to, previous)
			throw new Error(`连接器「${record.name}」启用后没通过 dsh 校验，已回滚；对方实例未受影响。\n${check.detail}`)
		}
		const led = teamLedger(record.to)
		led.mcp = {
			...(led.mcp || {}),
			[serverName]: { version: pkg.version || record.version, at: new Date().toISOString(), id: `mcp-market-${serverName}`, from: `share:${record.from}` },
		}
		setTeamLedger(record.to, led)
		restartRequired = true
	}

	updateShare(record.id, { status: 'enabled', enabledAt: new Date().toISOString(), enabledBy: meta.by || 'console' })
	appendOp({
		team: record.to,
		action: 'enable',
		kind: record.kind,
		name: record.name,
		by: meta.by,
		note: record.note,
		from: record.from,
		to: record.to,
		detail: `接收方启用（来源 ${record.from}，分享人 ${record.by || '未知'}）`,
	})
	dropInbox(record.to, record.id)
	return {
		enabled: record.kind,
		name: record.name,
		from: record.from,
		to: record.to,
		version: record.version,
		restartRequired,
	}
}

/** 接收方拒收：删掉暂存内容，只留一条 rejected 流水——「谁给过我、我拒了」也该能查到。 */
export async function rejectShare(id, meta = {}) {
	const record = shares().find((s) => s.id === id)
	if (!record) throw new Error('分享记录不存在')
	if (meta.expectTeam && record.to !== meta.expectTeam) throw new Error('这条分享不属于该团队')
	if (shareStatus(record) !== 'pending') throw new Error(`这条分享当前是「${statusLabel(record)}」，只有待接收的可以拒收`)
	updateShare(record.id, { status: 'rejected', rejectedAt: new Date().toISOString(), rejectedBy: meta.by || 'console' })
	appendOp({
		team: record.to,
		action: 'reject',
		kind: record.kind,
		name: record.name,
		by: meta.by,
		note: record.note,
		from: record.from,
		to: record.to,
		detail: '接收方拒收',
	})
	dropInbox(record.to, record.id)
	return { rejected: record.kind, name: record.name, from: record.from, to: record.to }
}

/** 把一个包投递到另一团队的收件箱；接收方启用之后才真正生效。 */
export async function shareAsset(from, to, kind, name, meta = {}) {
	return kind === 'mcp' ? shareMcp(from, to, name, meta) : shareSkill(from, to, name, meta)
}

// ---------- 发布：团队私有 → 市场 ----------

const slug = (text) =>
	String(text || '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '')

/** 包名会进文件路径、YAML 键和 shell 命令，所以只认这个字符集。 */
const isSafeName = (name) => /^[A-Za-z0-9._-]+$/.test(String(name))

/**
 * 找出团队的卷里「这个技能的真实目录」。
 *
 * 两个来源，顺序不能反：
 *   1. `$DSH_HOME/skills/<name>` —— 团队自己手写的（rank 400，本地优先）；
 *   2. `$DSH_HOME/market-skills/<name>@<ver>-<digest>` —— 市场技能物化出来的那份，
 *      团队在原地改了 references/scripts 之后想重发，读的就是它。
 *
 * 用一次 `docker exec` 决定去哪，再 `docker cp` 取出来：`docker cp` 不支持通配，
 * 而「最新那份物化目录」只能靠 shell 算。
 *
 * @returns {Promise<Array<{path:string,data:Buffer,executable:boolean}>|null>} 都没有则 null
 */
async function skillFilesFromTeam(team, name) {
	const script = [
		'd="$1"; n="$2"',
		// 按 mtime 取最新那份物化目录：`ls` 默认按名字排，1.10.0 会排在 1.2.0 前面
		'for c in "$d/skills/$n" $(ls -1dt "$d"/market-skills/"$n"@* 2>/dev/null | head -1); do',
		'  if [ -f "$c/SKILL.md" ]; then echo "$c"; exit 0; fi',
		'done',
		'exit 1',
	].join('\n')
	const found = await run('docker', ['exec', containerOf(team), 'sh', '-c', script, '_', DSH_HOME, name], 20_000)
	if (found.code !== 0) return null
	const dir = found.out.trim().split('\n').pop()
	if (!dir) return null

	const staging = join(MARKET_DIR, '.staging', `${team}-${name}-${Date.now()}`)
	mkdirSync(staging, { recursive: true })
	try {
		const cp = await run('docker', ['cp', `${containerOf(team)}:${dir}`, join(staging, 'pkg')], 60_000)
		if (cp.code !== 0) return null
		const files = walkSkillDir(join(staging, 'pkg'))
		return files.some((f) => f.path === 'SKILL.md') ? files : null
	} finally {
		rmSync(staging, { recursive: true, force: true })
	}
}

/**
 * 把一个团队的私有 skill 发布到市场。
 *
 * 内容从哪来，按这个顺序：
 *   1. 团队卷里的真实目录（手写的，或物化后改过的）——唯一能发布**新**文件的路径；
 *   2. 团队当前装的那一版（从库里 fork）——休眠中的团队也能重发，不必把人叫醒。
 *
 * 发布只读卷，不改团队的任何东西——这点很重要，发布不该有副作用。
 */
export async function publishSkill(team, name, meta = {}) {
	if (!isSafeName(name)) throw new Error(`包名不合法：${name}`)
	if (SKILL_MODE === 'db') {
		const db = openDb()
		const mounted = teamSkillRows(db, team).find((r) => r.name === name)
		const local = await skillFilesFromTeam(team, name)
		let files = local
		let src = null
		if (!files) {
			if (!mounted) throw new Error(`团队 ${team} 既没装技能「${name}」，卷里也没有同名目录`)
			src = itemByVersion(db, 'skill', name, mounted.version)
			if (!src) throw new Error(`市场里缺少 ${name}@${mounted.version} 的正文，无法发布`)
			files = itemBundleFiles(db, src.id)
			if (!files?.length) throw new Error(`市场里缺少 ${name}@${mounted.version} 的文件，无法发布`)
		}

		const skillMd = files.find((f) => f.path === 'SKILL.md')
		const fm = src ? {} : parseFrontmatter(skillMd.data.toString('utf8'))
		const version = String(meta.version || '1.0.0')
		const visibility = meta.visibility === 'public' ? 'public' : 'private'
		upsertItem(db, {
			kind: 'skill',
			name,
			version,
			title: meta.title || fm.name || src?.title || name,
			description: meta.desc || fm.description || fm.whenToUse || src?.description || '',
			whenToUse: src?.when_to_use ?? (meta.whenToUse || null),
			files,
			rank: src?.rank ?? 550,
			visibility,
			ownerTeam: team,
			status: 'published',
			createdBy: meta.by || 'console',
			publishedAt: nowIso(),
		})
		setCurrent(db, 'skill', name, version)
		// 发布者自己也要跟上新版本，否则「我发的版本我自己没在用」——这条最容易在排查时误导人。
		// 这里用 force：发布这个动作本身不该被本地同名技能拦下来，
		// 但要把遮蔽情况带回去，让门户提示「你发的版本自己这边其实没在用」。
		const remount = mountSkill(db, {
			team,
			name,
			version,
			enabled: Boolean(mounted?.enabled),
			source: 'market',
			by: meta.by,
			workspaceDir: await resolveWorkspace(team),
			force: true,
		})
		appendOp({
			team,
			action: 'publish',
			kind: 'skill',
			name,
			by: meta.by,
			note: meta.note,
			detail: `发布到市场 v${version}（${files.length} 个文件，${visibility === 'public' ? '公开' : '私有'}）`,
		})
		return {
			published: 'skill',
			name,
			version,
			visibility,
			files: files.length,
			from: local ? 'volume' : 'market',
			...(remount.shadow ? { shadow: remount.shadow } : {}),
		}
	}

	const container = containerOf(team)
	const staging = join(MARKET_DIR, '.staging', `${team}-${name}-${Date.now()}`)
	mkdirSync(staging, { recursive: true })
	try {
		const cp = await run('docker', ['cp', `${container}:${SKILL_ROOT}/${name}`, join(staging, 'pkg')], 60_000)
		if (cp.code !== 0) throw new Error(`导出失败（团队可能没有这个 skill）：${cp.out.slice(-400)}`)
		const src = join(staging, 'pkg')
		const info = skillMeta(src, name)
		const target = join(MARKET_SKILLS, name)
		rmSync(target, { recursive: true, force: true })
		mkdirSync(MARKET_SKILLS, { recursive: true })
		cpSync(src, target, { recursive: true })

		const items = marketIndex().items.filter((i) => !(i.kind === 'skill' && i.name === name))
		items.push({
			kind: 'skill',
			name,
			version: meta.version || '1.0.0',
			title: meta.title || info.title,
			desc: meta.desc || info.desc,
			tags: meta.tags || [],
			visibility: meta.visibility === 'public' ? 'public' : 'private',
			owner: team,
			publishedAt: new Date().toISOString(),
		})
		saveMarketIndex({ items })
		appendOp({
			team,
			action: 'publish',
			kind: 'skill',
			name,
			by: meta.by,
			note: meta.note,
			detail: `发布到市场 v${meta.version || '1.0.0'}（${meta.visibility === 'public' ? '公开' : '私有'}）`,
		})
		return { published: 'skill', name, version: meta.version || '1.0.0' }
	} finally {
		rmSync(staging, { recursive: true, force: true })
	}
}

/**
 * 从一个 tar.gz 上传包里发布技能。
 *
 * 这是唯一「不需要团队实例存在」的发布入口：文件来自浏览器，不来自任何卷。
 * 所以它也是唯一能往市场里放多文件包的外部通道——团队手写那条路要求实例醒着。
 *
 * 元信息以包内 `SKILL.md` 的 frontmatter 为准，参数只能覆盖「发给谁/什么版本/可不可见」，
 * 不能覆盖 title/description：那两个是模型的路由依据，应当和文件内容绑定。
 *
 * @param {{team:string, name:string, buffer:Buffer, version?:string, visibility?:string, by?:string, note?:string}} input
 */
export async function publishSkillFromBundle(input) {
	const { team, name, buffer } = input
	if (!isSafeName(name)) throw new Error(`包名不合法：${name}`)
	const files = readTarGz(buffer)
	const fm = parseFrontmatter(files.find((f) => f.path === 'SKILL.md').data.toString('utf8'))
	const db = openDb()
	const version = String(input.version || '1.0.0')
	const visibility = input.visibility === 'public' ? 'public' : 'private'
	upsertItem(db, {
		kind: 'skill',
		name,
		version,
		title: fm.name || name,
		description: fm.description || fm.whenToUse || '',
		whenToUse: fm.whenToUse || null,
		files,
		visibility,
		ownerTeam: team,
		status: 'published',
		createdBy: input.by || 'console',
		publishedAt: nowIso(),
	})
	setCurrent(db, 'skill', name, version)
	appendOp({
		team,
		action: 'publish',
		kind: 'skill',
		name,
		by: input.by,
		note: input.note,
		detail: `上传发布 v${version}（${files.length} 个文件，${visibility === 'public' ? '公开' : '私有'}）`,
	})
	return { published: 'skill', name, version, visibility, files: files.length, from: 'upload' }
}

/**
 * 发布一个 MCP 连接器。
 *
 * 只从标记块里取——团队手写在同一个文件里的其他 MCP 属于「个人爱好」，
 * 不该被顺手发到市场，也不该带上别人的 token。
 */
export async function publishMcp(team, name, meta = {}) {
	const container = containerOf(team)
	const staging = join(MARKET_DIR, '.staging', `${team}-mcp-${name}-${Date.now()}`)
	mkdirSync(staging, { recursive: true })
	try {
		const cp = await run('docker', ['cp', `${container}:${MCP_PATCH}`, join(staging, 'cordis.patch.yml')], 60_000)
		if (cp.code !== 0) throw new Error(`导出失败：${cp.out.slice(-400)}`)
		const text = readFileSync(join(staging, 'cordis.patch.yml'), 'utf8')
		const pattern = blockRe(name)
		const found = text.match(pattern)
		if (!found) throw new Error(`团队 ${team} 的 cordis.patch.yml 里没有市场块「${name}」`)

		const spec = parseMcpBlock(found[0])
		if (!spec.serverName) throw new Error('解析出的配置缺少 serverName')
		const version = String(meta.version || '1.0.0')
		const visibility = meta.visibility === 'public' ? 'public' : 'private'
		const env = meta.env || Object.keys(spec.env || {}).map((key) => ({ key, required: false, desc: '' }))

		if (SKILL_MODE === 'db') {
			// 表是事实：写 market_items（受「名字先到先得」约束）+ 把 current 指到这一版。
			// config 里只放结构，env 的取值在这里已经被解析过，一格都不能带进市场。
			const db = openDb()
			const clean = { ...spec, env: Object.fromEntries(Object.keys(spec.env || {}).map((key) => [key, ''])) }
			upsertItem(db, {
				kind: 'mcp',
				name: spec.serverName,
				version,
				title: meta.title || spec.serverName,
				description: meta.desc || '',
				config: JSON.stringify({ spec: clean, env }),
				visibility,
				ownerTeam: team,
				status: 'published',
				createdBy: meta.by || 'console',
				publishedAt: nowIso(),
			})
			setCurrent(db, 'mcp', spec.serverName, version)
			appendOp({
				team,
				action: 'publish',
				kind: 'mcp',
				name: spec.serverName,
				by: meta.by,
				note: meta.note,
				detail: `发布到市场 v${version}（${visibility === 'public' ? '公开' : '私有'}）`,
			})
			return { published: 'mcp', name: spec.serverName, version, visibility }
		}

		const pkg = {
			kind: 'mcp',
			name: spec.serverName,
			version,
			title: meta.title || spec.serverName,
			desc: meta.desc || '',
			tags: meta.tags || [],
			visibility,
			owner: team,
			publishedAt: new Date().toISOString(),
			spec,
			env,
		}
		mkdirSync(MARKET_MCPS, { recursive: true })
		writeInPlace(join(MARKET_MCPS, `${pkg.name}.json`), `${JSON.stringify(pkg, null, 2)}\n`)
		const items = marketIndex().items.filter((i) => !(i.kind === 'mcp' && i.name === pkg.name))
		items.push({ ...pkg, spec: undefined, env: pkg.env })
		saveMarketIndex({ items })
		appendOp({
			team,
			action: 'publish',
			kind: 'mcp',
			name: pkg.name,
			by: meta.by,
			note: meta.note,
			detail: `发布到市场 v${pkg.version}（${meta.visibility === 'public' ? '公开' : '私有'}）`,
		})
		return { published: 'mcp', name: pkg.name, version: pkg.version }
	} finally {
		rmSync(staging, { recursive: true, force: true })
	}
}

/**
 * 把标记块里的 YAML 解析回对象。
 *
 * 只认我们自己写出去的形状（固定缩进），不做通用 YAML 解析：
 * 通用解析器会把 `!!js` 这类 dsh 扩展标签处理错，而这里只需要往返自己生成的内容。
 *
 * 必须处理数组项（`- "-y"`）和 env 子块两层嵌套——漏掉数组会让发布出去的
 * 连接器包丢掉 args，再装回来就是一个没有参数的 npx，起不来也不报错。
 */
export function parseMcpBlock(text) {
	const spec = {}
	let mode = null // 'env' 表示当前在 env: 里，'list' 表示在当前数组里
	let arrayKey = null
	for (const raw of text.split(/\r?\n/)) {
		if (!raw.trim() || raw.trim().startsWith('#')) continue
		const indent = raw.length - raw.trimStart().length
		const trimmed = raw.trim()

		// 包装层：insert / id / name / config 都不是配置本身
		if (/^(insert:|config:|-\s+id:|id:)/.test(trimmed)) continue
		if (/^name:\s*['"]?@deepseek-ai/.test(trimmed)) continue

		const item = trimmed.match(/^-\s+(.+)$/)
		if (item && arrayKey) {
			spec[arrayKey].push(unquote(item[1]))
			continue
		}

		const kv = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/)
		if (!kv) continue
		const key = kv[1]
		const rawValue = kv[2].trim()

		if (rawValue === '') {
			if (key === 'env') {
				spec.env = {}
				mode = 'env'
				arrayKey = null
			} else {
				spec[key] = []
				arrayKey = key
				mode = 'list'
			}
			continue
		}

		if (mode === 'env' && indent >= 10) {
			spec.env[key] = unquote(rawValue)
			continue
		}
		if (rawValue.startsWith('[')) {
			try {
				spec[key] = JSON.parse(rawValue.replace(/'/g, '"'))
			} catch {
				spec[key] = rawValue.replace(/^\[|\]$/g, '').split(',').map((s) => unquote(s.trim())).filter(Boolean)
			}
			continue
		}
		spec[key] = unquote(rawValue)
	}
	return spec
}

const unquote = (text) => String(text).trim().replace(/^['"]|['"]$/g, '')

// ---------- 新团队的初始包 ----------

export const DEFAULTS_FILE = join(MARKET_DIR, 'defaults.json')

/** 新团队默认装什么。默认空——新团队从干净状态开始，要不要预装由运维决定。 */
export function defaults() {
	const data = readJson(DEFAULTS_FILE, {})
	return { skills: Array.isArray(data.skills) ? data.skills : [], mcp: Array.isArray(data.mcp) ? data.mcp : [] }
}

/**
 * 给刚建好的团队装基础包。
 *
 * 失败只记日志不抛：团队已经建好、注册表也写了，不该因为一个装不上的默认包
 * 把它回滚掉——那会让「建团队」这个动作变得看运气。
 *
 * @returns {Promise<{installed:string[], failed:string[]}>}
 */
export async function installDefaults(team) {
	const conf = defaults()
	const installed = []
	const failed = []
	for (const name of conf.skills) {
		try {
			await installSkill(team, name)
			installed.push(`skill:${name}`)
		} catch (error) {
			failed.push(`skill:${name}（${error.message.slice(0, 120)}）`)
		}
	}
	let mcpInstalled = false
	for (const entry of conf.mcp) {
		const name = typeof entry === 'string' ? entry : entry?.name
		if (!name) continue
		try {
			await installMcp(team, name, (typeof entry === 'object' && entry.env) || {})
			mcpInstalled = true
			installed.push(`mcp:${name}`)
		} catch (error) {
			failed.push(`mcp:${name}（${error.message.slice(0, 120)}）`)
		}
	}
	return { installed, failed, needsRestart: mcpInstalled }
}

// ---------- 市场整体视图 ----------

/** 市场 + 每个团队的安装情况，给门户一次拿全。 */
export async function marketView(team) {
	if (SKILL_MODE === 'db') {
		const db = openDb()
		const rows = marketCatalog(db, team || '')
		const skillInstalled = new Map(teamSkillRows(db, team || '').map((r) => [r.name, r.version]))
		const mcpInstalled = new Map(teamMcpRows(db, team || '').map((r) => [r.name, r.version]))
		return {
			market: rows.map((r) => ({
				kind: r.kind,
				name: r.name,
				version: r.version,
				title: r.title,
				desc: r.description,
				visibility: r.visibility,
				owner: r.owner_team,
				publishedAt: r.published_at,
				installedVersion: (r.kind === 'skill' ? skillInstalled : mcpInstalled).get(r.name),
			})),
			updatedAt: rows.reduce((latest, r) => (r.updated_at > latest ? r.updated_at : latest), ''),
		}
	}
	const index = marketIndex()
	const led = team ? teamLedger(team) : { skills: {}, mcp: {} }
	return {
		market: index.items.map((item) => ({
			...item,
			installedVersion: item.kind === 'skill' ? led.skills?.[item.name]?.version : led.mcp?.[item.name]?.version,
		})),
		updatedAt: index.updatedAt,
	}
}

/** 从磁盘重建某个 skill 包的元信息（给 reconcile 用）。 */
export function diskSkillMeta(name) {
	return skillMeta(join(MARKET_SKILLS, name), name)
}

/** 市场里现有的包名。 */
export function marketSlugs(kind) {
	const dir = kind === 'skill' ? MARKET_SKILLS : MARKET_MCPS
	if (!existsSync(dir)) return []
	return readdirSync(dir)
		.filter((entry) => {
			if (entry.startsWith('.')) return false
			const full = join(dir, entry)
			return kind === 'skill' ? statSync(full).isDirectory() : entry.endsWith('.json')
		})
		.map((entry) => (kind === 'skill' ? entry : entry.replace(/\.json$/, '')))
}

export { slug, SKILL_ROOT, MCP_PATCH }
