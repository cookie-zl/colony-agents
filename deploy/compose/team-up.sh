#!/usr/bin/env bash
# 本地起「一个团队 = 一个实例」，实例前面挂统一登录。
#
#   ./team-up.sh up    team-a            # → http://team-a.localhost:8080/
#   ./team-up.sh up    team-b 8081       # → http://team-b.localhost:8081/
#   ./team-up.sh sync  team-a            # 重启后重新把 dsh token 同步给账号服务
#   ./team-up.sh token team-a            # 打印绕过登录的原始 token 链接（排障用）
#   ./team-up.sh sleep team-a            # 休眠：只停 dsh，入口/账号服务/卷全部留着
#   ./team-up.sh wake  team-a            # 唤醒：起 dsh、等健康、重新同步 token
#   ./team-up.sh archive team-a          # 归档：卷打 tar → 删容器 → 删卷（打印归档路径）
#   ./team-up.sh restore team-a 包.tar.gz # 从归档恢复卷（之后仍需 up 起实例）
#   ./team-up.sh down  team-a            # 停整个实例（保留数据卷）
#   ./team-up.sh destroy team-a          # 停并删卷（会话、凭据全丢）
#   ./team-up.sh ps                      # 看所有实例
#
# 资源上限：DSH_CPUS（默认 1.5）与 DSH_MEM_LIMIT（默认 2g）。控制面建团队时按节点预算传入。
#
# 每个实例独占三样东西：compose 项目名（=容器名前缀）、dsh-home 卷、workspace 目录。
# 三者任一共享，就不再是两个团队。详见 docs/07-多团队账号.md。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILE="$HERE/compose.yaml"
AUTH_DIR="$HERE/../auth"
ORCH_DIR="$HERE/../orchestrator"

# 与 Makefile 保持一致；只影响「镜像不存在时要不要现场构建」
DSH_VERSION="${DSH_VERSION:-0.2.1-rc.5}"
IMAGE="colony-agents:${DSH_VERSION}"

# 归档用的临时容器：只需要 tar，复用已拉过的镜像，别为了一次打包再拉一个新镜像
ARCHIVE_IMAGE="${ARCHIVE_IMAGE:-caddy:2-alpine}"

usage() {
	# 打印文件头部的用法注释，遇到第一行非注释就停。写死行号的话，
	# 每次往头部加一条子命令都会漏掉最后一行。
	awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "${BASH_SOURCE[0]}"
	exit 1
}

die() { echo "错误: $*" >&2; exit 1; }

# 所有实例共用一份会话密钥：跨团队票据靠它验签，各团队账号靠它互通
ensure_secret() {
	mkdir -p "$AUTH_DIR/tokens"
	# 审计目录：容器以 uid 1000 写，宿主机目录留着默认权限会 EACCES。
	# 本地模拟环境放开写权限即可；云上应换成 PVC 或把审计直接打到 stdout。
	mkdir -p "$AUTH_DIR/audit"
	chmod 777 "$AUTH_DIR/audit"
	if [ ! -s "$AUTH_DIR/secret" ]; then
		openssl rand -hex 32 >"$AUTH_DIR/secret"
		chmod 600 "$AUTH_DIR/secret"
		echo "已生成 deploy/auth/secret（会话签名密钥，换掉等于让所有人重新登录）"
	fi
	# 控制面 token：账号服务拿它调宿主上的控制面（建团队 = 建容器）。
	# 必须在 compose up 之前存在，否则 Docker 会把挂载点建成一个目录。
	mkdir -p "$ORCH_DIR"
	if [ ! -s "$ORCH_DIR/console-token" ]; then
		openssl rand -hex 32 >"$ORCH_DIR/console-token"
		chmod 600 "$ORCH_DIR/console-token"
		echo "已生成 deploy/orchestrator/console-token（控制面鉴权用）"
	fi
}

# dsh 的 token 每次启动都变，账号服务靠这个文件把「登录过的浏览器」换成 dsh Cookie
sync_token() {
	team="$1"
	# 60 秒：镜像刚换、插件首次装载时，token 那行可能比 20 秒晚不少（实测踩过）
	find_token() {
		for _ in $(seq 1 60); do
			token=$(docker compose -f "$FILE" -p "dsh-$team" logs --no-log-prefix dsh 2>/dev/null |
				grep -o 'token=[A-Za-z0-9_-]*' | tail -1 | cut -d= -f2 || true)
			[ -n "$token" ] && return 0
			sleep 1
		done
		return 1
	}
	if find_token; then
		printf '%s' "$token" >"$AUTH_DIR/tokens/$team"
		echo "已同步 dsh token → deploy/auth/tokens/$team"
		return 0
	fi
	# 兜底：dsh 首启时那条 "dsh web: <url>?token=…" 偶发不打印（上游时序问题），
	# 重启一次就会打印。不重启的话整个团队会一直 401，用户只会看到「token 未同步」。
	echo "dsh 未打印 token，重启一次再试…" >&2
	docker compose -f "$FILE" -p "dsh-$team" restart dsh >/dev/null 2>&1 || true
	if find_token; then
		printf '%s' "$token" >"$AUTH_DIR/tokens/$team"
		echo "已同步 dsh token → deploy/auth/tokens/$team（重启后拿到）"
		return 0
	fi
	echo "警告: 两次都没抓到 dsh token，进入实例时会提示「token 未同步」，稍后跑 ./team-up.sh sync $team" >&2
	return 1
}

# 团队级模型凭据：容器里只放「网关地址 + 可吊销 token」，真 API Key 留在控制面。
#
# 为什么不能在容器里放真 key：dsh 与 agent 子进程同 uid，`/proc/<pid>/environ`
# 直接可读——env scrub 只挡得住「子进程继承」，挡不住读主进程。所以请求从容器发出来，
# 由控制面的 /llm/<team> 换成真 key（密钥 AES-GCM 加密存在 team_secrets 表里）。
#
# 拿不到 token 就留空：实例照常起来，只是调模型时报「凭据缺失」。
# 这比回落到全局 key 要好——那会让所有团队共用一个额度，账单也没法按团队切。
apply_team_secret() {
	_team="$1"
	if [ -n "${DSH_LLM_BASE_URL:-}" ]; then
		echo "模型直连 $DSH_LLM_BASE_URL（手动指定，跳过网关）"
		return 0
	fi
	_token="$(node "$ORCH_DIR/llm-token.mjs" "$_team" 2>/dev/null || true)"
	# 形状校验不是洁癖：一旦脚本往 stdout 多打一行（比如库层日志），
	# $(...) 会把整段文字当成 token 塞进容器，运行时表现成「密钥无效」，很难倒查。
	case "$_token" in
		gl_"$_team"_* ) ;;
		* )
			echo "警告：${_team} 的网关 token 形状不对（${_token%%$'\n'*}），按未配置处理" >&2
			return 0
			;;
	esac
	if [ -z "$_token" ]; then
		echo "警告：没取到 ${_team} 的网关 token，本实例调用模型会报凭据缺失" >&2
		return 0
	fi
	export DSH_LLM_BASE_URL="http://host.docker.internal:${CONSOLE_PORT:-9700}/llm/$_team"
	# 这个位置放的是网关 token（gl_ 前缀），不是真 key；泄漏也只能调我们自己的网关
	export DEEPSEEK_API_KEY="$_token"
	echo "模型走网关 ${DSH_LLM_BASE_URL}"
}

# 该实例的 dsh 容器 id / 状态（normalize 成 missing|running|exited|healthy|starting|unhealthy）
dsh_container() {	docker compose -f "$FILE" -p "dsh-$1" ps -aq dsh 2>/dev/null | head -1
}

container_state() {
	cid="$(dsh_container "$1")"
	if [ -z "$cid" ]; then
		echo missing
		return 0
	fi
	# 先看 State.Status：容器停了之后 .State.Health 还留着上一次的结论（exited 但显示 unhealthy），
	# 直接读 Health 会误判成「起来了但坏了」。
	raw="$(docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}{{end}}' "$cid" 2>/dev/null)" || {
		echo missing
		return 0
	}
	status="${raw%%|*}"
	health="${raw#*|}"
	if [ "$status" != "running" ]; then
		echo "$status"
	else
		echo "${health:-running}"
	fi
}

# 休眠：只停 dsh 本体。入口与账号服务必须留着——唤醒请求得由它们接住，
# 否则用户看到的是裸 502 空白页，而不是「正在唤醒」。
sleep_instance() {
	team="$1"
	state="$(container_state "$team")"
	case "$state" in
		missing) die "实例 dsh-$team 的容器不存在，可能没建过" ;;
		exited | created) echo "dsh-$team 本来就睡着（${state}）" ;;
		*)
			docker compose -f "$FILE" -p "dsh-$team" stop -t 10 dsh >/dev/null
			echo "已休眠 dsh-${team}：内存已释放，会话与工作区留在卷里，入口保持可访问"
			;;
	esac
}

# 唤醒：用 start 而不是 up。up 会按 compose.yaml 的默认变量（8080）重建，
# 端口和 DSH_PUBLIC_URL 就和登记的不一致，表现为能登录但 /api 全 403。
wake_instance() {
	team="$1"
	case "$(container_state "$team")" in
		missing) die "容器不存在，需要完整重建：./team-up.sh up $team <port>" ;;
		healthy) sync_token "$team" || true; echo "dsh-$team 已经是醒的" ; return 0 ;;
		running | starting) ;;
		*) docker compose -f "$FILE" -p "dsh-$team" start dsh >/dev/null ;;
	esac
	for _ in $(seq 1 60); do
		case "$(container_state "$team")" in
			healthy)
				sync_token "$team" || true
				echo "已唤醒 dsh-$team"
				return 0
				;;
			unhealthy) die "dsh-$team 起来了但健康检查失败：docker logs dsh-$team-dsh-1" ;;
		esac
		sleep 0.5
	done
	die "30 秒内没等到健康：docker logs dsh-$team-dsh-1"
}

# 归档：卷打包 → 删容器 → 删卷。顺序不能反——先删卷就永久丢数据了。
# 打包失败时脚本会因 set -e 退出，此时容器与卷都还在，可以重试。
archive_instance() {
	team="$1"
	archive_dir="${ARCHIVE_DIR:-$ORCH_DIR/archives}"
	mkdir -p "$archive_dir"
	vol="dsh-${team}_dsh-home"
	docker volume inspect "$vol" >/dev/null 2>&1 || die "卷 $vol 不存在，没有可归档的数据"

	case "$(container_state "$team")" in
		running | starting | healthy | unhealthy)
			echo "先停 dsh，保证打包时没有进程在写卷"
			docker compose -f "$FILE" -p "dsh-$team" stop -t 10 dsh >/dev/null
			;;
	esac

	stamp="$(date +%Y%m%d-%H%M%S)"
	file="$archive_dir/${team}-${stamp}.tar.gz"
	# 排除 market-skills/：那是市场包的物化缓存，恢复后按 digest 现拉即可，打进去纯属撑大归档
	docker run --rm -v "$vol:/data:ro" -v "$archive_dir:/backup" "$ARCHIVE_IMAGE" \
		sh -c "tar czf /backup/${team}-${stamp}.tar.gz --exclude='./market-skills' --exclude='./market-skills/*' -C /data ."
	[ -s "$file" ] || die "打包失败：$file 不存在或为空（卷与容器未动，可重试）"

	docker compose -f "$FILE" -p "dsh-$team" down -v >/dev/null
	rm -f "$AUTH_DIR/tokens/$team"
	# 变量后紧接中文必须用 ${}：bash 会把全角标点当成变量名的一部分，报 unbound variable
	echo "已归档 ${team}：容器与卷已删除，恢复用 ./team-up.sh restore ${team} <包>"
	# 最后一行只打路径：控制面直接把它当返回值
	echo "$file"
}

# 恢复：只负责把卷解出来，起实例交给调用方（控制面按注册表里的配额与入口起）。
restore_instance() {
	team="${1:-}"
	file="${2:-}"
	[ -n "$team" ] && [ -n "$file" ] || usage
	[ -f "$file" ] || die "归档文件不存在：$file"
	abs="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
	vol="dsh-${team}_dsh-home"
	if docker volume inspect "$vol" >/dev/null 2>&1; then
		die "卷 $vol 已存在。恢复会覆盖它，先确认里面没有要留的数据：./team-up.sh destroy $team"
	fi
	docker volume create "$vol" >/dev/null
	docker run --rm -v "$vol:/data" -v "$abs:/backup.tar.gz:ro" "$ARCHIVE_IMAGE" \
		sh -c "tar xzf /backup.tar.gz -C /data"
	echo "已恢复卷 $vol ← $file"
	echo "接着起实例：./team-up.sh up $team <port>"
}

[ $# -ge 1 ] || usage
cmd="$1"
shift

case "$cmd" in
up)
	team="${1:-}"
	port="${2:-8080}"
	ws="${3:-$HERE/workspace-$team}"
	[ -n "$team" ] || usage
	[[ "$team" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "团队名只用小写字母/数字/连字符：$team"
	[[ "$port" =~ ^[0-9]+$ ]] || die "端口必须是数字：$port"

	mkdir -p "$ws"
	ws="$(cd "$ws" && pwd)"
	ensure_secret

	# 端口被占就直说，别让 compose 抛一句看不懂的 bind error。
	# 但本项目自己的 edge 占着端口是正常的（重复 up 要能重建），所以要排除掉。
	if ! docker compose -f "$FILE" -p "dsh-$team" ps --status running --services 2>/dev/null | grep -qx edge; then
		if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
			die "端口 $port 已被占用，换一个：./team-up.sh up $team $((port + 1))"
		fi
	fi

	export DSH_TEAM="$team"
	export DSH_SITE_HOST="$team.localhost"
	export DSH_TRUSTED_HOST="$team.localhost"
	export DSH_PUBLIC_URL="http://$team.localhost:$port/"
	export EDGE_PORT="$port"
	export DSH_WORKSPACE="$ws"
	# 配额：控制面按节点余量传入；手动起实例时用默认值
	export DSH_CPUS="${DSH_CPUS:-1.5}"
	export DSH_MEM_LIMIT="${DSH_MEM_LIMIT:-2g}"

	# 市场只读 token：dsh 里的 market-skill 插件靠它拉本团队的技能目录。
	# 缺了它技能域是空的（插件会打一条 warning），所以拿不到就大声说，别静默降级。
	if command -v node >/dev/null 2>&1; then
		export MARKET_API_TOKEN="$(node "$HERE/../orchestrator/market-token.mjs" "$team" 2>/dev/null)" || true
	fi
	if [ -z "${MARKET_API_TOKEN:-}" ]; then
		echo "警告：没取到 ${team} 的市场 token，本实例不会从控制面加载技能" >&2
	fi

	# 团队级模型凭据：secrets.json 里按团队存的 key 覆盖全局 .env。
	# 不这么做的话所有团队共用 DEEPSEEK_API_KEY —— 一个团队换 key 或超额度，
	# 全平台的账单和限流都算在一起，也没法按团队计费。
	apply_team_secret "$team"

	build_flag=""
	docker image inspect "$IMAGE" >/dev/null 2>&1 || build_flag="--build"

	echo "实例 dsh-$team  host=$team.localhost:$port  workspace=$ws"
	# 必须 --force-recreate：镜像 tag 不变（比如同版本重打）时，compose 只会 start 旧容器，
	# 新镜像里的 entrypoint / 插件根本不生效——表现为「发版了但行为没变」，很难查。
	# 这里的语义就是「发布」，重建是预期行为；只想让它醒着请用 `wake`。
	docker compose -f "$FILE" -p "dsh-$team" up -d $build_flag --force-recreate dsh
	# Caddyfile 是挂载进去的，但 admin off 不会重载，改了必须重建容器才生效
	docker compose -f "$FILE" -p "dsh-$team" up -d --force-recreate --no-deps edge >/dev/null

	sync_token "$team" || true

	echo ""
	echo "入口:   http://$team.localhost:$port/"
	echo "账号:   alice / bob / carol / dave   密码 dsh-demo-1234"
	echo "门户:   http://$team.localhost:$port/__auth/home"
	;;
sync)
	team="${1:-}"
	[ -n "$team" ] || usage
	ensure_secret
	sync_token "$team"
	;;
token)
	team="${1:-}"
	[ -n "$team" ] || usage
	docker compose -f "$FILE" -p "dsh-$team" logs --no-log-prefix dsh 2>&1 |
		grep -o 'http[^ ]*token=[A-Za-z0-9_-]*' | tail -1 ||
		die "没找到 token，确认实例已起来：./team-up.sh ps"
	;;
sleep)
	team="${1:-}"
	[ -n "$team" ] || usage
	sleep_instance "$team"
	;;
wake)
	team="${1:-}"
	[ -n "$team" ] || usage
	wake_instance "$team"
	;;
archive)
	[ -n "${1:-}" ] || usage
	archive_instance "$1"
	;;
restore)
	restore_instance "${1:-}" "${2:-}"
	;;
down)
	team="${1:-}"
	[ -n "$team" ] || usage
	docker compose -f "$FILE" -p "dsh-$team" down
	;;
destroy)
	team="${1:-}"
	[ -n "$team" ] || usage
	read -r -p "会删掉 dsh-$team 的会话/凭据/工作区，确认？[y/N] " ans
	[ "$ans" = "y" ] || exit 0
	docker compose -f "$FILE" -p "dsh-$team" down -v
	rm -f "$AUTH_DIR/tokens/$team"
	;;
ps)
	docker compose ls --all 2>/dev/null | grep -E 'dsh-' || echo "没有 dsh 实例在跑"
	;;
*)
	usage
	;;
esac
