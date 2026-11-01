# 05 · Zadig 交付

目标：代码推上去 → Zadig 自动构建镜像 → 推到公司仓库 → 用 Helm 部署进 K8s。人只负责点「发布」。

## 流水线长什么样

```
[代码源：这个仓库] → [阶段1 构建：deploy/zadig/build.sh] → [阶段2 部署：Helm Chart]
                              ↓ 产物 image.env
                      IMAGE=harbor.../dsh/my-dsh:<sha>
```

只有两个阶段，刻意做薄：构建只做「打镜像并推」，部署只做「helm upgrade」。任何额外的逻辑都会让回滚变难。

## 阶段 1：构建

在 Zadig 的**构建**阶段，加一个执行脚本的步骤，工作目录设为仓库根目录，跑：

```bash
deploy/zadig/build.sh
```

需要注入的变量：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `IMAGE_REPOSITORY` | 是 | 如 `harbor.example.com/dsh/my-dsh`，不含 tag |
| `IMAGE_TAG` | 否 | 默认取 git 短 sha。**别用 latest**，回滚时你会后悔 |
| `DSH_VERSION` | 否 | 默认读 `Chart.yaml` 的 `appVersion` |
| `NPM_REGISTRY` | 否 | 公司有内网 npm 源就换成内网源，比走公网稳 |
| `PUSH` | 否 | 默认 `true`；只想验证构建时设 `false` |
| `ZADIG_OUTPUT_DIR` | 否 | `image.env` 输出目录，默认仓库根 |

脚本产出 `image.env`：

```
IMAGE_REPOSITORY=harbor.example.com/dsh/my-dsh
IMAGE_TAG=a1b2c3d
IMAGE=harbor.example.com/dsh/my-dsh:a1b2c3d
DSH_VERSION=0.2.1-rc.5
```

下游部署阶段读它，而不是自己去 `git rev-parse`——两处分别取 sha 迟早会不一致。

脚本里做的事只有三件：`docker build`（构建上下文是仓库根，插件在镜像内自动打包安装）、`docker push`、写 `image.env`。插件版本变化、dsh 版本变化，都通过**重建镜像**体现，运行期不做任何下载安装。

## 阶段 2：部署（Helm）

Chart 在 `deploy/helm/my-dsh`。Zadig 的 Helm 部署阶段填：

| 字段 | 值 |
| --- | --- |
| Chart 路径 | `deploy/helm/my-dsh` |
| values 文件 | `deploy/helm/my-dsh/values.yaml` + 你的 `values-<env>.yaml` |
| release 名 | `my-dsh` |
| 命名空间 | 如 `ai-tools` |
| 变量覆盖 | 见下表 |

| values 键 | 来源 | 说明 |
| --- | --- | --- |
| `image.repository` | `$IMAGE_REPOSITORY` | |
| `image.tag` | `$IMAGE_TAG` | 必须每次变，否则 K8s 不会滚动 |
| `dsh.publicUrl` | 手工 | 如 `https://dsh.example.com/`，必须与 `ingress.host` 一致 |
| `ingress.host` | 手工 | |
| `ingress.whitelist.sourceRange` | 手工 | 公司办公网 / VPN 网段 |
| `secrets.existingSecret` | 手工 | 已建好的 `DEEPSEEK_API_KEY` Secret 名 |

手工部分一次填好，之后每次发布只变 `image.tag`。

### 不想用 Helm 也可以

Zadig 的「Kubernetes YAML 部署」同样能用：本地渲染一份清单再提交给 Zadig 做变量替换。

```bash
helm template my-dsh deploy/helm/my-dsh \
  --namespace ai-tools \
  --set image.repository=harbor.example.com/dsh/my-dsh \
  --set image.tag=a1b2c3d \
  --set ingress.host=dsh.example.com \
  > deploy/zadig/rendered.yaml
```

代价是渲染结果要进仓库或制品库，且失去了 Helm 的 revision 历史（回滚只能靠 Zadig 自己的发布记录）。**优先 Helm。**

## 首次部署前必须准备好的东西

```bash
# 1. 命名空间
kubectl create namespace ai-tools

# 2. 模型凭据（不要写进 values）
kubectl -n ai-tools create secret generic dsh-deepseek-key \
  --from-literal=DEEPSEEK_API_KEY='sk-xxxx'

# 3. 拉镜像凭证（Harbor 是私有的就必须有）
kubectl -n ai-tools create secret docker-registry harbor-pull \
  --docker-server=harbor.example.com \
  --docker-username='robot$dsh' \
  --docker-password='xxx'

# 4. TLS 证书（用公司统一签发的，别自签）
kubectl -n ai-tools create secret tls dsh-example-tls \
  --cert=fullchain.pem --key=privkey.pem
```

对应 values：

```yaml
imagePullSecrets:
  - name: harbor-pull
secrets:
  existingSecret: dsh-deepseek-key
ingress:
  host: dsh.example.com
  tls:
    enabled: true
    secretName: dsh-example-tls
dsh:
  publicUrl: https://dsh.example.com/
```

装完第一件事是看 NOTES 里那条取 token 的命令，把带 token 的 URL 发给该用的人。

## 升级与回滚

升级：改代码 → 流水线跑一遍。`image.tag` 变了，Deployment 走 `Recreate`（不能滚动，见下），HTTP 会中断约 10~30 秒。

回滚两条路：

```bash
# Helm 侧
helm history my-dsh -n ai-tools
helm rollback my-dsh 3 -n ai-tools

# 或 Zadig 里重跑一次历史发布单
```

注意回滚**不会**回滚数据：会话和 `/workspace` 在 PVC 里，跟着新版本一起往前走。这也意味着回滚前要确认新版本没写坏持久化格式。

## 为什么只能是单副本、必须 Recreate

dsh 把会话放在进程内存 + `$DSH_HOME`，一个进程就是一个"用户视角"。两个副本会：各自持有一半会话、互相覆盖 `storages`、抢同一个 RWO 卷。

所以 Chart 里写死了：

```yaml
replicas: 1
strategy:
  type: Recreate     # 不是 RollingUpdate
```

`Recreate` 的后果就是升级时短暂中断。要消除中断只能上多实例架构，见 [06-访问控制.md](06-访问控制.md) 的「一人一实例」。

## 一个容易忽略的点

Zadig 部署完成后 Pod 是 Running，不代表服务可用。真正的验收是三行：

```bash
kubectl -n ai-tools logs deploy/my-dsh | grep -i landlock        # 沙箱生效
kubectl -n ai-tools exec deploy/my-dsh -- dsh --profile web --dump-config | grep '^# =='  # profile 对得上
curl -s -o /dev/null -w '%{http_code}\n' https://dsh.example.com/  # 期望 401（没带 token），不是 502
```
