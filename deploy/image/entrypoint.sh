#!/bin/sh
# dsh 容器入口：铺 profile、绑地址、把信号交给 dsh 自己处理。
set -eu

: "${DSH_HOME:=/home/dsh/.dsh}"
: "${DSH_PORT:=3080}"
: "${DSH_PROFILE_SEED:=refresh}"
: "${DSH_MARKETPLACE:=on}"
: "${DSH_SEED_SRC:=/opt/dsh-seed/profiles}"

mkdir -p "$DSH_HOME"
chmod 700 "$DSH_HOME" 2>/dev/null || true

# bind mount 进来的仓库属主可能和容器 uid 不一致，Git 会报 dubious ownership
git config --global --replace-all safe.directory '*'
# 关掉后台自动 gc/repack：在网络卷或 virtiofs 上跑会长时间吃 CPU
git config --global gc.auto 0
git config --global core.pager cat

# 把镜像里烘焙的 profile 铺进数据卷。
#   refresh 每次启动都覆盖 —— 线上与仓库永不脱钩（UI 里装的插件重启即失效，这是刻意的）
#   once    只在首次启动铺一次 —— 本地想留住手装的插件时用
#   off     完全不铺 —— 完全自己管 profile
seed_profiles() {
  [ -d "${DSH_SEED_SRC}/web" ] || return 0
  mkdir -p "${DSH_HOME}/profiles"
  rm -rf "${DSH_HOME}/profiles/web"
  cp -a "${DSH_SEED_SRC}/web" "${DSH_HOME}/profiles/web"
  date -u +%FT%TZ > "${DSH_HOME}/.seeded"
}

case "$DSH_PROFILE_SEED" in
  refresh)
    seed_profiles
    ;;
  once)
    [ -f "${DSH_HOME}/.seeded" ] || seed_profiles
    ;;
  off)
    ;;
  *)
    echo "dsh: DSH_PROFILE_SEED 取值非法：${DSH_PROFILE_SEED}（refresh|once|off）" >&2
    exit 1
    ;;
esac

# --host 只接受具体的本地 IP 字面量，通配地址会被拒绝；容器里取自己的地址给反代用
BIND_IP="$(hostname -i 2>/dev/null | awk '{print $1}')"
: "${BIND_IP:=127.0.0.1}"

# 参数顺序是有讲究的：dsh 的「启动器参数」必须在第一个它不认识的参数之前结束。
# 一旦出现 --host 这类 app 参数，后面的所有内容都归 app 的解析器，--patch 会被判成
# unknown option 直接退出。所以顺序固定为：启动器参数 → app 参数。
#
# 另外必须用 `--profile web`，不能用 `dsh web` 子命令：后者自带一套 app 选项表，
# 启动器参数同样进不去。
set -- --profile web

# --- 启动器参数：--patch 覆盖层 ---
# 运行期关掉社区插件市场：最高优先级的一层，不动镜像 profile，也不动数据卷里的手改。
if [ "${DSH_MARKETPLACE}" = "off" ]; then
  set -- "$@" --patch /opt/dsh/patch/marketplace-off.yml
fi

# 额外的 overlay（逗号分隔）。开发栈用它把插件指向宿主机上的源码目录。
if [ -n "${DSH_EXTRA_PATCH:-}" ]; then
  for patch in $(printf '%s' "$DSH_EXTRA_PATCH" | tr ',' ' '); do
    set -- "$@" --patch "$patch"
  done
fi

# --- app 参数：从这里开始交给 web 应用解析 ---
# --host 只接受具体的本地 IP 字面量，通配地址会被拒绝；容器里取自己的地址给反代用
set -- "$@" --host "$BIND_IP" --port "$DSH_PORT" --no-open

if [ -n "${DSH_PUBLIC_URL:-}" ]; then
  set -- "$@" --public-url "$DSH_PUBLIC_URL"
fi

# --trusted-host 是变长参数，放最后，避免吞掉后面的 flag
if [ -n "${DSH_TRUSTED_HOST:-}" ]; then
  for host in $(printf '%s' "$DSH_TRUSTED_HOST" | tr ',' ' '); do
    set -- "$@" --trusted-host "$host"
  done
fi


echo "dsh: ${BIND_IP}:${DSH_PORT} seed=${DSH_PROFILE_SEED} marketplace=${DSH_MARKETPLACE}" \
     "public-url=${DSH_PUBLIC_URL:-<none>} trusted-host=${DSH_TRUSTED_HOST:-<none>}" >&2

if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  echo "dsh: 提示：DEEPSEEK_API_KEY 为空。默认模型若走 dsh-our-free-model 免费车道则无需 Key；" \
       "切回官方模型（provider=deepseek-official）前必须提供，否则对话会报缺凭证。" >&2
fi

exec dsh "$@"
