/**
 * 校验「配置改动是否热生效」的判定逻辑，以及连接器的探测线索生成。
 *
 * 用法：`node deploy/orchestrator/verify-reload.mjs`（不需要 docker）
 *
 * 要证明的五件事：
 *   1. stdio 连接器：子进程出现即判定生效（basis=process, confirmed=true）；
 *   2. 卸载：子进程消失才算生效，且先给 HMR 一个稳定窗口（不能一上来就判「已经没了」）；
 *   3. 迟迟不出现：返回 applied=false，让调用方降级重启——**不能谎报成功**；
 *   4. 没有可探测子进程（http/sse）：等窗口 + 校验配置树，并如实标 confirmed=false；
 *   5. 探测线索只取够长、不带路径的片段（`/workspace` 会误撞别人进程）。
 */
const { createReloadWaiter, probeScript } = await import('./reload.mjs')
const { probeTokens } = await import('./market.mjs')

let failed = 0
const ok = (label, condition, detail = '') => {
	console.log(`${condition ? '✓' : '✗'} ${label}${condition ? '' : `  ${detail}`}`)
	if (!condition) failed += 1
}
const eq = (label, actual, expected) => ok(label, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)

const noDelay = async () => {}

/**
 * 造一个假 docker：按顺序吐预设的命中数，用完之后一直重复最后一个。
 *
 * @param {number[]} hits 每次探测的命中数
 * @param {{dump?: string, dumpCode?: number}} [options] 撞到 dump-config 时的输出
 */
function fakeExec(hits, { dump = '', dumpCode = 0 } = {}) {
	let index = 0
	const calls = []
	const exec = async (args) => {
		calls.push(args.join(' '))
		if (args.includes('--dump-config')) return { code: dumpCode, out: dump }
		const value = hits[Math.min(index, hits.length - 1)]
		index += 1
		return { code: 0, out: `${value}\n` }
	}
	return { exec, calls, count: () => calls.length }
}

// ---------- 1. 出现 ----------
{
	const fake = fakeExec([0, 0, 2])
	const wait = createReloadWaiter({ exec: fake.exec, delay: noDelay, intervalMs: 0 })
	const result = await wait('team-a', { id: 'mcp-market-filesystem', tokens: ['@modelcontextprotocol/server-filesystem'] }, 'present')
	eq('出现：判定生效', [result.applied, result.basis, result.confirmed], [true, 'process', true])
	eq('出现：探测次数（第 3 次才命中）', fake.count(), 3)
}

// ---------- 2. 卸载 ----------
{
	const fake = fakeExec([1, 0])
	const wait = createReloadWaiter({ exec: fake.exec, delay: noDelay, intervalMs: 0 })
	const result = await wait('team-a', { id: 'mcp-market-filesystem', tokens: ['@modelcontextprotocol/server-filesystem'] }, 'absent')
	eq('卸载：进程消失才算生效', [result.applied, result.basis], [true, 'process'])
	eq('卸载：第 1 次探测就已在（1 → 0）', fake.count(), 2)
}

// ---------- 3. 超时 ----------
{
	const fake = fakeExec([0])
	const wait = createReloadWaiter({ exec: fake.exec, delay: noDelay, intervalMs: 0, timeoutMs: 60 })
	const result = await wait('team-a', { tokens: ['@modelcontextprotocol/server-filesystem'] }, 'present')
	eq('超时：如实报未生效', [result.applied, result.basis], [false, 'process'])
}

// ---------- 4. 没有可探测子进程 ----------
{
	const fake = fakeExec([0], { dump: '- id: mcp-market-github\n  name: "@deepseek-ai/dsh-mcp-client"\n' })
	const wait = createReloadWaiter({ exec: fake.exec, delay: noDelay, windowMs: 0 })
	let result = await wait('team-a', { id: 'mcp-market-github', tokens: [] }, 'present')
	eq('无子进程：按配置树判定生效', [result.applied, result.basis, result.confirmed], [true, 'hmr-window', false])
	ok('无子进程：确实调了 dump-config', fake.calls.some((c) => c.includes('--dump-config')))

	const missing = fakeExec([0], { dump: '- id: something-else\n' })
	result = await createReloadWaiter({ exec: missing.exec, delay: noDelay, windowMs: 0 })('team-a', { id: 'mcp-market-github', tokens: [] }, 'present')
	eq('无子进程：配置树里没有这一行 → 未生效', result.applied, false)

	const broken = fakeExec([0], { dump: 'boom', dumpCode: 1 })
	result = await createReloadWaiter({ exec: broken.exec, delay: noDelay, windowMs: 0 })('team-a', { id: 'mcp-market-github', tokens: [] }, 'present')
	eq('无子进程：解析失败 → 未生效', [result.applied, result.confirmed], [false, false])
}

// ---------- 5. 探测线索 ----------
eq(
	'线索：stdio 只留包名（短参数与路径被过滤）',
	probeTokens({ transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'] }),
	['@modelcontextprotocol/server-filesystem'],
)
eq('线索：http 连接器没有子进程可数', probeTokens({ transport: 'http', url: 'https://example.com/mcp' }), [])
eq('线索：缺 spec 不炸', probeTokens(undefined), [])
ok('线索：脚本里内联 token（无 shell 引号问题）', probeScript(['a-b-c-d-e-f-g']).includes('["a-b-c-d-e-f-g"]'))
// 踩过：探针自己是 `node -e <源码>`，源码里带着 token，于是永远至少命中 1 个
ok('线索：脚本排除自身进程', probeScript(['x']).includes('process.pid'))
ok('线索：脚本排除其它探针', probeScript(['x']).includes("readdirSync'"))

// ---------- 6. 边界 ----------
{
	const dead = { exec: async () => ({ code: 1, out: '' }) }
	const result = await createReloadWaiter({ exec: dead.exec, delay: noDelay, intervalMs: 0, timeoutMs: 40 })('team-a', { tokens: ['@modelcontextprotocol/server-filesystem'] }, 'present')
	eq('命令一直失败：不谎报成功', result.applied, false)
}

console.log(failed ? `\n${failed} 条不通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
