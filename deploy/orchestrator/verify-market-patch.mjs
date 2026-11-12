/**
 * 校验 `cordis.patch.yml` 的拼接与规范化。
 *
 * 用法：`node deploy/orchestrator/verify-market-patch.mjs`
 * 需要一个 YAML 解析器来证明「拼出来的确实是顶层数组」——优先用 `.verify-yaml/`
 * （`make verify-profile` 从镜像里取的那份），没有就跳过解析类断言。
 *
 * 为什么单独立一条：真机上已经踩过一次——卸掉最后一个连接器后 patch 只剩空白，
 * dsh 启动报 `must be a top-level YAML array`，容器进入重启循环；紧接着把
 * 「空内容 → []」补上之后，`mergeMcpBlock` 又把 `[]` 当普通文本拼成了
 * 「[] 后面跟一个 - insert」，同样起不来。两个 bug 都在「空集合怎么表示」这一点上，
 * 靠真机试错太贵，必须在这里钉住。
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

// 从 .verify-yaml 里解析 yaml（make verify-profile 会把镜像里的那份取到这里）。
// 用 createRequire 而不是拼路径：包的入口在 dist/ 下，写死路径迟早对不上。
const yamlRoot = './.verify-yaml/package.json'
const YAML = existsSync(yamlRoot) ? createRequire(new URL(yamlRoot, `file://${process.cwd()}/`))('yaml') : null
const { mergeMcpBlock, normalizePatchText, renderMcpBlock } = await import('./market.mjs')

let failed = 0
const ok = (label, condition, detail = '') => {
	console.log(`${condition ? '✓' : '✗'} ${label}${condition ? '' : `  ${detail}`}`)
	if (!condition) failed += 1
}
const eq = (label, actual, expected) => ok(label, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)

const pkg = { name: 'filesystem', version: '1.2.0', spec: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'] } }
const block = renderMcpBlock(pkg, {}, '')

/** 解析成顶层数组，顺带断言元素形状。 */
const asArray = (text) => {
	if (!YAML) return null
	const parsed = YAML.parse(text)
	return Array.isArray(parsed) ? parsed : null
}

// ---------- 规范化 ----------
eq('空内容 → []', normalizePatchText(''), '[]\n')
eq('纯空白 → []', normalizePatchText('\n\n  \n'), '[]\n')
eq('已有 [] 原样', normalizePatchText('[]\n'), '[]\n')
eq('有内容不动', normalizePatchText(block), block)

// ---------- 追加 ----------
const fromEmpty = mergeMcpBlock('', 'filesystem', block)
ok('空文件追加：带标记块与 insert 行', fromEmpty.includes('market:mcp:filesystem') && fromEmpty.includes('- insert:'), fromEmpty.slice(0, 60))
if (YAML) eq('空文件追加：解析成顶层数组', asArray(fromEmpty)?.length, 1)

const fromEmptyArray = mergeMcpBlock('[]\n', 'filesystem', block)
ok('从 [] 追加：不再保留 []', !fromEmptyArray.includes('[]'), fromEmptyArray.slice(0, 60))
if (YAML) eq('从 [] 追加：解析成顶层数组', asArray(fromEmptyArray)?.length, 1)

const fromComment = mergeMcpBlock('# 团队自己的注释\n', 'filesystem', block)
if (YAML) eq('只有注释时追加：解析成顶层数组', asArray(fromComment)?.length, 1)

// ---------- 幂等与替换 ----------
const twice = mergeMcpBlock(fromEmpty, 'filesystem', block)
eq('重复安装：不叠第二块', (twice.match(/market:mcp:filesystem v/g) || []).length, 1)
if (YAML) eq('重复安装：仍是一个条目', asArray(twice)?.length, 1)

const upgraded = { ...pkg, version: '1.3.0' }
const replaced = mergeMcpBlock(fromEmpty, 'filesystem', renderMcpBlock(upgraded, {}, ''))
ok('升级：标记行版本跟着换', replaced.includes('market:mcp:filesystem v1.3.0'))
eq('升级：没有残留旧版本块', (replaced.match(/market:mcp:filesystem v/g) || []).length, 1)
if (YAML) eq('升级：仍是一个条目', asArray(replaced)?.length, 1)

// ---------- 卸载后回到合法空态 ----------
const removed = normalizePatchText(fromEmpty.replace(/# >>> market:mcp:filesystem v[\s\S]*?^# <<< market:mcp:filesystem$/m, '\n'))
eq('卸载唯一一块：回到 []', removed, '[]\n')
if (YAML) eq('卸载唯一一块：[] 解析成空数组', asArray(removed)?.length, 0)

// 多块时只删自己那块
const twoBlocks = mergeMcpBlock(mergeMcpBlock('', 'filesystem', block), 'github', renderMcpBlock({ ...pkg, name: 'github' }, {}, ''))
if (YAML) eq('两个连接器：两个条目', asArray(twoBlocks)?.length, 2)
const oneLeft = mergeMcpBlock(twoBlocks, 'filesystem', '').length >= 0 ? twoBlocks.replace(/# >>> market:mcp:filesystem v[\s\S]*?^# <<< market:mcp:filesystem$/m, '\n') : ''
if (YAML) {
	const parsed = asArray(oneLeft)
	eq('删掉一个：还剩一个条目', parsed?.length, 1)
	// 看 serverName 而不是全文：github 块里的 args 也可能含 filesystem 字样
	eq('删掉的是指定的那个', parsed?.[0]?.insert?.[0]?.config?.serverName, 'github')
}

if (!YAML) console.log('（没有 .verify-yaml，跳过解析类断言；先跑一次 make verify-profile 可准备它）')
console.log(failed ? `\n${failed} 条不通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
