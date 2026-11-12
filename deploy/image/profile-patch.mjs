#!/usr/bin/env node
/**
 * profile patch 的用户层持久化。
 *
 * 问题：dsh 把「UI 里改的模型 / preset / 工具开关」写进 active profile patch
 * （`$DSH_HOME/profiles/web/cordis.patch.yml`），而 entrypoint 的 `refresh` 模式
 * 每次启动都会 `rm -rf profiles/web` 再从镜像重铺 —— 用户的改动每次重启归零。
 *
 * 做法：把「用户改了什么」和「镜像默认是什么」分开记，重启时重新叠回去。
 *
 *   capture  启动前：把当前 patch 存成 prev.json（这是用户改过的现场）
 *   merge    seed 之后：baseline.json（上次的镜像基线）+ prev.json 求出用户改动，
 *            叠到新的 base 上，写回 patch；同时把改动集合导出到 effective.json
 *
 * 没有改动时**不重写文件**：base 原样保留，注释也不会丢。只有真改过才重写。
 *
 * 一个已知的取舍：dsh 的 configEditor 写回 patch 时会丢掉注释，所以「改过设置」
 * 的文件本来就没注释；我们重写时统一在文件头补一段说明。
 *
 * @module deploy/image/profile-patch
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const HOME = process.env.DSH_HOME || '/home/dsh/.dsh'
const PROFILE_PATCH = join(HOME, 'profiles/web/cordis.patch.yml')
/** 镜像里的基线：基线记录丢了也能算差异，比 baseline.json 更权威。 */
const SEED_PATCH = process.env.DSH_SEED_PATCH || '/opt/dsh-seed/profiles/web/cordis.patch.yml'
const KEEP = join(HOME, '.profile-keep')
const BASELINE = join(KEEP, 'baseline.json')
const PREV = join(KEEP, 'prev.json')
const EFFECTIVE = join(KEEP, 'effective.json')
/** 控制面在「卷是新的/刚 restore」时写进来的权威用户层，用完即删，不能长期压制 UI 改动。 */
const INJECT = join(KEEP, 'inject.json')

/** 镜像里 dsh 自带的 yaml：不额外装包，跟着 dsh 的解析器走，语义才不会偏。 */
function loadYaml() {
	const roots = [
		process.env.DSH_YAML_ROOT,
		'/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
		join(dirname(process.execPath), '../lib/node_modules/@deepseek-ai/dsh/package.json'),
		join(process.cwd(), 'package.json'),
	].filter(Boolean)
	for (const root of roots) {
		if (!existsSync(root)) continue
		try {
			return createRequire(root)('yaml')
		} catch {
			/* 换下一个 */
		}
	}
	return null
}

const log = (msg) => console.error(`profile-patch: ${msg}`)

/**
 * 读一个 patch 文件成「id → 条目」的有序表。
 *
 * dsh 的 patch 是顶层数组，元素两种形态：
 *   - { id, ...fields }      覆盖已有行
 *   - { insert: [ {...} ] }  追加新行
 * 同一个 id 出现多次时后者生效（与 YAML 顺序一致）。
 *
 * @param {string} text patch 文件内容
 * @param {object} yaml yaml 库
 * @returns {Map<string, {kind: 'patch'|'insert', value: object}>}
 */
function indexOf(text, yaml) {
	const map = new Map()
	const list = yaml.parse(text) ?? []
	if (!Array.isArray(list)) throw new Error('patch 顶层不是数组')
	for (const entry of list) {
		if (!entry || typeof entry !== 'object') continue
		if (Array.isArray(entry.insert)) {
			for (const row of entry.insert) if (row && row.id) map.set(String(row.id), { kind: 'insert', value: row })
			continue
		}
		if (entry.id) map.set(String(entry.id), { kind: 'patch', value: entry })
	}
	return map
}

/** 序列化回 dsh 认的形态：覆盖项平铺，insert 项合并成一个块。 */
function serializeOf(map) {
	const patchRows = []
	const insertRows = []
	for (const { kind, value } of map.values()) (kind === 'insert' ? insertRows : patchRows).push(value)
	return insertRows.length ? [...patchRows, { insert: insertRows }] : patchRows
}

/** 深比较：patch 条目是纯 JSON（yaml 解析产物），JSON 稳定序列化足够。 */
const same = (a, b) => JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b))

function sortDeep(value) {
	if (Array.isArray(value)) return value.map(sortDeep)
	if (!value || typeof value !== 'object') return value
	const out = {}
	for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key])
	return out
}

function readJson(path, fallback = null) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'))
	} catch {
		return fallback
	}
}

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** 把 Map 转成可落库的数组（保持顺序）。 */
const toRows = (map) => [...map.entries()].map(([id, { kind, value }]) => ({ id, kind, value }))

/** 从落库数组还原 Map。 */
function fromRows(rows) {
	const map = new Map()
	for (const row of rows ?? []) if (row && row.id) map.set(String(row.id), { kind: row.kind === 'insert' ? 'insert' : 'patch', value: row.value })
	return map
}

/**
 * 求用户改动：prev 与 baseline 不同的项、新增的项，以及被删掉的项（记为 null）。
 *
 * baseline 缺失（首次启动、旧卷、刚 restore）时退化为「prev 与 newBase 不同的项」——
 * 近似但方向正确：宁可多带一条用户行，也不要丢配置。
 */
function deltaOf(baseline, prev, newBase) {
	const delta = new Map()
	if (baseline) {
		for (const [id, entry] of prev) {
			const before = baseline.get(id)
			if (!before || !same(before.value, entry.value)) delta.set(id, entry)
		}
		for (const id of baseline.keys()) if (!prev.has(id)) delta.set(id, null)
		return delta
	}
	for (const [id, entry] of prev) {
		const current = newBase.get(id)
		if (!current || !same(current.value, entry.value)) delta.set(id, entry)
	}
	return delta
}

function capture() {
	if (!existsSync(PROFILE_PATCH)) {
		log('没有 profile patch，跳过 capture')
		return
	}
	const yaml = loadYaml()
	if (!yaml) {
		log('找不到 yaml 库，跳过 capture（本次重启不保留 UI 设置）')
		return
	}
	try {
		const map = indexOf(readFileSync(PROFILE_PATCH, 'utf8'), yaml)
		writeJson(PREV, toRows(map))
		log(`capture ${map.size} 行`)
	} catch (error) {
		log(`capture 失败：${error.message}`)
	}
}

function merge() {
	if (!existsSync(PROFILE_PATCH)) {
		log('没有 profile patch，跳过 merge')
		return
	}
	const yaml = loadYaml()
	if (!yaml) {
		log('找不到 yaml 库，跳过 merge（本次重启不保留 UI 设置）')
		return
	}
	let baseMap
	try {
		baseMap = indexOf(readFileSync(PROFILE_PATCH, 'utf8'), yaml)
	} catch (error) {
		log(`读新基线失败，保持原样：${error.message}`)
		return
	}

	const injected = readJson(INJECT)
	const prevRows = injected ?? readJson(PREV)
	const baseRows = readJson(BASELINE)
	if (!prevRows) {
		// 首次启动：没有上一次的现场，只记基线
		writeJson(BASELINE, toRows(baseMap))
		writeJson(EFFECTIVE, [])
		log('首次启动，只记基线')
		return
	}
	if (injected) log(`使用控制面注入的用户层（${injected.length} 行）`)

	const delta = deltaOf(baseRows ? fromRows(baseRows) : null, fromRows(prevRows), baseMap)
	// baseline 必须是「镜像这次给的基线」，绝不能是合并结果——写合并结果的话，下次启动
	// prev 与 baseline 天然相同，delta 恒为空，用户的改动就被静默丢掉了。
	// 放在合并之前写，无改动和有改动两条路径都覆盖。
	writeJson(BASELINE, toRows(baseMap))
	writeJson(EFFECTIVE, toRows(delta).filter((row) => row.value !== null))
	// 注入是一次性的：留着它会让之后每次启动都用旧快照，把用户在 UI 里的新改动顶掉
	if (injected) {
		try {
			unlinkSync(INJECT)
		} catch {
			/* 删不掉不影响本次合并 */
		}
	}
	if (!delta.size) {
		log('用户层为空，保持镜像基线不动')
		return
	}

	for (const [id, entry] of delta) {
		if (entry === null) baseMap.delete(id)
		else baseMap.set(id, entry)
	}
	const header = [
		'# 本文件由容器启动流程重建：镜像默认 + 用户层（.profile-keep/effective.json）。',
		'# 直接改这里的用户行会被下一次 UI 保存覆盖；要长期生效请改控制面的 agent 配置。',
		'',
	]
	writeFileSync(PROFILE_PATCH, `${header.join('\n')}${yaml.stringify(serializeOf(baseMap))}`)
	log(`叠加用户层 ${delta.size} 行`)
}

/**
 * 导出「当前生效的用户层」，不碰 profile patch。
 *
 * 为什么要单独一个命令：`merge` 只在启动时跑，之后用户在 UI 里接着改，卷里的
 * `effective.json` 还是旧的。控制面定时收集时必须现算一次，否则「最后改的那次」永远进不了库。
 *
 * 基线优先用 `baseline.json`（上次 seed 的）；它丢了就读镜像里的 seed 文件——
 * 那是同一份基线，比「把整份 patch 当用户层」安全得多（后者会把基线钉死在库里）。
 */
function exportEffective() {
	if (!existsSync(PROFILE_PATCH)) {
		log('没有 profile patch，跳过 export')
		return
	}
	const yaml = loadYaml()
	if (!yaml) {
		log('找不到 yaml 库，跳过 export')
		return
	}
	let current
	try {
		current = indexOf(readFileSync(PROFILE_PATCH, 'utf8'), yaml)
	} catch (error) {
		log(`读 profile patch 失败：${error.message}`)
		return
	}
	let baseline = null
	const rows = readJson(BASELINE)
	if (rows) baseline = fromRows(rows)
	else if (existsSync(SEED_PATCH)) {
		try {
			baseline = indexOf(readFileSync(SEED_PATCH, 'utf8'), yaml)
		} catch (error) {
			log(`读镜像基线失败：${error.message}`)
		}
	}
	const delta = deltaOf(baseline, current, current)
	writeJson(EFFECTIVE, toRows(delta).filter((row) => row.value !== null))
	log(`export 用户层 ${delta.size} 行`)
}

const command = process.argv[2]
try {
	if (command === 'capture') capture()
	else if (command === 'merge') merge()
	else if (command === 'export') exportEffective()
	else {
		log(`未知命令 ${command}（capture|merge|export）`)
		process.exit(2)
	}
} catch (error) {
	// 任何失败都不阻止容器启动：最坏情况是这一轮回到镜像默认
	log(`未预期错误：${error.message}`)
}
