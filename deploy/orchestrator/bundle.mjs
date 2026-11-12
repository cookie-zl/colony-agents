/**
 * 技能包的多文件封装：目录 ↔ tar.gz ↔ 字节。
 *
 * 这里只有「怎么把一堆文件变成一个可校验的字节流」，没有任何 IO 和权限判断——
 * 打包/解包是最容易被塞进恶意路径的一层，把它单独拎出来，才好逐条钉测试。
 *
 * 三条不变量，改代码前先确认它们还成立：
 *   1. **digest 只由文件清单算**（路径 + 内容 sha256 + 可执行位），不看 mtime、不看顺序。
 *      同一份内容在 macOS 上打一次、在 Linux 上再打一次，字节不同但 digest 必须相同。
 *   2. **写出去的 tar 是确定的**：mtime/uid/gid/uname 全部置零，只保留 exec 位。
 *      否则「内容没变但 digest 变了」会天天发生，缓存形同虚设。
 *   3. **解包只产出普通文件**。绝对路径、`..`、符号链接、硬链接、设备节点一律拒绝，
 *      不做「尽力修正」——修一半的路径就是越界写入。
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

/** 技能包里不参与分发的名字。前三个是 macOS 的垃圾，后两个是版本库与依赖。 */
const IGNORED_NAMES = new Set(['.DS_Store', '__MACOSX', '.git', 'node_modules', '.dsh-market.json'])

/** 阈值都写在一处，调用方不该各自造数。 */
export const BUNDLE_LIMITS = {
	/** 上传体积上限（压缩后）。再大就不是技能包了，是资源包。 */
	maxUpload: 32 * 1024 * 1024,
	/** 解压后总量上限，防 gzip 炸弹。 */
	maxTotal: 128 * 1024 * 1024,
	/** 文件数上限，防「一万个空文件」。 */
	maxEntries: 500,
	/** 单文件上限：技能是给模型读的，单个 8 MB 已经是异常。 */
	maxFile: 8 * 1024 * 1024,
}

/** @param {Buffer|string} data @returns {string} sha256 十六进制（按字节，不按字符串） */
export function sha256Bytes(data) {
	return createHash('sha256').update(Buffer.isBuffer(data) ? data : Buffer.from(String(data))).digest('hex')
}

/**
 * 包内文本与二进制统一成 Buffer。
 *
 * 不转字符串是有意的：`references/logo.png` 这种文件按 utf8 过一遍就废了，
 * 而技能包里带一张图完全合理。
 *
 * @param {Buffer|Uint8Array|string|null|undefined} data
 * @returns {Buffer}
 */
export function toBuffer(data) {
	if (data == null) return Buffer.alloc(0)
	if (Buffer.isBuffer(data)) return data
	if (data instanceof Uint8Array) return Buffer.from(data)
	return Buffer.from(String(data), 'utf8')
}

/**
 * 剥掉 SKILL.md 的 frontmatter。
 *
 * 库里存的是**原始字节**（含 frontmatter），因为物化到磁盘时要一字不差地写回去；
 * 只有喂给模型的 `content` 才需要剥。剥的动作集中在这里，别在插件和控制面各写一份。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripFrontmatter(text) {
	const body = String(text ?? '').replace(/^\uFEFF/, '')
	if (!body.startsWith('---')) return body
	const end = body.indexOf('\n---', 3)
	if (end === -1) return body
	const after = body.indexOf('\n', end + 4)
	return after === -1 ? '' : body.slice(after + 1).replace(/^\s*\n/, '')
}

/**
 * 从目录里读出要分发的文件。
 *
 * @param {string} root 技能目录（含 SKILL.md 的那一层）
 * @returns {Array<{path:string, data:Buffer, executable:boolean}>} 按路径排序
 */
export function walkSkillDir(root) {
	const files = []
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (IGNORED_NAMES.has(entry.name) || entry.name.startsWith('._')) continue
			const full = join(dir, entry.name)
			if (entry.isSymbolicLink()) continue
			if (entry.isDirectory()) {
				walk(full)
				continue
			}
			if (!entry.isFile()) continue
			const path = relative(root, full).split(sep).join('/')
			const stat = statSync(full)
			files.push({ path, data: readFileSync(full), executable: (stat.mode & 0o111) !== 0 })
		}
	}
	walk(root)
	return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * 内容指纹：只认清单，不认打包顺序与时间。
 *
 * @param {Array<{path:string, data:Buffer|string, executable?:boolean}>} files
 * @returns {string} sha256 十六进制
 */
export function filesDigest(files) {
	const manifest = files
		.map((f) => `${f.path}\u0000${sha256Bytes(f.data)}\u0000${f.executable ? 1 : 0}`)
		.sort()
		.join('\n')
	return sha256Bytes(manifest)
}

/**
 * @param {Array<{path:string, size:number, sha256:string, executable:boolean}>} files
 * @returns {number}
 */
export function totalSize(files) {
	return files.reduce((sum, f) => sum + f.size, 0)
}

/** 只按扩展名猜一个够用的 mime，仅用于列表展示；分发一律走 tar，不靠它。 */
export function mimeOf(path) {
	const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
	if (ext === 'md' || ext === 'markdown') return 'text/markdown; charset=utf-8'
	if (ext === 'json') return 'application/json'
	if (ext === 'yml' || ext === 'yaml') return 'application/yaml'
	if (ext === 'sh') return 'text/x-shellscript'
	if (ext === 'py') return 'text/x-python'
	if (ext === 'js' || ext === 'mjs') return 'text/javascript'
	if (ext === 'txt') return 'text/plain; charset=utf-8'
	if (ext === 'png') return 'image/png'
	if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
	if (ext === 'svg') return 'image/svg+xml'
	if (ext === 'csv') return 'text/csv; charset=utf-8'
	return 'application/octet-stream'
}

/** tar 头里 name 字段只有 100 字节；超了要拆到 prefix（155 字节）。 */
function splitName(name) {
	const bytes = Buffer.byteLength(name)
	if (bytes <= 100) return { name, prefix: '' }
	const parts = name.split('/')
	for (let i = 1; i < parts.length; i += 1) {
		const prefix = parts.slice(0, i).join('/')
		const rest = parts.slice(i).join('/')
		if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return { name: rest, prefix }
	}
	throw new Error(`包内路径过长，无法用 ustar 表示：${name}`)
}

const BLOCK = 512

function tarHeader({ name, size, mode }) {
	const buf = Buffer.alloc(BLOCK)
	const { name: rest, prefix } = splitName(name)
	buf.write(rest, 0, 100, 'utf8')
	buf.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8) // mode
	buf.write('0000000\0', 108, 8) // uid：置零是「同内容同字节」的一部分
	buf.write('0000000\0', 116, 8) // gid
	buf.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12)
	buf.write('00000000000\0', 136, 12) // mtime 置零，同理
	buf.write('        ', 148, 8) // 校验和先填空格
	buf.write('0', 156, 1) // typeflag：普通文件
	buf.write('ustar\0', 257, 6)
	buf.write('00', 263, 2)
	if (prefix) buf.write(prefix, 345, 155, 'utf8')
	let sum = 0
	for (const byte of buf) sum += byte
	buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
	return buf
}

/**
 * 打成 tar.gz。
 *
 * @param {Array<{path:string, data:Buffer|string, executable?:boolean}>} files
 * @returns {Buffer}
 */
export function buildTarGz(files) {
	const chunks = []
	for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
		const data = toBuffer(file.data)
		chunks.push(tarHeader({ name: file.path, size: data.length, mode: file.executable ? 0o755 : 0o644 }))
		chunks.push(data)
		const pad = (BLOCK - (data.length % BLOCK)) % BLOCK
		if (pad) chunks.push(Buffer.alloc(pad))
	}
	// 结尾必须是两个全零块，否则 GNU tar 会抱怨「unexpected EOF」
	chunks.push(Buffer.alloc(BLOCK * 2))
	return gzipSync(Buffer.concat(chunks), { level: 9 })
}

/**
 * 把包内路径规范化成安全的相对路径。
 *
 * @param {string} raw
 * @returns {string|null} 不安全时返回 null
 */
export function safeEntryPath(raw) {
	let path = String(raw ?? '').replace(/\\/g, '/').trim()
	if (!path || path.includes('\u0000')) return null
	if (path.startsWith('/')) return null
	if (/^[A-Za-z]:/.test(path)) return null
	while (path.startsWith('./')) path = path.slice(2)
	const parts = []
	for (const part of path.split('/')) {
		if (part === '' || part === '.') continue
		if (part === '..') return null
		parts.push(part)
	}
	return parts.length ? parts.join('/') : null
}

/** pax 扩展头（BSD tar 打长路径就写这个）里的 `path=` 记录。 */
function paxRecords(data) {
	const out = {}
	let at = 0
	while (at < data.length) {
		const space = data.indexOf(0x20, at)
		if (space === -1) break
		const len = Number(data.subarray(at, space).toString('utf8'))
		if (!Number.isFinite(len) || len <= 0) break
		const record = data.subarray(space + 1, at + len - 1).toString('utf8')
		const eq = record.indexOf('=')
		if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1)
		at += len
	}
	return out
}

/**
 * 解 tar.gz。只产出普通文件，任何无法安全解释的条目直接报错而不是跳过——
 * 跳过等于「悄悄少装一个文件」，比失败更难查。
 *
 * @param {Buffer} buffer
 * @param {{maxUpload?:number, maxTotal?:number, maxEntries?:number, maxFile?:number}} [limits]
 * @returns {Array<{path:string, data:Buffer, executable:boolean}>}
 */
export function readTarGz(buffer, limits = {}) {
	const cap = { ...BUNDLE_LIMITS, ...limits }
	if (buffer.length > cap.maxUpload) throw new Error(`包体积 ${buffer.length} 超过上限 ${cap.maxUpload}`)
	let raw
	try {
		raw = gunzipSync(buffer, { maxOutputLength: cap.maxTotal + BLOCK * 4 })
	} catch (error) {
		throw new Error(`不是合法的 tar.gz：${error.message}`)
	}

	const files = []
	let offset = 0
	let total = 0
	/** 上一个扩展头声明的长名字，作用域只有紧邻的下一个条目。 */
	let pendingName = null
	while (offset + BLOCK <= raw.length) {
		const header = raw.subarray(offset, offset + BLOCK)
		if (header.every((byte) => byte === 0)) break
		const flagByte = header[156]
		const flag = flagByte === 0 ? '0' : String.fromCharCode(flagByte)
		const size = Number.parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0
		const nameField = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
		const prefixField = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
		const bodyStart = offset + BLOCK
		const body = raw.subarray(bodyStart, bodyStart + size)
		offset = bodyStart + size + ((BLOCK - (size % BLOCK)) % BLOCK)
		if (size > cap.maxFile) throw new Error(`包内单文件 ${size} 字节超过上限 ${cap.maxFile}`)

		if (flag === 'L') {
			pendingName = body.toString('utf8').replace(/\0.*$/, '')
			continue
		}
		if (flag === 'x' || flag === 'g') {
			const records = paxRecords(body)
			if (records.path) pendingName = records.path
			continue
		}
		if (flag === '5') continue // 目录条目：结构由路径隐式表达，不落盘
		if (flag !== '0') {
			throw new Error(`包内含不支持的条目类型（typeflag=${JSON.stringify(flag)}），只接受普通文件与目录`)
		}
		const declared = pendingName ?? (prefixField ? `${prefixField}/${nameField}` : nameField)
		pendingName = null
		const path = safeEntryPath(declared)
		if (!path) throw new Error(`包内路径不安全：${JSON.stringify(declared)}`)
		if (files.length >= cap.maxEntries) throw new Error(`包内文件数超过上限 ${cap.maxEntries}`)
		total += body.length
		if (total > cap.maxTotal) throw new Error(`解压后总量超过上限 ${cap.maxTotal}`)
		const mode = Number.parseInt(header.subarray(100, 108).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0o644
		files.push({ path, data: Buffer.from(body), executable: (mode & 0o111) !== 0 })
	}

	if (!files.length) throw new Error('包里没有任何文件')
	// 允许整包套一层顶层目录（`tar czf x.tgz my-skill`），只允许一层
	const top = new Set(files.map((f) => f.path.split('/')[0]))
	const hasRootSkill = files.some((f) => f.path === 'SKILL.md')
	if (!hasRootSkill && top.size === 1) {
		const only = [...top][0]
		const stripped = files
			.filter((f) => f.path.startsWith(`${only}/`))
			.map((f) => ({ ...f, path: f.path.slice(only.length + 1) }))
		if (stripped.some((f) => f.path === 'SKILL.md')) return stripped.sort((a, b) => (a.path < b.path ? -1 : 1))
	}
	if (!hasRootSkill) throw new Error('包根目录缺少 SKILL.md')
	return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * 清单（不含内容）——进库、进列表、进 marker 都用这个形状。
 *
 * @param {Array<{path:string, data:Buffer|string, executable?:boolean}>} files
 * @returns {Array<{path:string, size:number, sha256:string, executable:boolean}>}
 */
export function fileManifest(files) {
	return files.map((f) => ({
		path: f.path,
		size: toBuffer(f.data).length,
		sha256: sha256Bytes(f.data),
		executable: Boolean(f.executable),
	}))
}
