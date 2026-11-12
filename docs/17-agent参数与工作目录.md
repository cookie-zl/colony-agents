# 17 · agent 参数与工作目录

docs/16 指出两个缺口：**agent 参数每次重启回默认**、**会话 cwd 在可写层重建即丢**。
这篇记实现：怎么对齐的、改了什么、验证到什么程度。

## 一、WorkBuddy 云端是怎么做的

他们的官方口径（企业智能体文档 + 官方号实测文）可以压成三层：

| 概念 | 含义 | 与我们对应 |
|---|---|---|
| **Runtime** | 真正跑起来的云端沙箱，含沙箱实例 + **Agent 的配置（Manifest）** + 一个或多个 Session | 一个团队实例 |
| **Session** | 用户与 Agent 的一次完整会话，独立对话历史与文件存储 | 一个对话 |
| **Manifest** | 声明式配置（JSON）：`id` / `name` / `system_prompt` / `workspaces` / `secrets` / `envs` / `initShellCommand` | 我们的 profile + patch |

关键设计有六条，逐条看能不能照搬：

| 他们的做法 | 解决什么 | 我们能照搬吗 |
|---|---|---|
| **配置存平台，进沙箱时应用**（Manifest 由企业后台维护，发布时汇入） | 沙箱是一次性的，配置不能长在沙箱里 | ✅ 照搬。这正是 `team_agent_config` 表 + `inject.json` 做的事 |
| **版本管理**：Checkpoint / Version，改坏可回滚 | 换错模型要能退回 | ✅ 照搬（我们的 `revision` 单调递增，回滚 = 把旧 rows 再存一版） |
| **workspaces 映射到 `/workspace/<name>`**，资料从 Git / downloadUrl 挂进来 | 工作目录有唯一口径，不依赖容器内随意路径 | ✅ 已照搬（`workspace-guard` 插件改写 `workspaceRegistry.create`，见 docs/19） |
| **secrets 走安全通道注入，不落沙箱文件** | 密钥不跟着产物外泄 | ✅ 已照搬（`docs/18`）：模型网关，容器里只有可吊销 token，真 key 不出控制面 |
| **Session 10 分钟无访问自动休眠** | 省资源 | ❌ 不照搬：他们一个沙箱只服务一个人，我们一个团队多人共享，10 分钟会误伤 |
| **每轮跑完存快照，异常退出从 checkpoint 续跑** | 长任务不白跑 | ⚠️ dsh 本身有 checkpoint（每个 tool call 前），但没有「轮级快照」 |

一句话：**配置跟着团队走，不跟着沙箱走**——这是他们最值得抄的一条，也是我们原来缺的那条。

## 二、agent 参数：卷内自愈 + 卷外权威

### 两个写入方，一个读取点

dsh 只认 **active profile patch**（`profiles/web/cordis.patch.yml`），Home patch 和 `--patch`
只读。而 entrypoint 的 `refresh` 每次启动都会 `rm -rf profiles/web` 再重铺。所以：

```
UI 改设置 → profiles/web/cordis.patch.yml ──┐
                                            │  entrypoint 启动时
镜像 seed ──→ 同一个文件（覆盖）─────────────┤
                                            ▼
                              profile-patch.mjs 合并 → dsh 读到的最终配置
```

### 合并算法（`deploy/image/profile-patch.mjs`）

启动时三步：

```sh
node profile-patch.mjs capture   # 把上一轮结束时的 patch 存成 prev.json
rm -rf profiles/web && cp -a 镜像 seed
node profile-patch.mjs merge     # baseline + prev 求用户改动，叠到新 base 上
```

求改动是**按 id 比对两条投影**，不是文本 diff：

| 情况 | 判定 | 结果 |
|---|---|---|
| prev 有、baseline 没有 | 用户新增 | 追加 |
| prev 有、baseline 有、内容不同 | 用户改过 | 覆盖镜像基线 |
| baseline 有、prev 没有 | 用户删了 | 从结果里删掉（不复活） |
| baseline 有、prev 也有、内容相同 | 没动过 | 用镜像新基线（升级能带新默认） |

三个刻意的取舍：

1. **没有改动就不重写文件**。大多数团队从没在 UI 里改过设置，这时 base 原样保留，
   注释也不丢（实测字节完全一致）。
2. **真改过才重写**，重写时注释会丢（dsh 自己写回也会丢），所以在文件头补一段说明。
3. **yaml 库从 dsh 的 node_modules 里借**（`createRequire`），不额外装包，解析语义跟 dsh 一致；
   借不到就跳过合并并打日志，绝对不动文件——宁可这一轮回到默认，也不能把配置写坏。

### 卷外副本（`team_agent_config` + `agent-config.mjs`）

卷内自愈解决「容器重建」，解决不了「卷没了」（归档 `down -v`、换节点）。所以：

| 时机 | 动作 | 为什么 |
|---|---|---|
| 每 5 分钟扫描（跟会话同步同一个循环） | `captureAgentConfig`：读卷里 `effective.json` → 入库 | 长驻不休眠的团队永远等不到「睡前同步」 |
| 睡前同步 | 同上 | 睡着后可能几天没人访问 |
| 归档恢复（解包完、容器起之前） | `applyAgentConfig`：把库里最新一版写成卷里 `inject.json` | 新卷里没有用户层，容器一起来就会用镜像默认 |
| 容器启动 | `profile-patch.mjs` 优先读 `inject.json`，用完即删 | 一次性注入，不能长期压制用户的新改动 |

`effective.json` 是「用户改动集合」的导出（合并后顺手写），不含镜像基线——这是关键：
基线随镜像升级自动变，只存差异才能既保住用户改动、又吃到新默认。

### 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/agent-config?team=X` | 最新版本 + rows + 近 10 版历史（只读库，容器睡着也能查） |
| POST | `/agent-config` | 覆盖一版（`rows` 数组），写库 + 写卷 inject，下次启动生效 |
| POST | `/agent-config/capture` | 手动从卷里收一次（平时自动） |
| POST | `/policy` | 改 `autoSleep` / `idleMs`，下一轮扫描生效 |

## 三、工作目录：启动前补建

dsh 对 cwd 的处理（`dsh-workspace/lib/index.js:887`）：`ENOENT` 时同时进
`missingSessionPaths` 与 `invalidSessionPaths`，会话仍出现在侧栏但目录不存在。
所以补建必须在 **dsh 读索引之前** —— 只能放在 entrypoint：

```sh
node /opt/dsh/prepare-workspaces.mjs || true   # 读 storages/workspace.json → mkdir -p
exec dsh "$@"
```

它做的事很少：读 `tables.workspaces[*].path`，只补容器内绝对路径，失败只打日志。
建出来的是空目录——产物本身回不来（那属于 S6 产物清单），但会话恢复可用。

默认工作目录本来就是 `/workspace`（容器 `WORKDIR`，bind mount 到宿主 `workspace-team-X`），
所以风险只来自用户在目录选择器里手动选了 `/home/dsh/**`。

## 四、验证到什么程度

| 验证 | 结果 |
|---|---|
| `make verify-profile`（30 条） | 全部通过：无改动不动文件、改模型保留、**连续三次重启都保留**、新增行保留、删除不复活、首次启动只记基线、运行期改动可现算、yaml 缺失不破坏文件、cwd 补建幂等、坏索引不崩 |
| `make verify-sessions` / `verify-objects` | 回归全部通过 |
| 控制面接口（9701 实例真机） | `/agent-config` GET/POST 往返、`/policy` 写入与非法值拒绝、`inject.json` 落卷、`capture` 入库，全部符合预期 |
| 启动卡顿修复 | `backups/` 2914 个文件时原来要卡 45 秒、刷 2140 行日志；现在启动到 `/health` 200 只用 **4 ms**（节流 + 单次限 20 个 + 失败聚合一条） |
| **真机：agent 参数跨重建** | team-c 注入 `deepseek-official/deepseek-flash` → `docker rm` + 重建 **两次**，日志都是 `capture 1 行 → 叠加用户层 1 行`，patch 两次都保持用户值；`baseline.json` 里是 `our-free-model`（镜像基线），符合「基线只记镜像给的」 |
| **真机：cwd 补建** | team-a 重建后日志 `prepare-workspaces: 补建 /home/dsh/测试1`，目录被建出来、两个会话文件都在、dsh 不再报 `cwd does not resolve` |

真机验证时发现并修掉的一个真 bug：`merge` 原来把**合并结果**写进 `baseline.json`，于是下一次启动
`prev` 与 `baseline` 天然相同、`delta` 恒为空，**用户的改动第二次重启就被静默丢掉**。
现在 baseline 记的是「这次 seed 的镜像基线」，写在合并之前。`verify-profile` 里那条「连续三次重启」
就是为它加的回归。

另一个顺手修的：`team-up.sh up` 原来只 `docker compose up -d`，镜像 tag 没变（同版本重打）时
compose 只会 `start` 旧容器 —— 新 entrypoint 和新脚本根本不生效，表现就是「发版了但行为没变」。
现在固定加 `--force-recreate dsh`：`up` 的语义是发布，重建是预期行为；只想让实例醒着用 `wake`。

## 五、已知限制

- **运行中的容器不会即时生效**：`POST /agent-config` 写的是 inject，要等下一次启动。
  想立刻生效得重启实例（`restartDsh`），但重启会打断正在跑的 turn。
- **只合并顶层条目**：patch 里嵌套 `include` 的子 profile 不在处理范围（当前没用到）。
- **删除靠比对推断**：如果镜像在某次升级里删掉了一行，而你上一次运行的文件里还有它，
  会被当成「用户新增」复活一次。概率低，日志会记下叠加了几行。
- **工作目录只是补建**，产物持久化仍是 S6；用户在 `/home/dsh/**` 里写的文件照样会丢（空目录回来）。
- ~~`secrets` 仍明文（D1）~~ → 已解决，见 `docs/18-密钥网关.md`。
