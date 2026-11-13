#!/usr/bin/env node
/**
 * 凭据自检：扫「已入库的文件」和「git 历史里加过的行」，发现疑似密钥就失败。
 *
 * 为什么不用 gitleaks-action：它要额外的 license，规则不受我们控制，而且在 CI 里
 * 把两个**故意写进夹具的假 Key**（`sk-verify-…`、`sk-rotated-…`）当成真凭据报错，
 * 让人以为仓库泄露了。这里把「规则 + 白名单」都放进仓库，本地和 CI 跑同一份。
 *
 * 只扫三类地方，够用且不误报：
 *   1. `git ls-files` 里的文本文件（<= 1 MB）；
 *   2. `--history` 时额外扫 `git log -p` 新增行（凭据删掉了也还在历史里）；
 *   3. 不扫 node_modules、.git、运行时目录。
 *
 * 用法：
 *   node deploy/orchestrator/scan-secrets.mjs            # 只扫当前文件
 *   node deploy/orchestrator/scan-secrets.mjs --history  # 连历史一起扫（CI 用）
 *
 * @module deploy/orchestrator/scan-secrets
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dirname, '..', '..')
const WITH_HISTORY = process.argv.includes('--history')

/**
 * 规则表。`allow` 里的正则命中即视为「已知的假凭据」而放行——加白名单必须写清理由，
 * 否则下一次有人照着抄就会把真凭据也塞进来。
 *
 * @type {Array<{id:string, pattern:RegExp, hint:string, allow?:Array<{re:RegExp, why:string}>}>}
 */
const RULES = [
	{
		id: 'private-key',
		pattern: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
		hint: '私钥不能入库',
	},
	{
		id: 'aws-key-id',
		pattern: /\bAKIA[0-9A-Z]{16}\b/,
		hint: 'AWS Access Key',
	},
	{
		id: 'github-token',
		pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/,
		hint: 'GitHub token',
	},
	{
		id: 'llm-api-key',
		pattern: /\bsk-[A-Za-z0-9_-]{16,}/,
		hint: '模型 API Key（sk- 开头）',
		allow: [
			{ re: /sk-verify-|sk-rotated-|sk-test-|sk-example-/, why: 'verify-gateway 的夹具，故意写死的假 Key' },
		],
	},
	{
		id: 'dingtalk-appkey',
		pattern: /\bding[a-z0-9]{14,}\b/,
		hint: '钉钉 Client ID / AppKey',
		allow: [
			{ re: /dingexample/, why: '文档与夹具里的示例值' },
			{ re: /dingx{6,}/, why: '登录表单的输入框占位符 dingxxxxxxxxxxxxxxxx' },
		],
	},
	{
		// 形如 APP_SECRET=xxxx / "apiKey": "xxxx" / token: 'xxxx'
		id: 'assigned-secret',
		pattern: /(?:api[_-]?key|app[_-]?secret|access[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["'][A-Za-z0-9_\-+/=]{16,}["']/i,
		hint: '疑似硬编码的 secret',
		allow: [
			{ re: /dingexample|your-|example|<|xxx/i, why: '占位符' },
		],
	},
	{
		id: 'demo-password-default',
		pattern: /LOGIN_PREFILL_PASSWORD:\s*\$\{LOGIN_PREFILL_PASSWORD-dsh-demo-1234\}/,
		hint: '本地演示默认口令（仅限 compose 默认值，别带到生产）',
		allow: [{ re: /dsh-demo-1234/, why: '演示账号固定口令，README 已注明仅限本机' }],
	},
]

/** 整个文件跳过：要么是夹具，要么是示例，要么是文档占位符。 */
const SKIP_PATHS = [
	/deploy\/auth\/accounts\.example\.json$/, // 演示账号的 scrypt 哈希，口令公开为 demo1234
	/deploy\/orchestrator\/verify-.*\.mjs$/,  // 自测夹具
	/^docs\//,                                 // 文档里全是 <占位符>
	/^README/,                                 // README 里有命令示例
]

/** 目录层面直接跳过，省时间也避免扫到依赖里的测试数据。 */
const SKIP_DIR = /(^|\/)(node_modules|\.git|\.verify-yaml|backups|archives|objects|audit|workspace|helm-values)(\/|$)/

/**
 * 判断某个命中是否被白名单解释掉。
 *
 * @param {object} rule 规则
 * @param {string} line 命中所在行
 * @returns {boolean} true 表示放行
 */
const allowed = (rule, line) => (rule.allow ?? []).some((a) => a.re.test(line))

/**
 * 扫一段文本，返回命中列表。
 *
 * @param {string} text 文本
 * @param {string} where 来源（文件路径或提交）
 * @returns {Array<{where:string,rule:string,hint:string,line:string}>} 命中
 */
function scanText(text, where) {
	const hits = []
	for (const rule of RULES) {
		for (const line of text.split('\n')) {
			if (!rule.pattern.test(line)) continue
			if (allowed(rule, line)) continue
			hits.push({ where, rule: rule.id, hint: rule.hint, line: line.trim().slice(0, 160) })
		}
	}
	return hits
}

const hits = []

// 1) 已入库的文件
const files = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
	.split('\n')
	.filter(Boolean)

let scanned = 0
for (const rel of files) {
	if (SKIP_DIR.test(rel)) continue
	if (SKIP_PATHS.some((re) => re.test(rel))) continue
	const abs = join(REPO, rel)
	if (!existsSync(abs) || statSync(abs).size > 1024 * 1024) continue
	let text
	try {
		text = readFileSync(abs, 'utf8')
	} catch {
		continue // 二进制文件读成 utf8 会带 \u0000，直接跳过
	}
	if (text.includes('\u0000')) continue
	scanned += 1
	hits.push(...scanText(text, rel))
}

// 2) 历史里新增的行（凭据即使后来删了也还在历史里，这是最容易被忽略的泄露面）
let commits = 0
if (WITH_HISTORY) {
	const log = execFileSync('git', ['log', '--all', '-p', '--unified=0', '--format=commit %H %s'], {
		cwd: REPO,
		encoding: 'utf8',
		maxBuffer: 256 * 1024 * 1024,
	})
	let current = ''
	for (const line of log.split('\n')) {
		if (line.startsWith('commit ')) {
			current = line.slice(7, 19)
			commits += 1
			continue
		}
		if (!line.startsWith('+') || line.startsWith('+++')) continue
		const body = line.slice(1)
		for (const rule of RULES) {
			if (!rule.pattern.test(body)) continue
			if (allowed(rule, body)) continue
			hits.push({ where: `commit ${current}`, rule: rule.id, hint: rule.hint, line: body.trim().slice(0, 160) })
		}
	}
}

if (hits.length) {
	console.error(`发现 ${hits.length} 处疑似凭据：\n`)
	for (const h of hits) {
		console.error(`  [${h.rule}] ${h.where}`)
		console.error(`    ${h.hint}`)
		console.error(`    ${h.line}\n`)
	}
	console.error('如果是夹具/示例：把它换成 `sk-example-` / `dingexample…` 这类明显假值，')
	console.error('真需要保留就在 scan-secrets.mjs 的 RULES[].allow 里写清理由。')
	process.exit(1)
}

console.log(
	`✓ 未发现疑似凭据（扫了 ${scanned} 个文件${WITH_HISTORY ? `，以及 ${commits} 个提交的新增行` : ''}）`,
)
