/**
 * 把现有的 JSON / 目录结构灌进 SQLite。
 *
 * 设计见 docs/12-数据模型.md 第 7 节。这一步**只读**旧文件，不修改它们，
 * 所以灌错了直接删库重跑即可，不会伤到现有部署。
 *
 *   node deploy/orchestrator/migrate-db.mjs             # 灌数据并打印对账摘要
 *   node deploy/orchestrator/migrate-db.mjs --reset     # 先删库再灌（本地反复验证用）
 *   node deploy/orchestrator/migrate-db.mjs --show-tokens
 *
 * 无法迁移的引用（比如团队装了一个市场里已经没有的历史版本）会被列出来并跳过，
 * 不做任何猜测性补全——补一个假条目比少一行更糟。
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { ACCOUNTS, HERE, REPO } from './store.mjs'
import { DB_PATH, appendOp, closeDb, ensureMarketToken, itemId, nowIso, openDb, sha256, setCurrent, upsertItem } from './db.mjs'
import { walkSkillDir } from './bundle.mjs'

const MARKET = resolveMarket()
const args = new Set(process.argv.slice(2))

function resolveMarket() {
	const dir = join(REPO, 'deploy/market')
	if (!existsSync(join(dir, 'index.json'))) throw new Error(`找不到市场索引：${dir}/index.json`)
	return dir
}

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback)

/**
 * 解析 SKILL.md 的 frontmatter。只认 `key: value` 这种平铺写法——市场里的技能都是这个格式，
 * 引 yaml 依赖只为这点事不值得。遇到不认识的写法就当普通正文，不影响导入。
 */
function parseSkillMd(text) {
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
	if (!m) return { meta: {}, body: text }
	const meta = {}
	for (const line of m[1].split(/\r?\n/)) {
		const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
		if (!kv) continue
		meta[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '').trim()
	}
	return { meta, body: text.slice(m[0].length) }
}

/** 团队侧记录的 `from` 字段 → (source, sourceTeam)。 */
function sourceOf(from) {
	if (typeof from !== 'string') return { source: 'market', sourceTeam: null }
	if (from.startsWith('share:')) return { source: 'share', sourceTeam: from.slice(6) }
	if (from === 'manual') return { source: 'manual', sourceTeam: null }
	return { source: 'market', sourceTeam: null }
}

function main() {
	if (args.has('--reset')) {
		for (const suffix of ['', '-wal', '-shm']) {
			const f = `${DB_PATH}${suffix}`
			if (existsSync(f)) unlinkSync(f)
		}
		console.log(`已删除旧库：${DB_PATH}`)
	}

	const db = openDb()
	const index = readJson(join(MARKET, 'index.json'), { items: [] })
	const packages = readJson(join(HERE, 'packages.json'), { teams: {} })
	const sharesFile = readJson(join(HERE, 'shares.json'), { shares: [] })
	const oplogFile = readJson(join(HERE, 'oplog.json'), { ops: [] })
	const accounts = readJson(ACCOUNTS, { teams: {} })

	/* ---------- 1. 市场 ---------- */
	const known = new Map() // `${kind}:${name}@${version}` → 行
	let imported = 0
	for (const item of index.items) {
		const kind = item.kind
		const name = item.name
		const version = item.version
		let files = null
		let config = null
		let whenToUse = null

		if (kind === 'skill') {
			const dir = join(MARKET, 'packages/skills', name)
			const md = join(dir, 'SKILL.md')
			if (!existsSync(md)) {
				console.warn(`  跳过 ${kind}:${name}@${version}：找不到 ${md}`)
				continue
			}
			const parsed = parseSkillMd(readFileSync(md, 'utf8'))
			// 整目录搬：旧索引里也可能有带 references/ 的包，只搬 SKILL.md 等于静默丢文件
			files = walkSkillDir(dir)
			whenToUse = parsed.meta.whenToUse || parsed.meta.when_to_use || null
		} else {
			const pkg = join(MARKET, 'packages/mcp', `${name}.json`)
			if (!existsSync(pkg)) {
				console.warn(`  跳过 ${kind}:${name}@${version}：找不到 ${pkg}`)
				continue
			}
			const json = readJson(pkg, {})
			config = JSON.stringify({ spec: json.spec || null, env: json.env || [] })
		}

		const id = upsertItem(db, {
			kind,
			name,
			version,
			title: item.title || name,
			description: item.desc || item.description || '',
			whenToUse,
			files,
			config,
			visibility: item.visibility === 'private' ? 'private' : 'public',
			ownerTeam: item.owner === 'system' ? '_system' : item.owner || '_system',
			status: 'published',
			createdBy: item.owner || '_system',
			createdAt: item.publishedAt || nowIso(),
			publishedAt: item.publishedAt || nowIso(),
			// 迁移是权威数据，跳过「名字先到先得」——历史归属以原台账为准，
			// 冲突留给迁移后的对账暴露，而不是在这里把数据丢掉。
			force: true,
		})
		setCurrent(db, kind, name, version)
		known.set(id, true)
		imported += 1
	}
	console.log(`市场：导入 ${imported} 个包（技能 ${index.items.filter((i) => i.kind === 'skill').length} / 连接器 ${index.items.filter((i) => i.kind === 'mcp').length}）`)

	/* ---------- 2. 团队挂载 ---------- */
	const missing = []
	let skillRows = 0
	let mcpRows = 0
	for (const [team, ledger] of Object.entries(packages.teams || {})) {
		for (const [name, rec] of Object.entries(ledger.skills || {})) {
			const id = itemId('skill', name, rec.version)
			if (!known.has(id)) {
				missing.push({ team, kind: 'skill', name, version: rec.version })
				continue
			}
			const { source, sourceTeam } = sourceOf(rec.from)
			db.prepare(
				`INSERT INTO team_skills (team_id, name, item_id, version, enabled, source, source_team,
				                          installed_by, installed_at, enabled_by, enabled_at)
				 VALUES (?,?,?,?,1,?,?,?,?,?,?)
				 ON CONFLICT (team_id, name) DO UPDATE SET
				   item_id=excluded.item_id, version=excluded.version, enabled=1,
				   source=excluded.source, source_team=excluded.source_team`,
			).run(team, name, id, rec.version, source, sourceTeam, sourceTeam ? `share:${sourceTeam}` : 'migrate', rec.at || nowIso(), sourceTeam ? `share:${sourceTeam}` : 'migrate', rec.at || nowIso())
			skillRows += 1
		}
		for (const [name, rec] of Object.entries(ledger.mcp || {})) {
			const id = itemId('mcp', name, rec.version)
			if (!known.has(id)) {
				missing.push({ team, kind: 'mcp', name, version: rec.version })
				continue
			}
			const { source, sourceTeam } = sourceOf(rec.from)
			db.prepare(
				`INSERT INTO team_mcps (team_id, name, item_id, version, enabled, source, source_team,
				                        installed_by, installed_at, enabled_by, enabled_at)
				 VALUES (?,?,?,?,1,?,?,?,?,?,?)
				 ON CONFLICT (team_id, name) DO UPDATE SET
				   item_id=excluded.item_id, version=excluded.version, enabled=1,
				   source=excluded.source, source_team=excluded.source_team`,
			).run(team, name, id, rec.version, source, sourceTeam, sourceTeam ? `share:${sourceTeam}` : 'migrate', rec.at || nowIso(), sourceTeam ? `share:${sourceTeam}` : 'migrate', rec.at || nowIso())
			mcpRows += 1
		}
	}
	console.log(`团队挂载：技能 ${skillRows} 行 / 连接器 ${mcpRows} 行`)

	/* ---------- 3. 分享 ---------- */
	let shareRows = 0
	let sharesWithoutItem = 0
	for (const s of sharesFile.shares || []) {
		// item_id 是授权判断的依据；手写的连接器块不在市场里，留空而不是伪造一个 id
		const shareItemId = known.has(itemId(s.kind, s.name, s.version)) ? itemId(s.kind, s.name, s.version) : null
		if (!shareItemId) sharesWithoutItem += 1
		db.prepare(
			`INSERT INTO shares (id, from_team, to_team, kind, item_id, name, version, status, note, env_keys, by, at,
			                     enabled_at, enabled_by, rejected_at, rejected_by)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
			 ON CONFLICT (id) DO NOTHING`,
		).run(
			s.id,
			s.from,
			s.to,
			s.kind,
			shareItemId,
			s.name,
			s.version,
			s.status || 'enabled', // 老记录没有 status，当时的语义就是「已生效」
			s.note || null,
			JSON.stringify(s.envKeys || []),
			s.by || 'unknown',
			s.at || nowIso(),
			s.enabledAt || null,
			s.enabledBy || null,
			s.rejectedAt || null,
			s.rejectedBy || null,
		)
		shareRows += 1
	}
	console.log(`分享：导入 ${shareRows} 条${sharesWithoutItem ? `（${sharesWithoutItem} 条是市场外的连接器，item_id 为空）` : ''}`)

	/* ---------- 4. 操作日志 ---------- */
	const ops = [...(oplogFile.ops || [])].sort((a, b) => String(a.at).localeCompare(String(b.at)))
	for (const op of ops) {
		appendOp(db, {
			team: op.team || '_unknown',
			action: op.action || 'unknown',
			kind: op.kind || null,
			name: op.name || null,
			by: op.by || null,
			note: op.note || null,
			// 老 oplog 把双方塞进 detail 文本；现在有独立列，结构化存一份，页面才能按来源过滤
			from: op.from || null,
			to: op.to || null,
			detail: op.detail || null,
		})
	}
	console.log(`操作日志：导入 ${ops.length} 条`)

	/* ---------- 5. 市场 token ---------- */
	const tokens = []
	for (const team of Object.keys(accounts.teams || {})) tokens.push({ team, token: ensureMarketToken(db, team) })
	console.log(`市场 token：${tokens.length} 个团队已签发`)
	if (args.has('--show-tokens')) for (const { team, token } of tokens) console.log(`  ${team}  ${token}`)

	/* ---------- 6. 对账 ---------- */
	if (missing.length) {
		console.log(`\n⚠️  ${missing.length} 条挂载无法迁移（市场里没有对应版本，跳过而非伪造）：`)
		for (const m of missing) console.log(`  ${m.team}  ${m.kind}:${m.name}@${m.version}`)
	}

	const orphan = db
		.prepare(
			`SELECT 'skill' AS kind, t.team_id AS team_id, t.name AS name FROM team_skills t
			   LEFT JOIN market_items i ON i.id = t.item_id WHERE i.id IS NULL
			 UNION ALL
			 SELECT 'mcp', t.team_id, t.name FROM team_mcps t
			   LEFT JOIN market_items i ON i.id = t.item_id WHERE i.id IS NULL`,
		)
		.all()
	const mismatch = db
		.prepare(
			`SELECT t.team_id, t.name, t.version, i.version AS item_version
			   FROM team_skills t JOIN market_items i ON i.id = t.item_id WHERE i.version <> t.version
			 UNION ALL
			 SELECT t.team_id, t.name, t.version, i.version
			   FROM team_mcps t JOIN market_items i ON i.id = t.item_id WHERE i.version <> t.version`,
		)
		.all()

	const nameConflicts = db
		.prepare(
			`SELECT kind, name, COUNT(DISTINCT owner_team) AS owners, GROUP_CONCAT(DISTINCT owner_team) AS teams
			   FROM market_items GROUP BY kind, name HAVING owners > 1`,
		)
		.all()

	console.log('\n对账：')
	console.log(`  孤儿引用（应为 0）：${orphan.length}`)
	console.log(`  版本不一致（应为 0）：${mismatch.length}`)
	console.log(`  名称跨团队冲突（应为 0）：${nameConflicts.length}`)
	for (const r of nameConflicts) console.log(`    ${r.kind}:${r.name} 被多个团队占用 → ${r.teams}`)
	for (const r of db
		.prepare(
			`SELECT team_id, COUNT(*) AS total, SUM(enabled) AS enabled FROM team_skills GROUP BY team_id ORDER BY team_id`,
		)
		.all())
		console.log(`  ${r.team_id}: 技能 ${r.total} 行，启用 ${r.enabled}`)
	for (const r of db
		.prepare(`SELECT team_id, COUNT(*) AS total, SUM(enabled) AS enabled FROM team_mcps GROUP BY team_id ORDER BY team_id`)
		.all())
		console.log(`  ${r.team_id}: 连接器 ${r.total} 行，启用 ${r.enabled}`)

	const digestFile = sha256(JSON.stringify(index.items), JSON.stringify(packages.teams)).slice(0, 12)
	console.log(`\n源数据指纹：${digestFile}`)
	console.log(`库：${DB_PATH}`)
	closeDb()
}

main()
