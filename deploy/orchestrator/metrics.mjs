/**
 * Prometheus 文本格式（text/plain; version=0.0.4）。
 *
 * 只暴露「运营这个平台时真的会看」的指标：每个团队醒没醒、吃多少资源、
 * 闲置多久，以及整机的配额余量。指标名一旦对外就不能随便改——Grafana 面板和
 * 告警规则都钉在上面，改名等于让所有看板静默失效。
 */

/** 指标值只允许数字；拿不到就写 NaN，别写字符串 "unknown"（Prometheus 会整条丢弃）。 */
const num = (value) => (Number.isFinite(value) ? String(value) : 'NaN')

/** label 值里的反斜杠、引号、换行必须转义，否则整行解析失败。 */
const label = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')

/**
 * @param {object} input
 * @param {Record<string, {running:boolean, health:string, cpu:number, memBytes:number, idleSec:number|null, asleepSince:string|null, quota:{cpus:number,memory:string}, node:string, archived:boolean}>} input.teams
 * @param {{cpuUsed:number, cpuBudget:number, memUsedGB:number, memBudgetGB:number}} input.quota
 * @param {{reconcile:number, rebuild:number, archive:number, wake:number, sleep:number, snapshots:number}} input.counters
 */
export function renderMetrics({ teams, quota, counters }) {
	const lines = []
	const head = (name, type, help) => {
		lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
	}

	head('dsh_team_up', 'gauge', '实例是否在运行：1 醒着，0 睡着或缺失')
	head('dsh_team_healthy', 'gauge', '实例健康检查是否通过')
	head('dsh_team_archived', 'gauge', '实例是否已归档（0/1）')
	head('dsh_team_cpu_percent', 'gauge', '实例当前 CPU 占用百分比')
	head('dsh_team_mem_bytes', 'gauge', '实例当前内存占用（字节）')
	head('dsh_team_idle_seconds', 'gauge', '距上次活跃的秒数；从未活跃过则为 NaN')
	head('dsh_team_quota_cpus', 'gauge', '该团队允许使用的 CPU 核数')
	head('dsh_team_info', 'gauge', '团队元信息，值恒为 1')

	for (const [team, row] of Object.entries(teams).sort(([a], [b]) => a.localeCompare(b))) {
		const at = `team="${label(team)}"`
		lines.push(
			`dsh_team_up{${at}} ${row.running ? 1 : 0}`,
			`dsh_team_healthy{${at}} ${row.running && row.health === 'healthy' ? 1 : 0}`,
			`dsh_team_archived{${at}} ${row.archived ? 1 : 0}`,
			`dsh_team_cpu_percent{${at}} ${num(row.cpu)}`,
			`dsh_team_mem_bytes{${at}} ${num(row.memBytes)}`,
			`dsh_team_idle_seconds{${at}} ${num(row.idleSec)}`,
			`dsh_team_quota_cpus{${at}} ${num(row.quota?.cpus)}`,
			`dsh_team_info{${at},node="${label(row.node || 'local')}",health="${label(row.health || 'unknown')}"} 1`,
		)
	}

	head('dsh_platform_quota_cpu_used', 'gauge', '所有团队已分配的 CPU 核数之和')
	head('dsh_platform_quota_cpu_budget', 'gauge', '所有节点可分配的 CPU 核数之和')
	head('dsh_platform_quota_mem_used_gb', 'gauge', '所有团队已分配的内存（GB）之和')
	head('dsh_platform_quota_mem_budget_gb', 'gauge', '所有节点可分配的内存（GB）之和')
	lines.push(
		`dsh_platform_quota_cpu_used ${num(quota.cpuUsed)}`,
		`dsh_platform_quota_cpu_budget ${num(quota.cpuBudget)}`,
		`dsh_platform_quota_mem_used_gb ${num(quota.memUsedGB)}`,
		`dsh_platform_quota_mem_budget_gb ${num(quota.memBudgetGB)}`,
	)

	head('dsh_platform_events_total', 'counter', '控制面各类动作的累计次数')
	for (const [name, value] of Object.entries(counters)) {
		lines.push(`dsh_platform_events_total{event="${label(name)}"} ${num(value)}`)
	}

	return `${lines.join('\n')}\n`
}

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'
