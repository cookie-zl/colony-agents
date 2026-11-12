/**
 * 团队密钥的信封加密与读写。
 *
 * 为什么要有这一层：`team-secrets.json` 是明文 JSON，密钥直接躺在宿主文件里；
 * 而把密钥注入容器（env 或 .credentials.yaml）无论怎么存，agent 与 dsh 同 uid，
 * 一定能从 `/proc/<pid>/environ` 或文件里读到。所以真正的边界不是「文件权限」，
 * 而是「密钥有没有进容器」——那份由 llm-gateway.mjs 负责，这里只解决「平台侧怎么放」。
 *
 * 用 AES-256-GCM 而不是纯加密：GCM 自带完整性校验，密文被改过（换团队、换 key 名）
 * 解密会直接失败，不会静默解出一段错的字符串。
 *
 * 主密钥（KEK）默认在本机 `secret.key`（0600）。它必须和密文分开保管：
 * 备份 `dsh.db` 时不带 KEK，泄漏面才只有一份。
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { HERE } from './store.mjs'

/** 主密钥文件。轮换它等于让所有已存密文作废，所以单独可配、单独备份。 */
export const KEK_PATH = resolve(process.env.DSH_KEK_PATH || resolve(HERE, 'secret.key'))

const VERSION = 0x01
const IV_BYTES = 12
const TAG_BYTES = 16

let kekCache = null

/**
 * 取主密钥，不存在就生成。首次生成后立刻 chmod 600——先写文件再 chmod 会有窗口期。
 *
 * @returns {Buffer} 32 字节
 */
export function kek() {
	if (kekCache) return kekCache
	if (existsSync(KEK_PATH)) {
		const raw = readFileSync(KEK_PATH)
		if (raw.length !== 32) throw new Error(`主密钥必须是 32 字节，实际 ${raw.length}（${KEK_PATH}）`)
		kekCache = raw
		return kekCache
	}
	mkdirSync(dirname(KEK_PATH), { recursive: true, mode: 0o700 })
	const fresh = randomBytes(32)
	writeFileSync(KEK_PATH, fresh, { mode: 0o600 })
	try {
		chmodSync(KEK_PATH, 0o600)
	} catch {
		/* 某些文件系统不支持，写入时的 mode 已经足够 */
	}
	console.log(`console: 生成了新的主密钥 ${KEK_PATH}（请单独备份，丢了所有团队密钥都要重配）`)
	kekCache = fresh
	return kekCache
}

/**
 * 把一段明文封成可入库的密文。
 *
 * AAD 绑定 `team:scope:key`：把 A 团队的密文复制到 B 团队、或改 key 名，解密都会失败，
 * 防止「换个 team_id 就复用了别人的密钥」。
 *
 * @param {string} plaintext
 * @param {string} aad
 * @returns {Buffer} 版本(1) + IV(12) + tag(16) + 密文
 */
export function seal(plaintext, aad) {
	const iv = randomBytes(IV_BYTES)
	const cipher = createCipheriv('aes-256-gcm', kek(), iv)
	cipher.setAAD(Buffer.from(aad, 'utf8'))
	const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
	return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body])
}

/**
 * 解开 seal() 的产物。密文被篡改或 AAD 不匹配时抛错，不返回残缺明文。
 *
 * @param {Buffer|Uint8Array} blob
 * @param {string} aad
 * @returns {string}
 */
export function open(blob, aad) {
	const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
	if (buf.length < 1 + IV_BYTES + TAG_BYTES) throw new Error('密文长度不足，文件被截断了')
	if (buf[0] !== VERSION) throw new Error(`不认识的密文版本 0x${buf[0].toString(16)}`)
	const iv = buf.subarray(1, 1 + IV_BYTES)
	const tag = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES)
	const body = buf.subarray(1 + IV_BYTES + TAG_BYTES)
	const decipher = createDecipheriv('aes-256-gcm', kek(), iv)
	decipher.setAAD(Buffer.from(aad, 'utf8'))
	decipher.setAuthTag(tag)
	return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}

/** AAD 的唯一来源，加密与解密必须用同一个，改这里等于让旧密文全部失效。 */
function aadOf(team, scope, key) {
	return `${team}\u0000${scope}\u0000${key}`
}

/**
 * 写一条团队密钥。同 (team, scope, key) 覆盖，并刷新时间戳。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{team:string, scope:string, key:string, value:string}} input
 */
export function putSecret(db, { team, scope, key, value }) {
	const id = `${team}:${scope}:${key}`
	db.prepare(
		`INSERT INTO team_secrets (id, team_id, scope, key, ciphertext, updated_at)
		 VALUES (?,?,?,?,?,?)
		 ON CONFLICT (team_id, scope, key) DO UPDATE
		   SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
	).run(id, team, scope, key, seal(value, aadOf(team, scope, key)), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))
}

/**
 * 取一条团队密钥的明文。没有返回 undefined。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{team:string, scope:string, key:string}} input
 * @returns {string|undefined}
 */
export function getSecret(db, { team, scope, key }) {
	const row = db.prepare('SELECT ciphertext FROM team_secrets WHERE team_id = ? AND scope = ? AND key = ?').get(team, scope, key)
	if (!row) return undefined
	return open(row.ciphertext, aadOf(team, scope, key))
}

/**
 * 列出某团队配了哪些密钥。**只回名字和时间，永不回值**——这个结果会进管理接口。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} team
 * @returns {Array<{scope:string, key:string, updated_at:string}>}
 */
export function listSecrets(db, team) {
	return db
		.prepare('SELECT scope, key, updated_at FROM team_secrets WHERE team_id = ? ORDER BY scope, key')
		.all(team)
		.map((row) => ({ ...row }))
}

/**
 * 删一条团队密钥。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{team:string, scope:string, key:string}} input
 * @returns {boolean} 是否真的删掉了一行
 */
export function deleteSecret(db, { team, scope, key }) {
	return db.prepare('DELETE FROM team_secrets WHERE team_id = ? AND scope = ? AND key = ?').run(team, scope, key).changes > 0
}

/**
 * 等长比较，避免用 `===` 比 token 时泄漏长度与前缀。
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeEqual(a, b) {
	const left = Buffer.from(String(a ?? ''), 'utf8')
	const right = Buffer.from(String(b ?? ''), 'utf8')
	if (left.length !== right.length) return false
	return timingSafeEqual(left, right)
}
