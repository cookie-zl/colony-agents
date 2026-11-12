/**
 * 【不可用，仅作记录】把历史助理会话从 `--workspace--` 迁到 `--workspace-agents--`。
 *
 * 结论（2026-11-13 实测）：**dsh 不支持跨 cwd 迁移会话**。
 * 这个脚本能改会话文件 header 的 cwd、也能改 `session_projcache` 的
 * `identity.cwd` / `workingDirectory`，但 `entity.attachSession()` 仍然判
 * `its cwd resolves to '/workspace'` —— dsh 侧还有更高层的会话索引/内存投影，
 * 不认外部改文件的结果。改完还会让会话处于「文件不在原工作区、注册表也不认」的中间态。
 *
 * 所以脚本保留只为了两件事：① 记录这个反面结论；② 里面的逐帧 zstd 解压/备份逻辑可复用。
 * **不要在生产数据上跑 `--apply`**。旧会话就留在用户工作区当历史；要「移走」只能新建会话。
 *
 * 原始说明：
 * 助理早期用 `/workspace` 作 cwd，会话因此挂在用户自己的工作区下。dsh 的 attachSession
 * 会校验「会话 header 的 cwd === 工作区路径」，所以不能只改注册表——必须同时改文件 header。
 * 会话文件是 `session.v4.jsonl.zstd`，多帧追加，Node 的 `zstdDecompressSync` 只解第一帧，
 * 这里按 zstd 魔数切帧逐帧解压，改完再压成单帧。
 *
 * @deprecated dsh 侧拒绝 attach，见上面的结论
 * @module deploy/orchestrator/migrate-agent-sessions
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const CONTAINER = process.env.DSH_CONTAINER || `dsh-${process.env.DSH_TEAM || 'team-a'}-dsh-1`
const HOME = process.env.DSH_HOME_IN_CONTAINER || '/home/dsh/.dsh'
const SRC = `${HOME}/sessions/--workspace--`
const DST = `${HOME}/sessions/--workspace-agents--`
const AGENT_ROOT = process.env.DSH_AGENT_WORKSPACE || '/workspace/agents'
/** 首条用户消息里出现这个前缀，就认定是助理会话。 */
const MATCH = process.env.DSH_AGENT_SESSION_MATCH || '你在钉钉群里被 @'

/** zstd 帧魔数。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 跑一条容器内命令，返回 stdout。
 *
 * @param {string[]} args docker 参数
 * @returns {string} 输出
 */
function docker(args) {
	return execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/**
 * 把多帧 zstd 解成文本。
 *
 * @param {Buffer} buf 文件内容
 * @returns {string} 解压后的 JSONL
 */
function decodeFrames(buf) {
	const starts = []
	for (let i = 0; i <= buf.length - 4; i += 1) {
		if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i)
	}
	let text = ''
	for (let k = 0; k < starts.length; k += 1) {
		const end = k + 1 < starts.length ? starts[k + 1] : buf.length
		try {
			text += zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8')
		} catch {
			// 坏帧跳过：宁可少一行事件，也别整个会话打不开
		}
	}
	return text
}

/**
 * 判断会话是不是助理的：首条 `user/message` 文本里带着人设前缀。
 *
 * @param {string} text 解压后的 JSONL
 * @returns {{agent:boolean,title:string,firstUser:string}} 判定结果
 */
function classify(text) {
	let title = ''
	let firstUser = ''
	for (const line of text.split('\n')) {
		if (!line.trim()) continue
		let row
		try {
			row = JSON.parse(line)
		} catch {
			continue
		}
		if (row.type === 'session/title' && !title) title = row.data?.title || ''
		if (row.type === 'user/message' && !firstUser) {
			const raw = row.data?.text ?? row.data?.content ?? ''
			firstUser = typeof raw === 'string' ? raw : JSON.stringify(raw)
		}
	}
	return { agent: firstUser.includes(MATCH), title, firstUser }
}

/**
 * 改 header 的 cwd，重新压成单帧。
 *
 * @param {string} text 原 JSONL
 * @param {string} cwd 新工作目录
 * @returns {Buffer} 新的 zstd 文件内容
 */
function rewrite(text, cwd) {
	const lines = text.split('\n')
	for (let i = 0; i < lines.length; i += 1) {
		if (!lines[i].trim()) continue
		let row
		try {
			row = JSON.parse(lines[i])
		} catch {
			continue
		}
		if (row.type !== 'session') throw new Error('首行不是 session header，拒绝改写')
		row.cwd = cwd
		lines[i] = JSON.stringify(row)
		break
	}
	return zstdCompressSync(Buffer.from(lines.join('\n'), 'utf8'))
}

const apply = process.argv.includes('--apply')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = resolve('deploy/orchestrator/backups', `agent-sessions-${stamp}`)
const work = mkdtempSync(join(tmpdir(), 'dsh-agent-migrate-'))

console.log(`container=${CONTAINER}`)
console.log(`from=${SRC}\nto=${DST}  cwd=${AGENT_ROOT}  ${apply ? 'APPLY' : 'DRY-RUN'}`)

const ids = docker(['exec', CONTAINER, 'sh', '-lc', `ls ${SRC} 2>/dev/null || true`])
	.split('\n')
	.map((s) => s.trim())
	.filter((s) => s.startsWith('session-'))

const picked = []
for (const id of ids) {
	const local = join(work, id)
	mkdirSync(local, { recursive: true })
	try {
		docker(['cp', `${CONTAINER}:${SRC}/${id}/session.v4.jsonl.zstd`, join(local, 'session.v4.jsonl.zstd')])
	} catch {
		continue
	}
	const buf = readFileSync(join(local, 'session.v4.jsonl.zstd'))
	const text = decodeFrames(buf)
	const info = classify(text)
	if (!info.agent) continue
	picked.push({ id, title: info.title, firstUser: info.firstUser.slice(0, 40), text, bytes: buf.length })
	console.log(`  · ${id}  ${JSON.stringify(info.title.slice(0, 28))}  ${(buf.length / 1024).toFixed(0)}KB`)
}

if (picked.length === 0) {
	console.log('\n没有需要迁移的助理会话')
	rmSync(work, { recursive: true, force: true })
	process.exit(0)
}

if (!apply) {
	console.log(`\n共 ${picked.length} 条待迁移（dry-run，加 --apply 执行）`)
	rmSync(work, { recursive: true, force: true })
	process.exit(0)
}

mkdirSync(backupDir, { recursive: true })
docker(['exec', CONTAINER, 'sh', '-lc', `mkdir -p ${DST}`])

for (const item of picked) {
	const local = join(work, item.id)
	// 1. 备份原文件（宿主一份，容器内不动）
	const backup = join(backupDir, item.id)
	mkdirSync(backup, { recursive: true })
	cpSync(join(local, 'session.v4.jsonl.zstd'), join(backup, 'session.v4.jsonl.zstd'))

	// 2. 改 header cwd，单帧写回
	writeFileSync(join(local, 'session.v4.jsonl.zstd'), rewrite(item.text, AGENT_ROOT))

	// 3. 放到新工作区的会话目录，再删旧的
	docker(['exec', CONTAINER, 'sh', '-lc', `mkdir -p ${DST}/${item.id}`])
	docker(['cp', join(local, 'session.v4.jsonl.zstd'), `${CONTAINER}:${DST}/${item.id}/session.v4.jsonl.zstd`])
	docker(['exec', CONTAINER, 'sh', '-lc', `rm -rf ${SRC}/${item.id}`])
	console.log(`✓ ${item.id} → 代理工作区`)
}

rmSync(work, { recursive: true, force: true })
console.log(`\n完成：${picked.length} 条；备份在 ${backupDir}`)
console.log('接下来由 workspace-guard 的轮询自动改注册表（≤30 秒）：旧工作区摘除、代理工作区挂上。')
