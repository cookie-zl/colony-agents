/**
 * 团队工作区定位 + 「本地技能遮蔽」检测。
 *
 * 为什么需要它：dsh 的技能目录是**按 name 唯一**的一张表，同名只留一条，
 * 谁赢看 rank：
 *
 *   <workspace>/.dsh/skills     100
 *   <workspace>/.agents/skills  200
 *   $DSH_HOME/skills            400（本方案里容器内不可写，用户放不进去）
 *   市场（本项目的 provider）    550
 *   bundled                     600
 *
 * 也就是说：用户在自己工作区里手写一个同名技能，**市场那份会从模型视野里静默消失**，
 * 而控制面的表还写着「已安装、已启用」。表说在跑市场版，实际跑的是本地版——
 * 这正是这套系统最想避免的「两套事实」。所以装/启用之前必须在这里拦一下。
 *
 * 检测范围刻意只到「工作区根 + 一层子目录」：再深就要按会话 cwd 逐个算了，
 * 而 cwd 是运行期才知道的。宁可多报（提示用户去确认）也不要漏报。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { run } from './runtime.mjs'
import { HERE } from './store.mjs'

/** 兜底猜测用的根目录：team-up.sh 默认把工作区放在 deploy/compose/workspace-<team>。 */
const WORKSPACE_ROOT = process.env.DSH_WORKSPACE_ROOT || resolve(HERE, '..', 'compose')

/** 扫描上限：工作区里项目目录多到一定程度就该换策略了，不能让它拖慢安装请求。 */
const MAX_SUBDIRS = 200

/** dsh 会扫的两个项目级技能根，顺序与内核一致（rank 小的先赢）。 */
const ROOTS = [
	{ dir: '.dsh/skills', source: 'project-dsh', rank: 100 },
	{ dir: '.agents/skills', source: 'project-agents', rank: 200 },
]

/**
 * 找出团队的宿主侧工作区目录。
 *
 * 以容器挂载为准——`team-up.sh up <team> <port> <ws>` 允许指定别的工作区，
 * 这时 `workspace-<team>` 这个命名约定是错的。容器不在（休眠也算在）就用约定路径兜底。
 *
 * @param {string} team
 * @returns {Promise<string|null>} 绝对路径；两次都没找到返回 null（调用方跳过检测）
 */
export async function resolveWorkspace(team) {
	const inspect = await run(
		'docker',
		[
			'inspect',
			`dsh-${team}-dsh-1`,
			'--format',
			'{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}',
		],
		8_000,
	)
	if (inspect.code === 0) {
		const source = inspect.out.trim()
		if (source) return source
	}
	const guessed = join(WORKSPACE_ROOT, `workspace-${team}`)
	return existsSync(guessed) ? guessed : null
}

/**
 * 在某个根目录下查一个技能名。
 *
 * dsh 两种形态都认：`<root>/<name>/SKILL.md`（目录包）和 `<root>/<name>.md`（单文件）。
 * 只查目录包会漏掉单文件那种，而单文件恰恰是用户临时手写时最常见的形态。
 *
 * @param {string} root
 * @param {string} name
 * @param {{dir:string, source:string, rank:number}} spec
 * @returns {{path:string, source:string, rank:number, shape:'directory'|'file'}|null}
 */
function hitAt(root, name, spec) {
	const dir = join(root, spec.dir)
	for (const candidate of [join(dir, name), join(dir, `${name}.md`)]) {
		if (!existsSync(candidate)) continue
		const shape = statSync(candidate).isDirectory() ? 'directory' : 'file'
		return { path: candidate, source: spec.source, rank: spec.rank, shape }
	}
	return null
}

/**
 * 扫出工作区里所有会和 `name` 撞名的本地技能。
 *
 * @param {string|null} workspaceDir {@link resolveWorkspace} 的结果
 * @param {string} name 市场侧的技能名
 * @returns {Array<{path:string, source:string, rank:number, shape:string}>} 空数组表示没有遮蔽
 */
export function findShadow(workspaceDir, name) {
	if (!workspaceDir || !existsSync(workspaceDir)) return []

	const bases = [workspaceDir]
	try {
		const children = readdirSync(workspaceDir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
			.slice(0, MAX_SUBDIRS)
		for (const child of children) bases.push(join(workspaceDir, child.name))
	} catch {
		// 工作区不可读就等于没法确认，退化成「不报」而不是「报错」：
		// 安装流程不该因为一个权限问题整条挂掉。
	}

	const found = []
	for (const base of bases) {
		for (const spec of ROOTS) {
			const hit = hitAt(base, name, spec)
			if (hit) found.push(hit)
		}
	}
	return found
}

/**
 * 把遮蔽信息写成一句人话，给 API 的 `error` 字段用。
 *
 * 必须带上「为什么装了也不生效」和「有哪几条出路」，否则用户只会看到
 * 「安装失败」然后反复重试——这是最容易把人卡死的一类报错。
 *
 * @param {string} name
 * @param {Array<{path:string, rank:number}>} shadow
 * @returns {string}
 */
export function shadowMessage(name, shadow) {
	const first = shadow[0]
	const more = shadow.length > 1 ? `（另有 ${shadow.length - 1} 处）` : ''
	return (
		`工作区里已有同名技能 ${first.path}${more}，它按 rank ${first.rank} 排在市场前面，` +
		`装上去也不会生效。先把它改名或删掉；确实要保留记录可以加 force 强装。`
	)
}
