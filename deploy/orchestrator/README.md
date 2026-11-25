# 控制面（本地模拟云）

把「新建团队」变成一次 HTTP 调用，背后真的去创建容器。**在 dsh 之外**运行，因为这个动作必须发生在 dsh 进程启动之前。

```bash
make console          # 前台运行，Ctrl-C 停
```

- 监听 `0.0.0.0:9700`（容器经 `host.docker.internal:9700` 访问）
- 鉴权：请求头 `X-Console-Token` = 本目录 `console-token`（首次由 `team-up.sh` 生成，勿提交）
- 创建动作直接复用 `deploy/compose/team-up.sh up <team> <port>`，与手动起实例走同一条路径

> **别在会注入 `NODE_OPTIONS` 的环境里起它。** 某些编辑器/Agent 工具会通过
> `NODE_OPTIONS=--require ...shim` 把 `fs.unlink` 换成需要确认的 safe-delete，
> 控制面的快照清理会被静默拦住：每 10 分钟写 7 份快照、一份也删不掉，
> 十天后目录涨到七千多个文件，`readdir` 把事件循环拖死 —— 表现为端口还在
> `LISTEN` 但所有请求 `connection reset`。真遇上了：`env -u NODE_OPTIONS node console.mjs`
> 重启，并把 `backups/` 清到每类 24 份。

| 接口 | 说明 |
| --- | --- |
| `POST /teams` | `{id,name,desc,owner,cpus?,memory?}` → 校验节点预算、分配端口、建容器、等健康 → `{team:{id,url,node,quota}}` |
| `GET /teams` | 列出注册表 |
| `GET /health` | 存活探测（不需要 token） |
| `POST /touch` | `{team}` → 记一次「有人来了」，账号服务在 `/__auth/verify` 里调（客户端 20 秒节流） |
| `GET /wake-state?team=` | 醒着还是睡着，账号服务据此决定要不要拦成「正在唤醒」页 |
| `POST /wake` | 异步唤醒，幂等（并发只拉起一次），返回 202 后调用方轮询 `/wake-state` |
| `POST /sleep` | 立刻休眠，`{team, reason}` |
| `GET /state` | 每个团队的闲置时长、配额、节点、休眠/归档状态（`make state`） |
| `GET /nodes` | 各节点配额余量与归属团队（`make nodes`） |
| `GET /reconcile` | 对账只看不动：缺失容器、孤儿项目、孤儿卷、state 漂移（`make reconcile-check`） |
| `POST /reconcile` | 对账并修复；`{cleanupVolumes:true}` 才删孤儿卷（`make reconcile`） |
| `POST /archive` | `{team,reason}` → 卷打包 → 删容器删卷 → 注册表记 `archived`（`make archive TEAM=`） |
| `POST /restore` | `{team}` → 解包卷 → 按注册表配额重新起实例（`make restore TEAM=`） |
| `POST /snapshot` | 立刻给 accounts/state/nodes 拍快照（`make snapshot`） |
| `GET /market?team=` | 技能与连接器市场：索引 + 该团队已装版本（`make market`） |
| `GET /packages?team=` | 某团队已装的技能与 MCP（读卷；容器睡着时退回台账并标 `stale`，`make packages`） |
| `POST /market/install` | `{team,kind,name,env}` → 投放进团队卷；MCP 会先校验配置再重建实例（`make install`） |
| `POST /market/uninstall` | `{team,kind,name}`（`make uninstall`） |
| `POST /market/publish` | `{team,kind,name,version,visibility}` 团队私有包 → 市场（`make publish`） |
| `GET /secrets?team=` | 该团队有没有独立模型 key（**只回布尔值，不回明文**） |
| `POST /secrets` | `{team,deepseekApiKey}` → AES-GCM 加密写 `team_secrets` 表，**不重启实例**（网关每次请求现查）；空值表示清除（`make team-key`） |
| `GET /llm-token?team=` | 该团队的模型网关 token（容器用它当 apiKey，不是真密钥） |
| `POST /llm-token` | `{team}` → 轮换 token 并重启实例，旧 token 当场失效 |

技能与连接器的落点、市场包格式、以及为什么 MCP 要重启而技能不用，见
[docs/11-技能与连接器.md](../../docs/11-技能与连接器.md)。
| `GET /metrics` | Prometheus 文本格式，认证可走 `Authorization: Bearer`（`make metrics`） |

自动休眠由本进程的定时器驱动（默认闲置 30 分钟 + CPU < 2% + 已运行 5 分钟，团队可用 `policy` 覆盖）；
对账每 10 分钟、归档扫描每 6 小时、配置快照每小时各一次。
配额、对账、归档、审计、指标的完整说明见 [docs/10-平台运维.md](../../docs/10-平台运维.md)，
休眠判据与实测数据见 [docs/09-休眠与唤醒.md](../../docs/09-休眠与唤醒.md)。

完整流程、验证记录与云上替换方式见 [docs/08-动态建团队.md](../../docs/08-动态建团队.md)。
