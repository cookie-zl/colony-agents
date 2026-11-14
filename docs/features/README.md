# 功能地图 · 总览与索引

> 这一套文档按 **需求 → 技术方案 → 实现功能** 三段式，把「目前到底做了什么」逐域列清楚。
> 它和 `docs/01`–`docs/20` 的分工：**根目录下的 NN 文档是设计记录**（为什么这么选、踩过什么坑），
> **这里是功能清单**（已经落地的能力、入口文件、验证证据）。互为链接，不互相替代。

最后核对：2026-11-10 · 代码基线 `colony-agents:0.2.1-rc.5` · 真机团队 `team-a`

## 一、需求

项目从「一台机器上跑一个 dsh」长成了「多团队、可发版、可休眠、数据不丢」的小平台。
改动分散在控制面（`deploy/orchestrator`）、镜像入口（`deploy/image`）、容器内插件（`plugins`）
三处，跨了 20 多篇设计文档和若干次迭代。**新接手或过一阵回来查，很难快速回答三个问题**：

- 某个能力到底做没做、做到什么程度？
- 它落在哪个文件、从哪个入口触发？
- 有没有真机验证过，还是只写了设计？

这套文档就是把这三个问题一次性答完。

## 二、技术方案

按**功能域**拆文档，不按时间、也不按代码目录。每份固定三段：

| 段落 | 回答什么 | 写法约束 |
|---|---|---|
| 一、需求 | 原始痛点、用户视角的现象 | 先说「不这么做会怎样」 |
| 二、技术方案 | 架构决策、被否掉的选项 | 写清「为什么不是另一个方案」 |
| 三、实现功能 | 能力清单、入口文件、验证证据 | 每条都要能对应到具体文件/接口/自测脚本 |

**不写**未实现的设计（那些留在 `docs/ROADMAP.md`），**不复制**设计文档里的推演过程。
每份末尾固定给「对应设计文档」和「未完成项」，方便下钻。

## 三、实现功能 · 文档索引

| 文档 | 覆盖域 | 主要落地位置 | 状态 |
|---|---|---|---|
| [01 · 平台基础与交付](./01-平台基础与交付.md) | 本地运行、镜像三层配置、插件机制、Zadig/Helm | `deploy/image/`、`deploy/zadig/`、`Makefile` | 已完成 |
| [02 · 多团队与访问控制](./02-多团队与访问控制.md) | 一团队一实例、SSO、动态建团队、token 接缝 | `deploy/auth/`、`deploy/orchestrator/console.mjs`、`team-up.sh` | 已完成 |
| [03 · 实例生命周期与运维](./03-实例生命周期与运维.md) | 休眠唤醒、配额、对账、归档恢复、观测 | `runtime.mjs`、`store.mjs`、`metrics.mjs` | 已完成（容量项待办） |
| [04 · 会话存算分离与对象层](./04-会话存算分离与对象层.md) | 会话索引、增量同步、对象层、唤醒拉回 | `sessions.mjs`、`objects.mjs`、`db.mjs` | 已完成 |
| [05 · 产物归因与工作目录](./05-产物归因与工作目录.md) | 轮级归因、工作区固定、Python 预装 | `plugins/changes-collector`、`artifacts.mjs`、`workspace-guard`、`migrate-workspaces.mjs` | 已完成 |
| [06 · 技能市场与多文件包](./06-技能市场与多文件包.md) | 市场数据模型、多文件包、物化、分享 | `market.mjs`、`bundle.mjs`、`plugins/market-skill` | 已完成 |
| [07 · 连接器热生效与 agent 配置](./07-连接器热生效与agent配置.md) | HMR 热应用、重启分级、参数跨重启 | `reload.mjs`、`profile-patch.mjs`、`agent-config.mjs` | 已完成 |
| [08 · 密钥网关与凭据](./08-密钥网关与凭据.md) | 真 key 不出控制面、团队 token、市场 token | `secrets.mjs`、`llm-gateway.mjs` | 已完成 |
| [09 · 代码规范审查](./09-代码规范审查.md) | 模块规范符合度、已修问题、遗留建议 | 全仓 `.mjs` / `.js` | 已审（21 处已修） |
| [10 · 定时任务能力实测](./10-定时任务能力实测.md) | 「让 agent 建定时任务」为什么没走 dsh | 会话日志、`cordis.patch.yml` | **实测结论：未达标，待办** |
| [11 · 助理与消息机器人](./11-助理与消息机器人.md) | 多助理、一助理一会话一机器人、钉钉/飞书 @ 才处理 | `assistants.mjs`、`assistant-channels.mjs`、`assistant-http.mjs`、`assistant-stream.mjs`、`plugins/client-ui-assistants`、门户 | 已完成（@ 版 + 侧栏面板 + 钉钉 Stream 已连上；真群 @ 待联调） |

## 四、按问题查

| 你想确认 | 看哪份 |
|---|---|
| 发版/重建后什么会丢 | [04](./04-会话存算分离与对象层.md) + [05](./05-产物归因与工作目录.md) |
| 装个技能/连接器要不要停服 | [07](./07-连接器热生效与agent配置.md) |
| 某个团队的数据别人能不能看到 | [02](./02-多团队与访问控制.md) + [08](./08-密钥网关与凭据.md) |
| 「这一轮改了哪些文件」去哪查 | [05](./05-产物归因与工作目录.md) |
| 群里 @ 机器人怎么转到 dsh、能开几个助理 | [11](./11-助理与消息机器人.md) |
| 团队闲置后被停了怎么回来 | [03](./03-实例生命周期与运维.md) |
| 模型 key 存在哪 | [08](./08-密钥网关与凭据.md) |
| 还没做的有哪些 | `docs/ROADMAP.md`（按会话 / 容量 / 生命周期 / Agent / 市场 / 助理分组） |

## 五、自测入口

全部走 `make`，共 13 个脚本，2026-11-11 重跑全绿：

```
verify-ownership  verify-sessions   verify-shadow       verify-gateway
verify-objects    verify-profile    verify-workspace-guard  verify-workspace-migrate
verify-artifacts  verify-reload     verify-market-patch  verify-bundle
verify-assistants
```

已知带计数的：`verify-gateway` 38 条、`verify-profile` 30 条、`verify-workspace-guard` 20 条、
`verify-workspace-migrate` 31 条、`verify-artifacts` 39 条、`verify-reload` 16 条、
`verify-market-patch` 19 条、`verify-bundle` 55 条、`verify-assistants` 64 条。

## 六、当前未完成（详见 `docs/ROADMAP.md`）

| 优先级 | 代表项 |
|---|---|
| **P0** | 无 |
| **P1** | S6b 产物文件本体进对象层；A8 非 git 工作区看不到 MCP/shell 写入；C1–C6 容量与观测；L3–L6 生命周期分档；B1 定时任务能力；E0 真实 IM 应用凭证/公网回调联调；E3 非 @ 群消息监控；E6 助理进度回执与失败提示 |
| **P2** | D11 技能 preset 作用域、D12 发布护栏、D13 市场 token 走网关、D14 `uv` 进镜像、A7 headless 默认挂归因插件 |
| 待定 | A10 是否隐藏「添加工作区…」入口 |
