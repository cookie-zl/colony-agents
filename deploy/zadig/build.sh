#!/usr/bin/env bash
#
# Zadig「构建」阶段调用的脚本：出一个带 tag 的 colony 镜像并推到公司仓库。
#
# 用法：
#   IMAGE_REPOSITORY=harbor.example.com/dsh/colony-agents ./deploy/zadig/build.sh
#
# 环境变量（全部可用 Zadig 的构建变量注入）：
#   IMAGE_REPOSITORY  必填，镜像仓库地址（不含 tag）
#   IMAGE_TAG         选填，默认取 git 短 sha。**不要用 latest**
#   DSH_VERSION       选填，默认取 Chart.yaml 的 appVersion
#   NPM_REGISTRY      选填，默认 npmmirror；公司有内网源就换成内网源
#   APT_MIRROR        选填，默认 mirrors.aliyun.com；构建机在海外就换回 deb.debian.org
#   PUSH              选填，默认 true。本地试构建时设 false
#   ZADIG_OUTPUT_DIR  选填，image.env 的输出目录，默认仓库根目录
#
# 产物：$ZADIG_OUTPUT_DIR/image.env，供下游 Helm 部署阶段读取。

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"

: "${IMAGE_REPOSITORY:?需要设置 IMAGE_REPOSITORY，例如 harbor.example.com/dsh/colony-agents}"

IMAGE_TAG=${IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M)}
DSH_VERSION=${DSH_VERSION:-$(sed -n 's/^appVersion:[[:space:]]*"\(.*\)"/\1/p' deploy/helm/colony-agents/Chart.yaml)}
NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmmirror.com}
APT_MIRROR=${APT_MIRROR:-mirrors.aliyun.com}
PUSH=${PUSH:-true}
IMAGE="${IMAGE_REPOSITORY}:${IMAGE_TAG}"

if [ -z "$DSH_VERSION" ]; then
  echo "无法从 Chart.yaml 读到 appVersion，请显式设置 DSH_VERSION" >&2
  exit 1
fi

echo "==> dsh 版本:   ${DSH_VERSION}"
echo "==> npm registry: ${NPM_REGISTRY}"
echo "==> apt 源:     ${APT_MIRROR}"
echo "==> 目标镜像:   ${IMAGE}"

# 构建上下文是仓库根目录；插件在镜像内自动打包并装进 profile。
docker build \
  -f deploy/image/Dockerfile \
  --build-arg "DSH_VERSION=${DSH_VERSION}" \
  --build-arg "NPM_REGISTRY=${NPM_REGISTRY}" \
  --build-arg "APT_MIRROR=${APT_MIRROR}" \
  -t "${IMAGE}" \
  .

if [ "${PUSH}" = "true" ]; then
  echo "==> 推送 ${IMAGE}"
  docker push "${IMAGE}"
else
  echo "==> 跳过推送（PUSH=${PUSH}）"
fi

OUT=${ZADIG_OUTPUT_DIR:-$ROOT}
mkdir -p "$OUT"
cat > "${OUT}/image.env" <<EOF
IMAGE_REPOSITORY=${IMAGE_REPOSITORY}
IMAGE_TAG=${IMAGE_TAG}
IMAGE=${IMAGE}
DSH_VERSION=${DSH_VERSION}
EOF

echo "==> 写下 ${OUT}/image.env"
cat "${OUT}/image.env"
