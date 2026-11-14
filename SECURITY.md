# 安全策略

## 报告漏洞

**不要开公开 issue。** 用 GitHub 的私信 / Security Advisory（仓库 → Security → Report a vulnerability），
或在仓库主页找到维护者联系方式私下说明。

请在报告里给出：影响版本、复现步骤、影响面（能否越权/读别人的会话/拿到模型 Key）、
你认为的修复方向。48 小时内会回一次；修复发布后会在这里致谢（除非你要求匿名）。

## 这个项目的安全模型

先把边界讲清楚，避免「以为它安全」：

| 层 | 谁负责 | 说明 |
| --- | --- | --- |
| 网络准入 | **你** | dsh 的身份是「URL 里的 token → 签名 Cookie」，拿到 token 就能进。生产必须在反代 / 网关做 IP 白名单、Basic Auth 或 SSO，见 [docs/06](docs/06-访问控制.md) |
| 团队成员 | 账号服务 | 登录、改密、团队角色、跨团队票据、审计日志 |
| 模型凭据 | 密钥网关 | Key 信封加密进库（AES-GCM + KEK），容器只拿可吊销的短令牌；KEK 在 `deploy/orchestrator/secret.key`，**丢了所有已存密钥都要重配** |
| 插件 | **你** | 插件是**进程内代码**，`apply(ctx)` 权限等于 dsh 本身，没有沙箱。装社区插件前请读源码，并锁到确切版本 |
| 容器 | Docker / K8s | 非 root 运行、内存与 CPU 上限、只挂必要目录 |

## 部署前检查清单

- [ ] `deploy/compose/.env` 里没有明文模型 Key（用 `make team-key`）
- [ ] `deploy/auth/accounts.json` 不是仓库里的示例账号（`alice / dsh-demo-1234` 等必须改掉）
- [ ] 入口前面有真鉴权（不要只依赖 dsh 自己的 token）
- [ ] `deploy/orchestrator/secret.key`、`console-token`、`tokens/*` 权限 600，且不进版本库
- [ ] 对外暴露前确认 `plugins.txt` 里每个插件都看过源码、锁了版本
- [ ] 审计日志有地方落盘（`deploy/auth/audit/`），并纳入备份

## 已知取舍（不是漏洞，但要知道）

1. **会话共享 = 数据共享。** 同一实例里的成员能看到彼此的历史；要隔离就一人一实例。
2. **`assistants` 的工作目录在 `/workspace` 之下。** Agent 能读写这个工作区，这是设计如此；
   不要把宿主机敏感目录挂进去。
3. **审计不含正文。** 群消息内容不进控制面日志，只在消息流水里；这是刻意的隐私取舍。
4. **dsh 上游的漏洞同样影响本平台。** 升级方式见 [docs/04](docs/04-镜像与profile.md)。
