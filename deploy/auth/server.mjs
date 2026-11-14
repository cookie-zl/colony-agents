/**
 * 账号与团队的最小实现：登录、加入团队、跨团队单点跳转、门户运维。
 *
 * 它只回答两个问题——「这个请求以谁的身份放行」「这个人能对自己的团队做什么」，
 * 其余全部交给 Caddy 与控制面：
 *   /__auth/verify          forward_auth 的子请求，返回 200 + X-Auth-User，或 401/403
 *   /__auth/login           发本 host 的会话 Cookie（Cookie 不跨 host，所以要按 host 登录）
 *   /__auth/sso             A 团队点 B 团队时发一次性票据，避免再输一次密码
 *   /__auth/home            门户：团队列表、运行状态、休眠/唤醒/归档/恢复
 *   /__auth/members         成员管理（团队 owner 或全局 owner）
 *   /__auth/packages        技能与连接器：本团队已装、市场、发布/分享（团队 owner 可改）
 *   /__auth/audit           访问审计：谁在什么时候用了哪个团队
 *   /__auth/password        改密（会踢掉该用户所有旧会话）
 *   /__auth/bootstrap       给 dsh 补 token（dsh 只认自己发的 Cookie）
 *
 * 换成公司 SSO（oauth2-proxy / Keycloak）时，换掉的是这个服务；
 * Caddy 与 Ingress 那一侧的 forward_auth 契约完全不变。
 *
 * 写 accounts.json 的两条规矩（踩过坑，别改）：
 *   1. 只能原地覆盖，不能 rename——它是单文件 bind mount，换 inode 会让容器里悬空
 *   2. 只改自己负责的字段（成员、策略、密码），团队与配额归控制面管
 */
import http from 'node:http'
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'

const cfg = {
	team: process.env.DSH_TEAM || 'team-a',
	port: Number(process.env.AUTH_PORT || 9000),
	accountsFile: process.env.ACCOUNTS_FILE || '/data/accounts.json',
	secretFile: process.env.SECRET_FILE || '/data/secret',
	tokenDir: process.env.TOKEN_DIR || '/tokens',
	auditDir: process.env.AUDIT_DIR || '/data/audit',
	auditKeepDays: Number(process.env.AUDIT_KEEP_DAYS || 30),
	sessionSeconds: Number(process.env.SESSION_SECONDS || 12 * 3600),
	passwordMinLength: Number(process.env.PASSWORD_MIN_LENGTH || 8),
	cookie: 'dsh-sso',
	// 登录暴破防护：窗口内错够次数就锁一段时间，见 loginRetryAfter
	loginMaxFailures: Number(process.env.LOGIN_MAX_FAILURES || 5),
	loginLockSeconds: Number(process.env.LOGIN_LOCK_SECONDS || 300),
	loginWindowSeconds: Number(process.env.LOGIN_WINDOW_SECONDS || 900),
	// 控制面（建团队 = 建容器）。本地是宿主上的 node 进程，云上换成 K8s API 的同一个接口。
	consoleUrl: process.env.ORCHESTRATOR_URL || 'http://host.docker.internal:9700',
	consoleTokenFile: process.env.ORCHESTRATOR_TOKEN_FILE || '/data/console-token',
	// 联调用的登录预填：两个都填了才会把表单预填好。生产部署不要设，
	// 因为密码会直接出现在 HTML 源码里（它本来也挡不住同机的开发者，但别让它成为默认行为）。
	prefillUser: String(process.env.LOGIN_PREFILL_USER || '').trim(),
	prefillPassword: String(process.env.LOGIN_PREFILL_PASSWORD || ''),
	// 本地调试免登录：开了就把所有请求当成 debugUser，登录页 / SSO / 成员校验全跳过。
	// 只在 dev compose 默认打开；生产部署必须显式设 DSH_SKIP_LOGIN=0。
	skipLogin: String(process.env.DSH_SKIP_LOGIN || '0') === '1',
	debugUser: String(process.env.DSH_DEBUG_USER || process.env.LOGIN_PREFILL_USER || 'alice').trim(),
}

const secret = readFileSync(cfg.secretFile, 'utf8').trim()
if (secret.length < 16) {
	console.error('auth: secret 太短，重新生成 deploy/auth/secret')
	process.exit(1)
}

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const hmac = (data) => createHmac('sha256', secret).update(data).digest()
const now = () => Math.floor(Date.now() / 1000)

function signToken(payload) {
	const body = b64u(JSON.stringify(payload))
	return `v1.${body}.${b64u(hmac(body))}`
}

function verifyToken(token) {
	const parts = String(token || '').split('.')
	if (parts.length !== 3 || parts[0] !== 'v1') return null
	const [, body, sig] = parts
	const expect = b64u(hmac(body))
	if (sig.length !== expect.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null
	try {
		const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
		if (!payload.exp || payload.exp < now()) return null
		return payload
	} catch {
		return null
	}
}

let cache = { mtimeMs: 0, data: null }
function accounts() {
	try {
		const mtimeMs = statSync(cfg.accountsFile).mtimeMs
		if (!cache.data || cache.mtimeMs !== mtimeMs) {
			cache = { mtimeMs, data: JSON.parse(readFileSync(cfg.accountsFile, 'utf8')) }
		}
	} catch (error) {
		// 控制面写注册表的瞬间可能读到半个文件；此时沿用上一份，别让整个服务崩掉。
		// 真的一直读不到（例如挂载断了）才把错误抛出去，让它显式失败。
		if (!cache.data) throw error
		console.error('auth: 读注册表失败，沿用上一份缓存', error.message)
	}
	return cache.data
}

function saveAccounts(data) {
	// 先写容器内的 /tmp 再整体覆盖目标文件：accounts.json 是绑定挂载的单个文件，
	// 容器里那个目录属于 root（Docker 为挂载点建的空目录），uid 1000 无法在里面建临时文件，
	// 但覆盖已存在的文件本身是可以的。
	const tmp = `/tmp/dsh-accounts-${process.pid}.json`
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
	copyFileSync(tmp, cfg.accountsFile)
	cache = { mtimeMs: 0, data: null }
}

function checkPassword(user, password) {
	const got = scryptSync(String(password), user.salt, 32)
	const want = Buffer.from(user.hash, 'hex')
	return got.length === want.length && timingSafeEqual(got, want)
}

/** 生成 scrypt 凭据。盐每次新生成，同一个人改回旧密码也不会得到相同的 hash。 */
function hashPassword(password) {
	const salt = randomBytes(16).toString('hex')
	return { salt, hash: scryptSync(String(password), salt, 32).toString('hex') }
}

function parseCookies(header = '') {
	const out = {}
	for (const part of header.split(';')) {
		const i = part.indexOf('=')
		if (i < 0) continue
		out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
	}
	return out
}

/**
 * 当前 host 是否已经有 dsh 自己签发的 Cookie。
 *
 * dsh 把 authority（host:port）签进 cookie 的 payload，并把 sha256(authority) 编进 cookie 名。
 * 端口一换（8080 → 8085），8080 时代的旧 cookie 还在浏览器里，但名字与 authority 都不匹配；
 * Caddy 只判断「有没有 dsh-auth- 前缀」会误以为已经换过票，把旧 cookie 递给新实例 →
 * `dsh web authentication required`。所以这里按 authority 精确判一次，缺了就让浏览器重签。
 *
 * @param {object} req 请求（forward_auth 带 X-Forwarded-Host）
 * @returns {boolean} 是否已有匹配的 dsh cookie
 */
function hasDshCookieFor(req) {
	const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase()
	if (!host) return false
	for (const [name, value] of Object.entries(parseCookies(req.headers.cookie || ''))) {
		if (!name.startsWith('dsh-auth-')) continue
		const payload = String(value).split('.')[1]
		if (!payload) continue
		try {
			const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
			if (body.authority === host) return true
		} catch {
			// 坏 cookie 当成没有，让 bootstrap 重签一个
		}
	}
	return false
}

/**
 * 解析当前会话。
 *
 * 除了验签与过期，还要比对密码版本号 pv：改密、被管理员强制下线时只把 pv 加一，
 * 所有旧 Cookie 立刻失效——不用维护会话表，也不用等 Cookie 自然过期。
 */
function session(req) {
	// 免登录调试：给一个固定身份，页面和所有 /__auth/api/* 都以它为准（面板也能正常读数据）
	if (cfg.skipLogin) {
		const user = accounts().users[cfg.debugUser]
		if (user) return { id: cfg.debugUser, ...user, _iat: 0 }
	}
	const raw = parseCookies(req.headers.cookie || '')[cfg.cookie]
	const payload = verifyToken(raw)
	if (!payload) return null
	const user = accounts().users[payload.u]
	if (!user) return null
	if ((payload.pv ?? 0) !== (user.pv ?? 0)) return null
	return { id: payload.u, ...user, _iat: payload.iat || 0 }
}

function isMember(user, team) {
	return Boolean(user?.teams?.includes(team))
}

/**
 * 管理员：唯一能新建团队的角色，同时可以管理所有团队。
 * 旧注册表里 alice 写的是 role: 'owner'，这里一并认，免得升级后没人能建团队。
 */
function isAdmin(user) {
	return user?.role === 'admin' || user?.role === 'owner'
}

/**
 * 某人在某个团队里的角色：owner / member；不在团队里返回 null。
 *
 * 角色存在团队上（teams[].roles）而不是账号上——同一个人可以是 A 组的 owner、
 * B 组的普通成员。roles 缺失时按 teams[].owner 推导，兼容旧注册表。
 *
 * 第一个参数是用户 id 而不是用户对象：注册表里的账号记录（users[x]）本身不带 id，
 * 传对象进来会让 roles[user.id] 永远取不到，权限判断会静默退化。
 * data 可选，调用方手里已经有改了一半的副本时传进来，避免读到旧文件。
 */
function teamRole(userId, team, data = null) {
	const source = data || accounts()
	const user = source.users?.[userId]
	if (!user || !(user.teams || []).includes(team)) return null
	const t = source.teams?.[team]
	const declared = t?.roles?.[userId]
	if (declared === 'owner' || declared === 'member') return declared
	return t?.owner === userId ? 'owner' : 'member'
}

/** 能否管理某个团队：团队 owner，或管理员。普通成员只能看。 */
function canManage(user, team) {
	if (!user || !accounts().teams[team]) return false
	return isAdmin(user) || teamRole(user.id, team) === 'owner'
}

// ---------- 登录限流 ----------

/**
 * 暴力破解防护：按「账户」和「来源 IP」两个维度计数。
 *
 * 只按 IP 挡不住换 IP 打同一个账号，只按账号挡不住撞库打一片账号，所以两个都数，
 * 任一到阈值就锁。锁定期内**即使密码正确也拒绝**——否则攻击者对每个候选密码
 * 只需验一次，锁定等于形同虚设。
 *
 * 状态只在内存里，进程重启即清空；每个团队是独立的 auth 容器，所以 A 团队被锁
 * 不影响 B 团队。这是隔离的副作用，不是漏。
 */
const loginFails = new Map()

/** 取客户端 IP。Caddy 会填 X-Forwarded-For，直连时退回 socket 地址。 */
function clientIp(req) {
	return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
		.split(',')[0]
		.trim()
}

const loginKeys = (id, ip) => (ip ? [`u:${id}`, `ip:${ip}`] : [`u:${id}`])

/**
 * 还要等多少秒才能再试。0 表示没锁。
 *
 * 窗口外的老记录顺手丢掉，否则 Map 只增不减——长期运行的进程里这是慢性泄漏。
 */
function loginRetryAfter(id, ip) {
	const at = now()
	let retry = 0
	for (const key of loginKeys(id, ip)) {
		const rec = loginFails.get(key)
		if (!rec) continue
		if (rec.lockedUntil > at) retry = Math.max(retry, rec.lockedUntil - at)
		else if (at - rec.firstAt > cfg.loginWindowSeconds) loginFails.delete(key)
	}
	return retry
}

function noteLoginFail(id, ip) {
	const at = now()
	for (const key of loginKeys(id, ip)) {
		const rec = loginFails.get(key)
		if (!rec || at - rec.firstAt > cfg.loginWindowSeconds) {
			loginFails.set(key, { count: 1, firstAt: at, lockedUntil: 0 })
			continue
		}
		rec.count += 1
		if (rec.count >= cfg.loginMaxFailures) rec.lockedUntil = at + cfg.loginLockSeconds
	}
	// 记录本身也防膨胀：正常规模只有几十条，真被刷爆就整体清一次。
	// 宁可短暂放行，也不能让内存被一张表吃满。
	if (loginFails.size > 2000) loginFails.clear()
}

/** 登录成功就把这个账号和这个 IP 的失败账一笔勾销。 */
function noteLoginOk(id, ip) {
	for (const key of loginKeys(id, ip)) loginFails.delete(key)
}

// ---------- 审计 ----------

let auditBroken = false
const auditSeen = new Map()

/**
 * 记一条访问审计。
 *
 * 目的不是「还原每条消息是谁说的」（dsh 的事件流里没有作者字段，做不到），
 * 而是回答运维真正会问的问题：谁在什么时候用了哪个团队。
 * 因此只记页面级与 API 请求，同一人同一路径去重。
 *
 * 去重窗口分两档：普通访问 5 秒（一次页面加载会打几十个请求，全记是噪声）；
 * 登录成败 1 秒——安全事件要能被数出来，5 秒去重会把「试了 5 次」压成一条，
 * 事后算不出攻击强度。1 秒既保留了人的操作粒度，也挡住脚本高速刷盘。
 */
const AUDIT_SECURITY_EVENTS = new Set(['login-failed', 'login-locked', 'password-changed'])

function audit(req, user, extra = {}) {
	// forward_auth 的子请求路径永远是 /__auth/verify，真实路径在 X-Forwarded-Uri 里
	const pathname = extra.path || ''
	const interesting = pathname === '/' || pathname.startsWith('/api') || pathname.startsWith('/__auth')
	if (!interesting) return
	const security = AUDIT_SECURITY_EVENTS.has(extra.event)
	const key = `${user.id}|${cfg.team}|${pathname}|${extra.event || ''}`
	const at = Date.now()
	if (at - (auditSeen.get(key) || 0) < (security ? 1000 : 5000)) return
	auditSeen.set(key, at)
	if (auditSeen.size > 4000) auditSeen.clear()

	const entry = {
		ts: new Date().toISOString(),
		user: user.id,
		team: cfg.team,
		method: extra.method || req.method,
		path: pathname,
		ip: clientIp(req),
		ua: String(req.headers['user-agent'] || '').slice(0, 160),
		...extra,
	}
	try {
		mkdirSync(cfg.auditDir, { recursive: true })
		appendFileSync(`${cfg.auditDir}/${entry.ts.slice(0, 10)}.jsonl`, `${JSON.stringify(entry)}\n`)
	} catch (error) {
		// 审计写不进去不能挡住业务，但必须让人知道它坏了
		if (!auditBroken) {
			auditBroken = true
			console.error('auth: 审计日志写入失败（本次运行只提示一次）', error.message)
		}
	}
}

/** 读最近几天的审计，按时间倒序。文件按天切，读多了会慢，所以最多回看 3 天。 */
function readAudit({ team, user, days = 3, limit = 120 } = {}) {
	const rows = []
	try {
		const files = readdirSync(cfg.auditDir)
			.filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
			.sort()
			.slice(-days)
		for (const file of files) {
			for (const line of readFileSync(`${cfg.auditDir}/${file}`, 'utf8').split('\n')) {
				if (!line.trim()) continue
				try {
					const row = JSON.parse(line)
					if (team && row.team !== team) continue
					if (user && row.user !== user) continue
					rows.push(row)
				} catch {
					// 半行（进程被杀时可能出现）直接跳过
				}
			}
		}
	} catch {
		return []
	}
	return rows.slice(-limit).reverse()
}

/**
 * 清掉过期审计。
 *
 * 按天切文件只是让单个文件不会大到打不开，**不等于自动轮转**：没人删的话
 * 一年就是 365 个文件，而审计里含用户名与 IP，留着无限久既占盘又多一份泄露面。
 * 三个团队的 auth 共享同一个挂载目录，删同一批文件是幂等的，谁删都一样。
 */
function pruneAudit() {
	try {
		const cutoff = Date.now() - cfg.auditKeepDays * 86400_000
		for (const file of readdirSync(cfg.auditDir)) {
			if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)) continue
			const path = `${cfg.auditDir}/${file}`
			if (statSync(path).mtimeMs < cutoff) unlinkSync(path)
		}
	} catch (error) {
		// 目录还没建出来（第一次启动、当天还没有请求）属于正常情况，不当故障
		if (error.code !== 'ENOENT') console.error('auth: 清理过期审计失败', error.message)
	}
}

// ---------- 控制面 ----------

/** 调控制面。失败时把控制面的错误原文透出来，别让用户只看到一个 500。 */
async function callConsole(pathname, method = 'GET', body) {
	let token = ''
	try {
		token = readFileSync(cfg.consoleTokenFile, 'utf8').trim()
	} catch {
		throw new Error(`控制面 token 不存在（${cfg.consoleTokenFile}）：在仓库根目录执行 make console 一次即可生成`)
	}
	const target = new URL(pathname, cfg.consoleUrl)
	const payload = body ? JSON.stringify(body) : null
	const res = await fetch(target, {
		method,
		headers: {
			'X-Console-Token': token,
			...(payload ? { 'Content-Type': 'application/json' } : {}),
		},
		body: payload,
		signal: AbortSignal.timeout(300_000),
	})
	const text = await res.text()
	let data = null
	try {
		data = JSON.parse(text)
	} catch {
		data = { error: text }
	}
	if (!res.ok) {
		// 带上状态与机器可读的 code：门户只读 message，但侧栏面板要据此决定
		// 「被本地同名遮蔽了，是否提供强制安装」这类分支，丢了这个就只能靠猜文案。
		const err = new Error(data?.error || `控制面返回 ${res.status}`)
		err.status = res.status
		err.code = data?.code
		err.detail = data?.detail
		throw err
	}
	return data
}

/**
 * 问控制面「本站点这个实例醒着吗」。
 *
 * 控制面没启动时要 fail-open（当作醒着）：休眠只是一个优化，
 * 不该因为它把所有人挡在门外。
 *
 * 缓存 2 秒：一次页面加载会并发几十个请求，每次都问控制面太浪费；
 * 但缓存太久的话，实例刚睡下的那一瞬间请求会被判成「醒着」，
 * 于是穿过 verify 撞上 Caddy 的裸 502。2 秒是这两个诉求的折中。
 */
let probe = { at: 0, info: null }
async function sleepState(maxAgeMs = 2000) {
	if (probe.info && Date.now() - probe.at < maxAgeMs) return probe.info
	try {
		const token = readFileSync(cfg.consoleTokenFile, 'utf8').trim()
		const target = new URL(`/wake-state?team=${encodeURIComponent(cfg.team)}`, cfg.consoleUrl)
		const res = await fetch(target, { headers: { 'X-Console-Token': token }, signal: AbortSignal.timeout(1500) })
		if (!res.ok) throw new Error(`控制面返回 ${res.status}`)
		probe = { at: Date.now(), info: await res.json() }
	} catch (error) {
		probe = { at: 0, info: { unknown: true, error: error.message } }
	}
	return probe.info
}

/** 门户用的全量状态。缓存 3 秒：home 页一次渲染只问一次控制面。 */
let consoleState = { at: 0, data: null }
async function allTeamState() {
	if (consoleState.data && Date.now() - consoleState.at < 3000) return consoleState.data
	try {
		consoleState = { at: Date.now(), data: await callConsole('/state') }
	} catch (error) {
		consoleState = { at: Date.now(), data: { error: error.message, teams: {} } }
	}
	return consoleState.data
}

/** 触发唤醒：幂等且会去重，所以每次被拦都可以放心调，不会真的重复拉起。 */
let wakeAt = 0
let touchAt = 0
function requestWake() {
	if (Date.now() - wakeAt < 3000) return
	wakeAt = Date.now()
	// 醒来后的第一次成功访问必须立刻上报活跃，否则会被节流窗口吞掉，
	// 控制面看到的 lastSeen 还停在休眠前，刚醒就可能被再次判定为闲置。
	touchAt = 0
	callConsole('/wake', 'POST', { team: cfg.team })
		.then(() => {
			probe = { at: 0, info: null }
		})
		.catch((error) => console.error('auth: 触发唤醒失败', error.message))
}

/** 记一次活跃，供控制面判断闲置。节流 20 秒，别让每个静态资源都打一次。 */
function touchSeen() {
	if (Date.now() - touchAt < 20_000) return
	touchAt = Date.now()
	callConsole('/touch', 'POST', { team: cfg.team }).catch(() => {})
}

// ---------- 会话 Cookie ----------

function setSessionCookie(res, userId, secure, pv = 0) {
	const value = signToken({ u: userId, pv, iat: now(), exp: now() + cfg.sessionSeconds })
	res.setHeader(
		'Set-Cookie',
		`${cfg.cookie}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${cfg.sessionSeconds}${secure ? '; Secure' : ''}`,
	)
}

function clearSessionCookie(res) {
	res.setHeader('Set-Cookie', `${cfg.cookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

/**
 * 滑动续期：用得越久越不该被踢下线。
 *
 * 只在「已过半程」时重发 Cookie，而不是每个请求都发 —— 一次页面加载几十个
 * 并发请求，全都带 Set-Cookie 是纯浪费，还会让 CDN/代理的缓存行为变怪。
 */
function refreshIfStale(res, user, secure) {
	const age = now() - (user._iat || 0)
	if (age < cfg.sessionSeconds * 0.5) return
	setSessionCookie(res, user.id, secure, user.pv ?? 0)
}

// ---------- 页面 ----------

const safePath = (value, fallback = '/') => {
	if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return fallback
	return value
}

const escapeHtml = (value) =>
	String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function teamUrl(team, pathname = '/') {
	const t = accounts().teams[team]
	if (!t) return pathname
	// helm 节点没有端口，入口是 ingress 域名，注册表里存了完整 url
	if (t.url) return `${t.url.replace(/\/$/, '')}${pathname}`
	return `http://${t.host}:${t.port}${pathname}`
}

function send(res, status, body, headers = {}) {
	res.writeHead(status, {
		'Cache-Control': 'no-store',
		'X-Robots-Tag': 'noindex',
		'Referrer-Policy': 'same-origin',
		...headers,
	})
	res.end(body)
}

function html(res, status, body, headers = {}) {
	send(res, status, body, { 'Content-Type': 'text/html; charset=utf-8', ...headers })
}

async function readBody(req, limit = 64 * 1024) {
	let size = 0
	const chunks = []
	for await (const chunk of req) {
		size += chunk.length
		if (size > limit) throw new Error('body too large')
		chunks.push(chunk)
	}
	return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

/** JSON 响应：给侧栏面板那些 fetch 调用用，不要与页面路由混在一起。 */
function json(res, status, body) {
	send(res, status, JSON.stringify(body), { 'Content-Type': 'application/json; charset=utf-8' })
}

/** 读 JSON 请求体。上限比表单大一点：连接器的 env 可能带证书。 */
async function readJson(req, limit = 256 * 1024) {
	let size = 0
	const chunks = []
	for await (const chunk of req) {
		size += chunk.length
		if (size > limit) throw new Error('body too large')
		chunks.push(chunk)
	}
	const text = Buffer.concat(chunks).toString('utf8')
	if (!text.trim()) return {}
	return JSON.parse(text)
}

const CSS = `
*{box-sizing:border-box}
body{margin:0;padding:48px 20px;font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;
  background:#f5f5f3;color:#1f1f1d}
.wrap{max-width:680px;margin:0 auto}
h1{font-size:20px;font-weight:500;margin:0 0 6px}
p.lead{margin:0 0 28px;color:#5f5e5a;font-size:14px}
.card{background:#fff;border:1px solid rgba(0,0,0,.12);border-radius:12px;padding:20px;margin-bottom:14px}
.card h2{font-size:15px;font-weight:500;margin:0 0 4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.meta{color:#5f5e5a;font-size:13px;margin:0 0 14px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.row form{display:inline;margin:0}
input[type=text],input[type=password],input[type=number],select{flex:1 1 160px;min-width:0;padding:9px 11px;font-size:14px;
  border:1px solid rgba(0,0,0,.2);border-radius:8px;background:#fff;color:inherit}
button{font-size:14px;padding:9px 16px;border-radius:8px;border:1px solid rgba(0,0,0,.2);
  background:#fff;color:inherit;cursor:pointer}
button.primary{background:#1f1f1d;border-color:#1f1f1d;color:#fff}
button.small{font-size:13px;padding:7px 12px}
button.danger{border-color:#e24b4a;color:#a32d2d}
.tag{font-size:12px;padding:2px 8px;border-radius:999px;background:#e6f1fb;color:#185fa5;font-weight:400}
.tag.muted{background:#f1efe8;color:#5f5e5a}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;background:#b4b2a9;flex:none}
.dot.on{background:#639922}
.dot.warn{background:#ef9f27}
.dot.off{background:#b4b2a9}
.state{font-size:13px;color:#5f5e5a}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid rgba(0,0,0,.08);vertical-align:top}
th{color:#5f5e5a;font-weight:400}
td.time{white-space:nowrap;color:#5f5e5a}
code{font-size:12px;background:rgba(0,0,0,.05);padding:1px 4px;border-radius:4px}
a{color:#185fa5}
.foot{margin-top:28px;font-size:12px;color:#888780}
@media(prefers-color-scheme:dark){
  body{background:#1a1a19;color:#eeeee9}
  .card{background:#242423;border-color:rgba(255,255,255,.14)}
  p.lead,.meta,.foot,.state,th,td.time{color:#b4b2a9}
  input[type=text],input[type=password],input[type=number],select,button{background:#1a1a19;border-color:rgba(255,255,255,.2);color:#eeeee9}
  button.primary{background:#eeeee9;border-color:#eeeee9;color:#1a1a19}
  .tag{background:#0c447c;color:#b5d4f4}
  .tag.muted{background:#2c2c2a;color:#b4b2a9}
  th,td{border-color:rgba(255,255,255,.1)}
  code{background:rgba(255,255,255,.1)}
  a{color:#85b7eb}
}`

function page(title, body, head = '') {
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>${head}<style>${CSS}</style></head>
<body><div class="wrap">${body}</div></body></html>`
}

const teamName = (id) => accounts().teams[id]?.name || id

function wakePage() {
	const label = escapeHtml(teamName(cfg.team))
	return page(
		`正在唤醒「${teamName(cfg.team)}」`,
		`<h1>正在唤醒「${label}」</h1>
<p class="lead">这个团队闲置了一段时间，实例正在恢复。通常 5~10 秒，会话和工作区都还在。</p>
<div class="card"><p class="meta" style="margin:0">超过 30 秒还停在这里，就 <a href="">重新加载</a> 一次；或者先回 <a href="/__auth/home">门户</a> 看看其他团队。</p></div>`,
		'<meta http-equiv="refresh" content="2">',
	)
}

function loginPage({ rd, error, user }) {
	const t = accounts().teams[cfg.team]
	const denied = user && !isMember(user, cfg.team)
	// 预填只在两个值都配了时生效：只配用户名容易让人以为密码忘了
	const prefill = Boolean(cfg.prefillUser && cfg.prefillPassword)
	const userValue = prefill ? ` value="${escapeHtml(cfg.prefillUser)}"` : ''
	const passValue = prefill ? ` value="${escapeHtml(cfg.prefillPassword)}"` : ''
	return page(
		`登录 · ${t ? t.name : cfg.team}`,
		`<h1>${t ? t.name : cfg.team}</h1>
<p class="lead">${t?.desc || ''} · 需要登录并属于该团队才能进入</p>
${error ? `<div class="card"><p class="meta" style="margin:0;color:#a32d2d">${error}</p></div>` : ''}
${denied ? `<div class="card"><h2>你不是「${t?.name || cfg.team}」的成员</h2>
<p class="meta">当前身份 ${user.name}（${user.id}）。加入后即可进入。</p>
<form method="post" action="/__auth/join"><input type="hidden" name="team" value="${cfg.team}">
<input type="hidden" name="rd" value="${rd}"><button class="primary">加入该团队</button></form></div>` : ''}
<div class="card"><h2>账号登录</h2>
<form method="post" action="/__auth/login" class="row">
<input type="hidden" name="rd" value="${rd}">
<input type="text" name="username" placeholder="用户名" autocomplete="username" autofocus${userValue}>
<input type="password" name="password" placeholder="密码" autocomplete="current-password"${passValue}>
<button class="primary">登录</button></form>
<p class="meta" style="margin:14px 0 0">${prefill
	? '已按 LOGIN_PREFILL_* 预填调试账号，直接点「登录」即可。'
	: '演示账号：alice / bob / carol / dave，密码 <code>dsh-demo-1234</code>'}
</p></div>
<p class="foot">会话只对本 host 有效（Cookie 不跨 host），换团队时会用一次性票据自动续上。</p>`,
	)
}

function passwordPage(user, error = '', forced = false) {
	return page(
		forced ? '需要修改密码' : '修改密码',
		`<h1>${forced ? '先设置一个新密码' : '修改密码'}</h1>
<p class="lead">${forced ? '管理员要求首次登录后修改密码，改完就能进入团队。' : `当前身份 ${escapeHtml(user.name)}（${user.id}）`}</p>
${error ? `<div class="card"><p class="meta" style="margin:0;color:#a32d2d">${escapeHtml(error)}</p></div>` : ''}
<div class="card"><h2>设置新密码</h2>
<form method="post" action="/__auth/password" class="row">
<input type="password" name="old" placeholder="当前密码" autocomplete="current-password" required>
<input type="password" name="new" placeholder="新密码（至少 ${cfg.passwordMinLength} 位）" autocomplete="new-password" required>
<input type="password" name="confirm" placeholder="再输一次" autocomplete="new-password" required>
<button class="primary">保存</button></form>
<p class="meta" style="margin:14px 0 0">改完密码后，你在所有浏览器上的旧会话立即失效。</p></div>
${forced ? '' : '<p class="foot"><a href="/__auth/home">返回门户</a></p>'}`,
	)
}

/** 按现有 team-x 顺推一个建议标识，省得用户自己想名字。 */
function suggestTeamId() {
	const used = new Set(Object.keys(accounts().teams))
	for (const ch of 'abcdefghijklmnopqrstuvwxyz') {
		const id = `team-${ch}`
		if (!used.has(id)) return id
	}
	return 'team-new'
}

/** 运行状态的展示形态：文字、圆点样式、可执行的动作。 */
function statusOf(team, live) {
	if (team.archived) return { text: '已归档', dot: 'off', action: 'restore' }
	const st = live?.teams?.[team.id]
	if (!st) return { text: '状态未知', dot: 'warn', action: null }
	if (st.archived) return { text: '已归档', dot: 'off', action: 'restore' }
	if (st.waking) return { text: '唤醒中', dot: 'warn', action: null }
	if (st.running) return { text: '运行中', dot: 'on', action: 'sleep' }
	return { text: '休眠中', dot: 'off', action: 'wake' }
}

function teamCard([id, t], live, user) {
	const st = statusOf({ ...t, id }, live)
	// 配额优先取控制面返回的实时值：旧注册表里没有 quota 字段时也能显示真实分配
	const quotaOfTeam = t.quota || live?.teams?.[id]?.quota
	const quota = quotaOfTeam ? `${quotaOfTeam.cpus} 核 / ${quotaOfTeam.memory}` : '默认配额'
	const members = Object.values(accounts().users).filter((u) => (u.teams || []).includes(id)).length
	const entry = t.url ? t.url : `${t.host}:${t.port}`
	const manage = canManage(user, id)

	const actionForm = (() => {
		if (!manage) return ''
		if (st.action === 'sleep')
			return `<form method="post" action="/__auth/team/sleep"><input type="hidden" name="team" value="${id}"><button class="small">休眠</button></form>`
		if (st.action === 'wake')
			return `<form method="post" action="/__auth/team/wake"><input type="hidden" name="team" value="${id}"><button class="small">唤醒</button></form>`
		if (st.action === 'restore')
			return `<form method="post" action="/__auth/team/restore"><input type="hidden" name="team" value="${id}"><button class="small">恢复</button></form>`
		return ''
	})()

	const roleTag = (() => {
		const role = teamRole(user.id, id)
		if (role === 'owner') return '<span class="tag">owner</span>'
		if (role === 'member') return '<span class="tag muted">成员</span>'
		return ''
	})()

	return `<div class="card">
<h2>${escapeHtml(t.name)}<span class="tag">${id}</span>${roleTag}<span class="dot ${st.dot}"></span><span class="state">${st.text}</span></h2>
<p class="meta">${escapeHtml(t.desc || '')} · ${escapeHtml(entry)} · ${quota} · ${members} 名成员</p>
<div class="row">
<a href="/__auth/sso?to=${id}&rd=/"><button class="primary small">进入</button></a>
${actionForm}
<a href="/__auth/members?team=${id}"><button class="small">成员</button></a>
<a href="/__auth/packages?team=${id}"><button class="small">技能</button></a>
<a href="/__auth/assistants?team=${id}"><button class="small">助理</button></a>
<a href="/__auth/audit?team=${id}"><button class="small">审计</button></a>
</div></div>`
}

async function homePage(user, notice = '') {
	const live = await allTeamState()
	const teams = Object.entries(accounts().teams)
	const mine = teams.filter(([id]) => isMember(user, id))
	// 管理员能看到自己没加入的团队，便于接手管理；普通成员只看到自己的
	const rest = isAdmin(user) ? teams.filter(([id]) => !isMember(user, id)) : []

	const createCard = isAdmin(user)
		? `<h2 style="font-size:14px;font-weight:500;margin:24px 0 10px">新建团队</h2>
<div class="card"><h2>开一个新团队<span class="tag">仅管理员</span></h2>
<p class="meta">提交后会真的创建一套隔离实例（独立容器 + 独立数据卷 + 独立入口），约 10~30 秒。你会自动成为这个团队的 owner 并跳转过去。配额由控制面按节点余量分配，放不下会直接拒绝。</p>
<form method="post" action="/__auth/teams" class="row">
<input type="text" name="id" placeholder="标识，如 team-d" value="${suggestTeamId()}" required>
<input type="text" name="name" placeholder="显示名，如 数据组" required>
<input type="text" name="desc" placeholder="一句话描述（可空）">
<button class="primary">创建并进入</button></form></div>`
		: ''

	const consoleError = live?.error
		? `<div class="card"><p class="meta" style="margin:0;color:#a32d2d">控制面暂时不可用，状态与运维操作已停用：${escapeHtml(live.error)}</p></div>`
		: ''

	return page(
		`我的团队 · ${user.name}`,
		`<h1>${escapeHtml(user.name)}</h1>
<p class="lead">已登录为 ${user.id} · 当前站点是「${teamName(cfg.team)}」${isAdmin(user) ? ' · 管理员' : ''}</p>
${notice ? `<div class="card"><p class="meta" style="margin:0;color:#a32d2d">${escapeHtml(notice)}</p></div>` : ''}
${consoleError}
${mine.length ? `<h2 style="font-size:14px;font-weight:500;margin:0 0 10px">我加入的团队</h2>${mine.map((entry) => teamCard(entry, live, user)).join('')}` : `<div class="card"><p class="meta" style="margin:0">还没有加入任何团队。团队不能自助加入，请联系该团队的 owner 把你加进去。</p></div>`}
${rest.length ? `<h2 style="font-size:14px;font-weight:500;margin:24px 0 10px">其他团队（管理员视角）</h2>${rest.map((entry) => teamCard(entry, live, user)).join('')}` : ''}
${createCard}
<p class="foot"><a href="/__auth/password">修改密码</a> · <a href="/__auth/logout">退出登录</a></p>`,
	)
}

/**
 * 成员页的可见性：团队不存在 404；非成员（且非管理员）403；其余 200。
 * 页面内容由 memberPage 决定，状态码必须在这里算——之前路由一律返回 200，
 * 于是「无权查看」的页面也报 200，脚本和监控都会当成成功。
 */
function memberStatus(user, teamId) {
	if (!accounts().teams[teamId]) return 404
	if (!isMember(user, teamId) && !isAdmin(user)) return 403
	return 200
}

function memberPage(user, teamId, notice = '') {
	const t = accounts().teams[teamId]
	if (!t) return page('团队不存在', '<h1>团队不存在</h1>')
	// 成员可以看花名册（谁在这个团队里是公开信息），但只有 owner 能改
	if (memberStatus(user, teamId) !== 200) {
		return page('无权查看', `<h1>你不属于「${escapeHtml(t.name)}」</h1><p class="lead">成员名单只对团队成员可见。</p><p class="foot"><a href="/__auth/home">返回门户</a></p>`)
	}
	const manage = canManage(user, teamId)
	const all = Object.entries(accounts().users)
	const members = all.filter(([, u]) => (u.teams || []).includes(teamId))
	const outsiders = all.filter(([, u]) => !(u.teams || []).includes(teamId))
	const rows = members
		.map(([id, u]) => {
			const role = teamRole(id, teamId) || 'member'
			const roleCell =
				role === 'owner' ? '<span class="tag">owner</span>' : '<span class="tag muted">成员</span>'
			const ownerCount = members.filter(([mid]) => teamRole(mid, teamId) === 'owner').length
			const actions = !manage
				? ''
				: [
						role === 'owner'
							? `<form method="post" action="/__auth/members/role" style="margin:0"><input type="hidden" name="team" value="${teamId}"><input type="hidden" name="user" value="${id}"><input type="hidden" name="role" value="member"><button class="small">降为成员</button></form>`
							: `<form method="post" action="/__auth/members/role" style="margin:0"><input type="hidden" name="team" value="${teamId}"><input type="hidden" name="user" value="${id}"><input type="hidden" name="role" value="owner"><button class="small">设为 owner</button></form>`,
						role === 'owner' && ownerCount <= 1
							? ''
							: `<form method="post" action="/__auth/members/remove" style="margin:0"><input type="hidden" name="team" value="${teamId}"><input type="hidden" name="user" value="${id}"><button class="small danger">移出</button></form>`,
					].join('')
			return `<tr><td>${escapeHtml(u.name)}<br><code>${id}</code></td><td>${roleCell}</td><td><div class="row">${actions}</div></td></tr>`
		})
		.join('')

	const options = outsiders.map(([id, u]) => `<option value="${id}">${escapeHtml(u.name)}（${id}）</option>`).join('')

	const addCard = manage
		? `<div class="card"><h2>添加成员<span class="tag">仅 owner</span></h2>
${outsiders.length ? `<form method="post" action="/__auth/members/add" class="row">
<input type="hidden" name="team" value="${teamId}">
<select name="user">${options}</select>
<select name="role"><option value="member">普通成员</option><option value="owner">owner</option></select>
<button class="primary">加入团队</button></form>` : '<p class="meta" style="margin:0">所有账号都已经在这个团队里了。</p>'}
<p class="meta" style="margin:14px 0 0">团队不能自助加入，只能由 owner 在这里添加。新增账号仍然要改 <code>deploy/auth/accounts.json</code>。</p></div>`
		: `<div class="card"><h2>添加成员</h2><p class="meta" style="margin:0">只有这个团队的 owner 可以添加成员。</p></div>`

	return page(
		`成员 · ${t.name}`,
		`<h1>${escapeHtml(t.name)} · 成员</h1>
<p class="lead">只有成员能进入该团队。owner 负责增减成员；移出后对方的会话仍有效，但访问会被挡在门外。</p>
${notice ? `<div class="card"><p class="meta" style="margin:0;color:#a32d2d">${escapeHtml(notice)}</p></div>` : ''}
<div class="card"><h2>现有成员<span class="tag">${members.length} 人</span></h2>
<table><tr><th>成员</th><th>角色</th><th></th></tr>${rows || '<tr><td colspan="3">还没有成员</td></tr>'}</table></div>
${addCard}
${
	manage
		? `<div class="card"><h2>休眠策略</h2>
<p class="meta">长期在用的团队可以关掉自动休眠；临时团队可以把闲置阈值调短，省内存。</p>
<form method="post" action="/__auth/policy" class="row">
<input type="hidden" name="team" value="${teamId}">
<select name="autoSleep">
<option value="1"${t.policy?.autoSleep === false ? '' : ' selected'}>自动休眠：开</option>
<option value="0"${t.policy?.autoSleep === false ? ' selected' : ''}>自动休眠：关</option>
</select>
<input type="number" name="idleMin" min="1" max="1440" value="${Math.round((t.policy?.idleMs ?? 1800000) / 60000)}" style="flex:0 0 110px">
<button class="primary">保存策略</button></form></div>`
		: ''
}
<p class="foot"><a href="/__auth/home">返回门户</a></p>`,
	)
}

/**
 * 面板用的市场快照：把控制面的 packages 视图收敛成「按 kind 分组 + 能不能管」。
 *
 * 与 packagesPage 共用同一份数据，形状不同而已。两处必须保持同一条可见性规则：
 * 别人的私有包连名字都不该出现——面板一旦多吐一个，就等于把私有包的存在泄露出去。
 */
function marketPayload(user, teamId, view) {
	const market = view?.market || []
	const installedRows = (kind) =>
		(kind === 'mcp' ? view?.installed?.detail?.mcp : view?.installed?.detail?.skills) || []

	const installedOf = (kind) =>
		installedRows(kind).map((row) => {
			// skills 的 detail 是表行（source + source_team 两列），mcp 的 detail 在控制面里
			// 已经拼成 'share:<team>'。两种形态都收敛成同一个前缀，面板只认 'share:'
			const raw = row.source || ''
			const from = raw.startsWith('share:') ? raw : raw === 'share' ? (row.source_team ? `share:${row.source_team}` : 'share') : raw
			return {
				name: row.name,
				version: row.version || '',
				// skills 的 detail 是表行（enabled 为 1/0），mcp 的 detail 是布尔，统一成布尔
				enabled: row.enabled !== 0 && row.enabled !== false,
				from,
				title: row.title || '',
				description: row.description || '',
			}
		})

	const marketOf = (kind) =>
		market
			.filter((item) => item.kind === kind)
			.filter((item) => !(item.visibility === 'private' && item.owner !== teamId))
			.map((item) => ({
				name: item.name,
				version: item.version,
				title: item.title || item.name,
				desc: item.desc || item.description || '',
				visibility: item.visibility || 'public',
				owner: item.owner || '',
				publishedAt: item.publishedAt || null,
			}))

	return {
		team: teamId,
		teamName: accounts().teams[teamId]?.name || teamId,
		user: user.id,
		manage: canManage(user, teamId),
		updatedAt: view?.updatedAt || null,
		// 实例休眠时控制面只能读台账，读不到卷里的实际情况
		stale: Boolean(view?.installed?.stale),
		skills: { installed: installedOf('skill'), market: marketOf('skill') },
		mcp: { installed: installedOf('mcp'), market: marketOf('mcp') },
		pending: (view?.pending || []).map((row) => ({
			id: row.id,
			kind: row.kind,
			name: row.name,
			from: row.from || '',
			note: row.note || '',
		})),
	}
}

/**
 * 技能 · 连接器页面。
 *
 * 两类东西的落点不同（skill 进 $DSH_HOME/skills，mcp 进 cordis.patch.yml），
 * 但对使用者来说是同一件事：这个团队现在能用什么、还能装什么、能不能把自家的发出去。
 * 所以合成一页，用 tab 分开，而不是两个入口。
 */
async function packagesPage(user, teamId, tab = 'skill', notice = '') {
	const t = accounts().teams[teamId]
	if (!t) return { status: 404, html: page('团队不存在', '<h1>团队不存在</h1>') }
	if (!isMember(user, teamId) && !isAdmin(user)) {
		return {
			status: 403,
			html: page('无权查看', `<h1>无权查看「${escapeHtml(t.name)}」</h1>
<p class="lead">技能与连接器属于团队配置，只有成员可见。</p>
<p class="foot"><a href="/__auth/home">返回门户</a></p>`),
		}
	}

	const manage = canManage(user, teamId)
	let view = null
	let error = ''
	try {
		view = await callConsole(`/packages?team=${encodeURIComponent(teamId)}`)
	} catch (err) {
		error = err.message
	}

	const installedSkills = view?.installed?.skills || []
	const installedMcp = (view?.installed?.mcp || []).map((m) => m.name)
	const kind = tab === 'mcp' ? 'mcp' : 'skill'
	const installed = kind === 'mcp' ? installedMcp : installedSkills
	// 台账是唯一知道「这个包从哪来」的地方：市场卡片只认得市场里有的包，分享进来的不在里面
	const origins = (view?.origins || {})[kind === 'mcp' ? 'mcp' : 'skills'] || {}
	const items = (view?.market || []).filter((item) => {
		if (item.kind !== kind) return false
		// 私有包只对拥有它的团队可见；别人的私有包连标题都不该出现
		if (item.visibility === 'private' && item.owner !== teamId) return false
		return true
	})

	const installedRows = installed.length
		? installed
				.map((name) => {
					// 已装版本取台账（market 项的 installedVersion），别用市场里的最新版冒充
					const marketItem = (view.market || []).find((i) => i.kind === kind && i.name === name)
					const version = marketItem?.installedVersion || (kind === 'mcp' ? (view.installed.mcp || []).find((m) => m.name === name)?.version : '') || '—'
					const from = origins[name]?.from || ''
					// 只有分享来的才标注：市场装的标「来自团队」会让每行都带个标签，反而看不清重点
					const originTag = from.startsWith('share:')
						? `<span class="tag muted">来自 ${escapeHtml(from.slice(6))} 分享</span>`
						: ''
					return `<tr><td><code>${escapeHtml(name)}</code>${originTag}</td><td>${escapeHtml(version)}</td>
<td>${manage ? `<form method="post" action="/__auth/packages/uninstall" style="margin:0">
<input type="hidden" name="team" value="${teamId}"><input type="hidden" name="kind" value="${kind}">
<input type="hidden" name="name" value="${escapeHtml(name)}"><button class="small danger">卸载</button></form>` : ''}</td></tr>`
				})
				.join('')
		: `<tr><td colspan="3">还没有装任何${kind === 'mcp' ? '连接器' : '技能'}。新团队从这里开始是空的。</td></tr>`

	const marketCards = items.length
		? items
				.map((item) => {
					const isInstalled = installed.includes(item.name)
					const envFields = (item.env || [])
						.map(
							(e) => `<input type="text" name="env_${escapeHtml(e.key)}" placeholder="${escapeHtml(e.key)}${e.required ? '（必填）' : ''}"${e.desc ? ` title="${escapeHtml(e.desc)}"` : ''}>`,
						)
						.join('')
					const action = !manage
						? ''
						: isInstalled
							? `<span class="tag muted">已安装</span>`
							: kind === 'mcp'
								? `<form method="post" action="/__auth/packages/install" class="row" style="margin:0">
<input type="hidden" name="team" value="${teamId}"><input type="hidden" name="kind" value="mcp">
<input type="hidden" name="name" value="${escapeHtml(item.name)}">${envFields}
<button class="primary small">安装</button></form>`
								: `<form method="post" action="/__auth/packages/install" style="margin:0">
<input type="hidden" name="team" value="${teamId}"><input type="hidden" name="kind" value="skill">
<input type="hidden" name="name" value="${escapeHtml(item.name)}"><button class="primary small">安装</button></form>`
					const ownerTag =
						item.owner === teamId
							? '<span class="tag">本团队发布</span>'
							: item.visibility === 'private'
								? '<span class="tag muted">私有</span>'
								: '<span class="tag muted">公开</span>'
					return `<div class="card"><h2>${escapeHtml(item.title || item.name)}
<code>${escapeHtml(item.name)}</code>${ownerTag}<span class="tag muted">v${escapeHtml(item.version || '1.0.0')}</span></h2>
<p class="meta">${escapeHtml(item.desc || '')}</p>${action}</div>`
				})
				.join('')
		: `<div class="card"><p class="meta" style="margin:0">市场里还没有${kind === 'mcp' ? '连接器' : '技能'}。
${manage ? '可以把本团队已装的包发布上去。' : ''}</p></div>`

	const tabLink = (value, label, count) =>
		`<a href="/__auth/packages?team=${teamId}&tab=${value}" style="text-decoration:none">
<button class="${kind === value ? 'primary' : ''} small">${label} ${count}</button></a>`

	const publishCard = manage
		? `<details class="card"><summary style="cursor:pointer;font-size:15px;font-weight:500">把本团队的包发布到市场</summary>
<p class="meta" style="margin:12px 0">发布只会读取这个团队的卷，不会改动任何运行中的东西。选「私有」的话，只有本团队在自己的市场里看得见。</p>
<form method="post" action="/__auth/packages/publish" class="row">
<input type="hidden" name="team" value="${teamId}">
<select name="kind"><option value="skill">技能</option><option value="mcp">连接器</option></select>
<input type="text" name="name" placeholder="包名（本团队已装的）" required>
<input type="text" name="version" placeholder="版本" value="1.0.0" style="flex:0 0 100px">
<select name="visibility"><option value="private">私有</option><option value="public">公开</option></select>
<button class="primary">发布</button></form></details>`
		: ''

	/**
	 * 点对点分享。
	 *
	 * 目标团队限定在「你自己也在其中」的团队（管理员不受限）：分享是跨租户投递，
	 * 不该由一个只能管自己团队的人发起。要发给不在其中的团队，
	 * 走上面的市场，让对方自己决定装不装。
	 *
	 * 注意语义是「投递」不是「写入」：对方收到的是待接收项，默认不生效。
	 */
	const targetTeams = Object.entries(accounts().teams).filter(
		([id]) => id !== teamId && (isAdmin(user) || isMember(user, id)),
	)
	const shareCard =
		manage && installed.length
			? `<details class="card"><summary style="cursor:pointer;font-size:15px;font-weight:500">把本团队的${kind === 'mcp' ? '连接器' : '技能'}分享给其他团队</summary>
<p class="meta" style="margin:12px 0">分享是点对点的：不经过市场，对方的市场里也看不到它。投递过去后<b>默认不生效</b>，由对方 owner 在「待接收」里确认后启用。${
				kind === 'mcp' ? '连接器的<b>凭据不会跟着走</b>，对方启用时要自己填。' : ''
			}</p>
${
	targetTeams.length
		? `<form method="post" action="/__auth/packages/share" class="row">
<input type="hidden" name="team" value="${teamId}">
<input type="hidden" name="kind" value="${kind}">
<select name="name">${installed.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')}</select>
<select name="to">${targetTeams.map(([id, x]) => `<option value="${id}">${escapeHtml(x.name || id)}（${id}）</option>`).join('')}</select>
<input type="text" name="note" placeholder="备注：为什么分享（对方会看到）" maxlength="120">
<button class="primary">投递</button></form>`
		: '<p class="meta" style="margin:12px 0 0">没有可分享的目标团队：你只在这个团队里。分享只能给你自己也在其中的团队；要给别的团队，请先用管理员账号，或者把它发布到市场。</p>'
}</details>`
			: ''

	/**
	 * 待接收的分享。
	 *
	 * 分享默认不生效：内容躺在控制面的 inbox 里，没进 skills 目录、也没进 cordis.patch.yml。
	 * 这里把「谁分享的、备注是什么」摆在最显眼的位置，让接收方据来源决定启不启用。
	 * 普通成员也能看到（否则不知道团队里为什么多出个包），但只有 owner 有按钮。
	 */
	const pending = view?.pending || []
	const pendingCard = pending.length
		? `<div class="card"><h2>待接收<span class="tag">${pending.length} 项</span></h2>
<p class="meta" style="margin:8px 0 12px">分享过来的包默认<b>不生效</b>：确认来源与备注后再启用，启用才写进本团队的卷。拒收只留一条记录，内容立即删除。</p>
${pending
	.map((p) => {
		const envFields = (p.envKeys || [])
			.map(
				(key) =>
					`<input type="text" name="env_${escapeHtml(key)}" placeholder="${escapeHtml(key)}" style="flex:0 0 150px">`,
			)
			.join('')
		const at = escapeHtml(String(p.at || '').replace('T', ' ').slice(5, 16))
		return `<div style="border-top:1px solid var(--line);padding:12px 0">
<div><code>${escapeHtml(p.name)}</code> <span class="tag muted">${p.kind === 'mcp' ? '连接器' : '技能'}</span>
<span class="tag">来自 ${escapeHtml(p.from)}</span><span class="tag muted">v${escapeHtml(p.version || '0.0.0')}</span></div>
<p class="meta" style="margin:6px 0">由 <code>${escapeHtml(p.by || '未知')}</code> 于 ${at} 分享 · 备注：${p.note ? escapeHtml(p.note) : '（未填写）'}${
			p.kind === 'mcp' ? ' · <b>凭据不会跟着走</b>，启用前请先填写' : ''
		}</p>
${
	manage
		? `<form method="post" action="/__auth/packages/share/enable" class="row" style="margin:0">
<input type="hidden" name="team" value="${teamId}"><input type="hidden" name="kind" value="${p.kind}"><input type="hidden" name="id" value="${escapeHtml(p.id)}">
${envFields}<button class="primary small">启用</button></form>
<form method="post" action="/__auth/packages/share/reject" style="margin:6px 0 0">
<input type="hidden" name="team" value="${teamId}"><input type="hidden" name="kind" value="${p.kind}"><input type="hidden" name="id" value="${escapeHtml(p.id)}">
<button class="small danger">拒收</button></form>`
		: '<span class="tag muted">等 owner 决定是否启用</span>'
}
</div>`
	})
	.join('')}</div>`
		: ''

	const shareHistory = (view?.shares || []).length
		? `<div class="card"><h2>分享记录<span class="tag muted">最近的流转</span></h2>
<table><tr><th>时间</th><th>包</th><th>方向</th><th>分享人</th><th>状态</th><th>备注</th></tr>
${(view.shares || [])
	.slice(0, 8)
	.map((s) => {
		const statusTag =
			s.status === 'pending'
				? '<span class="tag">待接收</span>'
				: s.status === 'rejected'
					? '<span class="tag muted">已拒收</span>'
					: '<span class="tag muted">已启用</span>'
		return `<tr><td class="time">${escapeHtml(String(s.at || '').replace('T', ' ').slice(5, 16))}</td>
<td><code>${escapeHtml(s.name)}</code> <span class="tag muted">${s.kind === 'mcp' ? '连接器' : '技能'}</span></td>
<td>${escapeHtml(s.from)} → ${escapeHtml(s.to)}</td><td><code>${escapeHtml(s.by)}</code></td>
<td>${statusTag}</td><td class="meta">${s.note ? escapeHtml(s.note) : '—'}</td></tr>`
	})
	.join('')}</table></div>`
		: ''

	// 动作名要覆盖写入侧全部取值：漏一个就会在页面上露出英文原文（disable / upgrade 曾经就是这样）
	const actionLabel = {
		install: '安装',
		uninstall: '卸载',
		upgrade: '升级',
		enable: '启用',
		disable: '停用',
		publish: '发布',
		share: '分享',
		reject: '拒收',
	}
	const ops = view?.ops || []
	const opLog = ops.length
		? `<div class="card"><h2>操作日志<span class="tag muted">技能与连接器的变更</span></h2>
<table><tr><th>时间</th><th>动作</th><th>包</th><th>操作者</th><th>说明</th></tr>
${ops
	.slice(0, 20)
	.map(
		(op) => `<tr><td class="time">${escapeHtml(String(op.at || '').replace('T', ' ').slice(5, 16))}</td>
<td>${escapeHtml(actionLabel[op.action] || op.action)}</td>
<td><code>${escapeHtml(op.name)}</code> <span class="tag muted">${op.kind === 'mcp' ? '连接器' : '技能'}</span></td>
<td><code>${escapeHtml(op.by || '—')}</code></td>
<td class="meta">${escapeHtml(op.detail || '')}${op.note ? ` · 备注：${escapeHtml(op.note)}` : ''}</td></tr>`,
	)
	.join('')}</table>
<p class="meta" style="margin:12px 0 0">只留最近 500 条，按团队隔离：成员能看到本团队相关记录（含别人分享给本团队的）。</p></div>`
		: ''

	const stale = view?.installed?.stale
		? `<div class="card"><p class="meta" style="margin:0">实例休眠中，已装清单取自安装台账（未与卷核对）。<a href="/__auth/team/wake?team=${teamId}">唤醒后刷新</a></p></div>`
		: ''

	return {
		status: 200,
		html: page(
			`技能 · 连接器 · ${t.name}`,
			`<h1>技能 · 连接器</h1>
<p class="lead">「${escapeHtml(t.name)}」自己的模型凭据、技能和连接器。每个团队一份，互不可见；新团队从空开始。</p>
${notice ? `<div class="card"><p class="meta" style="margin:0;color:#a32d2d">${escapeHtml(notice)}</p></div>` : ''}
${error ? `<div class="card"><p class="meta" style="margin:0;color:#a32d2d">控制面不可用：${escapeHtml(error)}</p></div>` : ''}
${stale}
<div class="row" style="margin-bottom:16px">${tabLink('skill', '技能', installedSkills.length)}${tabLink('mcp', '连接器', installedMcp.length)}</div>
${pendingCard}
<div class="card"><h2>本团队已装<span class="tag muted">${installed.length} 项</span></h2>
<table><tr><th>名称</th><th>版本</th><th></th></tr>${installedRows}</table>
${kind === 'mcp' ? '<p class="meta" style="margin:12px 0 0">连接器写入后 dsh 会重新加载配置（通常几秒），会话不会丢。</p>' : '<p class="meta" style="margin:12px 0 0">技能装完立即生效，无需重启——dsh 会 watch 这个目录。</p>'}</div>
${shareCard}
<h2 style="font-size:14px;font-weight:500;margin:24px 0 10px">市场</h2>
${marketCards}
${publishCard}
${shareHistory}
${opLog}
<p class="foot"><a href="/__auth/home">返回门户</a> · <a href="/__auth/packages?team=${teamId}">刷新</a></p>`,
		),
	}
}

function auditPage(user, teamFilter) {
	const canSeeAll = isAdmin(user)
	const scope = canSeeAll ? teamFilter : cfg.team
	const rows = readAudit({ team: scope })
	const body = rows
		.map(
			(r) => `<tr><td class="time">${r.ts.replace('T', ' ').slice(5, 19)}</td>
<td>${escapeHtml(r.user)}</td><td>${escapeHtml(r.team)}</td>
<td><code>${escapeHtml(r.method || '')} ${escapeHtml(r.path || '')}</code></td>
<td class="time">${escapeHtml(r.ip || '')}</td></tr>`,
		)
		.join('')
	return page(
		'访问审计',
		`<h1>访问审计</h1>
<p class="lead">记录「谁在什么时候用了哪个团队」。消息内容不在其中——dsh 的事件流没有作者字段，这个边界改不了。</p>
<div class="card"><h2>最近 ${rows.length} 条<span class="tag">${scope ? escapeHtml(scope) : '全部团队'}</span></h2>
${
	rows.length
		? `<table><tr><th>时间</th><th>用户</th><th>团队</th><th>请求</th><th>来源</th></tr>${body}</table>`
		: '<p class="meta" style="margin:0">还没有记录。产生访问后这里会自动出现。</p>'
}
<p class="meta" style="margin:14px 0 0">原始日志在 <code>deploy/auth/audit/</code>，按天切分，可直接 grep。</p></div>
<p class="foot"><a href="/__auth/home">返回门户</a></p>`,
	)
}

// ---------- 助理 ----------
// 一个助理 = 一个 IM 机器人 + 每群一条 dsh 会话。这里只管展示与提交表单，
// 状态、凭据、群线程、消息流水全部走控制面 /assistants（凭据在控制面加密落 team_secrets）。

/** 助理卡片：信息 + 编辑 + 测试 / 启停 / 删除。凭据只显示「已配置」，永不回显值。 */
function assistantCard(a, teamId) {
	const e = escapeHtml
	const platformLabel = a.platform === 'dingtalk' ? '钉钉' : '飞书'
	// 白名单是多群；地址栏里用逗号串展示与提交，和面板输入框保持一致
	const channels = (a.channels || []).map((c) => c.conversation_id).filter(Boolean)
	const scopeText = channels.length ? channels.map((c) => e(c)).join('，') : '不限群'
	const threadText = `群对话 ${Number(a.threads || 0)} 条`
	// 钉钉走 Stream：真正决定能不能收消息的是 Client ID + Client Secret；
	// 飞书没有 Stream 通道，仍然看 Verification Token。
	const streamOk = Boolean(a.credentials?.appKey && a.credentials?.appSecret)
	const verifyField = a.platform === 'feishu' ? 'verifyToken' : 'appKey'
	const verifyLabel = a.platform === 'feishu' ? 'Verification Token' : 'Client ID / Secret'
	const verifyOk = a.platform === 'feishu' ? Boolean(a.credentials?.verifyToken) : streamOk
	return `<div class="card">
<h2>${e(a.name)}<span class="tag">${platformLabel}</span><span class="tag">${a.enabled ? '已启用' : '已停用'}</span></h2>
<p class="meta">机器人 ${e(a.robot_key)} · 服务范围 ${scopeText} · ${threadText}</p>
<p class="meta">${verifyLabel} ${verifyOk ? '<b style="color:#2e7d32">已配置</b>' : '<b style="color:#c0392b">未配置，收不到消息</b>'} · 出站 webhook ${a.credentials?.outboundWebhook ? '已配置' : '未配置（用消息里的临时地址）'}</p>
<form method="post" action="/__auth/assistants/update" class="row">
<input type="hidden" name="team" value="${e(teamId)}"><input type="hidden" name="id" value="${e(a.id)}"><input type="hidden" name="platform" value="${e(a.platform)}">
<label>名称 <input name="name" value="${e(a.name)}"></label>
<label>只服务这些群 <input name="channels" value="${e(channels.join(','))}" placeholder="群 ID，多个用逗号分隔；留空=不限群"></label>
<label>人设 <input name="systemPrompt" value="${e(a.system_prompt || '')}" placeholder="附在每条消息前的指令"></label>
<label>出站 webhook <input name="outboundWebhook" placeholder="留空不修改"></label>
${a.platform === 'dingtalk'
	? `<label>Client ID <input name="appKey" placeholder="留空不修改"></label>
<label>Client Secret <input name="appSecret" type="password" placeholder="留空不修改"></label>
<label>AgentId <input name="agentId" placeholder="可选，留空不修改"></label>`
	: `<label>Verification Token <input name="signSecret" placeholder="留空不修改"></label>`}
<button class="small primary">保存</button>
</form>
<div class="row">
<a href="/__auth/assistants?team=${e(teamId)}&id=${e(a.id)}"><button class="small">消息流水</button></a>
<form method="post" action="/__auth/assistants/test" style="margin:0"><input type="hidden" name="team" value="${e(teamId)}"><input type="hidden" name="id" value="${e(a.id)}"><button class="small">测试发送</button></form>
<form method="post" action="/__auth/assistants/toggle" style="margin:0"><input type="hidden" name="team" value="${e(teamId)}"><input type="hidden" name="id" value="${e(a.id)}"><input type="hidden" name="enabled" value="${a.enabled ? '0' : '1'}"><button class="small">${a.enabled ? '停用' : '启用'}</button></form>
<form method="post" action="/__auth/assistants/delete" style="margin:0"><input type="hidden" name="team" value="${e(teamId)}"><input type="hidden" name="id" value="${e(a.id)}"><button class="small danger">删除</button></form>
</div></div>`
}

/** 助理页：列表 + 新建 + 选中助理的消息流水。 */
async function assistantsPage(user, teamId, selectedId, notice = '', inbound = null) {
	const e = escapeHtml
	let rows = []
	let messages = []
	let error = ''
	try {
		rows = (await callConsole(`/assistants?team=${encodeURIComponent(teamId)}`)).assistants || []
		if (selectedId) messages = (await callConsole(`/assistants/${encodeURIComponent(selectedId)}/messages`)).messages || []
	} catch (err) {
		error = err.message
	}
	const selected = rows.find((a) => a.id === selectedId)
	const management = canManage(user, teamId)
	const noticeHtml = notice ? `<div class="card"><p class="meta" style="margin:0">${e(notice)}</p></div>` : ''
	const errorHtml = error ? `<div class="card"><p class="meta" style="margin:0">读取失败：${e(error)}</p></div>` : ''
	// 回调地址：平台服务器要能直接访问，所以这里是「浏览器用的主机名 + 控制面端口」。
	// 本机名对平台不可达，先提示清楚，别让人填完在后台等一个永远不会来的事件。
	const inboundHtml = inbound
		? `<div class="card"><h2>入站方式</h2>
<p class="meta">钉钉走 <b>Stream 长连接</b>：填好 Client ID + Client Secret 后控制面主动连钉钉网关，本机也能收发，不用回调地址。飞书暂时只支持 HTTP 回调，需要公网可达。</p>
${
	inbound.local
		? `<p class="meta" style="margin:10px 0 0;color:#c0392b">下面的回调地址是本机地址，只有飞书会受影响：平台服务器打不进来。本地联调飞书要用内网穿透把域名指到 9700，再用 <code>ASSISTANT_INBOUND_BASE</code> 配成对外域名。</p>`
		: ''
}
<p><code>钉钉（仅 HTTP 回调模式）${e(inbound.dingtalk)}</code></p>
<p><code>飞书（必须公网可达）${e(inbound.feishu)}</code></p></div>`
		: ''
	const createHtml = management
		? `<div class="card"><h2>新增助理</h2>
<p class="meta">一个助理 = 一份机器人配置，对话按群拆分：同一个机器人在 A 群和 B 群各有一条 dsh 会话，上下文不串。当前版本只有「群里 @ 机器人」的消息才会被处理。</p>
<form method="post" action="/__auth/assistants/create" class="row">
<input type="hidden" name="team" value="${e(teamId)}">
<label>名称 <input name="name" placeholder="日报助理" required></label>
<label>平台 <select name="platform"><option value="dingtalk">钉钉</option><option value="feishu">飞书</option></select></label>
<label>机器人标识 <input name="robotKey" placeholder="钉钉填 Client ID / 飞书填 App ID" required></label>
<label>只服务这些群 <input name="channels" placeholder="群 ID，多个用逗号分隔；留空=不限群"></label>
<label>人设 <input name="systemPrompt" placeholder="附在每条消息前的指令"></label>
<label>Client ID（钉钉） <input name="appKey" placeholder="钉钉必填，飞书留空"></label>
<label>Client Secret（钉钉） <input name="appSecret" type="password" placeholder="钉钉必填，飞书留空"></label>
<label>AgentId（钉钉可选） <input name="agentId" placeholder="应用凭证页的 AgentId"></label>
<label>出站 webhook <input name="outboundWebhook" placeholder="可选，留空用消息里的临时地址"></label>
<label>Verification Token / 回调加签 <input name="signSecret" placeholder="飞书必填；钉钉走 Stream 可留空"></label>
<button class="primary small">创建</button>
</form>
<p class="meta" style="margin:10px 0 0">钉钉：开放平台 → 应用 → 凭证与基础信息，抄 Client ID 与 Client Secret；机器人标识一般与 Client ID 相同。
飞书：凭证页拿 App ID，事件订阅页拿 Verification Token。
建议直接用 dsh 侧栏的「助理」面板，那边字段说明和回调地址都在同一屏。</p></div>`
		: ''
	const messageHtml = selected
		? `<div class="card"><h2>${e(selected.name)} 的消息流水</h2>${
				messages.length
					? `<table><tr><th>时间</th><th>状态</th><th>输入</th><th>输出</th><th>耗时</th></tr>${messages
							.map(
								(m) => `<tr><td>${e(m.created_at)}</td><td>${e(m.status)}</td><td>${e(String(m.inbound || '').slice(0, 60))}</td><td>${e(String(m.outbound || m.error || '').slice(0, 80))}</td><td>${m.elapsed_ms ?? ''}</td></tr>`,
							)
							.join('')}</table>`
					: '<p class="meta" style="margin:0">还没有消息。</p>'
			}</div>`
		: ''
	return page(
		`助理 · ${teamName(teamId)}`,
		`<h1>助理</h1>
<p class="lead">给机器人开一个对话窗口。群里 @ 机器人时，消息转发到 dsh 处理，结果由机器人发回。</p>
${noticeHtml}${errorHtml}${inboundHtml}${createHtml}
${rows.length ? rows.map((a) => assistantCard(a, teamId)).join('\n') : '<div class="card"><p class="meta" style="margin:0">这个团队还没有助理。</p></div>'}
${messageHtml}
<p class="foot"><a href="/__auth/home">返回门户</a></p>`,
	)
}

// ---------- 助理 API（dsh 侧栏面板用） ----------
// 面板与门户页共用控制面的 /assistants，这里只包一层 JSON。
// 「回调地址」和「每个字段去哪儿拿」由服务端下发，面板不自己拼 URL、也不硬编码平台差异：
// 加一个平台只改这张表和 assistant-channels.mjs，前端不用动。

/**
 * 平台元信息：机器人在哪个后台、要填几个值、各自从哪儿抄。
 *
 * `credentials[].field` 必须与 assistant-http.mjs 的 SECRET_KEYS 对齐，否则填了也存不进去。
 *
 * @type {Array<object>}
 */
const ASSISTANT_PLATFORMS = [
	{
		id: 'dingtalk',
		label: '钉钉',
		robotKey: {
			label: 'RobotCode（= Client ID）',
			hint: '开放平台 → 应用开发 → 你的应用 → 凭证与基础信息 → Client ID（原 AppKey）。企业自建应用的机器人 RobotCode 与它一致。',
			placeholder: 'dingxxxxxxxxxxxxxxxx',
		},
		credentials: [
			{
				field: 'appKey',
				label: 'Client ID（AppKey）',
				required: true,
				hint: 'Stream 长连接用它建连。填了 AppKey + AppSecret 就自动走 Stream，不需要公网回调。',
			},
			{
				field: 'appSecret',
				label: 'Client Secret（AppSecret）',
				required: true,
				hint: '与 Client ID 配对，只存在控制面的加密密钥表里，接口永不回显。',
			},
			{
				field: 'agentId',
				label: 'AgentId',
				required: false,
				hint: '可选。应用凭证页的「原企业内部应用 AgentId」，将来用 OpenAPI 主动发消息时要用。',
			},
			{
				field: 'outboundWebhook',
				label: '出站 Webhook',
				required: false,
				hint: '可选。群自定义机器人的 Webhook；不填就用消息里带的 sessionWebhook（约 1.5 小时有效）。',
			},
			{
				field: 'signSecret',
				label: '回调加签密钥',
				required: false,
				hint: '只有走 HTTP 回调模式才需要（事件订阅页的加签密钥）。走 Stream 可以留空。',
			},
		],
		callbackNote: '走 Stream 模式时不用填回调地址：控制面会主动连钉钉网关，只要应用里「机器人 → 消息接收模式」选的是 Stream。',
	},
	{
		id: 'feishu',
		label: '飞书',
		robotKey: {
			label: 'App ID',
			hint: '开放平台 → 开发者后台 → 你的应用 → 凭证与基础信息 → App ID',
			placeholder: 'cli_xxxxxxxxxxxx',
		},
		credentials: [
			{
				field: 'verifyToken',
				label: 'Verification Token',
				required: true,
				hint: '事件订阅页面的 Verification Token，用来校验回调来源。不填则回调一律 401。',
			},
			{
				field: 'outboundWebhook',
				label: '出站 Webhook',
				required: false,
				hint: '可选。群自定义机器人的 Webhook 地址；飞书回调不带回信地址，不配就发不出结果。',
			},
		],
		callbackNote: '在「事件订阅」里填下面的地址，订阅 im.message.receive_v1。需要公网可达。',
	},
]

/** 主机是不是本机名。用于在界面上提示「这个地址平台打不进来」。 */
function isLoopbackHost(host) {
	return host === 'localhost' || host.startsWith('127.') || host.endsWith('.localhost') || host === '::1'
}

/**
 * 回调地址前缀。平台服务器要能直接访问，所以不能是 host.docker.internal 这类容器内地址。
 *
 * 默认用「浏览器访问的主机名 + 控制面端口」：本地 team-a.localhost:9700 正好指向宿主上的控制面，
 * 用 curl 能验通。上公网时用 ASSISTANT_INBOUND_BASE 显式覆盖成对外域名。
 *
 * @param {object} req 请求（取 Host 与 X-Forwarded-Proto）
 * @returns {{base:string,host:string,local:boolean,dingtalk:string,feishu:string}} 前缀、是否本机、各平台回调地址
 */
function inboundBase(req) {
	const env = String(process.env.ASSISTANT_INBOUND_BASE || '').trim()
	let base
	let host
	if (env) {
		base = env.replace(/\/+$/, '')
		host = base.replace(/^https?:\/\//, '').split('/')[0].split(':')[0]
	} else {
		host = String(req.headers.host || 'localhost').split(':')[0]
		const port = String(process.env.ORCHESTRATOR_PORT || '9700')
		const proto = String(req.headers['x-forwarded-proto'] || '').includes('https') ? 'https' : 'http'
		base = `${proto}://${host}:${port}`
	}
	// 平台路径在这里拼一次：门户页和侧栏面板都直接取，免得有一处忘了带前缀
	return {
		base,
		host,
		local: isLoopbackHost(host),
		dingtalk: `${base}/assistants/inbound/dingtalk`,
		feishu: `${base}/assistants/inbound/feishu`,
	}
}

/**
 * 面板首屏需要的全部数据。一次请求给全，避免前端串行发三四个请求。
 *
 * @param {object} req 请求
 * @param {object} user 当前用户
 * @param {string} teamId 团队 id
 * @returns {Promise<object>} 面板数据
 */
async function assistantsPayload(req, user, teamId) {
	const view = await callConsole(`/assistants?team=${encodeURIComponent(teamId)}`)
	const inbound = inboundBase(req)
	return {
		team: teamId,
		teamName: teamName(teamId),
		manage: canManage(user, teamId),
		inbound,
		platforms: ASSISTANT_PLATFORMS,
		assistants: view.assistants || [],
	}
}

// ---------- 服务 ----------

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
	const pathname = url.pathname
	const user = session(req)
	const secure = url.protocol === 'https:' || String(req.headers['x-forwarded-proto'] || '') === 'https'

	try {
		// 存活探针：控制面建完容器后靠它确认「可以点了」，不依赖 dsh 是否就绪
		if (pathname === '/__auth/health') return send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' })

		// Caddy forward_auth 的子请求：只回答放行与否，不产生页面跳转
		if (pathname === '/__auth/verify') {
			if (!user) return send(res, 401, 'unauthorized', { 'Content-Type': 'text/plain; charset=utf-8' })
			refreshIfStale(res, user, secure)
			if (user.mustChangePassword) {
				return html(
					res,
					403,
					page(
						'需要修改密码',
						`<h1>先设置一个新密码</h1>
<p class="lead">管理员要求首次登录后修改密码。</p>
<div class="card"><p class="meta" style="margin:0"><a href="/__auth/password">去改密码</a></p></div>`,
					),
				)
			}
			if (!isMember(user, cfg.team)) {
				return html(
					res,
					403,
					page(
						'需要加入团队',
						`<h1>还不是「${teamName(cfg.team)}」的成员</h1>
<p class="lead">当前身份 ${escapeHtml(user.name)}（${user.id}）</p>
<div class="card"><p class="meta">加入后立刻生效，不需要重新登录。</p>
<form method="post" action="/__auth/join"><input type="hidden" name="team" value="${cfg.team}">
<button class="primary">加入「${teamName(cfg.team)}」</button></form></div>
<p class="foot"><a href="/__auth/home">看我的其他团队</a></p>`,
					),
				)
			}
			// 实例睡着时先拦住并把它叫醒。这一步必须在 reverse_proxy 之前返回，
			// 否则用户拿到的是 Caddy 的裸 502（后端容器已经不在了）。
			const st = await sleepState()
			if (st?.asleep) {
				requestWake()
				return html(res, 503, wakePage(), { 'Retry-After': '2' })
			}
			touchSeen()
			// Caddy 只按 `dsh-auth-` 前缀判断「换过票没有」，端口一变就会误放行旧 cookie。
			// 这里按当前 authority 精确判一次；bootstrap 跳回的 /?token= 请求必须放行，否则死循环。
			const fwdUri = String(req.headers['x-forwarded-uri'] || pathname)
			if (!fwdUri.includes('token=') && !hasDshCookieFor(req)) {
				return send(res, 302, '', { Location: '/__auth/bootstrap', 'Cache-Control': 'no-store' })
			}
			audit(req, user, {
				path: String(req.headers['x-forwarded-uri'] || pathname),
				method: String(req.headers['x-forwarded-method'] || req.method),
			})

			return send(res, 200, 'ok', {
				'Content-Type': 'text/plain; charset=utf-8',
				'X-Auth-User': user.id,
				'X-Auth-Name': encodeURIComponent(user.name),
				'X-Auth-Teams': user.teams.join(','),
			})
		}

		if (pathname === '/__auth/login') {
			if (req.method === 'GET') {
				if (user && isMember(user, cfg.team)) return send(res, 302, '', { Location: safePath(url.searchParams.get('rd')) })
				return html(res, 200, loginPage({ rd: safePath(url.searchParams.get('rd')), user }))
			}
			const form = await readBody(req)
			const id = String(form.get('username') || '').trim().toLowerCase()
			const password = String(form.get('password') || '')
			const rd = safePath(form.get('rd'))
			const ip = clientIp(req)

			// 先看锁没锁。放在查账号之前，是为了不让「响应快慢」泄露账号是否存在。
			const wait = loginRetryAfter(id, ip)
			if (wait > 0) {
				audit(req, { id }, { path: pathname, event: 'login-locked' })
				return html(res, 429, loginPage({ rd, error: `尝试过于频繁，请 ${Math.ceil(wait / 60)} 分钟后再试` }), {
					'Retry-After': String(wait),
				})
			}

			const account = accounts().users[id]
			if (!account || !checkPassword(account, password)) {
				noteLoginFail(id, ip)
				audit(req, { id }, { path: pathname, event: 'login-failed' })
				return html(res, 401, loginPage({ rd, error: '用户名或密码不对' }))
			}
			noteLoginOk(id, ip)
			setSessionCookie(res, id, secure, account.pv ?? 0)
			audit(req, { id, ...account }, { path: pathname, event: 'login' })
			if (account.mustChangePassword) return send(res, 302, '', { Location: '/__auth/password' })
			if (!isMember(account, cfg.team)) {
				return html(res, 403, loginPage({ rd, user: { id, ...account } }))
			}
			return send(res, 302, '', { Location: rd })
		}

		if (pathname === '/__auth/logout') {
			clearSessionCookie(res)
			return send(res, 302, '', { Location: '/__auth/login' })
		}

		if (pathname === '/__auth/password') {
			if (!user) return send(res, 302, '', { Location: `/__auth/login?rd=${encodeURIComponent('/__auth/password')}` })
			if (req.method === 'GET') return html(res, 200, passwordPage(user, '', Boolean(user.mustChangePassword)))

			const form = await readBody(req)
			const oldPw = String(form.get('old') || '')
			const next = String(form.get('new') || '')
			const confirm = String(form.get('confirm') || '')
			const account = accounts().users[user.id]
			const forced = Boolean(user.mustChangePassword)
			// 改密也校验旧密码，所以它同样是一条「猜密码」的通道，限流要一起算
			const waitMine = loginRetryAfter(user.id, clientIp(req))
			if (waitMine > 0) {
				return html(res, 429, passwordPage(user, `尝试过于频繁，请 ${Math.ceil(waitMine / 60)} 分钟后再试`, forced), {
					'Retry-After': String(waitMine),
				})
			}
			if (!checkPassword(account, oldPw)) {
				noteLoginFail(user.id, clientIp(req))
				return html(res, 400, passwordPage(user, '当前密码不对', forced))
			}
			noteLoginOk(user.id, clientIp(req))
			if (next.length < cfg.passwordMinLength)
				return html(res, 400, passwordPage(user, `新密码至少 ${cfg.passwordMinLength} 位`, forced))
			if (next !== confirm) return html(res, 400, passwordPage(user, '两次输入不一致', forced))
			if (next === oldPw) return html(res, 400, passwordPage(user, '新密码不能和旧密码相同', forced))

			const data = accounts()
			const { salt, hash } = hashPassword(next)
			// pv 加一 = 这个人在所有浏览器上的旧 Cookie 立刻失效
			data.users[user.id] = {
				...data.users[user.id],
				salt,
				hash,
				pv: (data.users[user.id].pv ?? 0) + 1,
			}
			delete data.users[user.id].mustChangePassword
			saveAccounts(data)
			setSessionCookie(res, user.id, secure, data.users[user.id].pv)
			audit(req, user, { path: pathname, event: 'password-changed' })
			return send(res, 302, '', { Location: '/__auth/home' })
		}

		if (pathname === '/__auth/home') {
			if (!user) return send(res, 302, '', { Location: `/__auth/login?rd=${encodeURIComponent('/__auth/home')}` })
			return html(res, 200, await homePage(user, url.searchParams.get('err') || ''))
		}

		if (pathname === '/__auth/members') {
			if (!user) return send(res, 302, '', { Location: `/__auth/login?rd=${encodeURIComponent(req.url)}` })
			const teamId = url.searchParams.get('team') || cfg.team
			return html(res, memberStatus(user, teamId), memberPage(user, teamId, url.searchParams.get('err') || ''))
		}

		if (pathname === '/__auth/packages') {
			if (!user) return send(res, 302, '', { Location: `/__auth/login?rd=${encodeURIComponent(req.url)}` })
			const teamId = url.searchParams.get('team') || cfg.team
			const view = await packagesPage(user, teamId, url.searchParams.get('tab') || 'skill', url.searchParams.get('err') || '')
			return html(res, view.status, view.html)
		}

		if (pathname === '/__auth/assistants') {
			if (!user) return send(res, 302, '', { Location: `/__auth/login?rd=${encodeURIComponent(req.url)}` })
			const teamId = url.searchParams.get('team') || cfg.team
			const notice = url.searchParams.get('ok') || url.searchParams.get('err') || ''
			return html(res, 200, await assistantsPage(user, teamId, url.searchParams.get('id') || '', notice, inboundBase(req)))
		}

		// 助理的新增 / 编辑 / 启停 / 删除 / 测试：和技能面板一样，只有 owner 能改。
		// 表单里的凭据只在这里转交控制面，控制面加密进 team_secrets，页面永不回显。
		if (pathname.startsWith('/__auth/assistants/') && req.method === 'POST') {
			const action = pathname.slice('/__auth/assistants/'.length)
			if (!user) return send(res, 302, '', { Location: '/__auth/login' })
			const form = await readBody(req)
			const teamId = String(form.get('team') || '')
			const id = String(form.get('id') || '')
			const back = `/__auth/assistants?team=${encodeURIComponent(teamId)}`
			if (!canManage(user, teamId)) {
				return send(res, 302, '', { Location: `${back}&err=${encodeURIComponent('只有这个团队的 owner 可以管理助理')}` })
			}
			const sign = String(form.get('signSecret') || '').trim()
			const platform = String(form.get('platform') || 'dingtalk')
			const text = (name) => String(form.get(name) || '').trim()
			// 空值不写（控制面 saveCredentials 只收非空），所以「留空 = 不修改」这条语义靠这里保持
			const credentials = (value) => ({
				outboundWebhook: text('outboundWebhook'),
				appKey: text('appKey'),
				appSecret: text('appSecret'),
				agentId: text('agentId'),
				...(value ? (platform === 'feishu' ? { verifyToken: value } : { signSecret: value }) : {}),
			})
			// 表单里的「只服务这些群」是逗号分隔的一串；空数组 = 不限群
			const channels = (raw) => String(raw || '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
			try {
				if (action === 'create') {
					await callConsole('/assistants', 'POST', {
						team: teamId,
						name: String(form.get('name') || '新助理').trim(),
						platform,
						robotKey: String(form.get('robotKey') || '').trim(),
						channels: channels(form.get('channels')),
						systemPrompt: String(form.get('systemPrompt') || '').trim() || null,
						credentials: credentials(sign),
						by: user.id,
					})
				} else if (action === 'update') {
					await callConsole(`/assistants/${encodeURIComponent(id)}`, 'POST', {
						name: String(form.get('name') || '').trim(),
						channels: channels(form.get('channels')),
						systemPrompt: String(form.get('systemPrompt') || '').trim() || null,
						credentials: credentials(sign),
					})
				} else if (action === 'toggle') {
					await callConsole(`/assistants/${encodeURIComponent(id)}`, 'POST', { enabled: String(form.get('enabled')) === '1' })
				} else if (action === 'delete') {
					await callConsole(`/assistants/${encodeURIComponent(id)}`, 'DELETE')
				} else if (action === 'test') {
					await callConsole(`/assistants/${encodeURIComponent(id)}/test`, 'POST', { text: '你好，请用一句话介绍你自己。' })
				} else {
					return send(res, 404, 'not found')
				}
				return send(res, 302, '', { Location: `${back}&id=${encodeURIComponent(id)}&ok=${encodeURIComponent('已提交')}` })
			} catch (err) {
				return send(res, 302, '', { Location: `${back}&err=${encodeURIComponent(err.message)}` })
			}
		}

		// ---------- 市场面板的 JSON 接口 ----------
		// dsh 侧栏里的「市场」面板用这两个端点。和门户页共用同一份数据与权限判断，
		// 区别只是返回 JSON：面板要在界面内切 tab、就地刷新，不能整页重载。
		// 团队 id 一律取 cfg.team（一个团队一个 auth 实例），不接受请求里的 team 参数，
		// 否则改一个 query 就能看别人团队的市场。

		if (pathname === '/__auth/api/market') {
			if (!user) return json(res, 401, { error: '未登录' })
			if (!isMember(user, cfg.team) && !isAdmin(user)) return json(res, 403, { error: '不是这个团队的成员' })
			try {
				const view = await callConsole(`/packages?team=${encodeURIComponent(cfg.team)}`)
				return json(res, 200, marketPayload(user, cfg.team, view))
			} catch (err) {
				return json(res, 502, { error: `控制面不可用：${err.message}` })
			}
		}

		if (pathname === '/__auth/api/market/action' && req.method === 'POST') {
			if (!user) return json(res, 401, { error: '未登录' })
			if (!canManage(user, cfg.team)) return json(res, 403, { error: '只有这个团队的 owner 可以改动' })
			let body = {}
			try {
				body = await readJson(req)
			} catch {
				return json(res, 400, { error: '请求体不是合法 JSON' })
			}
			const action = String(body.action || '')
			const kind = body.kind === 'mcp' ? 'mcp' : 'skill'
			const name = String(body.name || '').trim()
			if (!name) return json(res, 400, { error: '缺少 name' })
			try {
				if (action === 'install') {
					// 连接器的凭据从请求体的 env 取，直接写进团队自己的卷，不落在市场里
					const env = {}
					for (const [key, value] of Object.entries(body.env || {})) {
						if (typeof value === 'string' && value.trim()) env[key] = value.trim()
					}
					await callConsole('/market/install', 'POST', {
						team: cfg.team,
						kind,
						name,
						env,
						by: user.id,
						// 本地有同名技能时默认不覆盖；用户点「仍然安装」才带 force
						force: Boolean(body.force),
					})
					audit(req, user, { path: pathname, event: 'install', target: name })
				} else if (action === 'uninstall') {
					await callConsole('/market/uninstall', 'POST', { team: cfg.team, kind, name, by: user.id })
					audit(req, user, { path: pathname, event: 'uninstall', target: name })
				} else if (action === 'toggle') {
					if (kind !== 'skill') return json(res, 400, { error: '连接器的启停还没接，只能装或卸' })
					await callConsole('/market/toggle', 'POST', {
						team: cfg.team,
						name,
						enabled: body.enabled !== false,
						by: user.id,
						force: Boolean(body.force),
					})
					audit(req, user, { path: pathname, event: body.enabled === false ? 'disable' : 'enable', target: name })
				} else {
					return json(res, 400, { error: `未知动作：${action || '（空）'}` })
				}
				// 动作成功后回传最新快照，面板直接用它setState，不再多发一次请求
				const view = await callConsole(`/packages?team=${encodeURIComponent(cfg.team)}`)
				return json(res, 200, { ok: true, ...marketPayload(user, cfg.team, view) })
			} catch (err) {
				// 控制面把 409 SHADOWED 这类语义放在 code/detail 里，原样透给面板
				return json(res, err.status && err.status >= 400 ? err.status : 502, {
					error: err.message,
					...(err.code ? { code: err.code } : {}),
					...(err.detail ? { detail: err.detail } : {}),
				})
			}
		}

		// ---------- 助理：侧栏面板的 JSON 接口 ----------
		// 团队 id 同样取 cfg.team，不接受请求参数，理由与市场那两个端点一样。
		if (pathname === '/__auth/api/assistants') {
			if (!user) return json(res, 401, { error: '未登录' })
			if (!isMember(user, cfg.team) && !isAdmin(user)) return json(res, 403, { error: '不是这个团队的成员' })
			try {
				return json(res, 200, await assistantsPayload(req, user, cfg.team))
			} catch (err) {
				return json(res, 502, { error: `控制面不可用：${err.message}` })
			}
		}

		if (pathname === '/__auth/api/assistants/messages') {
			if (!user) return json(res, 401, { error: '未登录' })
			if (!isMember(user, cfg.team) && !isAdmin(user)) return json(res, 403, { error: '不是这个团队的成员' })
			const id = String(url.searchParams.get('id') || '')
			if (!id) return json(res, 400, { error: '缺少 id' })
			try {
				// 控制面不做团队校验（它只认 id），所以这里先确认这条助理确实属于本团队
				const list = await callConsole(`/assistants?team=${encodeURIComponent(cfg.team)}`)
				if (!(list.assistants || []).some((a) => a.id === id)) {
					return json(res, 404, { error: '这条助理不属于当前团队' })
				}
				const view = await callConsole(`/assistants/${encodeURIComponent(id)}/messages`)
				return json(res, 200, { messages: view.messages || [] })
			} catch (err) {
				return json(res, 502, { error: `控制面不可用：${err.message}` })
			}
		}

		if (pathname === '/__auth/api/assistants/threads') {
			if (!user) return json(res, 401, { error: '未登录' })
			if (!isMember(user, cfg.team) && !isAdmin(user)) return json(res, 403, { error: '不是这个团队的成员' })
			const id = String(url.searchParams.get('id') || '')
			if (!id) return json(res, 400, { error: '缺少 id' })
			try {
				// 控制面只认 id，所以先确认这条助理属于本团队，避免按 id 猜别人的对话
				const list = await callConsole(`/assistants?team=${encodeURIComponent(cfg.team)}`)
				if (!(list.assistants || []).some((a) => a.id === id)) {
					return json(res, 404, { error: '这条助理不属于当前团队' })
				}
				const view = await callConsole(`/assistants/${encodeURIComponent(id)}/threads`)
				return json(res, 200, { threads: view.threads || [] })
			} catch (err) {
				return json(res, 502, { error: `控制面不可用：${err.message}` })
			}
		}

		if (pathname === '/__auth/api/assistants/action' && req.method === 'POST') {
			if (!user) return json(res, 401, { error: '未登录' })
			if (!canManage(user, cfg.team)) return json(res, 403, { error: '只有这个团队的 owner 可以改动' })
			let body = {}
			try {
				body = await readJson(req)
			} catch {
				return json(res, 400, { error: '请求体不是合法 JSON' })
			}
			const action = String(body.action || '')
			const id = String(body.id || '')
			// 群白名单：数组或「逗号分隔的一串」都收（面板里就是一个输入框）。
			// undefined 表示「这次不动白名单」——不能把「没提」当成「清空」。
			const channels = (() => {
				if (Array.isArray(body.channels)) return body.channels.map((c) => String(c ?? '').trim()).filter(Boolean)
				if (typeof body.channels === 'string') return body.channels.split(/[,，\s]+/).map((c) => c.trim()).filter(Boolean)
				return undefined
			})()
			// 凭据只收非空字符串：空值表示「不修改」，不能把已配的覆盖成空
			const credentials = {}
			for (const [field, value] of Object.entries(body.credentials || {})) {
				if (typeof value === 'string' && value.trim()) credentials[field] = value.trim()
			}
			try {
				if (action === 'create') {
					const created = await callConsole('/assistants', 'POST', {
						team: cfg.team,
						name: String(body.name || '').trim() || '新助理',
						platform: String(body.platform || ''),
						robotKey: String(body.robotKey || '').trim(),
						...(channels?.length ? { channels } : { conversationId: String(body.conversationId || '').trim() || null }),
						systemPrompt: String(body.systemPrompt || '').trim() || null,
						by: user.id,
						credentials,
					})
					audit(req, user, { path: pathname, event: 'assistant-create', target: created?.assistant?.id || '' })
				} else if (action === 'update') {
					if (!id) return json(res, 400, { error: '缺少 id' })
					await callConsole(`/assistants/${encodeURIComponent(id)}`, 'POST', {
						name: String(body.name || '').trim() || undefined,
						// 只在真的提交了 channels 时才带上：老面板仍走 conversationId，两条路都保留
						...(channels !== undefined ? { channels } : { conversationId: String(body.conversationId || '').trim() || null }),
						systemPrompt: String(body.systemPrompt || '').trim() || null,
						credentials,
					})
					audit(req, user, { path: pathname, event: 'assistant-update', target: id })
				} else if (action === 'resetThread') {
					if (!id) return json(res, 400, { error: '缺少 id' })
					const threadId = String(body.threadId || '')
					if (!threadId) return json(res, 400, { error: '缺少 threadId' })
					await callConsole(`/assistants/${encodeURIComponent(id)}/threads/${encodeURIComponent(threadId)}/reset`, 'POST', {})
					audit(req, user, { path: pathname, event: 'assistant-thread-reset', target: id })
				} else if (action === 'toggle') {
					if (!id) return json(res, 400, { error: '缺少 id' })
					const enabled = body.enabled !== false
					await callConsole(`/assistants/${encodeURIComponent(id)}`, 'POST', { enabled })
					audit(req, user, { path: pathname, event: enabled ? 'assistant-enable' : 'assistant-disable', target: id })
				} else if (action === 'delete') {
					if (!id) return json(res, 400, { error: '缺少 id' })
					await callConsole(`/assistants/${encodeURIComponent(id)}`, 'DELETE')
					audit(req, user, { path: pathname, event: 'assistant-delete', target: id })
				} else if (action === 'test') {
					if (!id) return json(res, 400, { error: '缺少 id' })
					const result = await callConsole(`/assistants/${encodeURIComponent(id)}/test`, 'POST', {
						text: String(body.text || '').trim() || '你好，请用一句话介绍你自己。',
					})
					audit(req, user, { path: pathname, event: 'assistant-test', target: id })
					return json(res, 200, { ok: true, result: result?.result, message: result?.message })
				} else {
					return json(res, 400, { error: `未知动作：${action || '（空）'}` })
				}
				return json(res, 200, { ok: true, ...(await assistantsPayload(req, user, cfg.team)) })
			} catch (err) {
				return json(res, err.status && err.status >= 400 ? err.status : 502, { error: err.message })
			}
		}

		// 装 / 卸 / 发布 / 分享 / 启用 / 拒收：只有团队 owner（或管理员）能动，普通成员只能看
		if (
			pathname === '/__auth/packages/install' ||
			pathname === '/__auth/packages/uninstall' ||
			pathname === '/__auth/packages/publish' ||
			pathname === '/__auth/packages/share' ||
			pathname === '/__auth/packages/share/enable' ||
			pathname === '/__auth/packages/share/reject'
		) {
			if (req.method !== 'POST') return send(res, 405, 'method not allowed')
			if (!user) return send(res, 302, '', { Location: '/__auth/login' })
			const form = await readBody(req)
			const teamId = String(form.get('team') || '')
			const kind = String(form.get('kind') || 'skill')
			const name = String(form.get('name') || '').trim()
			const back = `/__auth/packages?team=${encodeURIComponent(teamId)}&tab=${kind === 'mcp' ? 'mcp' : 'skill'}`
			if (!canManage(user, teamId)) {
				return send(res, 302, '', { Location: `${back}&err=${encodeURIComponent('只有这个团队的 owner 可以安装或发布')}` })
			}
			try {
				if (pathname.endsWith('/install')) {
					// 连接器的凭据从表单 env_XXX 取，直接写进团队自己的卷，不落在市场里
					const env = {}
					for (const [key, value] of form.entries()) {
						if (key.startsWith('env_') && String(value).trim()) env[key.slice(4)] = String(value).trim()
					}
					await callConsole('/market/install', 'POST', { team: teamId, kind, name, env, by: user.id })
					audit(req, user, { path: pathname, event: 'install', team2: teamId, target: name })
				} else if (pathname.endsWith('/uninstall')) {
					await callConsole('/market/uninstall', 'POST', { team: teamId, kind, name, by: user.id })
					audit(req, user, { path: pathname, event: 'uninstall', team2: teamId, target: name })
				} else if (pathname.endsWith('/share/enable') || pathname.endsWith('/share/reject')) {
					// 启用/拒收必须是「这条分享的接收方」自己操作。
					// 表单里的 team 只是一个可被改的字段，不能拿它当授权依据——
					// 先查这条分享确实落在当前团队名下，再动手。
					const id = String(form.get('id') || '')
					const fail = (message) => send(res, 302, '', { Location: `${back}&err=${encodeURIComponent(message)}` })
					if (!id) return fail('缺少分享 id')
					const inbox = await callConsole(`/shares?team=${encodeURIComponent(teamId)}`)
					if (!(inbox.pending || []).some((s) => s.id === id)) {
						return fail('这条分享不属于当前团队，或者已经处理过了')
					}
					if (pathname.endsWith('/share/enable')) {
						const env = {}
						for (const [key, value] of form.entries()) {
							if (key.startsWith('env_') && String(value).trim()) env[key.slice(4)] = String(value).trim()
						}
						const result = await callConsole('/market/share/enable', 'POST', { id, team: teamId, by: user.id, env })
						audit(req, user, { path: pathname, event: 'share-enable', team2: teamId, target: result?.name || '' })
					} else {
						const result = await callConsole('/market/share/reject', 'POST', { id, team: teamId, by: user.id })
						audit(req, user, { path: pathname, event: 'share-reject', team2: teamId, target: result?.name || '' })
					}
					return send(res, 302, '', { Location: back })
				} else if (pathname.endsWith('/share')) {
					const to = String(form.get('to') || '')
					const note = String(form.get('note') || '').trim().slice(0, 200)
					const fail = (message) => send(res, 302, '', { Location: `${back}&err=${encodeURIComponent(message)}` })
					if (!to) return fail('没选目标团队')
					if (!accounts().teams[to]) return fail('目标团队不存在')
					if (to === teamId) return fail('不能分享给自己')
					// 分享是跨租户投递。普通 owner 只能发给自己也在其中的团队，
					// 管理员不受限；否则任何 owner 都能往任意团队的待接收列表里塞东西。
					if (!isAdmin(user) && !isMember(user, to)) {
						return fail(`你不在「${teamName(to)}」里，不能直接投递。让对方 owner 把你加进去，或者改用「发布到市场」由对方自己安装。`)
					}
					const result = await callConsole('/market/share', 'POST', { from: teamId, to, kind, name, by: user.id, note })
					audit(req, user, { path: pathname, event: 'share', team2: to, target: name })
					const hint = result?.envKeys?.length ? `；对方启用时要补填：${result.envKeys.join(', ')}` : ''
					return send(res, 302, '', {
						Location: `${back}&err=${encodeURIComponent(`已投递给 ${to}（待对方启用）${hint}`)}`,
					})
				} else {
					await callConsole('/market/publish', 'POST', {
						team: teamId,
						kind,
						name,
						version: String(form.get('version') || '1.0.0'),
						visibility: String(form.get('visibility') || 'private'),
						by: user.id,
					})
					audit(req, user, { path: pathname, event: 'publish', team2: teamId, target: name })
				}
				return send(res, 302, '', { Location: back })
			} catch (error) {
				console.error('auth: 包操作失败', error.message)
				return send(res, 302, '', { Location: `${back}&err=${encodeURIComponent(error.message)}` })
			}
		}

		// 成员增删与角色调整：只有团队 owner（或管理员）能改
		if (
			pathname === '/__auth/members/add' ||
			pathname === '/__auth/members/remove' ||
			pathname === '/__auth/members/role'
		) {
			if (req.method !== 'POST') return send(res, 405, 'method not allowed')
			if (!user) return send(res, 302, '', { Location: '/__auth/login' })
			const form = await readBody(req)
			const teamId = String(form.get('team') || '')
			const target = String(form.get('user') || '').trim().toLowerCase()
			if (!canManage(user, teamId)) {
				return html(res, 403, memberPage(user, teamId, '只有这个团队的 owner 可以管理成员'))
			}
			const data = accounts()
			const team = data.teams[teamId]
			if (!team) return html(res, 404, page('团队不存在', '<h1>团队不存在</h1>'))
			if (!data.users[target]) return html(res, 404, memberPage(user, teamId, `账号 ${target} 不存在`))

			// roles 与 users[].teams 必须同时维护：前者决定角色，后者决定能不能进门
			const setRole = (next) => {
				if (!team.roles) team.roles = {}
				if (next) team.roles[target] = next
				else delete team.roles[target]
			}
			const owners = () =>
				Object.entries(team.roles || {}).filter(([, r]) => r === 'owner').length ||
				(team.owner ? 1 : 0)

			const action = pathname.split('/').pop()
			if (action === 'add') {
				data.users[target].teams = [...new Set([...(data.users[target].teams || []), teamId])]
				setRole(String(form.get('role') || 'member') === 'owner' ? 'owner' : 'member')
			} else if (action === 'remove') {
				if (teamRole(target, teamId, data) === 'owner' && owners() <= 1) {
					return html(res, 400, memberPage(user, teamId, '不能移出最后一位 owner，先给别人设 owner'))
				}
				data.users[target].teams = (data.users[target].teams || []).filter((t) => t !== teamId)
				setRole(null)
			} else {
				const next = String(form.get('role') || '')
				if (next !== 'owner' && next !== 'member') {
					return html(res, 400, memberPage(user, teamId, `未知角色：${next}`))
				}
				if (next === 'member' && teamRole(target, teamId, data) === 'owner' && owners() <= 1) {
					return html(res, 400, memberPage(user, teamId, '团队至少要有一个人是 owner'))
				}
				setRole(next)
				// teams[].owner 是历史字段，控制面还在读它，跟着最新 owner 走
				if (next === 'owner') team.owner = target
				else if (team.owner === target) team.owner = Object.keys(team.roles).find((k) => team.roles[k] === 'owner') || team.owner
			}
			saveAccounts(data)
			audit(req, user, { path: pathname, event: `member-${action}`, target })
			return send(res, 302, '', { Location: `/__auth/members?team=${encodeURIComponent(teamId)}` })
		}

		if (pathname === '/__auth/policy') {
			if (req.method !== 'POST') return send(res, 405, 'method not allowed')
			if (!user) return send(res, 302, '', { Location: '/__auth/login' })
			const form = await readBody(req)
			const teamId = String(form.get('team') || '')
			if (!canManage(user, teamId)) return html(res, 403, memberPage(user, teamId, '你不是这个团队的 owner'))
			const idleMin = Math.min(1440, Math.max(1, Number(form.get('idleMin') || 30)))
			const data = accounts()
			if (!data.teams[teamId]) return html(res, 404, page('团队不存在', '<h1>团队不存在</h1>'))
			data.teams[teamId].policy = {
				autoSleep: String(form.get('autoSleep') || '1') === '1',
				idleMs: Math.round(idleMin * 60_000),
			}
			saveAccounts(data)
			audit(req, user, { path: pathname, event: 'policy', team2: teamId })
			return send(res, 302, '', { Location: `/__auth/members?team=${encodeURIComponent(teamId)}` })
		}

		if (pathname === '/__auth/audit') {
			if (!user) return send(res, 302, '', { Location: `/__auth/login?rd=${encodeURIComponent(req.url)}` })
			return html(res, 200, auditPage(user, url.searchParams.get('team') || (isAdmin(user) ? '' : cfg.team)))
		}

		// 团队运维：休眠 / 唤醒 / 归档 / 恢复，全部转给控制面执行
		if (pathname.startsWith('/__auth/team/') && req.method === 'POST') {
			if (!user) return send(res, 302, '', { Location: '/__auth/login' })
			const action = pathname.slice('/__auth/team/'.length)
			const form = await readBody(req)
			const teamId = String(form.get('team') || '')
			if (!canManage(user, teamId)) return html(res, 403, await homePage(user, '你不是这个团队的 owner'))
			const map = {
				sleep: ['/sleep', { team: teamId, reason: `manual:${user.id}` }],
				wake: ['/wake', { team: teamId }],
				archive: ['/archive', { team: teamId, reason: `manual:${user.id}` }],
				restore: ['/restore', { team: teamId }],
			}
			const call = map[action]
			if (!call) return html(res, 404, page('未知操作', '<h1>未知操作</h1>'))
			try {
				await callConsole(call[0], 'POST', call[1])
			} catch (error) {
				console.error(`auth: ${action} ${teamId} 失败`, error.message)
				return html(res, 502, await homePage(user, `${action} 失败：${error.message}`))
			}
			audit(req, user, { path: pathname, event: `team-${action}`, team2: teamId })
			probe = { at: 0, info: null }
			consoleState = { at: 0, data: null }
			return send(res, 302, '', { Location: '/__auth/home' })
		}

		// 强制下线：把密码版本号加一，对方所有会话立刻失效
		if (pathname === '/__auth/revoke' && req.method === 'POST') {
			if (!user) return send(res, 302, '', { Location: '/__auth/login' })
			if (!isAdmin(user)) return html(res, 403, await homePage(user, '只有管理员可以强制下线'))
			const form = await readBody(req)
			const target = String(form.get('user') || '').trim().toLowerCase()
			const data = accounts()
			if (!data.users[target]) return html(res, 404, page('账号不存在', '<h1>账号不存在</h1>'))
			data.users[target].pv = (data.users[target].pv ?? 0) + 1
			saveAccounts(data)
			audit(req, user, { path: pathname, event: 'revoke', target })
			return send(res, 302, '', { Location: '/__auth/home' })
		}

		// 新建团队：调控制面起一套容器，成功后用一次性票据把用户送到新实例
		if (pathname === '/__auth/teams') {
			if (req.method !== 'POST') return send(res, 405, 'method not allowed')
			if (!user) return send(res, 302, '', { Location: '/__auth/login' })
			if (!isAdmin(user)) return html(res, 403, await homePage(user, '只有管理员可以新建团队'))
			const form = await readBody(req)
			const id = String(form.get('id') || '').trim().toLowerCase()
			const name = String(form.get('name') || '').trim()
			const desc = String(form.get('desc') || '').trim()
			try {
				await callConsole('/teams', 'POST', { id, name, desc, owner: user.id })
			} catch (error) {
				console.error('auth: 建团队失败', error.message)
				return html(res, 502, await homePage(user, `创建失败：${error.message}`))
			}
			// 角色表与 owner 入组由控制面在创建时一并写入，这里不重复写，避免两处真相
			audit(req, user, { path: pathname, event: 'team-create', team2: id })
			consoleState = { at: 0, data: null }
			return send(res, 302, '', { Location: `/__auth/sso?to=${encodeURIComponent(id)}&rd=/` })
		}

		// 团队不再支持自助加入：只保留这个地址用于给出明确提示，
		// 免得旧书签拿到一个 404 让人以为是坏了。
		if (pathname === '/__auth/join') {
			if (!user) return send(res, 302, '', { Location: '/__auth/login' })
			const form = await readBody(req)
			const team = String(form.get('team') || '')
			const owner = accounts().teams[team]?.owner || '该团队的 owner'
			audit(req, user, { path: pathname, event: 'join-rejected', team2: team })
			return html(
				res,
				403,
				page(
					'需要邀请',
					`<h1>加入团队需要 owner 批准</h1>
<p class="lead">团队不能自助加入。请让「${escapeHtml(owner)}」在他的成员页把你加进去。</p>
<p class="foot"><a href="/__auth/home">返回门户</a></p>`,
				),
			)
		}

		if (pathname === '/__auth/sso') {
			const to = url.searchParams.get('to') || ''
			const rd = safePath(url.searchParams.get('rd'))
			const data = accounts()
			if (!data.teams[to]) return html(res, 404, page('团队不存在', '<h1>团队不存在</h1>'))
			if (!user) return send(res, 302, '', { Location: `${teamUrl(to, '/__auth/login')}?rd=${encodeURIComponent(rd)}` })
			if (!isMember(user, to)) {
				return send(res, 302, '', { Location: `${teamUrl(to, '/__auth/login')}?rd=${encodeURIComponent(rd)}` })
			}
			if (to === cfg.team) return send(res, 302, '', { Location: rd })
			const ticket = signToken({ u: user.id, pv: user.pv ?? 0, aud: to, exp: now() + 60 })
			audit(req, user, { path: pathname, event: 'sso', team2: to })
			return send(res, 302, '', {
				Location: `${teamUrl(to, '/__auth/sso-callback')}?ticket=${encodeURIComponent(ticket)}&rd=${encodeURIComponent(rd)}`,
			})
		}

		if (pathname === '/__auth/sso-callback') {
			const payload = verifyToken(url.searchParams.get('ticket'))
			const rd = safePath(url.searchParams.get('rd'))
			if (!payload || payload.aud !== cfg.team) {
				return html(res, 401, page('票据无效', '<h1>票据无效或已过期</h1><p class="lead">重新进入即可。</p>'))
			}
			const account = accounts().users[payload.u]
			if (!account || !isMember(account, cfg.team)) {
				return html(res, 403, page('需要加入团队', `<h1>不是「${teamName(cfg.team)}」的成员</h1>`))
			}
			// 票据签发后密码可能已经被改过，pv 对不上就别续这个会话
			if ((payload.pv ?? 0) !== (account.pv ?? 0)) {
				return html(res, 401, page('请重新登录', '<h1>凭据已失效</h1><p class="lead">密码已在别处修改，请重新登录。</p>'))
			}
			setSessionCookie(res, payload.u, secure, account.pv ?? 0)
			return send(res, 302, '', { Location: rd })
		}

		// dsh 只认自己签发的 Cookie，这里把当前团队实例的 token 补上去
		if (pathname === '/__auth/bootstrap') {
			// verify 已经拦过一道，这里再拦一次：拿旧 token 跳过去只会撞 502
			const st = await sleepState()
			if (st?.asleep) {
				requestWake()
				return html(res, 503, wakePage(), { 'Retry-After': '2' })
			}
			const file = `${cfg.tokenDir}/${cfg.team}`
			const token = existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
			if (!token) {
				return html(
					res,
					503,
					page(
						'token 未同步',
						`<h1>这个实例的 token 还没同步</h1>
<p class="lead">登录已经通过，但 dsh 需要自己的入口 token 才能下发 Cookie。</p>
<div class="card"><p class="meta" style="margin:0">在仓库根目录执行：<br><code>make team-token TEAM=${cfg.team}</code></p></div>`,
					),
				)
			}
			return send(res, 302, '', { Location: `/?token=${encodeURIComponent(token)}` })
		}

		return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' })
	} catch (error) {
		console.error('auth: 处理失败', pathname, error)
		return send(res, 500, 'internal error', { 'Content-Type': 'text/plain; charset=utf-8' })
	}
})

server.listen(cfg.port, '0.0.0.0', () => {
	console.log(
		`auth: team=${cfg.team} listen=:${cfg.port} audit=${cfg.auditDir}（保留 ${cfg.auditKeepDays} 天）`,
	)
	pruneAudit()
	// 每隔几小时清一次就够，过期文件多留一会儿没有代价；unref 让它别拖住进程退出
	setInterval(pruneAudit, 6 * 3600_000).unref()
})
