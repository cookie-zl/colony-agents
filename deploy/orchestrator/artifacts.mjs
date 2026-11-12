/**
 * 产物归因：把容器里抄下来的「轮级变更摘要」收进库，把大块的 diff 放进对象层。
 *
 * ## 为什么是「索引在库、详情在对象层」
 * 一个团队聊 100 轮、每轮改 20 个文件，索引就有 2000 行——这适合放库、适合 SQL 查
 * 「哪个会话动过这个文件」。而逐文件的 hunks 动辄几百 KB，放进 SQLite 会让库文件
 * 涨到 GB 级、备份也变慢，且它只会被「点开某一轮」时读一次。所以：
 *
 *   session_artifacts  一行 = 一轮：文件清单（JSON）、行数合计、对象键、digest
 *   objects/artifacts/<team>/<sid>/t<turn>-<digest>.json   完整记录（含 hunks）
 *
 * ## 数据从哪来
 * `plugins/changes-collector` 在容器里把 `ctx.workspaceChanges.summary/diff` 抄成
 * `<DSH_HOME>/changes/<sid>/t<turn>.json`。这里按团队扫描目录（复用 sessions.mjs 的
 * 卷读写：容器在跑用 exec、停着用 --volumes-from、没了按卷名挂回来），
 * **收走即删本地文件**——卷只当中转站，长期副本在对象层。
 *
 * ## 幂等
 * 对象键里带内容 digest：同一轮重复同步时，行里的 detail_digest 相同就直接删本地文件，
 * 不产生第二个对象；内容真变了（同一轮又补了一条事件）才写新对象并删旧的。
 *
 * ## 为什么把 IO 抽成 store
 * 「扫目录、读文件、删文件」这三件事在 docker 上和本地目录上完全一样，只是执行方式不同。
 * 抽出来以后，`syncArtifacts` 的逻辑可以在没有 docker 的机器上被反复验证
 * （`verify-artifacts.mjs`），而不是只能靠真机跑一遍看天。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { nowIso, openDb } from './db.mjs'
import { deleteObject, putBuffer, readObject } from './objects.mjs'
import { createVolumeIo } from './sessions.mjs'

/** 卷内的 dsh 家目录；抄写目录与它同一棵树，相对路径好算。 */
const DSH_HOME = '/home/dsh/.dsh'

/** 抄写目录。与插件里的默认值必须是同一个（改一边要改另一边）。 */
export const CHANGES_ROOT = process.env.CONSOLE_CHANGES_ROOT || `${DSH_HOME}/changes`

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** 单引号包裹，内部单引号按 `'\''` 转义（路径里可能有空格或中文）。 */
const shq = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`

/**
 * 解析 `find -exec stat -c '%s %n'` 的输出。
 *
 * @param {string} text 每行 `<size> <绝对路径>`
 * @returns {Array<{bytes: number, path: string}>}
 */
export function parseChangeList(text) {
	const out = []
	for (const line of String(text || '').split('\n')) {
		const trimmed = line.trim()
		if (!trimmed) continue
		const space = trimmed.indexOf(' ')
		if (space < 0) continue
		const bytes = Number(trimmed.slice(0, space))
		const path = trimmed.slice(space + 1)
		if (!Number.isFinite(bytes) || !path) continue
		out.push({ bytes, path })
	}
	return out
}

/**
 * 从绝对路径里取出 `changes/<sid>/t<turn>.json` 三段。
 *
 * @param {string} absPath 抄写文件的绝对路径
 * @returns {{sessionId: string, file: string, turn: number} | null} 结构不符时返回 null
 */
export function splitChangePath(absPath) {
	const parts = String(absPath).split('/').filter(Boolean)
	if (parts.length < 3) return null
	const file = parts.pop()
	const sessionId = parts.pop()
	const match = file.match(/^t(\d+)\.json$/)
	if (!match) return null
	if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return null
	return { sessionId, file, turn: Number(match[1]) }
}

/**
 * 容器里的抄写目录：容器跑着用 exec、停着用 --volumes-from、容器没了按卷名挂回来。
 *
 * @param {string} team 团队 id
 * @returns {Promise<{list: Function, read: Function, remove: Function}>}
 */
export async function dockerChangeStore(team) {
	// root 指到 DSH_HOME：抄写目录在它下面，相对路径直接能用 readAll 读
	const volume = await createVolumeIo({ team, root: DSH_HOME })
	return {
		async list() {
			const text = await volume.run(
				`find ${shq(CHANGES_ROOT)} -type f -name 't*.json' -exec stat -c '%s %n' {} + 2>/dev/null || true`,
			)
			return parseChangeList(text).map((item) => item.path)
		},
		async read(absPath) {
			return volume.readAll(absPath.replace(`${DSH_HOME}/`, ''))
		},
		async remove(absPath) {
			await volume.run(`rm -f ${shq(absPath)}`)
		},
	}
}

/**
 * 本地目录版：校验脚本用，契约与 `dockerChangeStore` 完全一致。
 *
 * @param {string} dir 扮演「抄写根目录」的本地目录
 * @returns {{list: Function, read: Function, remove: Function}}
 */
export function localChangeStore(dir) {
	return {
		async list() {
			if (!existsSync(dir)) return []
			const out = []
			for (const sessionId of readdirSync(dir)) {
				const sessionDir = join(dir, sessionId)
				try {
					if (!statSync(sessionDir).isDirectory()) continue
				} catch {
					continue
				}
				for (const file of readdirSync(sessionDir)) {
					if (/^t\d+\.json$/.test(file)) out.push(join(sessionDir, file))
				}
			}
			return out
		},
		async read(absPath) {
			if (!existsSync(absPath)) return null
			return readFileSync(absPath)
		},
		async remove(absPath) {
			if (existsSync(absPath)) unlinkSync(absPath)
		},
	}
}

/**
 * 把一条记录写进库（按 team+session+turn 唯一）。
 *
 * @param {import('node:sqlite').DatabaseSync} db 连接
 * @param {object} row 行数据
 */
function upsertRow(db, row) {
	const at = nowIso()
	db.prepare(
		`INSERT INTO session_artifacts
		   (id, team_id, session_id, turn, seq, cwd, files, total, added, deleted,
		    detail_key, detail_bytes, detail_digest, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (team_id, session_id, turn) DO UPDATE SET
		   seq = excluded.seq, cwd = excluded.cwd, files = excluded.files,
		   total = excluded.total, added = excluded.added, deleted = excluded.deleted,
		   detail_key = excluded.detail_key, detail_bytes = excluded.detail_bytes,
		   detail_digest = excluded.detail_digest, updated_at = excluded.updated_at`,
	).run(
		row.id,
		row.teamId,
		row.sessionId,
		row.turn,
		row.seq,
		row.cwd,
		row.files,
		row.total,
		row.added,
		row.deleted,
		row.detailKey,
		row.detailBytes,
		row.detailDigest,
		at,
		at,
	)
}

/** 读一行已有记录（只为判 digest 是否变化）。 */
function existingRow(db, teamId, sessionId, turn) {
	return db
		.prepare('SELECT detail_key, detail_digest FROM session_artifacts WHERE team_id = ? AND session_id = ? AND turn = ?')
		.get(teamId, sessionId, turn)
}

/**
 * 同步一个团队的产物归因。
 *
 * 单个文件失败只记错误、继续处理其余文件：抄写目录里可能有一个半截文件（写到一半
 * 进程被杀），它不该让整轮同步停摆，下一轮扫描还会再来一次。
 *
 * @param {{team: string, db?: object, store?: object, keepLocal?: boolean}} options
 * @returns {Promise<{team: string, scanned: number, uploaded: number, skipped: number, failed: number, errors: string[]}>}
 */
export async function syncArtifacts({ team, db = null, store = null, keepLocal = false }) {
	const conn = db || openDb()
	const changes = store || (await dockerChangeStore(team))
	const paths = await changes.list()

	const result = { team, scanned: paths.length, uploaded: 0, skipped: 0, failed: 0, errors: [] }
	for (const path of paths) {
		const parts = splitChangePath(path)
		if (!parts) {
			result.failed += 1
			result.errors.push(`路径不符合抄写目录结构：${path}`)
			continue
		}
		try {
			const buffer = await changes.read(path)
			if (buffer === null) continue
			const record = JSON.parse(buffer.toString('utf8'))
			const turn = Number(record.turn ?? parts.turn)
			if (!Number.isInteger(turn) || turn < 1) throw new Error('缺少合法的 turn')

			const digest = sha256(buffer)
			const previous = existingRow(conn, team, parts.sessionId, turn)
			const summary = Array.isArray(record.files)
				? record.files.map((file) => ({
						path: file.path,
						display: file.display,
						action: file.action,
						added: file.added ?? 0,
						deleted: file.deleted ?? 0,
						kind: file.kind,
					}))
				: []

			if (previous?.detail_digest === digest) {
				// 内容没变：对象已经在层里，只补一次索引（可能上次库写失败）就收工
				result.skipped += 1
			} else {
				const key = `artifacts/${team}/${parts.sessionId}/t${turn}-${digest.slice(0, 12)}.json`
				await putBuffer(buffer, { key })
				upsertRow(conn, {
					id: `${team}:${parts.sessionId}:${turn}`,
					teamId: team,
					sessionId: parts.sessionId,
					turn,
					seq: Number(record.seq ?? 0),
					cwd: record.cwd ?? null,
					files: JSON.stringify(summary),
					total: Number(record.total ?? summary.length),
					added: Number(record.added ?? 0),
					deleted: Number(record.deleted ?? 0),
					detailKey: key,
					detailBytes: buffer.length,
					detailDigest: digest,
				})
				if (previous?.detail_key && previous.detail_key !== key) deleteObject(previous.detail_key)
				result.uploaded += 1
			}
		} catch (error) {
			result.failed += 1
			result.errors.push(`${path}：${error.message}`)
			continue
		}
		// 收走即删：卷里留一份等于「同一份数据两个真源」，早晚漂移
		if (!keepLocal) await changes.remove(path).catch(() => {})
	}
	return result
}

/**
 * 某会话的轮级产物清单，最新一轮在前。
 *
 * @param {object} db 连接
 * @param {{team: string, sessionId: string, limit?: number}} options
 * @returns {Array<object>} 行里带解析好的 files 数组
 */
export function artifactsFor(db, { team, sessionId, limit = 100 }) {
	const rows = db
		.prepare(
			`SELECT turn, seq, cwd, files, total, added, deleted, detail_key, detail_bytes, detail_digest, updated_at
			   FROM session_artifacts WHERE team_id = ? AND session_id = ?
			  ORDER BY turn DESC LIMIT ?`,
		)
		.all(team, sessionId, limit)
	return rows.map((row) => ({
		turn: row.turn,
		seq: row.seq,
		cwd: row.cwd,
		total: row.total,
		added: row.added,
		deleted: row.deleted,
		files: safeParse(row.files, []),
		detail: { key: row.detail_key, bytes: row.detail_bytes, digest: row.detail_digest },
		updatedAt: row.updated_at,
	}))
}

/**
 * 某一轮的完整记录（含 hunks），从对象层取。
 *
 * @param {object} db 连接
 * @param {{team: string, sessionId: string, turn: number}} options
 * @returns {object|null} 没有这一轮时返回 null
 */
export function artifactDetail(db, { team, sessionId, turn }) {
	const row = db
		.prepare('SELECT detail_key FROM session_artifacts WHERE team_id = ? AND session_id = ? AND turn = ?')
		.get(team, sessionId, turn)
	if (!row?.detail_key) return null
	return JSON.parse(readObject(row.detail_key).toString('utf8'))
}

/**
 * JSON 解析失败时给默认值：老版本写的行格式可能变过，不该让列表整页 500。
 *
 * @param {string} text JSON 文本
 * @param {*} fallback 兜底值
 */
function safeParse(text, fallback) {
	try {
		return JSON.parse(text)
	} catch {
		return fallback
	}
}
