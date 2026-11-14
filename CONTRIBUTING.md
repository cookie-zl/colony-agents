# 贡献指南

先说清楚这个项目的偏好：**宁可不加功能，也不要加一个「看起来能用」的功能**。
仓库里所有能跑的东西都有对应的离线自测，PR 也一样要求。

## 开发环境

需要 Docker 与本机 Docker（`verify-*` 脚本会用到，大部分不需要）。Node ≥ 22。

```bash
git clone https://github.com/cookie-zl/colony-agents.git && cd colony-agents
make seed     # 生成运行时配置（accounts.json / nodes.json / .env）
make up       # 起 team-a
```

改插件不需要重新构建镜像：

```bash
make reload   # 重新打包插件 + 替换容器，约 10 秒
make logs     # 跟日志
```

## 改动之前

- **加平台接入**（Slack / 企微 / …）：改 `deploy/orchestrator/assistant-channels.mjs` 的归一化函数
  与 `deploy/auth/server.mjs` 的 `ASSISTANT_PLATFORMS` 表，前端不用动。
- **加插件**：复制 `plugins/hello-dsh` 作骨架，`package.json` + `index.js` + `cordis.patch.yml` 三件套。
- **改数据模型**：`deploy/orchestrator/init-db.sql` 加表/列，同时改 `db.mjs` 的 `ensureColumns`，
  保证老库能自动迁移——线上库不能靠手工 ALTER。
- **动平台状态**（休眠、配额、对象层）：先读 `docs/09`、`docs/10`、`docs/15`，那里写了被否掉的方案。

## 提交前必须做

```bash
make verify-all        # 或至少跑你改到的那几个 verify-*
```

要求：

1. **新行为必须带自测**。测试是纯 Node 脚本，离线、不依赖 docker、不碰生产数据（临时目录 + 临时库）。
2. `node --check <改过的文件>` 通过。
3. **不要提交任何凭据**：`.env`、`deploy/auth/accounts.json`、`deploy/auth/tokens/*`、
   `deploy/orchestrator/console-token`、`secret.key`、`*.db` 都已在 `.gitignore` 里，
   别用 `git add -f` 绕过。
4. 文档要跟着改：行为变了而文档没改，视为没做完。

## 提交信息

中文一句话说清「改了什么、为什么」，不加 emoji、不加 `fix:` 前缀：

```
给助理加失败兜底：超时/出错时回群里一句，而不是沉默
修正模型断流时的空回答判断
```

一个提交只做一件事。重构和改行为分开提交，评审时容易分辨。

## Pull Request

- 标题同上；描述里写**怎么验证的**（跑了哪个 verify、真机看到什么），贴原始输出比贴结论有用。
- 涉及 UI 的附截图；涉及安全的说明威胁模型。
- 破坏性变更（改接口、改表结构、改默认行为）单独一段写**迁移方法**。

## 报告问题

用 issue 模板，务必带上：

- dsh 版本（`grep DSH_VERSION deploy/compose/.env`）、Node 版本、操作系统
- `make ps` 输出、相关容器日志（`make logs` 最后 50 行）
- 复现步骤：从哪个入口、点了什么

安全漏洞不要开 issue，见 [SECURITY.md](SECURITY.md)。

## 许可

提交即表示同意以 [Apache-2.0](LICENSE) 授权你的贡献。
