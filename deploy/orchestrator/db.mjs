/**
 * 数据访问层：把「技能 / 连接器 / 分享 / 日志」收敛到一张 SQLite 里。
 *
 * 设计见 docs/12-数据模型.md。对外只暴露查询与写入函数，不把 SQL 散到 console.mjs 里：
 *   - console.mjs 负责 HTTP 与鉴权；
 *   - 这里负责「按团队算出它该看到什么」，保证可见性规则只有一处实现。
 *
 * 用 node:sqlite（Node 22 内置，实验性）而不是 better-sqlite3：整个控制面目前零依赖，
 * 为了一个库引入原生编译不划算。Node 官方 API 稳定后可以原地替换，调用方无感。
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { HERE } from './store.mjs'
import { findShadow, shadowMessage } from './workspace.mjs'
import { filesDigest, mimeOf, sha256Bytes, stripFrontmatter, toBuffer } from './bundle.mjs'

export const DB_PATH = resolve(process.env.DSH_DB || resolve(HERE, 'dsh.db'))
const SCHEMA = resolve(HERE, 'init-db.sql')

/** @returns {string} ISO 时间戳，精确到秒。库里所有时间列都存这个格式，方便字符串比较。 */
export function nowIso() {
	return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** @param {...(string|null|undefined)} parts @returns {string} sha256 十六进制 */
export function sha256(...parts) {
	const h = createHash('sha256')
	for (const p of parts) h.update(p == null ? '' : String(p))
	return h.digest('hex')
}

/**
 * 内容指纹：文件清单（路径 + 内容 sha256 + 可执行位）、版本、类型、config 任一变化都会变。
 * 用于判断「表里说的」和「团队卷里物化的」是否一致——所以**绝不能纳入 mtime**。
 *
 * @param {{kind:string, name:string, version:string, files?:Array<{path:string,data:Buffer|string,executable?:boolean}>, config?:string|null}} item
 * @returns {string}
 */
export function digestOf({ kind, name, version, files = [], config = '' }) {
	const manifest = files.length ? filesDigest(files) : ''
	return sha256(kind, name, version, manifest, config).slice(0, 32)
}

/** @returns {string} 主键拼法，唯一入口，别在别处手拼。 */
export function itemId(kind, name, version) {
	return `${kind}:${name}@${version}`
}

/**
 * 给已经存在的老库补列。`CREATE TABLE IF NOT EXISTS` 不会改已建好的表，
 * 所以新增列必须在这里显式 ALTER——这是最小可用的迁移机制，正式的编号迁移见 docs/12 第 10 节。
 *
 * @param {DatabaseSync} db
 */
function ensureColumns(db) {
	const cols = (table) => db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((c) => c.name)
	const add = (table, column, ddl) => {
		if (!cols(table).includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
	}
	add('ops', 'from_team', 'from_team TEXT')
	add('ops', 'to_team', 'to_team TEXT')
	// 分享原先只记 kind/name/version，靠三元组反查包——那是按名称关联。
	// 改成按 item_id 定锚后，历史行要按同样的规则回填一次（幂等，可重复跑）。
	add('shares', 'item_id', 'item_id TEXT REFERENCES market_items (id)')
	db.exec('CREATE INDEX IF NOT EXISTS idx_shares_item ON shares (item_id)')
	const backfill = db
		.prepare(
			`UPDATE shares SET item_id = (SELECT i.id FROM market_items i
			                              WHERE i.kind = shares.kind AND i.name = shares.name
			                                AND i.version = shares.version)
			  WHERE item_id IS NULL`,
		)
		.run()
	if (backfill.changes) console.log(`db: 回填 ${backfill.changes} 条分享的 item_id`)

	// 多文件包需要的列。老库的 market_item_files 只有 content/sha256，这里补齐；
	// 顺便把 content 改建为「原始字节」语义（SQLite 是动态类型，列声明不用改）。
	add('market_item_files', 'size', 'size INTEGER NOT NULL DEFAULT 0')
	add('market_item_files', 'executable', 'executable INTEGER NOT NULL DEFAULT 0')
	add('market_item_files', 'mime', "mime TEXT NOT NULL DEFAULT 'application/octet-stream'")

	// 沟通记录要能看到「思考」与 token 用量：headless 的 thinking / usage 事件原来被丢了。
	// 老库并行补列，新库由 init-db.sql 建好，两边结构保持一致。
	add('assistant_messages', 'thinking', 'thinking TEXT')
	add('assistant_messages', 'usage', 'usage TEXT')
	add('market_item_files', 'storage', "storage TEXT NOT NULL DEFAULT 'db'")
	add('market_item_files', 'object_key', 'object_key TEXT')
	migrateItemContent(db, cols)
}

/**
 * 把 `market_items.content` 一次性搬进 `market_item_files['SKILL.md']`，然后删掉这一列。
 *
 * 为什么非要删：正文留在两处，就一定会出现「表里是新版、物化出来是旧版」这种谁都说不清的状态。
 * 所以这一步必须一次做完——不能先搬后删分两次上，中间那段两种读法并存。
 *
 * 搬过去时要补一个最小 frontmatter：老库里存的是**已剥离 frontmatter** 的正文，
 * 而物化到磁盘要写原始字节。不补的话，落盘后的 SKILL.md 少了 name/description，
 * 下次从磁盘读回来就解析不出技能名。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {(table:string)=>string[]} cols
 */
function migrateItemContent(db, cols) {
	if (!cols('market_items').includes('content')) return
	const rows = db
		.prepare("SELECT id, kind, name, version, title, description, content FROM market_items WHERE content IS NOT NULL")
		.all()
	const insert = db.prepare(
		`INSERT OR REPLACE INTO market_item_files
		   (item_id, path, content, sha256, size, executable, mime, storage)
		 VALUES (?,?,?,?,?,?,?,'db')`,
	)
	for (const row of rows) {
		const body = String(row.content ?? '')
		if (!body.trim()) continue
		const text = body.startsWith('---')
			? body
			: `---\nname: ${row.name}\ndescription: ${String(row.description ?? '').replace(/\n/g, ' ')}\n---\n\n${body}`
		const data = Buffer.from(text, 'utf8')
		insert.run(row.id, 'SKILL.md', data, sha256Bytes(data), data.length, 0, mimeOf('SKILL.md'))
	}
	if (rows.length) console.log(`db: 迁移 ${rows.length} 个市场包的正文到 market_item_files`)
	db.exec('ALTER TABLE market_items DROP COLUMN content')

	// digest 的算法同时变了（正文 → 文件清单），存量必须重算，否则「digest 一致就不重下」永远不成立。
	const items = db.prepare('SELECT id, kind, name, version, config FROM market_items').all()
	const update = db.prepare('UPDATE market_items SET digest = ? WHERE id = ?')
	for (const item of items) {
		const files = db
			.prepare('SELECT path, content, executable FROM market_item_files WHERE item_id = ? ORDER BY path')
			.all(item.id)
			.map((f) => ({ path: f.path, data: toBuffer(f.content), executable: Boolean(f.executable) }))
		update.run(digestOf({ ...item, files }), item.id)
	}
}

let cached = null

/**
 * 打开（并在首次打开时建表）。同一个进程重复调用返回同一个连接。
 *
 * @param {string} [path] 覆盖库路径，测试用
 * @returns {DatabaseSync}
 */
export function openDb(path = DB_PATH) {
	if (cached) return cached
	if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
	const db = new DatabaseSync(path)
	// WAL：控制面写、账号服务读，互不阻塞。synchronous=NORMAL 在 WAL 下已足够安全。
	db.exec('PRAGMA journal_mode = WAL')
	db.exec('PRAGMA synchronous = NORMAL')
	db.exec('PRAGMA foreign_keys = ON')
	db.exec('PRAGMA busy_timeout = 5000')
	if (existsSync(SCHEMA)) db.exec(readFileSync(SCHEMA, 'utf8'))
	ensureColumns(db)
	cached = db
	return db
}

/** 仅测试用：关掉缓存连接，让下次 openDb 重新打开。 */
export function closeDb() {
	if (!cached) return
	cached.close()
	cached = null
}

/* ------------------------------ 市场 ------------------------------ */

/**
 * 市场层的名称占用规则：`(kind, name)` 先到先得，被某个团队认领后别的团队不能再占用。
 *
 * 名字唯一是**业务约束**，不是关联键——库内一律靠 `item_id` 关联（`team_skills` /
 * `team_mcps` / `shares` 都是外键）。这么定的理由有两个：
 *   1. dsh 侧一个名字只对应一个技能（`ctx.skills.get(name)`），同名并存无法解释；
 *   2. 名字的归属一旦唯一，`market_current` 就不需要 owner 列——谁发的版本就是谁的。
 *
 * @param {DatabaseSync} db
 * @param {'skill'|'mcp'} kind
 * @param {string} name
 * @param {string} team 发布者；`_system` 表示内置包，同样占名
 * @throws {Error & {status: 409}} 名字已被别的团队占用
 */
export function assertNameAvailable(db, kind, name, team) {
	const row = db
		.prepare(
			`SELECT owner_team, version FROM market_items
			  WHERE kind = ? AND name = ? AND owner_team <> ?
			  ORDER BY version LIMIT 1`,
		)
		.get(kind, name, team ?? '')
	if (!row) return
	throw Object.assign(
		new Error(
			`市场里已经有 ${row.owner_team} 发布的 ${kind}「${name}」（v${row.version}）。名字先到先得：请换个名字，或让对方把它分享给你`,
		),
		{ status: 409 },
	)
}

/**
 * 写入（或覆盖）一个市场包。id 由 kind+name+version 决定，所以重复写入是幂等的。
 *
 * 除迁移脚本（`force`）外，所有写入都过 `assertNameAvailable`：这是名称唯一性的
 * 唯一执行点，别在 publish 里另写一遍——两处校验迟早有一处被绕过。
 *
 * `owner_team` 一旦落库不再被覆盖：重发同一版本只更新内容与可见性，不改主人。
 *
 * @param {DatabaseSync} db
 * @param {{kind:'skill'|'mcp', name:string, version:string, title:string, description:string,
 *          whenToUse?:string|null, files?:Array<{path:string,data:Buffer|string,executable?:boolean}>,
 *          config?:string|null, rank?:number,
 *          visibility:'public'|'private', ownerTeam?:string, status?:'draft'|'published'|'deprecated',
 *          createdBy:string, createdAt?:string, publishedAt?:string|null, force?:boolean}} item
 * @returns {string} 写入的 item id
 */
export function upsertItem(db, item) {
	const id = itemId(item.kind, item.name, item.version)
	const digest = digestOf(item)
	const owner = item.ownerTeam ?? '_system'
	if (!item.force) assertNameAvailable(db, item.kind, item.name, owner)
	db.prepare(
		`INSERT INTO market_items
		   (id, kind, name, version, title, description, when_to_use, config, digest,
		    rank, visibility, owner_team, status, created_by, created_at, published_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		 ON CONFLICT (id) DO UPDATE SET
		   title=excluded.title, description=excluded.description, when_to_use=excluded.when_to_use,
		   config=excluded.config, digest=excluded.digest,
		   rank=excluded.rank, visibility=excluded.visibility,
		   status=excluded.status, published_at=excluded.published_at`,
	).run(
		id,
		item.kind,
		item.name,
		item.version,
		item.title,
		item.description,
		item.whenToUse ?? null,
		item.config ?? null,
		digest,
		item.rank ?? 550,
		item.visibility,
		owner,
		item.status ?? 'published',
		item.createdBy,
		item.createdAt ?? nowIso(),
		item.publishedAt ?? null,
	)
	// 文件总是整组替换而不是增量对比：删掉的旧文件必须一起消失，否则「卸掉一个
	// references 文件」在库里永远做不到。同版本重发也是这个路径。
	if (item.files) {
		db.prepare('DELETE FROM market_item_files WHERE item_id = ?').run(id)
		const insert = db.prepare(
			`INSERT INTO market_item_files
			   (item_id, path, content, sha256, size, executable, mime, storage)
			 VALUES (?,?,?,?,?,?,?,'db')`,
		)
		for (const file of item.files) {
			const data = toBuffer(file.data)
			insert.run(id, file.path, data, sha256Bytes(data), data.length, file.executable ? 1 : 0, mimeOf(file.path))
		}
	}
	return id
}

/**
 * 把某个包的「当前发布」指向指定版本。
 *
 * 只收 kind+name+version 而不是裸 item_id，是为了在**写入时**就拦住拼错的名字：
 * 拼错的 id 若能写进来，市场首页会挂一个 join 不出内容的位置，比直接报错难查得多。
 */
export function setCurrent(db, kind, name, version) {
	const id = itemId(kind, name, version)
	if (!db.prepare('SELECT 1 FROM market_items WHERE id = ?').get(id)) {
		throw Object.assign(new Error(`不能把 ${kind}「${name}」的当前版本指向 v${version}：这个版本不在市场里`), { status: 409 })
	}
	db.prepare(
		`INSERT INTO market_current (kind, name, item_id, updated_at) VALUES (?,?,?,?)
		 ON CONFLICT (kind, name) DO UPDATE SET item_id=excluded.item_id, updated_at=excluded.updated_at`,
	).run(kind, name, id, nowIso())
	return id
}

/** @returns {object|undefined} 某个包当前发布的完整行 */
export function currentItem(db, kind, name) {
	return db
		.prepare(
			`SELECT i.* FROM market_current c JOIN market_items i ON i.id = c.item_id
			  WHERE c.kind = ? AND c.name = ?`,
		)
		.get(kind, name)
}

/** @returns {object|undefined} 指定版本的完整行（不看是否 current，老版本永远可读） */
export function itemByVersion(db, kind, name, version) {
	return db.prepare('SELECT * FROM market_items WHERE id = ?').get(itemId(kind, name, version))
}

/* ------------------------------ 团队可见性 ------------------------------ */

/**
 * 一个团队「模型应该看到」的技能：只来自它自己已启用、且被市场解析得到的行。
 *
 * 这里就是 docs/12 第 4 节那条规则的唯一实现。任何调用方（HTTP、CLI、未来的推送）
 * 都必须走它，不要在别处另写一套过滤。
 *
 * @param {DatabaseSync} db
 * @param {string} team
 * @returns {Array<object>}
 */
export function visibleSkills(db, team) {
	return db
		.prepare(
			`SELECT t.name, t.version, t.enabled, i.id AS item_id, i.title, i.description,
			        i.when_to_use, i.rank, i.digest, i.visibility, i.owner_team
			   FROM team_skills t
			   JOIN market_items i ON i.id = t.item_id
			  WHERE t.team_id = ? AND t.enabled = 1
			  ORDER BY t.name`,
		)
		.all(team)
}

/** 团队已装（含未启用）的全部技能，管理界面用。 */
export function teamSkillRows(db, team) {
	return db
		.prepare(
			`SELECT t.*, i.title, i.description, i.visibility, i.owner_team
			   FROM team_skills t JOIN market_items i ON i.id = t.item_id
			  WHERE t.team_id = ? ORDER BY t.name`,
		)
		.all(team)
}

/** 团队已装（含未启用）的全部连接器。 */
export function teamMcpRows(db, team) {
	return db
		.prepare(
			`SELECT m.*, i.title, i.description, i.visibility, i.owner_team
			   FROM team_mcps m JOIN market_items i ON i.id = m.item_id
			  WHERE m.team_id = ? ORDER BY m.name`,
		)
		.all(team)
}

/**
 * 市场对某团队展现的目录：当前发布版本 + 该团队能看见的可见性。
 *
 * 只读 `market_current`，所以同一时刻每个包只出现一次；历史版本仍在 `market_items` 里，
 * 已装团队按 `item_id` 取旧版正文不受影响。
 */
export function marketCatalog(db, team) {
	return db
		.prepare(
			`SELECT i.kind, i.name, i.version, i.title, i.description, i.visibility, i.owner_team,
			        i.published_at, i.status, c.updated_at
			   FROM market_current c JOIN market_items i ON i.id = c.item_id
			  WHERE i.visibility = 'public' OR i.owner_team = ?
			  ORDER BY i.kind, i.name`,
		)
		.all(team || '')
}

/**
 * 取某个团队可见技能的正文。
 *
 * 三道校验缺一不可：团队装了 → 启用了 → 版本对得上。少了任何一条，
 * 都等于让任意团队按名字读到别的团队的私有技能。
 *
 * @returns {{name:string, version:string, content:string, item:object}|undefined}
 */
export function skillBodyForTeam(db, team, name, version) {
	const row = db
		.prepare(
			`SELECT t.version, i.* FROM team_skills t JOIN market_items i ON i.id = t.item_id
			  WHERE t.team_id = ? AND t.name = ? AND t.enabled = 1 AND t.version = ?`,
		)
		.get(team, name, version)
	if (!row) return undefined
	const file = db.prepare("SELECT content FROM market_item_files WHERE item_id = ? AND path = 'SKILL.md'").get(row.id)
	if (!file) return undefined
	return { name: row.name, version: row.version, content: stripFrontmatter(fileRowText(file)), item: row }
}

/** 库里存的是 BLOB，老行是 TEXT——两种都要能读成字符串。 */
function fileRowText(row) {
	return row?.content == null ? '' : toBuffer(row.content).toString('utf8')
}

/** @returns {Array<{path:string,size:number,sha256:string,executable:boolean,mime:string,storage:string}>} */
export function itemFiles(db, itemIdValue) {
	return db
		.prepare(
			`SELECT path, size, sha256, executable, mime, storage FROM market_item_files
			  WHERE item_id = ? ORDER BY path`,
		)
		.all(itemIdValue)
		.map((row) => ({ ...row, executable: Boolean(row.executable) }))
}

/**
 * 一批包的体积/文件数/是否多文件，一次查完。
 *
 * 市场列表页要显示「这个技能带不带脚本」，逐个包查一次就是 N+1 ——
 * 目录里 20 个包时还能忍，200 个时首页会明显变慢。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string[]} itemIds
 * @returns {Map<string,{count:number, size:number, hasBundle:boolean}>}
 */
export function bundleInfoMap(db, itemIds) {
	const out = new Map()
	if (!itemIds.length) return out
	const rows = db
		.prepare(
			`SELECT item_id, COUNT(*) AS count, COALESCE(SUM(size), 0) AS size, MAX(path = 'SKILL.md') AS hasSkill
			   FROM market_item_files
			  WHERE item_id IN (${itemIds.map(() => '?').join(',')})
			  GROUP BY item_id`,
		)
		.all(...itemIds)
	for (const row of rows) {
		out.set(row.item_id, {
			count: Number(row.count),
			size: Number(row.size),
			// 除 SKILL.md 外还有文件才叫多文件包：单个 700 字节的字符串打成 tar 只会更慢
			hasBundle: Number(row.hasSkill) === 1 && Number(row.count) > 1,
		})
	}
	return out
}

/**
 * 取出一个包的完整字节，用于现场打 tar。
 *
 * @returns {Array<{path:string,data:Buffer,executable:boolean}>|undefined}
 */
export function itemBundleFiles(db, itemIdValue) {
	const rows = db
		.prepare('SELECT path, content, executable FROM market_item_files WHERE item_id = ? ORDER BY path')
		.all(itemIdValue)
	if (!rows.length) return undefined
	return rows.map((row) => ({ path: row.path, data: toBuffer(row.content), executable: Boolean(row.executable) }))
}

/**
 * 与 `skillBodyForTeam` 同一道闸门，只是取出的是全部文件。
 *
 * 三道校验必须和读正文那条**完全一致**（装了 / 启用了 / 版本对得上），
 * 否则「正文读不到但包能下」就成了一条绕过私有可见性的旁路。
 *
 * @returns {{name:string, version:string, digest:string, files:Array<object>}|undefined}
 */
export function skillBundleForTeam(db, team, name, version) {
	const row = db
		.prepare(
			`SELECT t.version, i.id, i.digest FROM team_skills t JOIN market_items i ON i.id = t.item_id
			  WHERE t.team_id = ? AND t.name = ? AND t.enabled = 1 AND t.version = ?`,
		)
		.get(team, name, version)
	if (!row) return undefined
	const files = itemBundleFiles(db, row.id)
	if (!files) return undefined
	return { name, version: row.version, digest: row.digest, files }
}

/**
 * 可见集合的版本号：只随「装了哪个版本 / 启没启用」变化，不随正文变。
 *
 * 插件用它决定要不要让 dsh 重扫目录。用摘要而不是递增计数，是为了让多个控制面进程
 * （将来多节点）算出来的值一致。
 */
export function marketRev(db, team) {
	const rows = visibleSkills(db, team)
	return sha256(rows.map((r) => `${r.name}@${r.version}`).join('\n')).slice(0, 12)
}

/* ------------------------------ 写入 ------------------------------ */

/**
 * 判断一个包能不能挂到某个团队名下。这是**写入侧的唯一授权点**，和读侧的
 * `visibleSkills` 一起构成完整边界：读侧管「已挂的能不能读」，这里管「能不能挂」。
 *
 * 三条放行路径：
 *   1. public          —— 谁都能装
 *   2. 自己是 owner    —— 发布者装自己的包
 *   3. 有指向它的分享  —— 私有包只能经分享授权；只认记录，不认调用方传的 source 字段
 *
 * 第 3 条按 `item_id` 校验，而不是 kind+name+version：名字可能被改名或复用，
 * 授权必须钉在具体那一版上——否则同名同版本的另一个包能靠旧分享白拿授权。
 *
 * 少了这个检查，任何团队只要知道包名就能 `install` 别人的私有包并读到正文，
 * 再 `publish` 成自己的公开版——私有内容会被洗成公开内容。
 *
 * @returns {boolean}
 */
function canMount(db, item, team, shareId) {
	if (item.visibility === 'public' || item.owner_team === team) return true
	if (!shareId) return false
	return Boolean(db.prepare('SELECT 1 FROM shares WHERE id = ? AND to_team = ? AND item_id = ?').get(shareId, team, item.id))
}

/**
 * 挂载或更换版本。item_id 与 version 在同一语句里写，不存在只改一个的窗口。
 *
 * 两道前置检查，都放在这个唯一写入点上，避免某个调用方漏掉：
 *   1. `canMount()` —— 有没有资格装这个包（跨租户越权）；
 *   2. `findShadow()` —— 装上去会不会被工作区里的同名技能压住（rank 100/200 赢 550）。
 *      这一条只阻止「白装」：不拦的话表里写着启用、模型看到的是另一份，
 *      恰恰是这套方案最想消灭的「两套事实」。
 *
 * @param {object} options
 * @param {string|null} [options.workspaceDir] 团队工作区宿主路径；不传则跳过遮蔽检测
 * @param {boolean} [options.force] 明知被遮蔽也装（保留记录，实际不生效）
 * @returns {{changed:boolean, previousVersion?:string, shadow?:Array<object>}}
 */
export function mountSkill(
	db,
	{
		team,
		name,
		version,
		enabled = false,
		source = 'market',
		sourceTeam = null,
		shareId = null,
		by,
		workspaceDir = null,
		force = false,
	},
) {
	const item = itemByVersion(db, 'skill', name, version)
	if (!item) throw new Error(`市场里没有 skill「${name}@${version}」`)
	if (!canMount(db, item, team, shareId)) {
		throw Object.assign(new Error(`skill「${name}@${version}」是 ${item.owner_team} 的私有包，需要先由对方分享给你`), { status: 403 })
	}
	const shadow = findShadow(workspaceDir, name)
	if (shadow.length > 0 && !force) {
		throw Object.assign(new Error(shadowMessage(name, shadow)), { status: 409, code: 'SHADOWED', detail: { shadow } })
	}
	const before = db.prepare('SELECT version FROM team_skills WHERE team_id = ? AND name = ?').get(team, name)
	const at = nowIso()
	db.prepare(
		`INSERT INTO team_skills (team_id, name, item_id, version, enabled, source, source_team, share_id,
		                          installed_by, installed_at, enabled_by, enabled_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
		 ON CONFLICT (team_id, name) DO UPDATE SET
		   item_id=excluded.item_id, version=excluded.version, enabled=excluded.enabled,
		   source=excluded.source, source_team=excluded.source_team, share_id=excluded.share_id,
		   installed_by=excluded.installed_by, installed_at=excluded.installed_at,
		   enabled_by=excluded.enabled_by, enabled_at=excluded.enabled_at`,
	).run(
		team,
		name,
		item.id,
		version,
		enabled ? 1 : 0,
		source,
		sourceTeam,
		shareId,
		by || 'system',
		at,
		enabled ? by || 'system' : null,
		enabled ? at : null,
	)
	appendOp(db, {
		team,
		action: before ? 'upgrade' : 'install',
		kind: 'skill',
		name,
		by,
		detail: before ? `${before.version} → ${version}` : `安装 v${version}`,
		note: shadow.length > 0 ? `强制安装：被 ${shadow[0].path} 遮蔽，实际不生效` : undefined,
	})
	return {
		changed: !before || before.version !== version,
		previousVersion: before?.version,
		...(shadow.length > 0 ? { shadow } : {}),
	}
}

/**
 * 卸载：删挂载记录，不动 market_items。
 *
 * 内容留在市场里，所以「卸了再装回来」不依赖任何备份；团队回收时也一样。
 *
 * @returns {{removed: boolean, version?: string}}
 */
export function unmountSkill(db, { team, name, by }) {
	const row = db.prepare('SELECT version, source_team FROM team_skills WHERE team_id = ? AND name = ?').get(team, name)
	if (!row) return { removed: false }
	db.prepare('DELETE FROM team_skills WHERE team_id = ? AND name = ?').run(team, name)
	appendOp(db, {
		team,
		action: 'uninstall',
		kind: 'skill',
		name,
		by,
		detail: row.source_team ? `卸载分享自 ${row.source_team} 的技能` : '卸载',
	})
	return { removed: true, version: row.version }
}

/**
 * 启用 / 停用。只改标志位，不碰版本。
 *
 * 启用同样要过遮蔽检测：停用期间用户完全可能在工作区里写了个同名技能，
 * 再点启用就会变成「明明开着却不生效」。
 *
 * @returns {{enabled:boolean, shadow?:Array<object>}}
 */
export function setSkillEnabled(db, { team, name, enabled, by, workspaceDir = null, force = false }) {
	const row = db.prepare('SELECT * FROM team_skills WHERE team_id = ? AND name = ?').get(team, name)
	if (!row) throw new Error(`团队 ${team} 没装 skill「${name}」`)
	const shadow = enabled ? findShadow(workspaceDir, name) : []
	if (shadow.length > 0 && !force) {
		throw Object.assign(new Error(shadowMessage(name, shadow)), { status: 409, code: 'SHADOWED', detail: { shadow } })
	}
	db.prepare('UPDATE team_skills SET enabled = ?, enabled_by = ?, enabled_at = ? WHERE team_id = ? AND name = ?').run(
		enabled ? 1 : 0,
		enabled ? by || 'system' : null,
		enabled ? nowIso() : null,
		team,
		name,
	)
	appendOp(db, {
		team,
		action: enabled ? 'enable' : 'disable',
		kind: 'skill',
		name,
		by,
		note: shadow.length > 0 ? `强制启用：被 ${shadow[0].path} 遮蔽，实际不生效` : undefined,
	})
	return { enabled, ...(shadow.length > 0 ? { shadow } : {}) }
}

/**
 * 追加一条操作日志。
 *
 * `from` / `to` 是分享类操作的双方：只有 `team` 一列的话，「谁把这个包塞给我」只能写进
 * detail 自由文本，没法按来源团队过滤，也没法做「谁分享给我的」列表。
 *
 * 裁剪策略见 docs/12 第 10 节：这里保留 500 条是过渡行为，正式版本要改成按团队 + 时间双维度。
 */
export function appendOp(db, { team, action, kind = null, name = null, by = null, note = null, detail = null, from = null, to = null }) {
	db.prepare('INSERT INTO ops (at, team, action, kind, name, by, note, detail, from_team, to_team) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
		nowIso(),
		team,
		action,
		kind,
		name,
		by,
		note,
		detail,
		from,
		to,
	)
	db.prepare('DELETE FROM ops WHERE id IN (SELECT id FROM ops ORDER BY id DESC LIMIT -1 OFFSET 500)').run()
}

/**
 * 团队视角的操作日志：本团队被操作的 + 本团队发出/收到的分享。
 *
 * 门户原来读的是 `oplog.json`，而写入早就切到本表，于是「安装/卸载/启停」全都不在页面上——
 * 两套日志并存比没有日志更糟，因为看的人不知道少了一半。
 *
 * @param {DatabaseSync} db
 * @param {string} team
 * @param {number} [limit]
 * @returns {Array<object>}
 */
export function opsForTeam(db, team, limit = 40) {
	const rows = team
		? db
				.prepare(
					`SELECT * FROM ops WHERE team = ? OR from_team = ? OR to_team = ?
					  ORDER BY at DESC, id DESC LIMIT ?`,
				)
				.all(team, team, team, limit)
		: db.prepare('SELECT * FROM ops ORDER BY at DESC, id DESC LIMIT ?').all(limit)
	return rows.map((r) => ({
		id: r.id,
		at: r.at,
		team: r.team,
		action: r.action,
		kind: r.kind,
		name: r.name,
		by: r.by,
		note: r.note,
		detail: r.detail,
		from: r.from_team || undefined,
		to: r.to_team || undefined,
	}))
}

/**
 * 挂载或更换连接器版本。与 mountSkill 同构，区别是多两列：config_override 与 rendered_digest。
 *
 * rendered_digest 在真正写进 cordis.patch.yml 之后才会有值；为空表示「表里装了、卷里还没渲染」，
 * 这是可以自动修复的漂移，不是错误。
 */
export function mountMcp(db, { team, name, version, enabled = false, source = 'market', sourceTeam = null, shareId = null, configOverride = null, by }) {
	const item = itemByVersion(db, 'mcp', name, version)
	if (!item) throw new Error(`市场里没有 mcp「${name}@${version}」`)
	if (!canMount(db, item, team, shareId)) {
		throw Object.assign(new Error(`连接器「${name}@${version}」是 ${item.owner_team} 的私有包，需要先由对方分享给你`), { status: 403 })
	}
	const before = db.prepare('SELECT version FROM team_mcps WHERE team_id = ? AND name = ?').get(team, name)
	const at = nowIso()
	db.prepare(
		`INSERT INTO team_mcps (team_id, name, item_id, version, enabled, source, source_team, share_id,
		                        config_override, installed_by, installed_at, enabled_by, enabled_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
		 ON CONFLICT (team_id, name) DO UPDATE SET
		   item_id=excluded.item_id, version=excluded.version, enabled=excluded.enabled,
		   source=excluded.source, source_team=excluded.source_team, share_id=excluded.share_id,
		   installed_by=excluded.installed_by, installed_at=excluded.installed_at,
		   enabled_by=excluded.enabled_by, enabled_at=excluded.enabled_at`,
	).run(
		team,
		name,
		item.id,
		version,
		enabled ? 1 : 0,
		source,
		sourceTeam,
		shareId,
		configOverride,
		by || 'system',
		at,
		enabled ? by || 'system' : null,
		enabled ? at : null,
	)
	appendOp(db, {
		team,
		action: before ? 'upgrade' : 'install',
		kind: 'mcp',
		name,
		by,
		detail: before ? `${before.version} → ${version}` : `安装 v${version}`,
	})
	return { changed: !before || before.version !== version, previousVersion: before?.version }
}

/**
 * 卸载连接器：只删挂载记录。
 *
 * 顺序由调用方保证——先删卷里的渲染块、校验通过，再来这里删记录。
 * 反过来做的话，渲染失败会留下「表里没装、卷里还开着」的幽灵连接器。
 *
 * @returns {{removed: boolean, version?: string}}
 */
export function unmountMcp(db, { team, name, by }) {
	const row = db.prepare('SELECT version, source_team FROM team_mcps WHERE team_id = ? AND name = ?').get(team, name)
	if (!row) return { removed: false }
	db.prepare('DELETE FROM team_mcps WHERE team_id = ? AND name = ?').run(team, name)
	appendOp(db, {
		team,
		action: 'uninstall',
		kind: 'mcp',
		name,
		by,
		detail: row.source_team ? `卸载分享自 ${row.source_team} 的连接器` : '卸载',
	})
	return { removed: true, version: row.version }
}

/* ------------------------------ 分享流水 ------------------------------ */
/** 库里的下划线列名 → 门户/控制面一直在用的驼峰字段名。一处转换，别在调用方各写一遍。 */
function shareRecord(row) {
	if (!row) return undefined
	return {
		id: row.id,
		from: row.from_team,
		to: row.to_team,
		kind: row.kind,
		itemId: row.item_id || undefined,
		name: row.name,
		version: row.version,
		status: row.status,
		note: row.note || '',
		envKeys: row.env_keys ? JSON.parse(row.env_keys) : [],
		by: row.by,
		at: row.at,
		enabledAt: row.enabled_at || undefined,
		enabledBy: row.enabled_by || undefined,
		rejectedAt: row.rejected_at || undefined,
		rejectedBy: row.rejected_by || undefined,
	}
}

/**
 * 记一条分享。
 *
 * `item_id` 是关联键（授权按它判），`name` / `version` 是快照（展示与审计用）。
 * 手写的连接器块可能不在市场里，这时 `itemId` 为空——分享仍然成立，
 * 接收方启用时按块内容渲染，不经过 `mountMcp`。
 *
 * 不建 200 条上限的裁剪：`shares` 回答的是「这个包是谁塞进来的」，
 * 删老记录等于让这个问题过期。按团队查有索引，量级很小。
 */
export function insertShare(db, entry) {
	db.prepare(
		`INSERT INTO shares (id, from_team, to_team, kind, item_id, name, version, status, note, env_keys, by, at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		entry.id,
		entry.from,
		entry.to,
		entry.kind,
		entry.itemId ?? null,
		entry.name,
		entry.version,
		entry.status || 'pending',
		entry.note ?? null,
		entry.envKeys?.length ? JSON.stringify(entry.envKeys) : null,
		entry.by || 'console',
		nowIso(),
	)
	return getShare(db, entry.id)
}

/** 改一条分享的状态。找不到就抛错——静默成功会让门户显示「已启用」但实际没启用。 */
export function patchShare(db, id, patch) {
	const map = {
		status: 'status',
		enabledAt: 'enabled_at',
		enabledBy: 'enabled_by',
		rejectedAt: 'rejected_at',
		rejectedBy: 'rejected_by',
		note: 'note',
	}
	const sets = []
	const values = []
	for (const [key, column] of Object.entries(map)) {
		if (patch[key] === undefined) continue
		sets.push(`${column} = ?`)
		values.push(patch[key] === null ? null : String(patch[key]))
	}
	if (!sets.length) return getShare(db, id)
	const before = getShare(db, id)
	if (!before) throw new Error(`分享记录 ${id} 不存在`)
	db.prepare(`UPDATE shares SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
	return getShare(db, id)
}

/** @returns {object|undefined} 一条分享（驼峰字段） */
export function getShare(db, id) {
	return shareRecord(db.prepare('SELECT * FROM shares WHERE id = ?').get(id))
}

/**
 * 分享流水。传团队时只返回「发出 + 收到」两侧，避免门户看到无关团队的流转。
 *
 * @returns {Array<object>}
 */
export function listShares(db, team) {
	const rows = team
		? db.prepare('SELECT * FROM shares WHERE from_team = ? OR to_team = ? ORDER BY at DESC, id DESC').all(team, team)
		: db.prepare('SELECT * FROM shares ORDER BY at DESC, id DESC').all()
	return rows.map(shareRecord)
}

/* ------------------------------ 市场 token ------------------------------ */
/**
 * 取（必要时生成）某团队的市场 token。幂等：已存在就原样返回。
 *
 * token 存库而不是文件，是为了它也能被轮换：`revoked_at` 置位即失效，
 * 团队容器重启后拿到的就是新 token。
 *
 * @returns {string}
 */
export function ensureMarketToken(db, team) {
	const existing = db.prepare('SELECT token FROM market_tokens WHERE team_id = ? AND revoked_at IS NULL').get(team)
	if (existing) return existing.token
	const token = `mt_${team}_${randomBytes(18).toString('base64url')}`
	db.prepare(
		`INSERT INTO market_tokens (team_id, token, created_at) VALUES (?,?,?)
		 ON CONFLICT (team_id) DO UPDATE SET token=excluded.token, created_at=excluded.created_at, revoked_at=NULL`,
	).run(team, token, nowIso())
	return token
}

/** @returns {string|undefined} token 对应的团队；无效或已吊销返回 undefined */
export function teamOfMarketToken(db, token) {
	if (!token) return undefined
	const row = db.prepare('SELECT team_id FROM market_tokens WHERE token = ? AND revoked_at IS NULL').get(token)
	return row?.team_id
}

/* --------------------------- agent 参数 --------------------------- */

/**
 * 取某团队最新的 agent 参数（profile 用户层）。
 *
 * @param {DatabaseSync} db
 * @param {string} team
 * @returns {{team_id:string, revision:number, rows:Array<object>, digest:string, source:string, created_at:string, created_by:string|null}|undefined}
 */
export function latestAgentConfig(db, team) {
	const row = db
		.prepare('SELECT * FROM team_agent_config WHERE team_id = ? ORDER BY revision DESC LIMIT 1')
		.get(team)
	if (!row) return undefined
	return { ...row, rows: safeParse(row.rows) }
}

/**
 * 存一版 agent 参数。内容没变就不写新版本——否则每 5 分钟扫描都会多一行。
 *
 * @param {DatabaseSync} db
 * @param {{team:string, rows:Array<object>, source?:'ui'|'api'|'restore', by?:string|null}} input
 * @returns {{revision:number, digest:string, unchanged:boolean}}
 */
export function saveAgentConfig(db, { team, rows, source = 'ui', by = null }) {
	const normalized = Array.isArray(rows) ? rows : []
	const digest = sha256(JSON.stringify(normalized))
	const latest = latestAgentConfig(db, team)
	if (latest?.digest === digest) return { revision: latest.revision, digest, unchanged: true }
	const revision = (latest?.revision ?? 0) + 1
	db.prepare(
		`INSERT INTO team_agent_config (team_id, revision, rows, digest, source, created_at, created_by)
		 VALUES (?,?,?,?,?,?,?)`,
	).run(team, revision, JSON.stringify(normalized), digest, source, nowIso(), by)
	return { revision, digest, unchanged: false }
}

/**
 * 版本历史，新的在前。用于「改坏了回滚」：把某一版 rows 重新 save 一次即可（会生成新版本）。
 *
 * @param {DatabaseSync} db
 * @param {string} team
 * @param {number} [limit]
 */
export function agentConfigHistory(db, team, limit = 20) {
	return db
		.prepare('SELECT revision, digest, source, created_at, created_by FROM team_agent_config WHERE team_id = ? ORDER BY revision DESC LIMIT ?')
		.all(team, limit)
}

/** rows 是上一版写进去的 JSON，解析失败不该把整个接口打挂。 */
function safeParse(text) {
	try {
		return JSON.parse(text)
	} catch {
		return []
	}
}

/* --------------------------- 模型网关 token --------------------------- */

/**
 * 取某团队的网关 token，没有就发一枚。
 *
 * 令牌形如 `gl_<team>_<随机>`：前缀让日志里一眼能认出是哪类凭证，
 * 团队段便于排查，随机段才是安全边界。
 *
 * @param {DatabaseSync} db
 * @param {string} team
 * @returns {string}
 */
export function ensureLlmToken(db, team) {
	const existing = db.prepare('SELECT token FROM team_llm_tokens WHERE team_id = ? AND revoked_at IS NULL').get(team)
	if (existing) return existing.token
	const token = `gl_${team}_${randomBytes(18).toString('base64url')}`
	db.prepare(
		`INSERT INTO team_llm_tokens (team_id, token, created_at) VALUES (?,?,?)
		 ON CONFLICT (team_id) DO UPDATE SET token=excluded.token, created_at=excluded.created_at, revoked_at=NULL`,
	).run(team, token, nowIso())
	return token
}

/**
 * 吊销并重发。轮换时呼这一个：旧 token 当场失效，容器下次唤醒拿到新的。
 *
 * @param {DatabaseSync} db
 * @param {string} team
 * @returns {string} 新 token
 */
export function rotateLlmToken(db, team) {
	db.prepare('UPDATE team_llm_tokens SET revoked_at = ? WHERE team_id = ? AND revoked_at IS NULL').run(nowIso(), team)
	return ensureLlmToken(db, team)
}

/**
 * token 反查团队。已吊销、格式不对、查不到都返回 undefined。
 *
 * @param {DatabaseSync} db
 * @param {string} token
 * @returns {string|undefined}
 */
export function teamOfLlmToken(db, token) {
	if (!token) return undefined
	const row = db.prepare('SELECT team_id FROM team_llm_tokens WHERE token = ? AND revoked_at IS NULL').get(String(token))
	return row?.team_id
}
