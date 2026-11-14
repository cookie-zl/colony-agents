#!/usr/bin/env node
/**
 * 把本仓 `plugins/` 导出成一个可独立安装的插件仓（默认 `../colony-dsh-plugins`）。
 *
 * 为什么要这一步：插件有两种使用场景——「平台的镜像里内置」和「我自己有 dsh，只想装一个」。
 * 后者不该被要求 clone 整个平台。但插件又必须跟平台一起开发和验证（行为测试要用 dsh 容器
 * 和数据库夹具）。所以确定单向关系：**本仓是上游，插件仓是导出形态**。
 *
 * 导出时做两件平台侧不该关心的事：
 *   1. `license` 统一成 Apache-2.0（本仓整体许可）；
 *   2. 写入 `repository.directory`，让 npm 上能跳回源码位置。
 * 其余字段原样保留——版本、描述、`dsh.bundle` 都是插件自己的事。
 *
 * 不做的事：不 git commit、不 push。导出后由你在插件仓 review 再提交。
 *
 * 用法：
 *   node deploy/orchestrator/mirror-plugins.mjs                     # 导出到 ../colony-dsh-plugins
 *   node deploy/orchestrator/mirror-plugins.mjs --to ../my-plugins # 指定目标
 *   node deploy/orchestrator/mirror-plugins.mjs --check             # 只比对，不写（CI 用）
 *
 * @module deploy/orchestrator/mirror-plugins
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const HERE = import.meta.dirname
const REPO = resolve(HERE, '..', '..')
const SRC = join(REPO, 'plugins')
const PLUGINS_REPO_URL = 'https://github.com/cookie-zl/colony-dsh-plugins.git'

const argv = process.argv.slice(2)
const CHECK = argv.includes('--check')
const toIndex = argv.indexOf('--to')
const DST_ROOT = resolve(toIndex >= 0 ? argv[toIndex + 1] : join(REPO, '..', 'colony-dsh-plugins'))
const DST = join(DST_ROOT, 'packages')

/**
 * 执行命令并返回 stdout（失败抛错）。
 *
 * @param {string} cmd 可执行文件
 * @param {string[]} args 参数
 * @returns {string} stdout
 */
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/**
 * 把单个插件的 package.json 规范化成导出形态。
 *
 * @param {object} pkg 原始 package.json
 * @param {string} dir 插件目录名
 * @returns {object} 规范化后的对象
 */
const normalize = (pkg, dir) => ({
	...pkg,
	license: 'Apache-2.0',
	repository: { type: 'git', url: PLUGINS_REPO_URL, directory: `packages/${dir}` },
})

/**
 * 列出本仓的插件目录名（只认带 package.json 的）。
 *
 * @returns {string[]} 插件目录名
 */
const listPlugins = () => readdirSync(SRC, { withFileTypes: true })
	.filter((d) => d.isDirectory() && existsSync(join(SRC, d.name, 'package.json')))
	.map((d) => d.name)
	.sort()

const plugins = listPlugins()
if (!plugins.length) {
	console.error(`没有在 ${SRC} 里找到插件`)
	process.exit(1)
}

if (CHECK) {
	if (!existsSync(DST)) {
		console.error(`目标仓不存在：${DST}\n先建好插件仓，或在 CI 里跳过这步`)
		process.exit(1)
	}
	const drift = []
	for (const name of plugins) {
		const src = join(SRC, name)
		const dst = join(DST, name)
		if (!existsSync(dst)) { drift.push(`${name}: 缺失`); continue }
		for (const file of ['index.js', 'cordis.patch.yml', 'package.json']) {
			const a = join(src, file)
			const b = join(dst, file)
			if (!existsSync(a)) continue
			if (!existsSync(b)) { drift.push(`${name}/${file}: 缺失`); continue }
			const left = readFileSync(a, 'utf8')
			const right = file === 'package.json'
				? JSON.stringify(normalize(JSON.parse(readFileSync(a, 'utf8')), name), null, 2) + '\n'
				: left
			if (right !== readFileSync(b, 'utf8')) drift.push(`${name}/${file}: 内容不一致`)
		}
	}
	if (drift.length) {
		console.error('插件仓落后于上游：')
		for (const line of drift) console.error(`  ${line}`)
		console.error('\n上游跑 `make mirror-plugins` 重新导出')
		process.exit(1)
	}
	console.log(`✓ ${plugins.length} 个插件与上游一致（${DST}）`)
	process.exit(0)
}

if (!existsSync(DST_ROOT)) {
	console.error(`目标仓不存在：${DST_ROOT}\n先创建它，或加 --to <path> 指定`)
	process.exit(1)
}

// --delete 让删掉的插件也同步消失，避免插件仓里留下孤儿目录
sh('rsync', ['-a', '--delete', '--exclude', 'node_modules', '--exclude', '/README.md', `${SRC}/`, `${DST}/`])

for (const name of plugins) {
	const file = join(DST, name, 'package.json')
	writeFileSync(file, JSON.stringify(normalize(JSON.parse(readFileSync(file, 'utf8')), name), null, 2) + '\n')
}

console.log(`已导出 ${plugins.length} 个插件 → ${DST}`)
for (const name of plugins) console.log(`  ${name}`)
console.log('\n下一步：cd ' + DST_ROOT + ' && git status && git commit')
