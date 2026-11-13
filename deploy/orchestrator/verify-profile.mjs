#!/usr/bin/env node
/**
 * `deploy/image/profile-patch.mjs` 与 `prepare-workspaces.mjs` 的本地验证。
 *
 * 两个脚本跑在容器启动路径上，出错会直接影响「容器能不能起来」，所以逻辑必须
 * 在宿主上可反复验证，不依赖 docker。
 *
 * 用法：node deploy/orchestrator/verify-profile.mjs
 *
 * DSH_YAML_ROOT 指向一个能 require 到 `yaml` 的目录（镜像里是 dsh 的 node_modules），
 * 没有就用镜像导出的那份：
 *   docker run --rm --entrypoint sh colony:0.2.1-rc.5 \
 *     -c 'cd /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules && tar cf - yaml' \
 *     | tar xf - -C /tmp/yamltest/node_modules
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const HERE = resolve(import.meta.dirname, '..')
const SCRIPT = join(HERE, 'image/profile-patch.mjs')
const PREPARE = join(HERE, 'image/prepare-workspaces.mjs')
const YAML_ROOT =
	process.env.DSH_YAML_ROOT ||
	['.verify-yaml/package.json', '/tmp/yamltest/package.json'].find((path) => existsSync(path)) ||
	'.verify-yaml/package.json'
const YAML_AVAILABLE = existsSync(YAML_ROOT)
const yaml = YAML_AVAILABLE ? createRequire(YAML_ROOT)('yaml') : null

let passed = 0
let failed = 0
const ok = (name) => {
	passed += 1
	console.log(`  ✓ ${name}`)
}
const bad = (name, detail) => {
	failed += 1
	console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
}
const check = (name, condition, detail) => (condition ? ok(name) : bad(name, detail))

/** 镜像里的基线：注释很多，只有一个生效行。 */
const BASE_PATCH = `# dsh profile 覆盖层（镜像基线）
# 注释说明：改默认模型用 id=agent-default-model
- id: agent-default-model
  config:
    provider: our-free-model
    model: kilo-auto/free
`

function sandbox() {
	const home = mkdtempSync(join(tmpdir(), 'dsh-profile-'))
	mkdirSync(join(home, 'profiles/web'), { recursive: true })
	writeFileSync(join(home, 'profiles/web/cordis.patch.yml'), BASE_PATCH)
	return home
}

/** 两个脚本的诊断信息都走 stderr，采集时合并回来，否则断言看不见原因。 */
function runNode(args, env) {
	const result = spawnSync('node', args, { env, encoding: 'utf8' })
	return { out: `${result.stdout ?? ''}${result.stderr ?? ''}`, code: result.status ?? 1 }
}

function run(home, command, { yamlAvailable = YAML_AVAILABLE, seedPatch = null } = {}) {
	const env = { ...process.env, DSH_HOME: home }
	if (yamlAvailable) env.DSH_YAML_ROOT = YAML_ROOT
	else delete env.DSH_YAML_ROOT
	if (seedPatch) env.DSH_SEED_PATCH = seedPatch
	else delete env.DSH_SEED_PATCH
	return runNode([SCRIPT, command], env).out
}

const patchOf = (home) => readFileSync(join(home, 'profiles/web/cordis.patch.yml'), 'utf8')
const keepJson = (home, name) => JSON.parse(readFileSync(join(home, '.profile-keep', name), 'utf8'))

/** 模拟 dsh 的 configEditor 写回：整份 stringify，注释全丢。 */
function uiWrite(home, mutate) {
	const rows = yaml.parse(patchOf(home)) ?? []
	writeFileSync(join(home, 'profiles/web/cordis.patch.yml'), yaml.stringify(mutate(rows)))
}

/** 模拟 entrypoint 的 seed：用镜像那份覆盖 profile。 */
const seed = (home) => writeFileSync(join(home, 'profiles/web/cordis.patch.yml'), BASE_PATCH)

console.log('profile-patch：无改动时不能动文件')
{
	const home = sandbox()
	run(home, 'capture')
	seed(home)
	run(home, 'merge')
	check('文件字节与镜像基线完全一致（注释没被重写）', patchOf(home) === BASE_PATCH)
	check('effective 为空', keepJson(home, 'effective.json').length === 0)
	check('baseline 记下了 1 行', keepJson(home, 'baseline.json').length === 1)
	rmSync(home, { recursive: true, force: true })
}

console.log('profile-patch：UI 改模型后重启要保留')
{
	const home = sandbox()
	run(home, 'capture')
	seed(home)
	run(home, 'merge')
	// 用户在 UI 里把模型换成官方
	uiWrite(home, (rows) => {
		for (const row of rows) if (row.id === 'agent-default-model') row.config = { provider: 'deepseek-official', model: 'deepseek-flash' }
		return rows
	})
	run(home, 'capture')
	seed(home)
	run(home, 'merge')
	const merged = yaml.parse(patchOf(home))
	const model = merged.find((row) => row.id === 'agent-default-model')
	check('合并后仍是用户选的 provider', model?.config?.provider === 'deepseek-official', JSON.stringify(model))
	check('合并后仍是用户选的 model', model?.config?.model === 'deepseek-flash')
	check('effective 记下了这一行', keepJson(home, 'effective.json').some((row) => row.id === 'agent-default-model'))
	check('重写后的文件带说明头', patchOf(home).startsWith('# 本文件由容器启动流程重建'))
	rmSync(home, { recursive: true, force: true })
}

console.log('profile-patch：用户新增的行要保留')
{
	const home = sandbox()
	run(home, 'capture')
	seed(home)
	run(home, 'merge')
	uiWrite(home, (rows) => [
		...rows,
		{ insert: [{ id: 'mcp-market-filesystem', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'filesystem' } }] },
	])
	run(home, 'capture')
	seed(home)
	run(home, 'merge')
	const merged = yaml.parse(patchOf(home))
	const insertRow = merged.flatMap((row) => row.insert ?? []).find((row) => row.id === 'mcp-market-filesystem')
	check('新增的 insert 行还在', insertRow?.config?.serverName === 'filesystem', JSON.stringify(merged))
	check('镜像基线那一行也在', merged.some((row) => row.id === 'agent-default-model'))
	rmSync(home, { recursive: true, force: true })
}

console.log('profile-patch：用户删掉的行不要复活')
{
	const home = sandbox()
	// 先让卷里有两行
	writeFileSync(
		join(home, 'profiles/web/cordis.patch.yml'),
		`- id: agent-default-model\n  config:\n    provider: our-free-model\n    model: kilo-auto/free\n- id: dsh-plugin\n  disabled: true\n`,
	)
	run(home, 'capture')
	seed(home)
	run(home, 'merge')
	// 用户在 UI 里把 disabled 那行删掉
	uiWrite(home, (rows) => rows.filter((row) => row.id !== 'dsh-plugin'))
	run(home, 'capture')
	seed(home)
	run(home, 'merge')
	const merged = yaml.parse(patchOf(home))
	check('被删的行没有复活', !merged.some((row) => row.id === 'dsh-plugin'), JSON.stringify(merged))
	check('另一行还在', merged.some((row) => row.id === 'agent-default-model'))
	rmSync(home, { recursive: true, force: true })
}

console.log('profile-patch：首次启动 / 旧卷降级')
{
	const home = sandbox()
	run(home, 'merge')
	check('没有 prev 时只记基线、不改文件', patchOf(home) === BASE_PATCH)
	check('baseline 已写入', existsSync(join(home, '.profile-keep/baseline.json')))
	rmSync(home, { recursive: true, force: true })

	const home2 = sandbox()
	// 有 prev 但 baseline 丢了（旧卷迁移）：按「prev 与 newBase 不同」近似
	mkdirSync(join(home2, '.profile-keep'), { recursive: true })
	writeFileSync(join(home2, '.profile-keep/prev.json'), JSON.stringify([
		{ id: 'agent-default-model', kind: 'patch', value: { id: 'agent-default-model', config: { provider: 'x', model: 'y' } } },
	]))
	run(home2, 'merge')
	const merged = yaml.parse(patchOf(home2))
	check('降级路径也把用户值带回来', merged.find((r) => r.id === 'agent-default-model')?.config?.provider === 'x')
	rmSync(home2, { recursive: true, force: true })
}

console.log('profile-patch：yaml 库缺失时不能弄坏文件')
{
	const home = sandbox()
	const out = run(home, 'capture', { yamlAvailable: false })
	check('capture 打印跳过原因', out.includes('找不到 yaml 库'), out.trim())
	check('文件仍是基线', patchOf(home) === BASE_PATCH)
	seed(home)
	run(home, 'merge', { yamlAvailable: false })
	check('merge 也不动文件', patchOf(home) === BASE_PATCH)
	rmSync(home, { recursive: true, force: true })
}

console.log('profile-patch：连续多次重启都要保留（baseline 不能写成合并结果）')
{
	const home = sandbox()
	run(home, 'capture')
	seed(home)
	run(home, 'merge')
	uiWrite(home, (rows) => {
		for (const row of rows) if (row.id === 'agent-default-model') row.config = { provider: 'keep', model: 'me' }
		return rows
	})
	for (let round = 1; round <= 3; round += 1) {
		run(home, 'capture')
		seed(home)
		run(home, 'merge')
		const model = yaml.parse(patchOf(home)).find((row) => row.id === 'agent-default-model')
		check(`第 ${round} 次重启后仍是用户的值`, model?.config?.provider === 'keep', JSON.stringify(model))
	}
	rmSync(home, { recursive: true, force: true })
}

console.log('profile-patch：运行期改动要能现算（不用重启）')
{
	const home = sandbox()
	run(home, 'capture')
	seed(home)
	run(home, 'merge')
	uiWrite(home, (rows) => {
		for (const row of rows) if (row.id === 'agent-default-model') row.config = { provider: 'p2', model: 'm2' }
		return rows
	})
	const out = run(home, 'export')
	const effective = keepJson(home, 'effective.json')
	check(
		'export 认出了运行期的改动',
		effective.some((row) => row.id === 'agent-default-model' && row.value?.config?.provider === 'p2'),
		out,
	)
	check('export 不动 patch 文件', patchOf(home).includes('m2'))
	rmSync(home, { recursive: true, force: true })
}

console.log('profile-patch：baseline 丢了也能按镜像 seed 算差异')
{
	const home = sandbox()
	const seedFile = join(home, 'seed-baseline.yml')
	writeFileSync(seedFile, BASE_PATCH)
	uiWrite(home, (rows) => {
		for (const row of rows) if (row.id === 'agent-default-model') row.config = { provider: 'p3', model: 'm3' }
		return rows
	})
	const out = run(home, 'export', { seedPatch: seedFile })
	const effective = keepJson(home, 'effective.json')
	check('按 seed 基线只算出 1 行改动', effective.length === 1 && effective[0].value?.config?.provider === 'p3', out)
	rmSync(home, { recursive: true, force: true })
}

console.log('prepare-workspaces：补建历史 cwd')
{
	const home = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
	mkdirSync(join(home, 'storages'), { recursive: true })
	const wanted = join(home, 'projects/测试1')
	writeFileSync(
		join(home, 'storages/workspace.json'),
		JSON.stringify({
			tables: {
				workspaces: {
					a: { path: wanted, title: '测试1' },
					b: { path: join(home, 'projects/第二个'), title: '第二个' },
					c: { path: 'relative/dir', title: '相对路径应跳过' },
				},
			},
		}),
	)
	const out = runNode([PREPARE], { ...process.env, DSH_HOME: home }).out
	check('建出了第一个目录', existsSync(wanted))
	check('建出了第二个目录', existsSync(join(home, 'projects/第二个')))
	check('相对路径没被创建', !existsSync(join(process.cwd(), 'relative/dir')))
	check('日志说明了补建数量', out.includes('补建'), out)

	const again = runNode([PREPARE], { ...process.env, DSH_HOME: home }).out
	check('第二次运行是幂等的', again.includes('无需补建'), again)

	rmSync(home, { recursive: true, force: true })
}

console.log('prepare-workspaces：索引缺失/损坏不影响启动')
{
	const home = mkdtempSync(join(tmpdir(), 'dsh-ws2-'))
	const out = runNode([PREPARE], { ...process.env, DSH_HOME: home }).out
	check('没有索引时正常退出', out.includes('跳过'), out)
	mkdirSync(join(home, 'storages'), { recursive: true })
	writeFileSync(join(home, 'storages/workspace.json'), '{ 坏掉的 json')
	const out2 = runNode([PREPARE], { ...process.env, DSH_HOME: home }).out
	check('坏索引时也正常退出', out2.includes('读 workspace 索引失败'), out2)
	rmSync(home, { recursive: true, force: true })
}

console.log(`\n${failed ? '✗' : '✓'} verify-profile: ${passed} 通过, ${failed} 失败${YAML_AVAILABLE ? '' : '（未找到 yaml 库，已跳过的用例不完整）'}`)
process.exit(failed ? 1 : 0)
