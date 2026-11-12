/**
 * 对象层：大块二进制（归档包、以后的会话日志与产物）统一从这里进出。
 *
 * 为什么要有这一层：归档包现在直接落在 `deploy/orchestrator/archives/`，
 * 那是控制面所在的磁盘——机器坏掉就只剩一个单点副本。而且「容器可丢」
 * 这个前提要求数据必须存在容器之外，将来换 OSS 时不该让调用方跟着改。
 *
 * 现在实现的是本地内容寻址后端：
 *   key = <prefix>/<sha256>，落盘时在最后一级前插两位分片（避免单目录几万文件）
 *   同一份内容重复 put 是幂等的，也不产生第二份副本。
 *
 * 换 OSS 时只改本文件的 putFile / materialize / statObject / deleteObject，
 * 调用方（runtime.mjs、console.mjs）一行都不用动。这是 docs/TODO.md L5 的前提。
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, basename, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { HERE } from './store.mjs'

/** 对象根目录。换后端前，它就是「当前的存储」；测试时用环境变量指到临时目录。 */
export const OBJECTS_DIR = process.env.CONSOLE_OBJECTS_DIR || resolve(HERE, 'objects')

/**
 * key → 磁盘路径。分片用 digest 前两位，和 OSS 的 `<prefix>/<xx>/<digest>` 习惯一致，
 * 将来迁移时对象键不用重写。
 *
 * @param {string} key 形如 `archives/team-a/<sha256>`
 * @returns {string} 绝对路径
 */
export function objectPath(key) {
	const parts = String(key || '').split('/').filter(Boolean)
	if (parts.length < 2) throw new Error(`对象键格式不对（至少要 <prefix>/<name>）：${key}`)
	const name = parts.pop()
	return resolve(OBJECTS_DIR, ...parts, name.slice(0, 2), name)
}

/**
 * 流式计算文件 sha256。归档包可能几百 MB，读进内存会直接把控制面撑爆，
 * 所以一律走流。
 *
 * @param {string} file 绝对路径
 * @returns {Promise<string>} 小写十六进制
 */
export function sha256File(file) {
	return new Promise((done, fail) => {
		const hash = createHash('sha256')
		const stream = createReadStream(file)
		stream.on('error', fail)
		stream.on('data', (chunk) => hash.update(chunk))
		stream.on('end', () => done(hash.digest('hex')))
	})
}

/**
 * 把本地文件移入对象层，返回对象键。
 *
 * **注意是「移入」不是「复制」**：成功后源文件不再存在。归档流程里 tar 本来就只是
 * 中转产物，移入可以省掉一次整包拷贝；需要保留源文件的调用方请自己先 copy。
 *
 * @param {string} srcPath 源文件（会被移走）
 * @param {{prefix?: string}} [options] prefix 决定对象归到哪一类，如 `archives/team-a`
 * @returns {Promise<{key: string, digest: string, bytes: number, storage: string}>}
 */
export async function putFile(srcPath, { prefix = 'blobs' } = {}) {
	if (!existsSync(srcPath)) throw new Error(`putFile 找不到源文件：${srcPath}`)
	const digest = await sha256File(srcPath)
	const bytes = statSync(srcPath).size
	const key = `${prefix.replace(/\/+$/, '')}/${digest}`
	const dest = objectPath(key)
	mkdirSync(dirname(dest), { recursive: true })
	if (!existsSync(dest)) {
		try {
			renameSync(srcPath, dest)
		} catch (error) {
			// 跨设备（临时目录在别的分区）时 rename 会 EXDEV，退化成流式拷贝再删源
			if (error.code !== 'EXDEV') throw error
			await pipeline(createReadStream(srcPath), createWriteStream(dest))
			unlinkSync(srcPath)
		}
	} else {
		// 同一份内容已经在库里：内容寻址天然去重，源文件直接丢掉即可
		unlinkSync(srcPath)
	}
	return { key, digest, bytes, storage: 'local' }
}

/**
 * 把一段内存字节放进对象层。会话日志按字节区间增量上传时走这里：
 * 一个区间就是一份内容，没有本地文件可移。
 *
 * @param {Buffer} buffer 内容
 * @param {{prefix?: string, key?: string}} [options] key 优先；否则用 `<prefix>/<sha256>`
 * @returns {Promise<{key: string, digest: string, bytes: number, storage: string}>}
 */
export async function putBuffer(buffer, { prefix = 'blobs', key = '' } = {}) {
	const digest = createHash('sha256').update(buffer).digest('hex')
	const objectKey = key || `${prefix.replace(/\/+$/, '')}/${digest}`
	const dest = objectPath(objectKey)
	if (!existsSync(dest)) {
		mkdirSync(dirname(dest), { recursive: true })
		writeFileSync(dest, buffer)
	}
	return { key: objectKey, digest, bytes: buffer.length, storage: 'local' }
}

/**
 * 读回对象的完整字节。恢复会话时要把分段拼成一个文件再写进卷，
 * 落临时文件再读回去是多余的一次磁盘往返。
 *
 * @param {string} key 对象键
 * @returns {Buffer}
 */
export function readObject(key) {
	const file = objectPath(key)
	if (!existsSync(file)) throw new Error(`对象不存在：${key}`)
	return readFileSync(file)
}

/**
 * 把对象取回本地指定路径。恢复归档时需要真实文件路径（tar 只认路径），
 * 所以这里落一份临时副本，由调用方在用完后清理。
 *
 * @param {string} key 对象键
 * @param {string} destPath 目标路径
 */
export async function materialize(key, destPath) {
	const src = objectPath(key)
	if (!existsSync(src)) throw new Error(`对象不存在：${key}`)
	mkdirSync(dirname(destPath), { recursive: true })
	await pipeline(createReadStream(src), createWriteStream(destPath))
}

/**
 * 对象元信息。
 *
 * @param {string} key 对象键
 * @returns {{bytes: number, digest: string} | null} 不存在时返回 null，不抛
 */
export function statObject(key) {
	const file = objectPath(key)
	if (!existsSync(file)) return null
	return { bytes: statSync(file).size, digest: basename(file) }
}

/** 判断对象是否存在；键残缺时按不存在处理，让调用方走降级分支。 */
export function objectExists(key) {
	try {
		return existsSync(objectPath(key))
	} catch {
		// 键残缺（老记录可能是纯文件名）时按不存在处理，让调用方走降级分支而不是崩掉
		return false
	}
}

/** 删除对象，返回是否真的删了（不存在返回 false）。 */
export function deleteObject(key) {
	const file = objectPath(key)
	if (!existsSync(file)) return false
	unlinkSync(file)
	return true
}

/**
 * 从 `listObjectFiles` 返回的落盘相对路径反推对象键。
 *
 * `objectPath` 会在倒数第二级插一个两位分片目录，所以反推就是把它去掉。
 * 单独抽出来是因为「列出对象」和「删除对象」用的键必须是同一个字符串，
 * 这里少一步就会删不到东西而看起来一切正常。
 *
 * @param {string} relPath 相对 OBJECTS_DIR 的落盘路径
 * @returns {string} 对象键
 */
export function keyFromDiskPath(relPath) {
	const parts = String(relPath || '').split('/').filter(Boolean)
	if (parts.length >= 2) parts.splice(parts.length - 2, 1)
	return parts.join('/')
}

/**
 * 列出某前缀下的对象文件（磁盘相对路径，含分片目录）。
 *
 * 返回的是**落盘结构**而不是对象键：分片目录（digest 前两位）是存储实现细节，
 * 调用方要对象键的话自己从文件名取 digest 拼。供巡检与测试统计用。
 *
 * @param {string} prefix 相对 OBJECTS_DIR 的目录，如 `archives/team-a`
 * @returns {string[]}
 */
export function listObjectFiles(prefix = '') {
	const root = resolve(OBJECTS_DIR, prefix)
	if (!existsSync(root)) return []
	const out = []
	const walk = (dir, rel) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const next = join(dir, entry.name)
			const nextRel = rel ? `${rel}/${entry.name}` : entry.name
			if (entry.isDirectory()) walk(next, nextRel)
			else out.push(prefix ? `${prefix}/${nextRel}` : nextRel)
		}
	}
	walk(root, '')
	return out
}
