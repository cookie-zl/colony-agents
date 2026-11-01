# syntax=docker/dockerfile:1.7
#
# my-dsh 运行镜像。构建上下文是**仓库根目录**：
#   docker build -f deploy/image/Dockerfile -t my-dsh:dev .
#
# 镜像自包含：不在镜像里构建 dsh 源码，只装 npm 发布版；插件在镜像里打包并装进 profile。

# ---------- 1. 插件打包：每个 plugins/<name>/ 出一个 tarball ----------
FROM node:24-bookworm-slim AS pluginpack
WORKDIR /src
COPY plugins/ ./plugins/
RUN set -eu; \
    mkdir -p /out; \
    for dir in plugins/*/; do \
      [ -f "${dir}package.json" ] || continue; \
      ( cd "$dir" && npm pack --pack-destination /out --silent ); \
    done; \
    ls -l /out

# ---------- 2. 运行镜像 ----------
FROM node:24-bookworm-slim

# 升级 dsh = 改这一个参数，然后重新构建。不要在运行中的容器里 npm i -g。
ARG DSH_VERSION=0.2.1-rc.5
ARG PNPM_VERSION=11.28.5
ARG NPM_REGISTRY=https://registry.npmmirror.com
# 系统包源。默认走 Debian 官方源，国内构建换成 mirrors.aliyun.com 之类会快一到两个数量级
# （实测官方源在部分网络下只有 ~1MB/min，光装 git/curl 就要十几分钟）。
ARG APT_MIRROR=deb.debian.org
# node-pty / koffi 是原生模块，必须放行安装脚本，否则终端与 subprocess 能力缺失
ARG NPM_ALLOW_SCRIPTS=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai

# git：agent 读写代码与提交要用
# curl：社区插件市场用它拉目录与安装包（不依赖 node 的 fetch 与代理行为）
# tini：容器 PID 1 收信号后转发给 dsh，SIGTERM 才能让它 dispose 整棵 root 再退出
RUN if [ "${APT_MIRROR}" != "deb.debian.org" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" \
        /etc/apt/sources.list \
        /etc/apt/sources.list.d/*.sources \
        /etc/apt/sources.list.d/*.list 2>/dev/null || true; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git tini \
 && rm -rf /var/lib/apt/lists/* \
 && ln -snf "/usr/share/zoneinfo/${TZ}" /etc/localtime \
 && echo "${TZ}" > /etc/timezone

RUN npm config set registry "${NPM_REGISTRY}" --location=global \
 && npm install -g --prefix /usr/local --allow-scripts="${NPM_ALLOW_SCRIPTS}" \
      "pnpm@${PNPM_VERSION}" "@deepseek-ai/dsh@${DSH_VERSION}" \
 && npm cache clean --force \
 && dsh --version

# 非 root 运行：uid 1000 与 macOS 默认用户一致，bind mount 写出的文件不会变 root 属主。
# node:*-slim 自带 uid 1000 的 node 用户，直接改名复用（不能再 useradd 一个 1000）。
RUN usermod --login dsh --home /home/dsh --move-home node \
 && groupmod --new-name dsh node \
 && mkdir -p /home/dsh/.dsh /workspace /opt/dsh/plugins-tgz /opt/dsh-seed/profiles \
 && chown -R dsh:dsh /home/dsh /workspace /opt/dsh /opt/dsh-seed

# pnpm 只读 ~/.npmrc，不读 npm 的 globalconfig。
# 少了这一行，`dsh plugin add` 会去连 registry.npmjs.org（镜像构建期就挂，运行期也挂）。
RUN printf 'registry=%s\n' "${NPM_REGISTRY}" > /home/dsh/.npmrc \
 && chown dsh:dsh /home/dsh/.npmrc

# profile 种子：运行期由 entrypoint 按 DSH_PROFILE_SEED 铺进数据卷
COPY profile/ /opt/dsh-seed/profiles/web/
COPY plugins.txt /opt/dsh/plugins.txt
COPY --from=pluginpack /out/ /opt/dsh/plugins-tgz/
RUN chown -R dsh:dsh /opt/dsh-seed /opt/dsh/plugins-tgz

USER dsh
ENV HOME=/home/dsh

# 把插件装进 profile：先第三方（plugins.txt，锁版本），再自研插件的 tarball。
# 装完用 --dump-config 校验整棵树能拼出来——这一步失败就让构建失败，
# 而不是等到线上启动才发现某个包的 engines.dsh 不匹配。
RUN set -eu; \
    export DSH_HOME=/opt/dsh-seed; \
    cd "$DSH_HOME/profiles/web"; \
    grep -vE '^[[:space:]]*(#|$)' /opt/dsh/plugins.txt | while read -r spec; do \
      echo "==> dsh plugin add ${spec}"; \
      dsh plugin --profile web add "${spec}"; \
    done; \
    for tgz in /opt/dsh/plugins-tgz/*.tgz; do \
      [ -f "${tgz}" ] || continue; \
      echo "==> dsh plugin add ${tgz}"; \
      dsh plugin --profile web add "${tgz}"; \
    done; \
    dsh --profile web --dump-config > /dev/null; \
    echo "==> profile 校验通过"

ENV DSH_HOME=/home/dsh/.dsh \
    DSH_PORT=3080 \
    DSH_PERMISSION_MODE=workspace-write \
    DSH_PROFILE_SEED=refresh \
    DSH_MARKETPLACE=on \
    NODE_ENV=production

COPY --chmod=0755 deploy/image/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY deploy/image/patch/ /opt/dsh/patch/

WORKDIR /workspace
EXPOSE 3080

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
