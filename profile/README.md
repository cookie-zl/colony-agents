# profile 目录

这是 dsh 的 **profile**：描述「这套组合由哪些组合包按什么顺序拼起来」。运行时它被铺到 `$DSH_HOME/profiles/web/`。

三个文件，各有分工：

| 文件 | 谁写 | 作用 |
| --- | --- | --- |
| `package.json` | **不要手写**，由 `dsh plugin add` 维护 | `dependencies` 是树外插件包；`dsh.profile.bundles` 是有序的组合包列表 |
| `pnpm-workspace.yaml` | 人 | pnpm 解析策略（hoisted、禁止自动装 peer、git 包的构建授权） |
| `cordis.patch.yml` | 人 | 覆盖层：改内置行的 `config`、禁用某行、插入新行 |

仓库里这份 `package.json` 只有 `dsh-base` + `dsh-web-app` 两条，是**空模板**：镜像构建时它被复制到 `/opt/dsh-seed/profiles/web/`，然后由 Dockerfile 逐条执行 `dsh plugin add`（`plugins.txt` + 自研插件 tarball），把那两份清单填进去。所以你在仓库里看不到已装插件是正常的——真实清单是 `plugins.txt` 和各插件的 `package.json`，版本也就锁在那里。

## 为什么不直接写 `package.json`

`dependencies` 和 `dsh.profile.bundles` 必须一一对应，且顺序有意义。手工维护两份清单迟早会漂。`dsh plugin add` 会同时改这两处，所以**新增插件统一走它**：

```bash
# 在容器内（镜像构建阶段由 Dockerfile 自动执行）
dsh plugin --profile web add dsh-plugin@2.2.7
dsh plugin --profile web add ./plugins/hello-dsh-0.1.0.tgz
```

改完想核对层顺序：

```bash
dsh --profile web --dump-config | grep -n '^# =='
```

输出里每一行 `# == <层名>` 就是一层配置，最后几行能看到 `patched by .../cordis.patch.yml`。

## 与「运行期手改」的关系

镜像里烘焙了这份 profile，容器启动时按 `DSH_PROFILE_SEED` 铺进数据卷（默认 `refresh` = 每次启动都用镜像里的版本覆盖）。所以：

- 想让改动永久生效 → 改这个目录，重新构建，重新走流水线；
- 在 Web UI 里点「安装插件」装的东西，**重启后会消失**（这是刻意的，避免线上与仓库脱钩）；
- 需要临时压制某个插件 → 用 `$DSH_HOME/cordis.patch.yml`（home 级，不会被 seed 覆盖），或 `DSH_MARKETPLACE=off`。

细节见 [../docs/04-镜像与profile.md](../docs/04-镜像与profile.md)。
