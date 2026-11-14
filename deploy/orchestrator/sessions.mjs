/**
 * 会话存算分离：把卷里的 session 日志增量搬到对象层，让容器变成「可丢的缓存」。
 *
 * ## 为什么不做成 dsh 的 persistence 后端
 * `dsh-session-persistence-jsonl` 是唯一的第一方 provider，换实现要完整复刻
 * handle / append / fsync / 格式迁移语义，而且会随 dsh 升级失配。这里改成
 * 「旁路读取 + 增量上推」：dsh 一行不改，本地文件仍是它的事实来源，
 * 对象层是副本；容器丢掉后按副本重建出同样的文件，dsh 起来自然就看见历史了。
 *
 * ## 增量怎么算
 * 日志是 append-only 的（`docs/14` 与 persistence README 都确认），所以
 * **已上传的字节前缀永不改变**，增量就是 `[uploaded_bytes, size)`。
 * 每个区间存成一个独立对象：`sessions/<team>/<sid>/<offset>-<bytes>-<digest>`。
 *
 * 为什么用「区间对象」而不是「整文件覆盖」：整文件每次重传，20 MB 的会话聊 50 轮
 * 就是 GB 级流量；区间对象只在内容真变了的地方产生新对象，且天然幂等。
 *
 * ## 一个必须处理的反向变化
 * dsh 崩溃恢复时会「截掉撕裂的尾部再重写」，所以文件可能**变小**。
 * 这不是异常而是正常路径，处理方式见 syncSession：删掉越界的分段、
 * 游标回到最后一段的末尾，下次接着往上推。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deleteObject, keyFromDiskPath, listObjectFiles, putBuffer, readObject } from './objects.mjs'
import { nowIso, openDb } from './db.mjs'
import { run, runStdin } from './runtime.mjs'

/** 卷内会话根目录。与 dsh profile 里 `session-persistence-jsonl.root` 必须是同一个。 */
export const SESSION_ROOT = process.env.CONSOLE_SESSION_ROOT || '/home/dsh/.dsh/sessions'
/** 挂卷时挂到同一个位置，路径就不用做任何翻译（--volumes-from 与 -v 都按它挂）。 */
const DSH_HOME = '/home/dsh/.dsh'
/** 容器不存在（down 过）时用来挂卷的镜像。 */
const HELPER_IMAGE = process.env.CONSOLE_HELPER_IMAGE || 'colony-agents:dev'
/** 增量小于这个值就先攒着：一次 append 几十字节也建一个对象，对象数会失控。 */
export const MIN_SEGMENT_BYTES = Number(process.env.CONSOLE_SEGMENT_BYTES || 262_144)
/**
 * 会话多久没写就把尾巴强制传上去。
 *
 * 没有这条兜底，一个只聊了三五轮、尾巴一直小于阈值的会话**永远不会上传**，
 * 卷一丢就少最后一段——而「少最后一段」在 dsh 眼里就是历史被截断，没有报错。
 */
export const IDLE_FORCE_MS = Number(process.env.CONSOLE_SESSION_IDLE_FORCE_MS || 600_000)

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const pad = (n) => String(n).padStart(12, '0')

/** 单引号包裹，内部单引号按 `'\''` 转义。路径里有 `--` 和空格，必须转义。 */
const shq = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`

/**
 * 把 `find -exec stat` 的输出解析成会话清单。
 *
 * @param {string} text 每行 `<size> <mtime 秒> <绝对路径>`
 * @param {string} [root] 会话根目录，用来把绝对路径折成卷内相对路径
 * @returns {Array<{id: string, project: string, cwd: string|null, generation: number, logPath: string, bytes: number, mtimeMs: number}>}
 */
export function parseListOutput(text, root = SESSION_ROOT) {
	const bySession = new Map()
	for (const line of String(text || '').split('\n')) {
		const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/)
		if (!match) continue
		const [, size, mtime, abs] = match
		const rel = abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs
		const parts = rel.split('/')
		// <project>/<sessionId>/<file>，多一层少一层都不是我们要的文件
		if (parts.length !== 3) continue
		const [project, id, file] = parts
		const name = file.match(/^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/)
		if (!name) continue
		// `session.jsonl.zstd` 是 v0，`session.v3.jsonl.zstd` 是 v3
		const generation = name[1] ? Number(name[1]) : 0
		const prev = bySession.get(id)
		// dsh 运行时选「数字最大的规范代」，索引也只能选那一份，否则恢复出来的文件名对不上
		if (prev && prev.generation >= generation) continue
		bySession.set(id, {
			id,
			project,
			cwd: /^--.*--$/.test(project) ? project.slice(2, -2) : null,
			generation,
			logPath: rel,
			bytes: Number(size),
			mtimeMs: Number(mtime) * 1000,
		})
	}
	return [...bySession.values()]
}

/**
 * 团队的会话卷是否存在。
 *
 * 唤醒前要判断这一条：卷不存在时（新建团队、或归档时 `down -v` 删过），
 * 用 `docker run -v` 去读会**顺手把卷建出来**，而且是以 root 身份建的——
 * 之后容器里的 dsh 用户写不进去，症状是「起得来但一聊就报持久化失败」。
 *
 * @param {string} team 团队 id
 * @returns {Promise<boolean>}
 */
export async function sessionVolumeExists(team) {
	const result = await run('docker', ['volume', 'inspect', `dsh-${team}_dsh-home`], 10_000)
	return result.code === 0
}

/**
 * 基于 docker 的卷读写：容器在跑用 `exec`，停着用 `--volumes-from`，容器没了按卷名挂回来。
 *
 * 三条路径都挂在 `/home/dsh/.dsh`，所以调用方拿到的路径永远是同一套，
 * 不需要为「容器在不在」分叉。
 *
 * 起辅助容器时**必须 `--entrypoint sh`**：镜像的 ENTRYPOINT 是 tini + entrypoint.sh，
 * 直接 `docker run <image> sh -c ...` 会把 `sh -c ...` 当成给它自己的参数，
 * 结果是又拉起一个 dsh 服务端并永久挂着——表现为备份/恢复卡住不返回。
 *
 * @param {{team: string, root?: string}} options
 * @returns {Promise<{root: string, list: Function, read: Function, write: Function}>}
 */
export async function createVolumeIo({ team, root = SESSION_ROOT }) {
	const container = `dsh-${team}-dsh-1`
	const inspected = await run('docker', ['inspect', '--format', '{{.State.Running}}|{{.Config.Image}}', container], 15_000)
	let makeArgs
	if (inspected.code === 0) {
		const [running, image] = inspected.out.trim().split('|')
		if (running === 'true') {
			// 跑着的容器直接 exec：不用再起一个容器，也避免两个进程同时写同一个卷
			// `-i` 是必须的：没有它 stdin 是关的，`cat > 文件` 会「成功」但写出 0 字节
			makeArgs = (cmd) => ['docker', ['exec', '-i', container, 'sh', '-c', cmd]]
		} else {
			makeArgs = (cmd) => [
				'docker',
				['run', '--rm', '-i', '--entrypoint', 'sh', '--volumes-from', container, image || HELPER_IMAGE, '-c', cmd],
			]
		}
	} else {
		// down 过：容器没了但卷还在。按卷名挂回来，路径保持一致
		makeArgs = (cmd) => [
			'docker',
			['run', '--rm', '-i', '--entrypoint', 'sh', '-v', `dsh-${team}_dsh-home:${DSH_HOME}`, HELPER_IMAGE, '-c', cmd],
		]
	}

	const exec = async (cmd, input = Buffer.alloc(0)) => {
		const [bin, args] = makeArgs(cmd)
		return runStdin(bin, args, input, 120_000)
	}

	return {
		root,
		async list() {
			// stat -c 在 Debian 与 busybox 上都有；-printf 是 GNU 独有，不能用
			const cmd = `find ${shq(root)} -type f \\( -name 'session*.jsonl' -o -name 'session*.jsonl.zstd' \\) -exec stat -c '%s %Y %n' {} + 2>/dev/null`
			const result = await exec(cmd)
			// find 在没有会话目录时返回 1，这是正常的空集，不是失败
			if (result.code !== 0 && result.buffer.length === 0) return ''
			return result.buffer.toString('utf8')
		},
		async read(relPath, from, to) {
			const abs = join(root, relPath)
			const want = to - from
			// tail -c +N 是 1 基偏移；区间读避免把整个日志读进内存
			const result = await exec(`tail -c +${from + 1} ${shq(abs)} | head -c ${want}`)
			if (result.code !== 0) throw new Error(`读会话区间失败 ${relPath}[${from},${to})：${result.out.slice(-300)}`)
			if (result.buffer.length !== want) throw new Error(`读会话区间长度不符 ${relPath}[${from},${to})：期望 ${want} 实得 ${result.buffer.length}`)
			return result.buffer
		},
		/**
		 * 整文件读，文件不存在返回 null。
		 *
		 * 有小文件（agent 配置、workspace 索引）不值得为它单开一套 IO；`read` 需要精确
		 * 的字节区间，用在「不知道多大」的文件上会抛错，所以单独给一个。
		 *
		 * @param {string} relPath 相对 root 的路径
		 * @returns {Promise<Buffer|null>}
		 */
		async readAll(relPath) {
			const abs = join(root, relPath)
			const result = await exec(`if [ -f ${shq(abs)} ]; then cat ${shq(abs)}; else exit 3; fi`)
			if (result.code === 3) return null
			if (result.code !== 0) throw new Error(`读文件失败 ${relPath}：${result.out.slice(-300)}`)
			return result.buffer
		},
		/**
		 * 在卷旁边跑一条命令（容器跑着用 exec，停着用 --volumes-from）。
		 *
		 * 只给「需要用容器里的运行时算一点东西」的场景用——比如让容器里的 node + yaml
		 * 把 profile patch 解析成用户层。会话同步本身的逻辑不要搬进来。
		 *
		 * @param {string} command
		 * @returns {Promise<string>} 命令输出
		 */
		async run(command) {
			const result = await exec(command)
			if (result.code !== 0) throw new Error(`卷内命令失败（${result.code}）：${result.out.slice(-300)}`)
			return result.buffer.toString('utf8')
		},
		async write(relPath, buffer) {
			const abs = join(root, relPath)
			// 写完顺手 stat 一次：`cat > f` 在没有 stdin 的情况下也会「成功」，
			// 只靠退出码会得到一个 0 字节的会话文件，而 dsh 只会说它解不开
			const result = await exec(`mkdir -p ${shq(dirname(abs))} && cat > ${shq(abs)} && stat -c %s ${shq(abs)}`, buffer)
			if (result.code !== 0) throw new Error(`写会话文件失败 ${relPath}：${result.out.slice(-300)}`)
			const written = Number(result.buffer.toString('utf8').trim())
			if (written !== buffer.length) throw new Error(`写会话文件字节数不符 ${relPath}：期望 ${buffer.length} 实得 ${written}`)
			return written
		},
	}
}

/**
 * 本地目录版 IO。契约与 createVolumeIo 完全一致，供校验脚本使用——
 * 让「增量/收缩/恢复」这些逻辑能在没有 docker 的机器上被反复验证。
 *
 * @param {string} dir 扮演会话根目录的本地目录
 */
export function createLocalIo(dir) {
	const abs = (rel) => join(dir, rel)
	return {
		root: dir,
		async list() {
			if (!existsSync(dir)) return ''
			const lines = []
			const walk = (current, rel) => {
				for (const entry of readdirSync(current, { withFileTypes: true })) {
					const next = join(current, entry.name)
					const nextRel = rel ? `${rel}/${entry.name}` : entry.name
					if (entry.isDirectory()) walk(next, nextRel)
					else if (/^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(entry.name)) {
						const st = statSync(next)
						lines.push(`${st.size} ${Math.floor(st.mtimeMs / 1000)} ${next}`)
					}
				}
			}
			walk(dir, '')
			return lines.join('\n')
		},
		async read(relPath, from, to) {
			const buffer = readFileSync(abs(relPath))
			const slice = buffer.subarray(from, to)
			if (slice.length !== to - from) throw new Error(`读会话区间长度不符 ${relPath}[${from},${to})`)
			return Buffer.from(slice)
		},
		async write(relPath, buffer) {
			mkdirSync(dirname(abs(relPath)), { recursive: true })
			writeFileSync(abs(relPath), buffer)
		},
	}
}

/**
 * 某会话已上传的分段，按 offset 升序。
 *
 * @param {string} team 团队 id
 * @param {string} sessionId 会话目录名
 * @returns {Array<{offset: number, bytes: number, digest: string, key: string}>}
 */
export function listSegments(team, sessionId) {
	const prefix = `sessions/${team}/${sessionId}`
	const out = []
	for (const rel of listObjectFiles(prefix)) {
		const name = rel.split('/').pop()
		const match = name.match(/^(\d{12})-(\d+)-([0-9a-f]{64})$/)
		if (!match) continue
		out.push({ offset: Number(match[1]), bytes: Number(match[2]), digest: match[3], key: keyFromDiskPath(rel) })
	}
	return out.sort((a, b) => a.offset - b.offset)
}

/** 清单摘要：各分段 sha256 按顺序再取一次 sha256。不读日志内容就能判断「清单有没有变」。 */
function manifestDigest(segments) {
	return sha256(segments.map((s) => s.digest).join(''))
}

/**
 * 把清单写进索引表（会话索引表 team_sessions）。已存在的行只更新可变字段，
 * `created_at` 保持第一次看见它的时间。
 */
function upsertIndex(db, team, entry) {
	const at = nowIso()
	db.prepare(
		`INSERT INTO team_sessions (id, team_id, project, cwd, generation, log_path, log_bytes, last_active_at, created_at, updated_at, missing_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
		 ON CONFLICT (id) DO UPDATE SET
		   project = excluded.project, cwd = excluded.cwd, generation = excluded.generation,
		   log_path = excluded.log_path, log_bytes = excluded.log_bytes,
		   last_active_at = excluded.last_active_at, updated_at = excluded.updated_at, missing_at = NULL`,
	).run(
		entry.id,
		team,
		entry.project,
		entry.cwd,
		entry.generation,
		entry.logPath,
		entry.bytes,
		new Date(entry.mtimeMs || Date.now()).toISOString(),
		at,
		at,
	)
}

/** 卷里已经见不到的会话打标记，记录本身留着（内容还在对象层，恢复后能重新出现）。 */
function markMissing(db, team, aliveIds) {
	const rows = db.prepare('SELECT id FROM team_sessions WHERE team_id = ? AND missing_at IS NULL').all(team)
	const alive = new Set(aliveIds)
	const at = nowIso()
	for (const row of rows) {
		if (alive.has(row.id)) continue
		db.prepare('UPDATE team_sessions SET missing_at = ?, updated_at = ? WHERE id = ?').run(at, at, row.id)
	}
}

/**
 * 同步一个会话：先自愈收缩，再推增量，最后回写游标。
 *
 * @returns {Promise<{id: string, uploaded: number, added: number, dropped: number, skipped?: string}>}
 */
export async function syncSession({ db, team, entry, io, force = false, minSegmentBytes = MIN_SEGMENT_BYTES }) {
	upsertIndex(db, team, entry)
	const prefix = `sessions/${team}/${entry.id}`

	// ① 收缩自愈：dsh 崩溃恢复会截掉撕裂尾部再重写，文件变小是正常路径。
	//    已上传的前缀不会变，所以只要删掉越界的分段，游标回退到最后一段末尾即可。
	let kept = []
	let dropped = 0
	for (const segment of listSegments(team, entry.id)) {
		if (segment.offset + segment.bytes > entry.bytes) {
			deleteObject(segment.key)
			dropped += 1
			continue
		}
		kept.push(segment)
	}
	kept.sort((a, b) => a.offset - b.offset)
	// 游标（session_sync.uploaded_bytes）不算事实来源：对象层里到底有什么才是。
	// 这样对象被外部清掉、或上一次写到一半崩了，都能自愈。
	let uploaded = kept.length ? kept[kept.length - 1].offset + kept[kept.length - 1].bytes : 0

	// ② 增量上传：太小的尾巴先攒着，否则每来一次 append 就多一个对象
	const delta = entry.bytes - uploaded
	let added = 0
	if (delta > 0 && (force || delta >= minSegmentBytes)) {
		const buffer = await io.read(entry.logPath, uploaded, entry.bytes)
		const digest = sha256(buffer)
		const key = `${prefix}/${pad(uploaded)}-${buffer.length}-${digest}`
		await putBuffer(buffer, { key })
		kept.push({ offset: uploaded, bytes: buffer.length, digest, key })
		uploaded = entry.bytes
		added = buffer.length
	}

	// ③ 回写：索引表的字节数与清单摘要、进度表的游标
	const at = nowIso()
	db.prepare('UPDATE team_sessions SET log_bytes = ?, digest = ?, updated_at = ? WHERE id = ?').run(entry.bytes, manifestDigest(kept), at, entry.id)
	db.prepare(
		`INSERT INTO session_sync (session_id, team_id, uploaded_bytes, segment_count, synced_at, status, error)
		 VALUES (?, ?, ?, ?, ?, 'idle', NULL)
		 ON CONFLICT (session_id) DO UPDATE SET
		   uploaded_bytes = excluded.uploaded_bytes, segment_count = excluded.segment_count,
		   synced_at = excluded.synced_at, status = 'idle', error = NULL`,
	).run(entry.id, team, uploaded, kept.length, at)

	return { id: entry.id, uploaded, added, dropped, segments: kept.length, pending: entry.bytes - uploaded }
}

/**
 * 同步一个团队的全部会话。
 *
 * 单个会话失败不中断整轮：一个坏文件不该让其他会话永远上不去，
 * 失败原因写进 results 由调用方决定怎么告警。
 *
 * @param {{team: string, io?: object, force?: boolean, db?: object, minSegmentBytes?: number, idleForceMs?: number}} options
 */
export async function syncTeam({ team, io = null, force = false, db = null, minSegmentBytes = MIN_SEGMENT_BYTES, idleForceMs = IDLE_FORCE_MS }) {
	// openDb 是进程级单例，这里**不能**在结束时 close：控制面其他地方（市场、日志）
	// 还拿着同一个连接，关掉会让它们的 prepared statement 全部失效。
	const conn = db || openDb()
	const volume = io || (await createVolumeIo({ team }))
	const entries = parseListOutput(await volume.list(), volume.root)
	const results = []
	for (const entry of entries) {
		// 闲置会话即使尾巴很小也必须上传：否则「最后一小段」永远不在对象层
		const idle = idleForceMs > 0 && Date.now() - entry.mtimeMs >= idleForceMs
		try {
			results.push(await syncSession({ db: conn, team, entry, io: volume, force: force || idle, minSegmentBytes }))
		} catch (error) {
			results.push({ id: entry.id, error: error.message })
		}
	}
	markMissing(conn, team, entries.map((e) => e.id))
	return {
		team,
		sessions: entries.length,
		uploadedBytes: results.reduce((sum, r) => sum + (r.added || 0), 0),
		failed: results.filter((r) => r.error).length,
		results,
	}
}

/**
 * 按对象层重建一个会话的本地文件。
 *
 * 三段校验缺一不可：偏移必须连续（否则拼出来的文件是错位的）、
 * 每段长度必须等于声明值、每段摘要必须对得上。少一段就是静默的坏文件，
 * 而 dsh 拿到坏文件只会「解不开」，不会告诉你少了哪一段。
 */
export async function restoreSession({ team, row, io }) {
	const segments = listSegments(team, row.id)
	if (!segments.length) return { id: row.id, skipped: 'no-objects' }
	let cursor = 0
	const parts = []
	for (const segment of segments) {
		if (segment.offset !== cursor) throw new Error(`分段不连续：期望偏移 ${cursor}，实际 ${segment.offset}（${row.id}）`)
		const buffer = readObject(segment.key)
		if (buffer.length !== segment.bytes) throw new Error(`分段长度不符 ${segment.key}`)
		if (sha256(buffer) !== segment.digest) throw new Error(`分段校验失败 ${segment.key}`)
		parts.push(buffer)
		cursor += segment.bytes
	}
	const all = Buffer.concat(parts)
	await io.write(row.log_path, all)
	return { id: row.id, bytes: all.length, segments: segments.length }
}

/**
 * 把卷里缺的会话从对象层补齐。容器可以被销毁，靠的就是这一步。
 *
 * `force` 只用于校验脚本与人工修复：正常唤醒时绝不覆盖卷里已有的文件——
 * 那个文件可能比对象层里的新（上次同步之后又聊了几句）。
 *
 * @param {{team: string, io?: object, force?: boolean, db?: object, only?: string}} options
 */
export async function restoreTeam({ team, io = null, force = false, db = null, only = null }) {
	const conn = db || openDb()
	const volume = io || (await createVolumeIo({ team }))
	const entries = parseListOutput(await volume.list(), volume.root)
	const present = new Set(entries.map((e) => e.logPath))
	const rows = conn.prepare('SELECT * FROM team_sessions WHERE team_id = ?').all(team)
	const restored = []
	const skipped = []
	for (const row of rows) {
		if (only && row.id !== only) continue
		if (!force && present.has(row.log_path)) {
			skipped.push(row.id)
			continue
		}
		try {
			restored.push(await restoreSession({ team, row, io: volume }))
			// 重建成功就把 missing 标记清掉：它已经回到卷里了
			conn.prepare('UPDATE team_sessions SET missing_at = NULL, updated_at = ? WHERE id = ?').run(nowIso(), row.id)
		} catch (error) {
			restored.push({ id: row.id, error: error.message })
		}
	}
	return { team, restored, skipped: skipped.length, failed: restored.filter((r) => r.error).length }
}

/** 侧栏列表：一次查询就是全部，不碰卷。 */
export function listTeamSessions(db, team, limit = 200) {
	return db
		.prepare(
			`SELECT s.id, s.project, s.cwd, s.log_path, s.log_bytes, s.last_active_at, s.missing_at, s.digest,
			        y.uploaded_bytes, y.segment_count, y.synced_at, y.status
			 FROM team_sessions s LEFT JOIN session_sync y ON y.session_id = s.id
			 WHERE s.team_id = ?
			 ORDER BY COALESCE(s.last_active_at, s.updated_at) DESC
			 LIMIT ?`,
		)
		.all(team, limit)
}
