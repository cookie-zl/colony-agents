#!/usr/bin/env node
/**
 * 修复 `~/.dsh` 里属主不是 dsh 的文件（默认 dry-run）。
 *
 * 为什么需要它：`docker cp` 进容器时，文件属主保留**宿主 uid**（macOS 上是 501），
 * 而容器里的 dsh 是 1000。会话文件是 `-rw-------`，于是 dsh 打不开：
 *
 *   workspace (@deepseek-ai/dsh-workspace): Error: EACCES: permission denied,
 *     open '.../sessions/--workspace--/session-xxx/session.v4.jsonl.zstd'
 *   session-controller: pending (waiting for service: workspaceRegistry)
 *
 * `workspaceRegistry` 加载失败会把下游插件全变成 pending，**侧栏就会显示「暂无会话」**——
 * 数据其实一条没丢，只是列表读不出来。这个错看起来像"数据被删了"，非常容易误判。
 *
 * 容器里 `-u 0` 不可用（OrbStack 的 btrfs 子卷 + 用户命名空间，root 也读不了 700 的
 * `/home/dsh/.dsh`，chown 必然失败）。所以修法是：docker cp 取到宿主 →
 * 以 **dsh 用户**从 stdin 重写回去（`cat file | docker exec -i -u 1000 sh -c 'cat > …'`），
 * 属主自然就是 1000。
 *
 * 用法：
 *   node deploy/orchestrator/fix-session-perms.mjs                # 只报告
 *   node deploy/orchestrator/fix-session-perms.mjs --apply        # 修
 *   node deploy/orchestrator/fix-session-perms.mjs --team team-b  # 指定团队容器
 *
 * @module deploy/orchestrator/fix-session-perms
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const teamIndex = argv.indexOf('--team')
const TEAM = teamIndex >= 0 ? argv[teamIndex + 1] : 'team-a'
const CONTAINER = `dsh-${TEAM}-dsh-1`
/** 容器内 dsh 的 uid/gid。 */
const DSH_UID = '1000'
const HOME_DIR = '/home/dsh/.dsh'

/**
 * 找到 docker 可执行文件。
 *
 * 宿主上 docker 常由 OrbStack 提供在 `~/.orbstack/bin`，默认 PATH 里没有，
 * 直接用 `'docker'` 会 ENOENT（报错还很难懂），所以显式回落。
 *
 * @returns {string} docker 路径
 */
function dockerBin() {
	const local = join(process.env.HOME ?? '', '.orbstack', 'bin', 'docker')
	return existsSync(local) ? local : 'docker'
}

const DOCKER = dockerBin()

/**
 * 在容器里以 dsh 用户跑一段命令，返回 stdout。
 *
 * @param {string} script sh 片段
 * @param {{input?:Buffer,user?:string}} [opts] 标准输入与执行用户
 * @returns {Buffer} stdout
 */
function run(script, opts = {}) {
	return execFileSync(DOCKER, ['exec', '-i', '-u', opts.user ?? DSH_UID, CONTAINER, 'sh', '-lc', script], {
		input: opts.input,
		stdio: ['pipe', 'pipe', 'pipe'],
	})
}

/**
 * 列出属主不是 dsh 的路径。
 *
 * @returns {string[]} 容器内绝对路径
 */
function findForeign() {
	try {
		const out = run(`find ${HOME_DIR} -not -user dsh 2>/dev/null || true`).toString('utf8')
		return out.split('\n').map((l) => l.trim()).filter(Boolean)
	} catch (error) {
		throw new Error(`无法在容器 ${CONTAINER} 里扫描（容器没起？）：${error.message}`)
	}
}

/**
 * 判断路径是目录还是文件。
 *
 * @param {string} path 容器内路径
 * @returns {'dir'|'file'|'unknown'} 类型
 */
function kindOf(path) {
	const out = run(`stat -c %F ${JSON.stringify(path)} 2>/dev/null || true`).toString('utf8').trim()
	if (out.includes('directory')) return 'dir'
	if (out.includes('regular')) return 'file'
	return 'unknown'
}

/**
 * 把一个文件重新以 dsh 身份写回（内容不变，属主变 1000）。
 *
 * @param {string} path 容器内路径
 * @param {string} dir 宿主临时目录
 * @returns {number} 重写后的字节数
 */
function rewrite(path, dir) {
	const local = join(dir, path.replace(/[^\w.-]/g, '_'))
	execFileSync(DOCKER, ['cp', `${CONTAINER}:${path}`, local], { stdio: 'pipe' })
	const bytes = readFileSync(local)
	run(`rm -f ${JSON.stringify(path)}`)
	run(`cat > ${JSON.stringify(path)}`, { input: bytes })
	return bytes.length
}

const foreign = findForeign()
if (!foreign.length) {
	console.log(`✓ ${CONTAINER} 里 ${HOME_DIR} 全部属于 dsh，没有需要修的`)
	process.exit(0)
}

console.log(`${APPLY ? '修复' : '发现'} ${foreign.length} 个属主异常路径（容器 ${CONTAINER}）：`)
for (const path of foreign) console.log(`  ${kindOf(path) === 'dir' ? 'dir ' : 'file'} ${path}`)

if (!APPLY) {
	console.log('\n以上只是报告。加 --apply 才会改：')
	console.log('  node deploy/orchestrator/fix-session-perms.mjs --apply')
	console.log('\n注意：属主异常会让 workspaceRegistry 加载失败，侧栏表现为「暂无会话」，但数据没丢。')
	process.exit(0)
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-perms-'))
let files = 0
let bytes = 0
try {
	for (const path of foreign) {
		if (kindOf(path) === 'dir') {
			// 目录由 dsh 自己 mkdir 才不会连带把子文件属主带错；先建后收紧权限
			run(`mkdir -p ${JSON.stringify(path)} && chmod 700 ${JSON.stringify(path)}`)
			continue
		}
		bytes += rewrite(path, dir)
		run(`chmod 600 ${JSON.stringify(path)}`)
		files += 1
		console.log(`  已重写 ${path}`)
	}
} finally {
	rmSync(dir, { recursive: true, force: true })
}

const left = findForeign()
if (left.length) {
	console.error(`\n✗ 还有 ${left.length} 个没修好：${left.slice(0, 3).join(', ')}`)
	process.exit(1)
}
console.log(`\n✓ 修复完成：${files} 个文件 / ${(bytes / 1024).toFixed(1)} KB 已按 dsh 身份重写`)
console.log('  下一步：docker compose -f deploy/compose/compose.yaml -p dsh-' + TEAM + ' restart dsh')
console.log('  重启后 workspaceRegistry 才会重新加载，侧栏恢复会话列表')
