# 待办台账

只在「设计已讨论出结论、但还没动手」时记一行；动手时把对应方案写成正式文档（`docs/NN-*.md`），
这里只留指针。优先级按「不做会不会出事」排，不按工作量排。

**已经做完的功能不在这里**，统一按「需求 → 技术方案 → 实现功能」列在
[`docs/features/`](./features/README.md)（1 份总览 + 10 份专题，含代码规范审查与定时任务实测）。

## 一、会话记录与中间产物

背景：dsh 是桌面优先的 harness，会话以 zstd JSONL 落 `$DSH_HOME/sessions/`，
而我们的容器是可丢的、卷是不可丢的（`pvc.yaml` 两个卷都 `helm.sh/resource-policy: keep`）。
结果是「沙箱是唯一副本」，任何清理策略都等于删数据。改造目标：**卷降级为缓存，记录外置。**

| # | 待办 | 做什么 | 不做的后果 | 优先级 |
|---|---|---|---|---|
| S1 | 会话索引表 | `team_sessions`（会话索引表：一行 = 一个会话的元信息与正文指针），侧栏 `WHERE team_id=?` 直接出列表 | 侧栏依赖扫卷，卷丢则列表全丢 | **已完成**（docs/15） |
| S2 | 增量同步 | `session_sync`（同步进度表：一行 = 一个会话已上推到哪个字节），按 `uploaded_bytes` 只推区间，周期扫描 + 睡前强制 | 每次全量重传；崩溃丢最后一段 | **已完成**（docs/15） |
| S3 | 正文进对象层 | 日志进对象层，表里只存指针与清单摘要；**不进事务库**（单条 tool result 上限 64 KB，50 轮几十 MB） | 库迅速膨胀，备份不可用 | **已完成**（docs/15；换 OSS 见 L5） |
| S4 | 上传先于回收 | 顺序固定为「上传 → 校验摘要 → 才允许本地清理」；睡前强制同步是这条的落地 | 顺序反了就是静默丢会话 | **已完成**（docs/15） |
| S5 | 启动走「查库→拉文件→起 dsh」 | dsh 只有 jsonl 一个 provider，所以必须重建出本地文件再启动；唤醒前补齐 | 表建了也用不上 | **已完成**（docs/15） |
| S6 | 中间产物 manifest | 建 `session_artifacts`（产物归因表：一行 = 会话的一轮），字段 `turn, seq, cwd, files JSON, total, added, deleted, detail_key, detail_digest`；逐文件 hunks 进对象层，点开才读 | 做不到「第 7 轮生成了哪些文件」 | **已完成**（docs/20；粒度是「轮」不是「文件行」——一轮一行更好查，详情在对象层） |
| S7 | 产物归因赶在销毁前 | `workspace-changes` 的摘要与 diff 只活到 Session dispose。改成**事件到达即抄**（`plugins/changes-collector` 监听 `session/event`），落卷后再由控制面收进对象层 | 事后无法补归因 | **已完成**（docs/20，`make verify-artifacts` 39 条） |
| S6b | 产物文件本身进对象层 | 现在记的是「哪些文件、改了几行、diff 是什么」，文件内容仍在 `/workspace`（宿主 bind）。要「会话跟着产物走」得把文件按内容寻址存一份 | 换机器/删宿主目录后只剩 diff，没有成品 | P1 |
| S8 | 会话标题 | 日志是 zstd 压缩的，不解析只有 id 与目录名。要么解首帧取 header，要么复用 `session_projcache` | 侧栏列表不好认 | P1 |

已确认的约束（别推翻）：

- **不加 Redis**。Redis 在 Langfuse 里是队列解耦 + 多副本共享缓存，我们是单控制面进程（9700）
  + 每团队单容器，内存 LRU 够用。
- **正文不可用消息级替代事件级**。上下文是 `deriveMessages()` 从事件流现算的，
  只存 user/assistant 文本等于存了一个不能恢复的副本。
- **compaction 不减少体积**，只隐藏 superseded entries，日志事件一条不删。
- **`storages/workspace.json` 是 single 布局**，所有会话 id 在一个 JSON 里、每次操作全量重写。
  这是 N 个会话最先碰到的墙，layout 固定在 `dsh-workspace` 的 domain spec 里，平台层改不了。

## 二、容量与观测（都是当前完全空白的地方）

| # | 待办 | 做什么 | 现状 |
|---|---|---|---|
| C1 | 容器内存指标 | `metrics.mjs` 加 per-team `container_memory_working_set` / `max_usage`，告警线 85%（2 GiB → 1.7 GiB） | 只有 69 行，零内存指标 |
| C2 | 三处硬配额 + 时间 LRU | `sessions/`、`attachments/`、`/tmp` 各给上限，到顶按 mtime 清最早（照 WorkBuddy 3000 MB 共享备份空间的模式） | 三处都是无尽的 |
| C3 | `/tmp` spill 治理 | 工具输出超 64 KB 落 `/tmp/<per-process>/`，单流上限 64 MiB，**无人清理、不进归档、不在 PVC、查不到**。纳入巡检并在重建前清理 | 唯一「无声增长 + 重建即蒸发」的东西 |
| C4 | 卷配额预警 | 云端 `home` 10 GiB / `workspace` 20 GiB 是硬顶，写满表现为 checkpoint fail-closed → agent 直接停摆（不是变慢）。要提前告警 | 无 |
| C5 | 内存分档 | 从单一 2 GiB 改 2/4/8 三档，按 `nodes.json`（`memBudgetGB: 7`）余量分配。**不要手工设 `max-old-space-size`**，node 按 cgroup 自动算（2G → 1120 MB），调高只会让 cgroup 先 SIGKILL | 单一规格 |
| C6 | 归档包纳入 workspace | `team-up.sh:171` 只打 `dsh-home` 卷，宿主机 `workspace-team-X` 不在包里；包也只在本机 `deploy/orchestrator/archives/` | 机器坏了没有 workspace 副本 |

## 三、明确不做的

| 项 | 为什么不做 |
|---|---|
| 一会话一沙箱 | 并发度约为 1，「团队 ≈ 一个对话」这个近似成立；照搬会让内存 ×N，7 GB 预算装不下第 4 个并发会话 |
| per-session token / 拆 Caddy 路由 / 预热池 | 沙箱粒度不变，这些都不需要 |
| 改 `session-persistence` 写 OSS 插件 | 要实现完整 handle/append/fsync/迁移语义，随 dsh 升级容易失配；走 sidecar 增量同步更稳 |
| 把消息级记录当恢复源 | 缺 tool result 和 request header，恢复不出来 |

## 四、沙箱生命周期（对齐 WorkBuddy 云端工作）

背景：WorkBuddy 云端工作的官方口径是 **1 Session : 1 沙箱 + 存算分离**（实例销毁不丢数据、
休眠唤醒 P95 ≤ 300ms、闲置不计费）。我们的映射是「1 团队 ≈ 1 会话」，粒度成立，可以照搬机制。
但有一处不对称：他们的沙箱只服务 1 个人，销毁只影响发起人；我们一个团队多人共享，
销毁/重建期间**全团队不可用**，所以回收窗口要更保守、重建必须秒级。

他们的沙箱拆成五件套，逐项对照我们的现状：

| 部件 | WorkBuddy | 我们 | 差距 |
|---|---|---|---|
| 存算分离 | 会话/产物在持久层（持久卷 + 对象存储） | 会话在 `dsh-home` 卷，**容器内唯一副本** | 核心缺口 |
| 四级状态机 | 运行 → 休眠(10min) → 回收(数天，容器销毁) → 冷归档 | 只有两级：`compose stop` + 30 天 `down -v` 打 tar | 缺「回收」档 |
| 重建路径 | 预热池 + 预制镜像 + CoW，秒级 | 只有手工 archive → restore | 缺自动重建 |
| 预热池 | 已启动实例待命 | 无 | 单机没必要 |
| 弹性启停 | 300ms（内存换出） | `stop`/`start`，实测 5.8s（内存态丢） | 不追 |

| # | 待办 | 做什么 | 前置 | 优先级 |
|---|---|---|---|---|
| L1 | 存算分离 | 会话与产物出容器，进对象层 + `team_sessions`/`session_sync`（= S1–S5） | 无 | **P0 · 已完成**（`sessions.mjs` + `make verify-sessions`，详见 docs/15；产物归因见 docs/20） |
| L2 | 归档包进对象层 | `archive_instance` 打的 tar 不再留 `deploy/orchestrator/archives/` 本机目录，改走统一对象层；`archived` 记录存 `key + digest + bytes`，`restore` 按 key 取回。上传失败自动降级回本机文件，不丢数据 | 无 | **P0 · 已完成**（`objects.mjs` + `make verify-objects`，详见 docs/14） |
| L3 | 「回收」单独一档 | `compose stop`（释放内存、留容器）与 `down`（删容器、留卷）分开，后者等更长的闲置窗口；这样容器与卷的生命周期各自回收 | L1 | P1 |
| L4 | 自动重建 | 对账发现容器缺失时自动 `up` 而不是报「需要完整重建」；会话从持久层拉回 | L1 | P1 |
| L5 | 对象层换 OSS 后端 | 只改 `objects.mjs` 的 `putFile`/`materialize`/`statObject`，调用方不动 | L2 | P1 |
| L6 | 归档纳入 workspace | 见 C6：`team-up.sh` 只打 `dsh-home`，宿主机 `workspace-team-X` 不在包里 | L2 | P1 |

不照搬的三条（理由见上表）：300ms 内存快照唤醒、1 Session : 1 沙箱（我们 7 GB 预算装不下
第 4 个 2 GiB 容器）、「数天即回收」的激进窗口。

## 五、agent 参数与工作目录（详见 docs/16、docs/17）

背景：会话正文已经双份（卷 + 对象层），但**配置与工作目录都不在持久层**。前者每次启动被镜像覆盖，
后者在容器可写层里随重建蒸发。发版、休眠唤醒、删容器重建三种场景都会踩到。

对齐的是 WorkBuddy 云端那条原则：**配置跟着团队走，不跟着沙箱走**（他们的 Manifest 由平台维护，
发布时汇入沙箱；我们把它落到 `team_agent_config` 表 + 启动时合并）。

| # | 待办 | 做什么 | 不做的后果 | 优先级 |
|---|---|---|---|---|
| A1 | agent 参数持久化 | `profile-patch.mjs` 在 seed 前后做 capture/merge（按 id 叠用户层）；`team_agent_config` 存卷外权威副本；`GET/POST /agent-config` 读写；睡前与 5 分钟扫描入库，归档恢复到新卷时注入 | UI 里改的模型/preset/工具开关每次重启回默认，用户以为「保存了」 | **P0 · 已完成**（`make verify-profile` 27 条） |
| A2 | 会话 cwd 重建后补建 | `prepare-workspaces.mjs` 在 dsh 启动前读 `storages/workspace.json` 补 `mkdir -p`；`workspace-guard` 把新建工作区钉到 `/workspace/<name>`（见 docs/19，工作区收敛见 A9） | cwd 在可写层，重建后 `cwd does not resolve`，会话留在侧栏但跑不了命令 | **P0 · 已完成**（新会话不再需要补建，脚本只服务旧路径；产物持久化仍见 S6） |
| A3 | 团队 `policy` 可配置 | `POST /policy`（`autoSleep` / `idleMs`，带范围校验），写回 `accounts.json` | 想「常驻不休眠」的团队只能改文件，改错没有校验 | **已完成**（门户开关未做） |
| A4 | 休眠判据补活跃 turn | `scanOnce` 在 CPU 判据之外再查会话日志最近写入（`find -mmin`），有写入不睡；查不到按活跃处理 | 等模型/等审批时 CPU < 2%，长任务被当闲置杀掉 | **已完成**（轮级快照仍缺，见 L3） |
| A5 | 门户里的策略开关 | 控制台 UI 加「常驻 / 闲置窗口」两个控件，走 `POST /policy` | 现在只有接口，运营还得用 curl | P2 |
| A6 | 装/卸连接器不再重建容器 | 写完 `cordis.patch.yml` 先等 HMR 热重载（stdio 连接器数子进程、http 走窗口+配置树），等不到才 `docker restart`；`restartDsh(team, mode)` 分 `reload` / `recreate` 两级 | 用户被白白踢下线 40 秒 | **已完成**（docs/20；实测装 2.4s、卸 2.5s，`PID1` 不变。顺带修了「卸掉最后一个连接器后 patch 只剩空白 → dsh 起不来」） |
| A7 | headless profile 默认挂归因插件 | 现在只有 web 种子里装了 `changes-collector`；headless 的 profile 由 dsh 首次运行时生成，要另做种子才能默认挂上 | headless/自动化的任务没有产物归因 | P2 |
| A8 | 非 git 工作区看不到 MCP / shell 写的文件 | `workspace-changes` 只认 dsh 自己的 `write`/`edit` 与 git 快照；实测用 `mcp__filesystem__write_file` 写文件时归因为空。想覆盖全部写入，可在 `/workspace` 里 `git init`（快照走 git，就与谁写的无关） | 「谁改的」看不全 | P1 |
| A9 | `/workspace` 变成唯一的工作区 | `bootstrap()` 只在 `initialized === false` 时按 cwd 自动建工作区，team-a 11-04 建了 `/home/dsh/测试1` 之后就永久跳过了，导致 cwd 在 `/workspace` 的会话全堆进「未分组」（那个桶不能新建会话、不能改名、不能拖，从它里面点新会话还会回落到「测试1」把用户拉回可写层）。做法：`migrate-workspaces.mjs` 摘掉根外登记 + 会话归档 + `initialized=false`，由 bootstrap 重建；`workspace-guard` 的 `ensureRoot` 幂等兜底并把英文目录名改成「工作区」 | 界面上看到的工作区和会话实际落点对不上，用户以为在「测试1」里干活，其实文件在 `/workspace` | **已完成**（docs/19 §五；`make verify-workspace-migrate` 31 条 + `verify-workspace-guard` 20 条。真机 team-a：旧工作区摘除、4 会话归档、8 会话归入「工作区」） |
| A10 | 工作区选择器要不要锁成单工作区 | A9 之后下拉里就只剩一个「工作区」，效果上等于固定；但「添加工作区…」仍然可用（多人多项目确实需要）。若产品上要彻底锁死，得在 `client-ui` 层隐藏入口——改注册表只能防写，防不住用户点 | 用户以为自己选的是「文档存哪」，其实只是一个逻辑分组 | 待定 |

**顺手修的（原 P0-2）**：`pruneSnapshots` 在 `backups/` 有两千多个文件时把事件循环按住几十秒
（逐条 `unlink` + 逐条 `console.error` 同步写终端），控制面 `/health` 连续 45 秒无响应，连带
auth 的 1.5 秒探活失败 → 用户看到 502。现在：10 分钟内只清理一次、单次最多删 20 个、失败聚合成一条。
实测启动到 `/health` 200 从「卡死几十秒」变成 **4 ms**。

## 六、其他已确认但未实施的（来自 docs/12、docs/13）

| # | 待办 | 出处 |
|---|---|---|
| D1 | ✅ **已完成**（docs/18）：`team_secrets` 信封加密 + 模型网关。容器里只有 `gl_` 开头的可吊销 token，真 key 不出控制面；`team-secrets.json` 已删除，`/proc/1/environ` 那个洞已实测关闭 | docs/18 |
| D2 | MCP 启停（现在只有装/卸，无 toggle） | docs/11 |
| D3 | `rendered_digest` 从未写入 | docs/12 |
| D4 | 全库 0 处事务，多表写入无原子性 | docs/12 |
| D5 | `market_tokens` 明文且 PK 是 `team_id` | docs/12 |
| D6 | `market_packages` 拆分（P0-2 根治：`market_current` 无 owner 会被抢） | docs/12 |
| D7 | P0-3 分享撞同名 | docs/12 |
| D8 | 镜像补 python3 + uv | 容器内实测无 python3，带 .py 的技能包跑不了。**python3/pip/venv 已完成**（docs/19，含 `python` 别名、PEP 668 放开、`PYTHONUSERBASE` 进卷）；`uv` 未做 | docs/13、docs/19 |
| D9 | ✅ **已完成**（docs/13 §12）：`market_item_files` 落文件 + `market_items.content` 删列 + digest 改算文件清单 + `/bundle` + `POST /market/upload` + 物化落盘（`market-skills/<name>@<ver>-<digest:8>/`）+ 启动预热 + 旧版本裁剪 + 归档排除。实测：3 文件包（含 `scripts/check.py`）上传→安装→物化→在容器里跑通；升级换目录；restart 后 mtime 不变（没重下） | docs/13 §12 |
| D10 | auth / registry 切表（三表已迁移但仍是影子数据，accounts.json 是真源） | docs/12 §2 |
| D11 | 技能 preset 作用域（按会话选技能） | 现在技能是**团队级**：装了就对所有会话可见，只能整体开/关。要「这个会话只带 SQL 技能、那个会话只带打标技能」，得把每类技能做成一个 preset，`market-skill` 按会话所属 preset 过滤候选；UI 用 `dsh-client-ui-agent-preset` 在**新建会话时**选，中途不能换（换了上下文里的技能清单会漂移）。产出：会话级隔离，装得多也不互相干扰 | docs/13 §12.1 |
| D12 | 发布护栏 | 三件：① 单包体积上限 32 MB / 8 MB 是估值，要统计一批真实包再定；② 上传只收 `tar.gz`，不收 zip（`fetch(url, {body: file})` 一行够用，zip 解析是几百行最易出越界问题的代码）；③ `scripts/` 的解释器不校验，写 `#!/usr/bin/env node18` 这种发出去也不拦 | docs/13 §12.1 |
| D13 | `MARKET_API_TOKEN` 走网关 | 容器里现在拿着能直连控制面 9700 的长期 token（虽只读）。跟 D1 的模型 key 一个道理：真凭据不出控制面，容器里只该有可吊销的短期凭据。改法同 D1——网关代理 `/market/*`，token 由网关注入并带过期 | docs/13 §8、docs/18 |
| D14 | `uv` 进镜像 | `python3`/`pip`/`venv` 已在（docs/19），`uv` 未做。带 `pyproject.toml` 的技能包装依赖会慢一个量级 | docs/19 §三 |
| D15 | ✅ 已恢复（观察）：headless 模型断流 | 11-11 晚 `STREAM_CUT: our free model continuation ended without a complete answer after 14~24s` 连复现两次；**11-12 22:30 重测 `POST /assistants/:id/test` 9.7s 正常产出回答**，判断是 `kilo-auto/free` 免费车道临时抖动，不是链路 bug。仍留着两个待查：`llm-deepseek` / `llm-deepseek-account` 启动时 `TypeError: Invalid URL` 未激活（「2 entries did not activate」），以及免费车道再抖动时没有自动切换 provider | 复发时群里会「问了不回」；要根治得配一个稳定的 provider / API key | P1（观察） |

## 七、Agent 能力与工具选用（实测记录见 `docs/features/10-定时任务能力实测.md`）

| # | 待办 | 做什么 | 不做的后果 | 优先级 |
|---|---|---|---|---|
| B1 | 「定时 / 每天 / 周期性」要真正走 dsh 的 `schedule_create` | 实测两次都失败：① 原始会话（web，51 个工具含 `schedule_create/list/update/delete`）调用 **0 次**，agent 自己写脚本 + 让用户去别处配 crontab（容器里 `crontab: not found`）；② 换成「以后每天早上 9 点提醒我…」的问法，headless 只有 44 个工具、**没有 schedule 工具**，agent 直接写了 systemd service + timer + install.sh 一套。根因两层：工具描述「reminder / current session / delivers prompt」与「定时任务」意图错配；headless 链路连服务都挂不上（`schedule` pending on `sessionController`）。修法：web profile 的 `agent-instructions` 加硬约束（定时/每天/每周/周期性/提醒到点 → 必须 `schedule_create`，禁止 crontab / `nohup` / `sleep` 循环 / systemd unit；脚本落 `/workspace`），并用 headless 验收 `tool/call` 出现 `schedule_create`、日志出现 `schedule/changed`、重启后 `schedule_list` 仍在 | 用户以为创建了自动化任务，实际没有任何东西在定时运行；给出的 crontab/system 方案在本环境无落点 | P1 |
| B2 | headless / SDK / ACP 链路补齐 schedule 能力 | 与 web 的工具差集 7 个（含 4 个 `schedule_*`）；简单 `--patch` 插 `schedule` + `tool-schedule` 会卡在 `waiting for service: sessionController`，要连带补齐 host runner 或改造成独立服务 | headless/自动化任务没有定时能力，只能靠自己写定时器 | P2 |
| B3 | 把风格检查做成 `make lint` 接 CI | 现在只有 12 个 `verify-*` 行为级自测，没有静态检查。建议至少固化三条：「插件禁止 `console.log`（stdout 会打挂 `dsh --json`）」「导出成员必须有 JSDoc」「禁止未使用的命名导入」；审查脚本原型见 `docs/features/09` | 同一类漂移会反复出现（本轮一次性修了 21 处） | P2 |

## 八、助理与钉钉 / 飞书消息通道（**「@ 才处理」版本已实现**，2026-11-11）

需求：门户里加「助理」菜单，可新增多个助理；**一个助理 = 一个机器人 + 一个固定 dsh 会话**，
多个助理互不冲突；支持钉钉、飞书自建应用；先做只有 @ 才处理消息的版本。
完整设计、竞品对照、接口与验证证据见 [`docs/features/11-助理与消息机器人.md`](./features/11-助理与消息机器人.md)。

**竞品差异**：WorkBuddy 的「助理（远程任务）」是**单会话**——多平台通道都汇到同一个会话、
工作目录固定、上下文不可清空（见官方「远程任务与普通任务的区别」表）。
我们要的是 N 个助理各开各的窗口，靠 dsh 的多会话架构 + 两条 UNIQUE 约束实现。

**关键前提修正**：`https://oapi.dingtalk.com/robot/send?access_token=…`（11-08 实测发通过的那类地址）
是**自定义群机器人 webhook，单向只发不收**。收消息必须另配钉钉企业内部应用机器人 +
`ClientId/ClientSecret`，入站走 **Stream 出站长连接**（推荐，不需要公网 IP/HTTPS 回调）或 HTTP 回调
（要公网 HTTPS，当前 Caddy 只有 `*.localhost`）。所以一个助理要绑的是「入站应用凭证 + 出站通道 + 触发规则」
三组配置，不是一个 webhook。

| # | 待办 | 做什么 | 风险 / 前置 | 优先级 |
|---|---|---|---|---|
| E0 | ✅ 钉钉真实群联调已打通 | 22:29 真实群 @ 消息（`msgId`、`conversationId` 见流水）→ `status=done`、`elapsed=10135ms`、回信 POST 成功。飞书仍需公网回调地址或 Stream SDK | 原证据与原始流水见 docs/features/11 | 飞书待做 |
| E1 | ✅ 助理实体 + 侧栏面板 + 门户页 | `init-db.sql` 加 `assistants` / `assistant_messages`；`deploy/auth/server.mjs` 加 `/__auth/assistants` 页与 `/__auth/api/assistants*` JSON 接口；`plugins/client-ui-assistants` 在 dsh 侧栏注册「助理」面板（卡片列表 / 内联表单 / 回调地址复制 / 凭据红绿点 / 流水）；控制面 `/assistants` CRUD + 「测试发送」 | 门户要按 team 隔离，owner 可增删改 | P1 |
| E2 | ✅ 模式 A：被 @ 才处理 | 新增 `deploy/orchestrator/assistant-gateway.mjs`：Stream 客户端 → 验签/`msgId` 去重 → 按 `robotCode`/`conversationId` 匹配助理 → 规则过滤 → **每个助理一条串行队列** → `dsh --profile headless --json --session-id <sid> "<prompt>"` → 取 `text` 事件 → 按 4000 字符分片 → POST `sessionWebhook`（过期则回落到助理绑定的自定义 webhook） | 同一会话有 `session.lock`，并发跑会打架；headless 实测可能 >180s，群里必须先回「收到」再异步发结果；Stream SDK 默认空 logger 要桥接，否则「一片寂静」难排查 | P1 |
| E3 | 模式 B：监控群内指定消息 | 助理配规则（关键词/正则/发送人白名单/消息类型）。若 E0 确认能拿全量消息则复用 E2 链路只换过滤；否则走 DWS / 消息查询 API 按 `conversationId` 主动拉取（准实时、轮询），或降级为「@ + 关键词」 | 依赖 E0；全量监听涉及群成员知情与合规，需管理员审批 | P1（有外部依赖） |
| E4 | ✅ 凭据与流水 | `ClientId/ClientSecret/webhook token` 走 `secrets.mjs` 信封加密，`scope = assistant:<id>`；加 `assistant_messages`（msgId 去重、谁、哪个群、输入、输出、耗时、状态）做审计与重放 | 绝不能明文进 env / 表；`sessionWebhook` 有 `sessionWebhookExpiredTime`，长任务要兜底 | P1 |
| E5 | 与既有待办联动 | ① D11 技能 preset：助理天然是「按会话选技能」的落地点，可给助理绑技能组；② B1 定时任务：若 `schedule_create` 修好，助理会话可「每天 9 点主动发群消息」，成为第三种模式；③ A7：headless 默认没挂 `changes-collector`，助理会话的产物归因会漏 | 依赖 D11 / B1 / A7 | P2 |
| E6 | ✅ 失败/超时兜底（入站回执未做） | `dispatcher` 在 `failed/timeout` 时会往原会话回一句「跑了 N 秒没答完 / 没处理成功 + 简短原因」（`shortError` 把 headless 堆栈压成一句），不再沉默；没有回信地址就只记流水。**入站「收到，正在处理」故意没做**：每条都回执会刷屏，等真实需求再说 | `postReply` 顺带加了 10s 超时，webhook 卡住不再占着串行队列 | P1（部分完成） |
| E7 | ✅ 钉钉 Stream / 飞书待做 | 钉钉已落地：`assistant-stream.mjs` 自己实现了网关注册 + WebSocket + 帧回执（没引 SDK，Node 22 自带 WebSocket），`make verify-stream` 46 条 | 飞书的 Stream 长连接仍未接，只支持 HTTP 回调 | 钉钉已完成；飞书 P2 |
| E8 | 高风险操作二次确认 | 对齐 WorkBuddy 助理的安全边界：涉及文件删除、系统配置修改、命令批准时要用户确认 | 群里远程触发比本地更容易误操作 | P2 |
| E9 | ✅ 钉钉 OpenAPI 主动发送 | `dingtalk-openapi.mjs`：`oauth2/accessToken`（7200s，缓存续期、401 重试）+ `robot/groupMessages/send`（群）/ `robot/oToMessages/batchSend`（单聊）。出站顺序 OpenAPI → sessionWebhook → OUTBOUND_WEBHOOK，彻底摆脱 1.5 小时限制；`/assistants/:id/test` 支持 `conversationId` 真发到群 | 自建应用 `robotCode` 实测 = Client ID；`verify-openapi` 23 条 | 已完成 |
| E10 | 会话标题被首条人设占满 | dsh 用「首个 prompt」生成标题，而首轮 prompt 是人设 + 问题，侧栏标题就成了「你在钉钉群里被 @ 后回答。回」。试过 `--patch` 给 `@deepseek-ai/dsh-system-prompt` 设 `personaPrefix`，**实测没生效**（回复完全没受约束），可能是 headless bundle 里该插件的 config 被更高优先级覆盖。备选：① 查真正的注入点；② 首轮 prompt 把人设放后、问题放前（标题会变成问题，但人设次轮仍在上下文里）；③ 让控制面调 dsh 的会话重命名 API | 影响观感不影响功能；手动在 UI 里改名可绕过 | P2 |
| E11 | 旧助理会话无法迁到代理工作区 | 实测 dsh 不支持跨 cwd 迁移：改会话文件 header + `session_projcache` 的 `identity.cwd`/`workingDirectory` + 重启后，`attachSession` 仍报 `its cwd resolves to '/workspace'`（有更高层会话索引）。`migrate-agent-sessions.mjs` 已标 deprecated；旧会话留在「工作区」当历史，或手动删。替代：给助理加「重置会话」按钮，新会话自然进代理工作区 | 影响「彻底分开」的观感，不影响新消息归属 | P2 |
| E12 | ✅ 属主异常导致「侧栏暂无会话」 | `docker cp` 进容器的文件属主是宿主 uid（501），dsh 是 1000 且会话文件 600 → `EACCES` → `workspaceRegistry` 起不来 → 下游插件全 `pending`，侧栏空白（数据其实没丢）。容器内 `-u 0` 无特权、`chown` 不可用，只能以 dsh 从 stdin 重写。已固化为 `make fix-perms` / `make fix-perms APPLY=1`（`fix-session-perms.mjs`），验证过 501:0 → 1000:1000 且内容不变 | 排查口诀：先 `docker logs \| grep EACCES`，别急着恢复备份 | 已完成 |

### 落地状态（2026-11-11）

**已完成**：`init-db.sql` 加 `assistants` / `assistant_messages`（两条 UNIQUE 约束）；
新增 `assistants.mjs`（CRUD、串行队列、全局信号量、首轮建会话、分片）、
`assistant-channels.mjs`（钉钉/飞书归一化、加签/token/challenge、回复体）、
`assistant-http.mjs`（只收 stdout 的 headless 调用、入站路由、管理路由、凭据写入 team_secrets）；
`console.mjs` 把入站回调排在 console-token 之前；`server.mjs` 加门户「助理」页与团队卡片入口；
`make verify-assistants` **64 条全过**，13 个 `verify-*` 回归全绿。

真机 team-a 记录：无签名 401 / 飞书 challenge 正确返回 / 错误 token 401 / 未知机器人 404 /
非 @ 消息流水 `ignored` 且不跑 dsh / @ 消息流水 `running → failed (6663ms, fetch failed)` /
`session_id` 由 headless 返回后回写为 `session-fe0f51c1-…`。出站故意用假地址验证错误路径。
测试助理与流水已删除。

### 2026-11-12 补充：钉钉 Stream 上线

新增 `assistant-stream.mjs`（网关注册 → WebSocket → 帧回执 → 换票重连，没引 SDK）、
`verify-stream.mjs`（46 条）；`CREDENTIAL_KEYS` 加 `APP_KEY / AGENT_ID`；
`assistant-http.mjs` 增 `onChange` 回调，助理增删改后控制面即时重连；
`console.mjs` 启动时 `startAssistantStreams()`、`SIGTERM` 时断开；
auth 门户与登录页同步（`LOGIN_PREFILL_*` 预填调试账号）。

真机：控制面日志 `stream ding0h… connecting → connected`；助理 `as-example0001` 三项凭据齐；
`POST /assistants/:id/test` 当时只差模型——`elapsed 26.7s`，错误是 `STREAM_CUT`（见 D15，
11-12 22:30 重测 9.7s 已正常出回答）。22:29 已有一条真实群消息 `status=done`，
E0 钉钉侧端到端打通，见 docs/features/11「消息去哪了」。

**未做**：真实平台联调（E0）、非 @ 监控（E3）、进度回执（E6）、Stream SDK（E7）。

### 界面层（2026-11-11 追加）

侧栏面板 `plugins/client-ui-assistants` 已上线：侧栏「助理」→ 卡片列表 → 内联新建/编辑 →
「回调地址」一键复制 → 凭据红绿点 → 消息流水。数据走 auth 的 `/__auth/api/assistants*`，
不直连控制面（token 不进浏览器）。平台字段说明与回调地址都由服务端下发，
加平台只改 `ASSISTANT_PLATFORMS` 一张表。

联合验证：未登录 401 / 首屏 `manage:true` + 回调地址 `local:true` / 创建后
`credentials.verifyToken:true`、其余 false / 错 token 回调 401 / 未 @ 消息 `ignored` / 删除后剩余 0；
`make verify-assistants` 仍 64 条全过。

**仍然卡在 E0**：地址算出来了，但本机名平台打不进来（面板上有黄条明说）。
要真跑起来，二选一：内网穿透 + `ASSISTANT_INBOUND_BASE`，或做 E7 的 Stream。

**一个助理 = 一个固定 `sessionId` 的 dsh 会话 + 一个 team**（决定用哪个实例、哪些技能/MCP、哪个 `/workspace`），
不是每次新建会话 —— 这才对应「给机器人开一个对话窗口」，上下文能连续。
多个助理共用同一个 dsh 容器，靠 `--session-id` 隔离；全容器并发闸门默认 2。

