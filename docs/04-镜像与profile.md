# 04 · 镜像与 profile

这一篇讲清楚「配置从哪来、数据放哪、升级时什么会变」。

## 镜像里有什么

```
/usr/local/                      dsh + pnpm（npm 全局安装，锁版本）
/opt/dsh-seed/profiles/web/      profile 种子：package.json + node_modules + cordis.patch.yml
/opt/dsh/plugins-tgz/            构建期打包的插件 tarball（仅溯源用）
/opt/dsh/plugins.txt             装进镜像的插件清单（仅溯源用）
/opt/dsh/patch/                  运行期开关用的 --patch 文件
/usr/local/bin/entrypoint.sh     入口脚本
/workspace                       工作目录（运行期挂卷）
/home/dsh/.dsh                   DSH_HOME（运行期挂卷）
```

镜像不在容器里构建 dsh 源码，只装 npm 发布版。所以整个镜像 ≈ 1GB（其中 `node_modules` 878MB 是 dsh 本体），启动秒级。

## 三个配置层的职责

dsh 的生效配置是「一层压一层」拼出来的，顺序固定：

```
1. @deepseek-ai/dsh-base          基础能力（工具、会话、LLM、沙箱…）
2. @deepseek-ai/dsh-web-app       Web 界面覆盖层
3. plugins.txt 里每个组合包        按加入顺序
4. plugins/*.tgz 打出来的自研插件   按安装顺序
5. profile/cordis.patch.yml       你的覆盖层
6. $DSH_HOME/cordis.patch.yml     home 级：机器本地偏好，不会被 seed 覆盖
7. 命令行 --patch                 最高优先级：运行期开关走这里
```

后一层按行覆盖前一层，`config` 是整块替换不是深合并。查实际生效结果：

```bash
dsh --profile web --dump-config | grep -n '^# =='
```

输出里每一条 `# == xxx` 就是一层，你会看到 `patched by .../cordis.patch.yml` 这类标记。

## seed：镜像里的 profile 怎么进数据卷

`$DSH_HOME/profiles` 在数据卷里，镜像是只读的，所以启动时要"铺"一遍。`entrypoint.sh` 由 `DSH_PROFILE_SEED` 控制：

| 值 | 行为 | 用在哪 |
| --- | --- | --- |
| `refresh`（默认） | **每次启动**删掉卷里的 `profiles/web`，用镜像里的版本覆盖 | 线上。仓库即真相，UI 装的插件重启即失效 |
| `once` | 只在首次启动铺一次 | 本地想留住手装插件时 |
| `off` | 完全不铺 | 开发栈（插件走源码 overlay），或你完全自己管 profile |

只有 `profiles/` 会被覆盖。`sessions/`、`storages/`、`.credentials.yaml`、`.pnpm-store/` 都不动。

`refresh` 的代价是「在 Web UI 里装的插件活不过重启」。这是刻意的：否则线上会慢慢长出一份只有运维机器才知道的配置，回滚和审计都无从下手。要长期生效的插件，改 `plugins/` 或 `plugins.txt`，走流水线。

## 数据在哪，备份什么

| 路径 | 内容 | 丢了会怎样 |
| --- | --- | --- |
| `$DSH_HOME/sessions/` | 会话历史 | 所有对话消失 |
| `$DSH_HOME/storages/` | 持久化状态（agent 记忆等） | 上下文丢失 |
| `$DSH_HOME/.credentials.yaml` | 凭据（用 env 注入 key 时可重建） | 需要重新填 key |
| `$DSH_HOME/profiles/` | profile 与插件 | seed 会重建，不用备份 |
| `/workspace` | agent 改过的代码 | 这是最值钱的部分，必须备份 |

备份就两件事：`$DSH_HOME/sessions` + `/workspace`。Helm 里两个 PVC 都带 `helm.sh/resource-policy: keep`，卸载 release 不会删卷。

## 升级路径

```bash
# 1. 改版本（唯一需要改的地方）
sed -i '' 's/DSH_VERSION=0.2.1-rc.5/DSH_VERSION=0.2.2-alpha.2/' deploy/compose/.env.example
#    同时把 deploy/image/Dockerfile 的 ARG 默认值与 Chart.yaml 的 appVersion 对齐

# 2. 重建镜像并本地验证
make image
make up
make verify

# 3. 走流水线发到公司环境
```

为什么不在运行中的容器里 `npm i -g dsh@latest`：那会让线上和仓库脱钩，下次重建镜像就回到旧版本，故障排查时你会对着两个不同的运行时发呆。

## 升级插件（不动 dsh 本体）

自研插件：改 `plugins/<name>/package.json` 的 `version` → 重建镜像。tarball 名带版本号，`dsh plugin add` 会装新版本。

社区插件：改 `plugins.txt` 里那一行的版本号 → 重建镜像。

两边都建议顺带跑一次：

```bash
dsh --profile web --dump-config > /dev/null   # 镜像构建里已经跑了，手动再确认一次不亏
```

构建期这一步失败会让整个构建失败，而不是等到线上启动才发现某个包的 `engines.dsh` 不匹配。
