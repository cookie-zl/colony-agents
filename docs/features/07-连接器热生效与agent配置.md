# 07 · 连接器热生效与 agent 配置

> 一句话：装/卸连接器不再重建容器（2.4 秒热生效，`PID1` 不变）；UI 里改的 agent 参数能活过发版。
> 对应设计文档：[docs/17](../17-agent参数与工作目录.md)、[docs/20](../20-产物归因与配置热生效.md)、
> [docs/11](../11-技能与连接器.md)

## 一、需求

| 原始问题 | 不做的后果 |
|---|---|
| 装一个连接器走 `compose up --force-recreate` | 全团队被踢下线，冷镜像 40 秒以上；1:1 后降级为「自己等几秒」，仍比重载差一档 |
| UI 里改的模型 / preset / 工具开关，重启回默认 | 用户以为「保存了」，实际被镜像基线覆盖 |
| 卸掉最后一个连接器后 patch 文件只剩空白 | dsh fatal：patch 必须是顶层 YAML 数组 → 容器重启循环 |
| 判断「配置生效了没」只看等了几秒 | HMR 默认 `awaitWriteFinish` 要 2 秒，探针数到自己会谎报成功 |
| env 变更用 `docker restart` | restart 沿用旧 env，「看起来成功了但根本不生效」 |

## 二、技术方案

**三级生效判据**（`reload.mjs: createReloadWaiter()`）：

```
① process   数 /proc/*/cmdline 里的 stdio 连接器子进程 → confirmed: true（最硬）
② hmr-window 等 HMR 窗口（3.5s）+ --dump-config 验配置树 → confirmed: false
③ 超时（12s）降级 docker restart
```

探针脚本必须**排除自身**：`node -e <脚本>` 的 cmdline 含 token 字面量，不排除则永远命中 ≥1。
实测这个坑会让 `waitedMs: 62` 谎报生效（HMR 至少要 2 秒）。

**`restartDsh(team, mode)` 两级**：

| mode | 动作 | 适用 | 实测 |
|---|---|---|---|
| `reload` | `docker restart` + `waitHealthy(port, 90s)` | profile / 插件配置 | 5 秒到 healthy，`PID1` 不变 |
| `recreate` | `compose up --force-recreate` | **env 变更必须走这条** | 9 秒（冷镜像 40 秒+） |

**patch 空集合唯一合法写法是 `[]`**：空白解析成 `null` → `must be a top-level YAML array of loader patch entries`
→ fatal。`normalizePatchText()` 把空内容写成 `[]`；`mergeMcpBlock()` 必须把 `^\[\s*\]$` 也视为空，
否则拼出「`[]` 后跟 `- insert`」同样 fatal。写 patch 后一律 `validatePatch`，失败 `restorePatch` 回滚
—— 装和卸两条路径都要有（最初只有装的时候有）。

**agent 参数「卷内自愈 + 卷外权威」**：`profile-patch.mjs` 在 seed 前后按 id 叠用户层，
`team_agent_config` 表存卷外权威副本；睡前与 5 分钟扫描入库；归档恢复到新卷时注入。
对齐的是「配置跟着团队走，不跟着沙箱走」。

## 三、实现功能

| 功能点 | 入口 / 文件 | 关键行为 |
|---|---|---|
| 热重载判定 | `reload.mjs: probeScript / createReloadWaiter` | 常量 `HMR_WINDOW_MS=3500`、`PROBE_TIMEOUT_MS=12000`、`ABSENT_SETTLE_MS=1500` |
| 包变更统一入口 | `console.mjs: applyPackageChange(team, result)` | 热重载成功 → `restartRequired:false`；失败 → `restartDsh(team,'reload')` + `reload.fallback:'restart'` |
| 重启分级 | `console.mjs: restartDsh(team, mode)` | `reload` / `recreate` 两条路径 |
| patch 拼接与归一化 | `market.mjs: renderMcpBlock / mergeMcpBlock / normalizePatchText / probeTokens` | 标记块、空集合 `[]`、写后校验 + 失败回滚 |
| 装/卸连接器 | `market.mjs: installMcp / uninstallMcp` | 返回 `expect:'present'\|'absent'` + `probe:{id,tokens}` 供控制面判定 |
| agent 参数捕获/应用 | `agent-config.mjs: captureAgentConfig / applyAgentConfig` | 卷内 capture → 库 → 新卷 apply |
| profile 叠层 | `deploy/image/profile-patch.mjs` | 按 id 合并用户改动到镜像新基线 |
| 读写接口 | `GET/POST /agent-config`、`POST /agent-config/capture` | 门户与 CLI 共用 |
| 分享启用也走热生效 | `POST /market/share/enable` → `applyPackageChange` | 与装/卸同一判定 |

**验证证据**

| 项 | 结果 |
|---|---|
| `make verify-reload` | 16 条通过（子进程出现/消失、超时降级、无子进程那一档、探针排除自身） |
| `make verify-market-patch` | 19 条通过（真解析 YAML，钉住「空 → `[]`」「`[]` 追加」「卸载回 `[]`」） |
| `make verify-profile` | 30 条通过 |
| 真机卸载 filesystem | **2.45 s**，`basis=process, confirmed=true, waitedMs=2083`，`PID1` 不变，patch 归一成 `[]` |
| 真机安装 filesystem | **2.42 s**，`waitedMs=2044`，MCP 子进程在请求后 3 秒起来 |

**踩过并修掉的坑**（`docs/20 §四`）

1. 空 patch → 容器重启循环（现场用挂载卷改回 `[]` + `docker restart` 恢复）
2. `mergeMcpBlock` 把 `[]` 当普通文本 → install 返回 500
3. 探针数到自己 → 62ms 谎报生效
4. 插件 `console.log` 污染 `--json` 事件流 → `JSON.parse` 报 `Unexpected token 'c'`

**未完成 / 边界**

- **env 变更仍必须 `recreate`**：`docker restart` 沿用创建时的 env，这条不能优化掉
- Headless / SDK / ACP 组合包在 YAML 里**禁用 HMR**，只有 web 开启；那些链路仍走重启
- `restartRequired` 现在大部分场景是 `false`，但 K8s 侧仍靠控制面 `rollout restart` 兜底
- TODO D2：MCP 只有装/卸，没有 toggle
