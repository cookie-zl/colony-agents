/**
 * 容器运行时：把「起/停/唤醒/归档一个团队实例」收敛到一处。
 *
 * 两种 provider 只在这里分叉，上层（HTTP 路由、定时扫描）完全不感知：
 *   compose  本地与单机 VM。调 team-up.sh，一个团队 = 一个 compose 项目
 *   helm     多机 K8s。每个团队一个 release，动态生成 values 覆盖 ingress 与配额
 *
 * 这样做的原因：本地要能跑真容器验证，云上又必须换成 K8s；
 * 如果 provision 逻辑分散在路由里，两边一定会跑偏成两套行为。
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { REPO, ARCHIVE_DIR } from './store.mjs'
import { materialize, putFile } from './objects.mjs'

export const TEAM_UP = resolve(REPO, 'deploy/compose/team-up.sh')
export const TEAM_COMPOSE = resolve(REPO, 'deploy/compose/compose.yaml')
export const HELM_CHART = resolve(REPO, 'deploy/helm/colony')
export const HELM_BASE_VALUES = resolve(REPO, 'deploy/helm/values-team.yaml')
const HELM_VALUES_DIR = resolve(REPO, 'deploy/orchestrator/helm-values')

/** Docker CLI 不一定在非交互 shell 的 PATH 里（OrbStack 装在 ~/.orbstack/bin）。 */
export function dockerEnv() {
	const env = { ...process.env }
	const orbstack = `${process.env.HOME}/.orbstack/bin`
	if (existsSync(orbstack) && !String(env.PATH || '').split(':').includes(orbstack)) {
		env.PATH = `${orbstack}:${env.PATH || ''}`
	}
	return env
}

/** 跑一条命令，超时就 SIGKILL。输出截断保留尾部：报错时最有用的信息在最后。 */
export function run(cmd, args, timeoutMs = 20_000) {
	return new Promise((done) => {
		const child = spawn(cmd, args, { cwd: REPO, env: dockerEnv() })
		let out = ''
		const collect = (chunk) => {
			out += chunk.toString()
			if (out.length > 40_000) out = out.slice(-40_000)
		}
		child.stdout.on('data', collect)
		child.stderr.on('data', collect)
		const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
		child.once('error', (error) => {
			clearTimeout(timer)
			done({ code: -1, out: error.message })
		})
		child.once('exit', (code) => {
			clearTimeout(timer)
			done({ code, out })
		})
	})
}

/**
 * 跑一条命令并把 input 写进 stdin。
 *
 * tar 流和 `cat > 文件` 都依赖 stdin，而 run() 不开 stdin——用它会把子进程挂成
 * 永远等输入的僵尸，父进程超时后才发现。所以单独开一条。
 *
 * 同时收 stdout 的原始字节（buffer）与文本（out）：tar 包是二进制，
 * 走字符串会被 UTF-8 解码搞坏，这类包拷过去之后 dsh 解不开，且没有任何报错线索。
 */
export function runStdin(cmd, args, input, timeoutMs = 60_000) {
	return new Promise((done) => {
		const child = spawn(cmd, args, { cwd: REPO, env: dockerEnv() })
		const chunks = []
		let bytes = 0
		let errText = ''
		const collectOut = (chunk) => {
			chunks.push(chunk)
			bytes += chunk.length
			if (bytes > 64 * 1024 * 1024) child.kill('SIGKILL')
		}
		// stderr 必须单独收：混进 buffer 会把 tar 包弄坏，解出来的东西文件头就是乱的
		const collectErr = (chunk) => {
			errText += chunk.toString()
			if (errText.length > 20_000) errText = errText.slice(-20_000)
		}
		child.stdout.on('data', collectOut)
		child.stderr.on('data', collectErr)
		const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
		child.once('error', (error) => {
			clearTimeout(timer)
			done({ code: -1, out: error.message, buffer: Buffer.alloc(0) })
		})
		child.once('exit', (code) => {
			clearTimeout(timer)
			const buffer = Buffer.concat(chunks)
			done({ code, out: errText || buffer.toString('utf8').slice(-4000), buffer })
		})
		child.stdin.on('error', () => {}) // 子进程提前退出时写 stdin 会 EPIPE，属正常
		child.stdin.end(input)
	})
}

/** 跑 team-up.sh 的子命令。失败时把脚本输出的尾部带进错误里，别只说「退出码 1」。 */
export function runTeamUp(args, timeoutMs = 300_000, extraEnv = {}) {
	return new Promise((done, fail) => {
		const child = spawn('bash', [TEAM_UP, ...args], { cwd: REPO, env: { ...dockerEnv(), ...extraEnv } })
		let out = ''
		const collect = (chunk) => {
			out += chunk.toString()
			if (out.length > 20_000) out = out.slice(-20_000)
		}
		child.stdout.on('data', collect)
		child.stderr.on('data', collect)
		const timer = setTimeout(() => {
			child.kill('SIGKILL')
			fail(new Error(`team-up.sh ${args[0]} 超时（>${timeoutMs}ms）\n${out.slice(-800)}`))
		}, timeoutMs)
		child.once('error', (error) => {
			clearTimeout(timer)
			fail(error)
		})
		child.once('exit', (code) => {
			clearTimeout(timer)
			if (code === 0) done(out)
			else fail(new Error(`team-up.sh ${args.join(' ')} 退出码 ${code}\n${out.slice(-1200)}`))
		})
	})
}

/**
 * 一个团队实例的真实状态。永远以容器为准：state.json 只是缓存。
 *
 * 先看 .State.Status 再看 Health —— 容器停掉之后 Health 会留在上一次的结论
 * （exited 却显示 unhealthy），读它会把「睡着」误判成「坏了」。
 */
export async function containerState(team) {
	const list = await run('docker', ['compose', '-f', TEAM_COMPOSE, '-p', `dsh-${team}`, 'ps', '-aq', 'dsh'])
	const id = list.out.trim().split('\n')[0]
	if (!id) return { exists: false, running: false, health: 'missing', startedAt: 0 }
	const info = await run('docker', [
		'inspect',
		'--format',
		'{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.StartedAt}}',
		id,
	])
	const [status, health, startedAt] = info.out.trim().split('|')
	return {
		exists: true,
		running: status === 'running',
		health: status === 'running' ? health || 'running' : status || 'unknown',
		startedAt: Date.parse(startedAt) || 0,
	}
}

/**
 * 一次拿到所有 dsh 容器的状态，供对账使用。
 *
 * 对账要遍历全部团队，逐个 containerState 会产生 2N 次 docker 调用；
 * 团队一多这里就是瓶颈，所以用单次 ps 归组。
 *
 * @returns {Promise<Record<string, {exists:boolean, running:boolean, health:string, project:string, container:string}>>}
 */
export async function allStates() {
	const result = await run('docker', [
		'ps',
		'-a',
		'--format',
		'{{.Names}}|{{.State}}|{{.Status}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}',
	])
	const out = {}
	for (const line of result.out.split('\n')) {
		const [name, state, status, project, service] = line.trim().split('|')
		if (!name || service !== 'dsh' || !project?.startsWith('dsh-')) continue
		const team = project.slice(4)
		const health = /\(healthy\)/.test(status) ? 'healthy' : /\(unhealthy\)/.test(status) ? 'unhealthy' : ''
		out[team] = {
			exists: true,
			running: state === 'running',
			health: state === 'running' ? health || 'running' : state || 'unknown',
			project,
			container: name,
		}
	}
	return out
}

/** 所有 dsh-* compose 项目名。注册表里没有的就是孤儿（改过名、建失败的残留）。 */
export async function projectList() {
	const result = await run('docker', ['compose', 'ls', '--all', '--format', 'json'])
	try {
		const rows = JSON.parse(result.out.trim() || '[]')
		return rows.map((row) => row.Name).filter((name) => String(name).startsWith('dsh-'))
	} catch {
		return []
	}
}

/**
 * 所有形如 `<项目>_dsh-home` 的卷。
 *
 * 项目 down 之后容器和网络都没了，卷还留在盘上——磁盘就是被这些吃满的。
 * 名字里的项目前缀就是它归属的实例，去掉 `_dsh-home` 即可反查团队。
 */
/**
 * 列出所有「属于某个团队项目」的卷。
 *
 * 一个团队是一整个 compose 项目，不只一个卷：dsh-home 装会话与技能、
 * caddy-data 装入口的证书与状态、dsh-node-modules 装依赖缓存。
 * 只盯 dsh-home 会让后两种在团队删掉之后永远留在磁盘上——体积不大，
 * 但只增不减，而且看 docker volume ls 时会被当成「有东西在那」误导判断。
 */
export async function volumeList() {
	const result = await run('docker', ['volume', 'ls', '--format', '{{.Name}}'])
	return result.out
		.split('\n')
		.map((name) => name.trim())
		.map((name) => {
			const match = name.match(/^(.+)_(dsh-home|caddy-data|dsh-node-modules)$/)
			return match ? { volume: name, project: match[1], kind: match[2] } : null
		})
		.filter(Boolean)
}

/** 一次拿到所有实例的 CPU% 与内存字节。按名字循环 docker stats 会慢到不可用。 */
export async function statsMap(names) {
	const out = {}
	if (!names.length) return out
	const result = await run('docker', ['stats', '--no-stream', '--format', '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}', ...names], 30_000)
	for (const line of result.out.split('\n')) {
		const [name, cpu, mem] = line.trim().split('|')
		if (!name) continue
		out[name] = { cpu: Number(String(cpu || '').replace('%', '')) || 0, memBytes: parseBytes(mem) }
	}
	return out
}

const UNITS = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 }

/**
 * 把 "2g" / "2048m" / "2Gi" 统一换算成 GB。
 * 认不出来时返回 0，让调用方在预算校验上失败——宁可拒绝创建，也别按 0 放行。
 */
export function memoryGB(value) {
	const match = String(value ?? '').trim().match(/^([\d.]+)\s*([kmgt]?)i?b?$/i)
	if (!match) return 0
	const n = Number(match[1])
	switch (match[2].toLowerCase()) {
		case 't':
			return n * 1024
		case 'g':
			return n
		case 'm':
			return n / 1024
		case 'k':
			return n / 1024 ** 2
		default:
			return n / 1024 ** 3
	}
}

/** 把 docker stats 的 "234.5MiB / 2GiB" 解析成字节数。 */
export function parseBytes(value) {
	const match = String(value || '').match(/([\d.]+)\s*([KMGTP]?i?B)/)
	if (!match) return 0
	const unit = match[2] === 'B' ? 'B' : match[2].replace(/^([KMGTP])B$/, '$1iB')
	return Math.round(Number(match[1]) * (UNITS[unit] || 1))
}

/** 等实例的账号服务能回答，避免用户点进去撞上一个还没起来的站点。 */
export async function waitHealthy(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const ok = await new Promise((done) => {
			const req = http.get({ host: '127.0.0.1', port, path: '/__auth/health', timeout: 2000 }, (res) => {
				res.resume()
				done(res.statusCode === 200)
			})
			req.on('timeout', () => {
				req.destroy()
				done(false)
			})
			req.on('error', () => done(false))
		})
		if (ok) return
		await new Promise((r) => setTimeout(r, 500))
	}
	throw new Error(`实例 ${port} 端口在 ${timeoutMs}ms 内没有响应 /__auth/health`)
}

// ---------- provider：compose ----------

const composeOpts = (node, team, port, quota) => ({
	DSH_CPUS: String(quota.cpus),
	DSH_MEM_LIMIT: quota.memory,
	DSH_PORT_BASE: String(node?.portBase ?? 8082),
	...(port ? { EDGE_PORT: String(port) } : {}),
})

// ---------- provider：helm ----------

/**
 * 生成该团队的 values 覆盖文件。
 *
 * 只写与团队相关的差异项，其余继承 values-team.yaml —— 这样基础规格改动
 * （镜像、探针、安全上下文）能一次性对所有团队生效，不会散落在 N 个文件里。
 */
function writeHelmValues({ team, node, quota }) {
	mkdirSync(HELM_VALUES_DIR, { recursive: true })
	const host = `${team}.${node.domain || 'example.com'}`
	const file = resolve(HELM_VALUES_DIR, `${team}.yaml`)
	// compose 用 2g，K8s 习惯 2Gi：统一成 Gi，避免清单里出现小写的十进制单位
	const memGi = Math.max(1, Math.round(memoryGB(quota.memory)))
	const body = `# 由控制面生成，勿手改。团队 ${team} → 节点 ${node.id}
ingress:
  host: "${host}"
  forwardAuth:
    url: "http://oauth2-proxy-${team}.ai-tools.svc.cluster.local/oauth2/auth"
    signinUrl: "https://auth.${node.domain || 'example.com'}/oauth2/start?rd=https://${host}$escaped_request_uri"
dsh:
  publicUrl: "https://${host}/"
  trustedHosts: "${host}"
resources:
  requests:
    cpu: "${Math.max(0.25, Math.round((quota.cpus / 4) * 100) / 100)}"
    memory: "${Math.max(1, Math.round(memGi / 2))}Gi"
  limits:
    cpu: "${quota.cpus}"
    memory: "${memGi}Gi"
`
	writeFileSync(file, body)
	return { file, host }
}

async function helmProvision({ team, node, quota }) {
	const { file, host } = writeHelmValues({ team, node, quota })
	const args = [
		'upgrade',
		'--install',
		`dsh-${team}`,
		HELM_CHART,
		'--namespace',
		'ai-tools',
		'--create-namespace',
		'-f',
		HELM_BASE_VALUES,
		'-f',
		file,
	]
	// 本地没有集群时用它验证「能渲染出正确的清单」，而不是把失败当成配置错误
	if (process.env.CONSOLE_HELM_DRYRUN === '1') {
		const render = await run('helm', ['template', `dsh-${team}`, HELM_CHART, '--namespace', 'ai-tools', '-f', HELM_BASE_VALUES, '-f', file], 60_000)
		if (render.code !== 0) throw new Error(`helm template 失败：${render.out.slice(-800)}`)
		return { url: `https://${host}/`, dryRun: true }
	}
	const applied = await run('helm', args, 300_000)
	if (applied.code !== 0) throw new Error(`helm upgrade 失败：${applied.out.slice(-1200)}`)
	const rollout = await run('kubectl', ['-n', 'ai-tools', 'rollout', 'status', `deploy/dsh-${team}`, '--timeout=180s'], 200_000)
	if (rollout.code !== 0) throw new Error(`rollout 未完成：${rollout.out.slice(-800)}`)
	return { url: `https://${host}/` }
}

async function helmScale(team, replicas) {
	const result = await run(
		'kubectl',
		['-n', 'ai-tools', 'scale', `deploy/dsh-${team}`, `--replicas=${replicas}`],
		60_000,
	)
	if (result.code !== 0) throw new Error(`kubectl scale 失败：${result.out.slice(-600)}`)
	if (replicas > 0) {
		const rollout = await run('kubectl', ['-n', 'ai-tools', 'rollout', 'status', `deploy/dsh-${team}`, '--timeout=180s'], 200_000)
		if (rollout.code !== 0) throw new Error(`rollout 未完成：${rollout.out.slice(-600)}`)
	}
}

// ---------- 对外统一入口 ----------

/**
 * 创建一个团队实例。
 *
 * @param {{team:string, node:object, port:number, quota:{cpus:number, memory:string}}} input
 * @returns {Promise<{url:string, dryRun?:boolean}>}
 */
export async function provision({ team, node, port, quota }) {
	if (node.provider === 'helm') return helmProvision({ team, node, quota })
	await runTeamUp(['up', team, String(port)], 300_000, composeOpts(node, team, port, quota))
	await waitHealthy(port, 90_000)
	return { url: `http://${team}.localhost:${port}/` }
}

/** 休眠团队实例：Helm 走 `scale 0`，本地走 `team-up.sh sleep`。 */
export async function sleepInstance({ team, node }) {
	if (node.provider === 'helm') return helmScale(team, 0)
	return runTeamUp(['sleep', team], 120_000)
}

/** 唤醒团队实例：Helm 走 `scale 1`，本地走 `team-up.sh wake`。 */
export async function wakeInstance({ team, node }) {
	if (node.provider === 'helm') return helmScale(team, 1)
	return runTeamUp(['wake', team], 90_000)
}

/** 销毁团队实例（卷保留）：Helm 走 `helm uninstall`，本地走 `team-up.sh down`。 */
export async function downInstance({ team, node }) {
	if (node.provider === 'helm') {
		const result = await run('helm', ['uninstall', `dsh-${team}`, '--namespace', 'ai-tools'], 180_000)
		if (result.code !== 0) throw new Error(`helm uninstall 失败：${result.out.slice(-600)}`)
		return
	}
	await runTeamUp(['down', team], 120_000)
}

/**
 * 清理暂存目录里的残包。
 *
 * `team-up.sh` 是 `set -e`：tar 打到一半磁盘满、或上传前进程被杀，都会留下一个
 * 不完整的 tar。它不会被任何记录引用，但可能有几百 MB，攒几个就把磁盘吃出问题。
 * 只删一天以前的——正在进行的归档生命周期只有几秒。
 *
 * @param {string} dir 暂存目录
 */
function pruneStaging(dir) {
	let removed = 0
	for (const name of readdirSync(dir)) {
		const file = resolve(dir, name)
		try {
			if (Date.now() - statSync(file).mtimeMs < 24 * 3600_000) continue
			unlinkSync(file)
			removed += 1
		} catch {
			/* 删不掉不影响本次归档 */
		}
	}
	if (removed) console.log(`console: 清理归档暂存残包 ${removed} 个`)
}

/**
 * 归档：卷打包 → 删容器 → 删卷 → 包移入对象层。
 *
 * 顺序不能反。先删卷再打包就永久丢数据了；归档失败必须能回退到「容器还在、卷还在」。
 *
 * 为什么要多一步「移入对象层」：`team-up.sh` 打完包就 `down -v`，此刻这个 tar 是
 * 全库唯一副本，却落在控制面自己的磁盘上——机器坏了就没了。移入对象层后，
 * 数据在容器与卷之外，这才满足「容器可丢」的前提（docs/TODO.md L2）。
 *
 * 上传失败**不丢数据**：tar 留在本机 archives/ 并按旧格式记账，恢复照旧可用。
 *
 * @returns {Promise<{key:string,digest:string,bytes:number}|{file:string,degraded:string}>}
 *   正常返回对象键三元组；对象层不可用时返回本机文件路径并带 degraded 原因。
 */
export async function archiveInstance({ team, node, reason = 'idle' }) {
	// tar 先落到暂存目录：失败重试时不会和上一次的残包混淆，也不会被误当成正式归档
	const staging = resolve(ARCHIVE_DIR, '.staging')
	mkdirSync(staging, { recursive: true })
	pruneStaging(staging)
	const out = await runTeamUp(['archive', team], 300_000, { ARCHIVE_DIR: staging, ARCHIVE_REASON: reason })
	const file = out.trim().split('\n').filter(Boolean).pop() || ''
	if (!file || !existsSync(file)) throw new Error(`归档失败，未生成文件：${out.slice(-600)}`)
	return storeArchive(file, team)
}

/**
 * 把一个打好的归档包收进对象层；对象层不可用时降级为本机文件。
 *
 * 单独抽出来是因为这段是**唯一的数据安全点**：调用它之前 `team-up.sh` 已经 `down -v`，
 * 传进来的 tar 就是全库唯一副本。所以这里任何分支都只允许「换位置」，不允许「删掉」。
 *
 * @param {string} file 刚打好的 tar（会被移走）
 * @param {string} team 团队 id，决定对象键前缀 archives/<team>/
 * @returns {Promise<{key:string,digest:string,bytes:number}|{file:string,degraded:string}>}
 */
export async function storeArchive(file, team) {
	try {
		return await putFile(file, { prefix: `archives/${team}` })
	} catch (error) {
		mkdirSync(ARCHIVE_DIR, { recursive: true })
		const fallback = resolve(ARCHIVE_DIR, basename(file))
		renameSync(file, fallback)
		const degraded = `对象层不可用，归档降级为本机文件 ${fallback}：${error.message}`
		console.error(`console: ${degraded}`)
		return { file: fallback, degraded }
	}
}

/**
 * 从归档恢复：先把卷解出来，再正常起实例（走 provision，配额与入口按注册表来）。
 *
 * source 两种形态都要认：新版是对象键（key），老注册表只有本机文件路径（file）。
 * 不认老的会让升级前归档的团队永久恢复不了。
 *
 * `beforeStart` 是解包完成、容器启动之前的钩子：归档里只有卷内那点东西，团队级的
 * agent 参数在库里，必须在这个窗口写回卷里，否则新容器起来时用的是镜像默认。
 *
 * @param {{team:string, node:object, port:number, quota:object,
 *          source:{key?:string, file?:string}, beforeStart?:Function}} input
 */
export async function restoreInstance({ team, node, port, quota, source, beforeStart = null }) {
	const { file, cleanup } = await stageArchive(team, source)
	try {
		await runTeamUp(['restore', team, file], 300_000)
	} finally {
		// 解包已经完成，临时副本没用了；失败也要清，否则每重试一次就多一份整包
		cleanup()
	}
	if (beforeStart) await beforeStart()
	return provision({ team, node, port, quota })
}

/**
 * 把归档来源落成一个 tar 路径。
 *
 * @returns {Promise<{file:string, cleanup:()=>void}>} 对象键来源会在 ARCHIVE_DIR 下生成临时副本，需 cleanup
 */
async function stageArchive(team, source) {
	if (source?.file) return { file: source.file, cleanup: () => {} }
	if (!source?.key) throw new Error('归档记录里既没有对象键也没有文件路径，无法恢复')
	mkdirSync(ARCHIVE_DIR, { recursive: true })
	// 带上 pid 与时间戳：并发恢复同一个团队时不会互相覆盖对方的临时包
	const temp = resolve(ARCHIVE_DIR, `.restore-${team}-${process.pid}-${Date.now()}.tar.gz`)
	await materialize(source.key, temp)
	return {
		file: temp,
		cleanup: () => {
			try {
				unlinkSync(temp)
			} catch {
				/* 已经被清理过，或文件系统只读：留着也无害 */
			}
		},
	}
}
