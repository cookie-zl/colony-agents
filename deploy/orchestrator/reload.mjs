/**
 * 判断一次 profile 改动有没有真的生效。
 *
 * ## 为什么需要这个模块
 * 装/卸连接器写的是团队的 `cordis.patch.yml`。web 组合包开着 HMR，改完 2 秒级就重组；
 * 但从外部看，「文件写了」和「插件加载了」是两件事——中间可能 YAML 解析失败、
 * 可能包装不上、可能 watcher 没收到事件。以前的做法是一律重建容器（40 秒、踢人下线），
 * 代价是为了覆盖一个概率很低的失败。
 *
 * 这里的判据分三档，从强到弱，**并且明确告诉调用方自己有多确定**：
 *
 *   1. `process`    —— stdio 连接器在宿主上就是一个子进程，argv 里有包名。数到它（或数到
 *                      它消失），就是「插件真的被加载/卸载」的直接证据。
 *   2. `hmr-window` —— http/sse 连接器没有子进程可数：等过 HMR 稳定窗口，再用 dsh 自己
 *                      解析一遍合成后的配置树，确认这一行在（或不在）。弱一档，
 *                      `confirmed: false` 会如实反映。
 *   3. 都不是       —— 返回 `applied: false`，调用方降级到重启。
 *
 * ## 为什么不问 dsh 要工具清单
 * 那要走 Typert RPC（WebSocket），控制面没有客户端；而 `/proc` 是本机就能读的事实。
 * 代价是判据依赖「命令行里有可识别的包名」，所以 `probeTokens` 只取够长、不以 `/`
 * 开头的片段——`/workspace` 这种会和张三李四的进程撞上，误判比不判更糟。
 */

/** HMR 的配置文件监听默认 `awaitWriteFinish` 2 秒，加上重组时间实测 2.11 秒。 */
export const HMR_WINDOW_MS = 3500
/** 等子进程出现/消失的上限。超过就认为热重载没成，交给调用方降级。 */
export const PROBE_TIMEOUT_MS = 12_000
/** 卸载场景先给 HMR 一点时间动手，别把「没装过」和「装过没卸掉」混为一谈。 */
export const ABSENT_SETTLE_MS = 1500

const defaultDelay = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * 生成「数进程」的脚本。token 列表直接内联进源码，避免 shell 引号问题。
 *
 * **必须排除自己**：这段脚本是以 `node -e <源码>` 跑起来的，它的 cmdline 里就带着
 * token 字面量——不排除的话永远至少命中 1 个，「已加载」会被无条件判成真
 * （实测 install 返回 waitedMs=62ms，而 HMR 至少要 2 秒）。
 *
 * @param {string[]} tokens 命令行里应当出现的片段
 * @returns {string} 可直接 `node -e` 执行的脚本
 */
export function probeScript(tokens) {
	return [
		"const fs=require('node:fs')",
		`const tokens=${JSON.stringify(tokens)}`,
		'let hits=0',
		"for (const pid of fs.readdirSync('/proc').filter((d)=>/^\\d+$/.test(d))) {",
		'  if (Number(pid) === process.pid) continue',
		"  let cmd=''",
		'  try { cmd=fs.readFileSync(`/proc/${pid}/cmdline`,"utf8") } catch { continue }',
		// 同一条命令行里带脚本源码的其它进程（比如另一个探针）也不算
		"  if (cmd.includes('node\\0-e\\0') && cmd.includes('readdirSync')) continue",
		'  if (tokens.some((t)=>cmd.includes(t))) hits+=1',
		'}',
		'console.log(hits)',
	].join('\n')
}

/**
 * 造一个「等待生效」的函数。
 *
 * @param {{exec: (args: string[], timeoutMs: number) => Promise<{code: number, out: string}>, delay?: Function, windowMs?: number, timeoutMs?: number, intervalMs?: number}} deps
 *   `exec` 是本模块唯一的外部依赖（生产里是 `run('docker', args)`，校验脚本里是假的）
 * @returns {(team: string, probe: {id?: string, tokens?: string[]}, expect?: 'present'|'absent') => Promise<{applied: boolean, basis: string, confirmed: boolean, waitedMs: number}>}
 */
export function createReloadWaiter({ exec, delay = defaultDelay, windowMs = HMR_WINDOW_MS, timeoutMs = PROBE_TIMEOUT_MS, intervalMs = 400 }) {
	return async function waitApplied(team, probe, expect = 'present') {
		const started = Date.now()
		const container = `dsh-${team}-dsh-1`
		const done = (applied, basis, confirmed) => ({ applied, basis, confirmed, waitedMs: Date.now() - started })
		const tokens = (probe?.tokens || []).filter((token) => typeof token === 'string' && token.length >= 10)

		/** 数一次命中；命令失败返回 null（容器没了之类），调用方当作「还不知道」。 */
		const count = async () => {
			const result = await exec(['exec', container, 'node', '-e', probeScript(tokens)], 20_000).catch(() => null)
			if (!result || result.code !== 0) return null
			const hits = Number(result.out.trim())
			return Number.isFinite(hits) ? hits : null
		}

		if (!tokens.length) {
			// 没有可探测的子进程：等窗口 + 验证配置树里这一行在不在
			await delay(windowMs)
			const check = await exec(['exec', container, 'dsh', '--profile', 'web', '--dump-config'], 90_000).catch(() => null)
			if (!check || check.code !== 0) return done(false, 'hmr-window', false)
			const present = probe?.id ? check.out.includes(`id: ${probe.id}`) : true
			return done(expect === 'present' ? present : !present, 'hmr-window', false)
		}

		if (expect === 'absent') await delay(ABSENT_SETTLE_MS)
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			const hits = await count()
			if (hits !== null && (expect === 'present' ? hits > 0 : hits === 0)) {
				return done(true, 'process', true)
			}
			await delay(intervalMs)
		}
		return done(false, 'process', true)
	}
}
