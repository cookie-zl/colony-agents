#!/usr/bin/env node
/**
 * 把 accounts.json 里的人员 / 团队 / 成员关系搬进 users / teams / team_members 三张表。
 *
 * 只做「搬」，不改任何读取路径 —— accounts.json 目前是以单个文件 bind mount 挂进
 * 每个容器的（compose.yaml），换 inode 会让运行中的容器当场悬空。所以切换读取
 * （auth/server.mjs + 控制面 registry()）必须和「改成挂目录」一起做，不能只改一半。
 *
 * 用法：
 *   node deploy/orchestrator/migrate-accounts.mjs            # 写入
 *   node deploy/orchestrator/migrate-accounts.mjs --dry-run  # 只打印将写入什么
 *
 * 幂等：全部 ON CONFLICT DO UPDATE，可以反复跑。
 *
 * 成员关系的权威来源是 `user.teams[]`，不是 `team.roles{}` —— 这不是偏好，是
 * auth/server.mjs 的 teamRole() 的实际行为：
 *
 *   if (!(user.teams || []).includes(team)) return null     // 不在 teams[] 里 = 不是成员
 *   role = teams[team].roles[user] ?? (owner === user ? 'owner' : 'member')
 *
 * 所以「roles 里有、user.teams[] 里没有」的人在系统里根本没有权限，迁移时不能
 * 当成成员写进去，只能报出来让人确认。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const ACCOUNTS = process.env.ACCOUNTS_FILE || join(REPO, 'deploy', 'auth', 'accounts.json')
const DB_FILE = process.env.DSH_DB || join(HERE, 'dsh.db')
const DRY = process.argv.includes('--dry-run')

const nowIso = () => new Date().toISOString()

if (!existsSync(ACCOUNTS)) {
	console.error(`读不到 ${ACCOUNTS}`)
	process.exit(1)
}

const accounts = JSON.parse(readFileSync(ACCOUNTS, 'utf8'))
const fallbackTime = new Date(statSync(ACCOUNTS).mtimeMs).toISOString()
const warnings = []

/** 账号记录里没有创建时间，只能用文件 mtime 兜底，并在输出里标明是推导值。 */
const derivedTime = (value, label) => {
	if (value) return { at: value, derived: false }
	void label
	return { at: fallbackTime, derived: true }
}

/* ------------------------------ 1. 用户 ------------------------------ */

const users = Object.entries(accounts.users || {}).map(([id, u]) => {
	const at = derivedTime(null, 'user.created_at')
	return {
		id,
		displayName: u.name || id,
		salt: u.salt || '',
		hash: u.hash || '',
		pwdVer: Number(u.pv) || 0,
		// auth 的 isAdmin() 认 admin 和旧值 owner；这里照抄它的语义，不自行发挥
		isAdmin: u.role === 'admin' || u.role === 'owner' ? 1 : 0,
		rawRole: u.role || null,
		createdAt: at.at,
		createdDerived: at.derived,
	}
})

/* ------------------------------ 2. 团队 ------------------------------ */

const teams = Object.entries(accounts.teams || {}).map(([id, t]) => {
	const at = derivedTime(t.createdAt, 'team.created_at')
	return {
		id,
		name: t.name || id,
		description: t.desc ?? null,
		host: t.host ?? null,
		port: t.port ?? null,
		// accounts.json 里没有节点归属；nodes.json 现在只有一个 local，
		// 但「唯一节点」不等于「就是这个团队用的节点」，不猜，留空由控制面回填
		nodeId: null,
		// desired 只有 'running' / 缺省两种，映射不到 archived —— 归档信息只在控制面
		status: t.desired === 'stopped' ? 'sleeping' : 'active',
		createdBy: t.createdBy ?? null,
		createdAt: at.at,
		createdDerived: at.derived,
		rawDesired: t.desired ?? null,
	}
})

/* ------------------------------ 3. 成员 ------------------------------ */

const teamById = accounts.teams || {}
const members = []
let roleFromRoles = 0
let roleFromOwner = 0
let roleDefaultMember = 0

for (const [userId, u] of Object.entries(accounts.users || {})) {
	for (const teamId of u.teams || []) {
		const t = teamById[teamId]
		if (!t) {
			warnings.push(`${userId}.teams[] 引用了不存在的团队 ${teamId}，已跳过`)
			continue
		}
		const declared = t.roles?.[userId]
		let role
		if (declared === 'owner' || declared === 'member') {
			role = declared
			roleFromRoles += 1
		} else if (t.owner === userId) {
			role = 'owner'
			roleFromOwner += 1
		} else {
			role = 'member'
			roleDefaultMember += 1
		}
		members.push({
			teamId,
			userId,
			role,
			joinedAt: derivedTime(null, 'team_members.joined_at').at,
			invitedBy: t.createdBy && t.createdBy !== userId ? t.createdBy : null,
		})
	}
}

// 有 roles 记录但不在 user.teams[] 里：按 auth 的判定这些人没有权限，报出来而不是写进去
for (const [teamId, t] of Object.entries(teamById)) {
	for (const [userId, role] of Object.entries(t.roles || {})) {
		if (!(accounts.users?.[userId]?.teams || []).includes(teamId)) {
			warnings.push(`${teamId}.roles.${userId}=${role} 存在，但 ${userId}.teams[] 里没有 ${teamId} —— 按 auth 判定此人无权限，未写入`)
		}
	}
}

// 团队没有 owner：迁移后没人能管理它
const ownersByTeam = new Map()
for (const m of members) {
	if (m.role === 'owner') ownersByTeam.set(m.teamId, (ownersByTeam.get(m.teamId) || 0) + 1)
}
for (const t of teams) {
	if (!ownersByTeam.get(t.id)) warnings.push(`团队 ${t.id} 迁移后没有 owner，没人能管理它`)
}

/* ------------------------------ 4. 打印 ------------------------------ */

console.log(`来源：${ACCOUNTS}`)
console.log(`目标：${DB_FILE}${DRY ? '（dry-run，不写）' : ''}`)
console.log(`\n用户 ${users.length} 个：`)
for (const u of users) {
	console.log(`  ${u.id.padEnd(8)} ${u.displayName.padEnd(8)} admin=${u.isAdmin} pwdVer=${u.pwdVer}` + (u.createdDerived ? '  [created_at 由文件 mtime 推导]' : ''))
}
console.log(`\n团队 ${teams.length} 个：`)
for (const t of teams) {
	console.log(`  ${t.id.padEnd(8)} ${t.name.padEnd(8)} owner=${(accounts.teams[t.id]?.owner || '-').padEnd(8)} ${t.host || '-'}:${t.port ?? '-'}` + (t.createdDerived ? '  [created_at 由文件 mtime 推导]' : ''))
}
console.log(`\n成员关系 ${members.length} 条：`)
for (const m of members) console.log(`  ${m.teamId.padEnd(8)} ${m.userId.padEnd(8)} ${m.role}`)
console.log(`  来源统计：roles 显式 ${roleFromRoles} 条 · 由 owner 推导 ${roleFromOwner} 条 · 缺省 member ${roleDefaultMember} 条`)

if (warnings.length) {
	console.log(`\n需要人工确认 ${warnings.length} 条：`)
	for (const w of warnings) console.log(`  ! ${w}`)
}

if (DRY) {
	console.log('\ndry-run 结束，没有写库。')
	process.exit(0)
}

/* ------------------------------ 5. 写库 ------------------------------ */

const db = new DatabaseSync(DB_FILE)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

// 建表用同一份 init-db.sql，不在这里复制 DDL：两份定义迟早漂移，
// 而且加了列只改一处、忘另一处，报错会出现在离改动很远的地方。
db.exec(readFileSync(join(HERE, 'init-db.sql'), 'utf8'))

const now = nowIso()
const upsertUser = db.prepare(`
INSERT INTO users (id, display_name, password_salt, password_hash, password_version,
                   is_admin, status, created_at, updated_at)
VALUES (?,?,?,?,?,?,?,?,?)
ON CONFLICT (id) DO UPDATE SET
  display_name=excluded.display_name, password_salt=excluded.password_salt,
  password_hash=excluded.password_hash, password_version=excluded.password_version,
  is_admin=excluded.is_admin, updated_at=excluded.updated_at`)

const upsertTeam = db.prepare(`
INSERT INTO teams (id, name, description, host, port, node_id, status, created_by, created_at)
VALUES (?,?,?,?,?,?,?,?,?)
ON CONFLICT (id) DO UPDATE SET
  name=excluded.name, description=excluded.description, host=excluded.host,
  port=excluded.port, status=excluded.status`)

const upsertMember = db.prepare(`
INSERT INTO team_members (team_id, user_id, role, joined_at, invited_by)
VALUES (?,?,?,?,?)
ON CONFLICT (team_id, user_id) DO UPDATE SET role=excluded.role`)

db.exec('BEGIN IMMEDIATE')
try {
	for (const u of users) {
		upsertUser.run(u.id, u.displayName, u.salt, u.hash, u.pwdVer, u.isAdmin, 'active', u.createdAt, now)
	}
	for (const t of teams) {
		upsertTeam.run(t.id, t.name, t.description, t.host, t.port, t.nodeId, t.status, t.createdBy, t.createdAt)
	}
	for (const m of members) {
		upsertMember.run(m.teamId, m.userId, m.role, m.joinedAt, m.invitedBy)
	}
	db.exec('COMMIT')
} catch (error) {
	db.exec('ROLLBACK')
	throw error
}

/* ------------------------------ 6. 对账 ------------------------------ */

const check = (label, rows) => {
	console.log(`  ${label}（应为 0）：${rows.length}`)
	if (rows.length) for (const r of rows.slice(0, 5)) console.log('    ', JSON.stringify(r))
}

console.log('\n写库完成，对账：')
console.log(`  users=${db.prepare('SELECT COUNT(*) n FROM users').get().n}`)
console.log(`  teams=${db.prepare('SELECT COUNT(*) n FROM teams').get().n}`)
console.log(`  team_members=${db.prepare('SELECT COUNT(*) n FROM team_members').get().n}`)

check(
	'成员引用了不存在的团队',
	db.prepare(`SELECT m.team_id, m.user_id FROM team_members m
	             LEFT JOIN teams t ON t.id = m.team_id WHERE t.id IS NULL`).all(),
)
check(
	'成员引用了不存在的用户',
	db.prepare(`SELECT m.team_id, m.user_id FROM team_members m
	             LEFT JOIN users u ON u.id = m.user_id WHERE u.id IS NULL`).all(),
)
check(
	'没有 owner 的团队',
	db.prepare(`SELECT t.id FROM teams t
	             WHERE NOT EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.role = 'owner')`).all(),
)
check(
	'团队被 team_skills 引用但没进 teams 表',
	db.prepare(`SELECT DISTINCT s.team_id FROM team_skills s
	             LEFT JOIN teams t ON t.id = s.team_id WHERE t.id IS NULL`).all(),
)
