# my-dsh

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下文简称 dsh）当成一个**内部平台**来运营的仓库：一个镜像、一份 profile、一组自研插件，一条 Zadig 流水线。

dsh 本体不作为源码 fork 进来，而是当作**上游 npm 依赖锁版本**。这个仓库只做三件事：

| 主线 | 产出 | 你改哪里 |
| --- | --- | --- |
| 部署 | 一个可复现的容器镜像 + Helm Chart | `deploy/` |
| 增量插件开发 | 若干 npm 包形态的 bundle | `plugins/` |
| 用别人的插件 | `plugins.txt` 里锁版本的一行 | `plugins.txt` |

```
.
├── plugins.txt                     # 要装进镜像的插件清单（锁版本）
├── profile/                        # dsh profile：镜像里烘焙的「配置即代码」
│   ├── package.json                #   依赖 + bundles 顺序（由 dsh plugin add 维护）
│   ├── pnpm-workspace.yaml
│   └── cordis.patch.yml            #   用户覆盖层：改内置行、关插件
├── plugins/
│   ├── README.md
│   └── hello-dsh/                  # 样板插件：纯 ESM JS，无构建步骤
├── deploy/
│   ├── image/                      # Dockerfile + entrypoint + 运行期 patch
│   ├── compose/                    # 本地/单机 VM 跑法（含 Caddy 入口）
│   ├── helm/my-dsh/          # 公司 K8s
│   └── zadig/build.sh              # Zadig 构建阶段调用
└── docs/                           # 1~6 篇，按顺序看
```

## 快速开始

```bash
git clone <本仓库> && cd my-dsh

# 1) 本机跑起来（需要 Docker）
cp deploy/compose/.env.example deploy/compose/.env   # DEEPSEEK_API_KEY 可留空，默认走免费模型车道
make up            # → http://dsh.localhost:8080/

# 2) 改插件：改完一条命令重建并替换容器，约 10 秒
make reload

# 3) 出一个可交付镜像
make image         # 单条 docker build，插件在镜像里自动打包安装
```

`make` 的全部目标见 `make help`。

## 三个必须知道的约束

1. **单实例、有状态。** dsh 把会话放在进程内存 + `$DSH_HOME`，一个进程服务一个「用户视角」。所以 `replicas` 只能是 1，PVC 用 `ReadWriteOnce`，升级用 `Recreate`。要给全组人用，只有两条路：大家共用同一个实例（共享会话历史），或一人一实例（推荐，用 Helm 多 release）。
2. **插件是进程内代码，不是沙箱。** `apply(ctx)` 跑在 dsh 主进程里，权限等于 dsh 本身。装一个社区插件等于允许它的作者在你的服务器上执行代码——`plugins.txt` 里每一行都要过审、锁到确切版本。
3. **鉴权只有一层，且在 dsh 之外。** dsh 用「打印出来的 URL 里的 token → 签名 Cookie」标识来访者，拿到 token 的人就能进。所以「只允许公司的人用」必须在 Ingress / 反代上做（IP 白名单 + Basic Auth 或公司 SSO），详见 [docs/06-访问控制.md](docs/06-访问控制.md)。

## 版本锁定

| 项 | 位置 | 当前值 |
| --- | --- | --- |
| dsh 本体 | 构建参数 `DSH_VERSION` | `0.2.1-rc.5` |
| 社区插件 | `plugins.txt` | 每行带确切版本 |
| 自研插件 | 各自 `package.json` 的 `version` | — |
| 默认模型 | `profile/cordis.patch.yml` 的 `agent-default-model` | `our-free-model` / `kilo-auto/free`（免费车道，无需 Key） |

升级 dsh 就是改一个 `DSH_VERSION` 然后重新构建、重新走流水线。**不要**在运行中的容器里 `npm i -g`，那会让线上和仓库脱钩。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/01-本地运行.md](docs/01-本地运行.md) | compose 起服务、Caddy 入口、常见启动失败 |
| [docs/02-插件开发.md](docs/02-插件开发.md) | 插件形态、开发循环、工具/命令/配置、打包 |
| [docs/03-社区插件.md](docs/03-社区插件.md) | 市场、锁版本、审计清单、离线镜像 |
| [docs/04-镜像与profile.md](docs/04-镜像与profile.md) | 镜像分层、seed 策略、升级插件不丢会话 |
| [docs/05-Zadig交付.md](docs/05-Zadig交付.md) | 构建阶段、Helm 部署阶段、变量与回滚 |
| [docs/06-访问控制.md](docs/06-访问控制.md) | 白名单、Basic Auth、公司 SSO 网关、多实例方案 |
