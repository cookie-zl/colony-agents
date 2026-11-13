#!/usr/bin/env bash
# 按 teams.txt 批量发布团队实例：./deploy-teams.sh [--dry-run]
#
# 前置（只做一次）：
#   kubectl -n ai-tools create secret generic dsh-deepseek-key --from-literal=DEEPSEEK_API_KEY=...
#   kubectl -n ai-tools create secret docker-registry harbor-pull ...
#   # 每个团队一条 oauth2-proxy：--allowed-groups=dsh-<团队名>，详见 docs/07-多团队账号.md
#
# 每个团队一条命令完成发布，不碰别的团队：helm upgrade --install 是幂等的。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART="$HERE/colony"
TEAMS="$HERE/teams.txt"
NAMESPACE="${NAMESPACE:-ai-tools}"
HELM="${HELM:-helm}"
BASE_VALUES="$HERE/values-team.yaml"
RELEASE_PREFIX="${RELEASE_PREFIX:-dsh-}"

dry_run=""
[ "${1:-}" = "--dry-run" ] && dry_run="--dry-run"

die() { echo "错误: $*" >&2; exit 1; }
[ -f "$TEAMS" ] || die "找不到 $TEAMS"
[ -f "$BASE_VALUES" ] || die "找不到 $BASE_VALUES"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

seen_hosts=" "
count=0

while read -r name host auth_host _rest; do
	[ -z "${name:-}" ] && continue
	case "$name" in \#*) continue ;; esac
	[ -n "${host:-}" ] && [ -n "${auth_host:-}" ] || die "teams.txt 这一行列数不够：$name"
	[[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "团队名只能小写字母/数字/连字符：$name"
	case "$seen_hosts" in *" $host "*) die "host 重复：$host" ;; esac
	seen_hosts="$seen_hosts$host "

	overlay="$tmp/$name.yaml"
	cat >"$overlay" <<EOF
# 由 deploy-teams.sh 生成，勿手改
ingress:
  host: "$host"
  forwardAuth:
    # 服务名固定在 ai-tools 命名空间；oauth2-proxy 自己用 --allowed-groups=dsh-$name 做组放行
    url: "http://oauth2-proxy-$name.$NAMESPACE.svc.cluster.local/oauth2/auth"
    signinUrl: "https://$auth_host/oauth2/start?rd=https://$host\$escaped_request_uri"
  annotations:
    nginx.ingress.kubernetes.io/auth-response-headers: "X-Auth-Request-User,X-Auth-Request-Email"
dsh:
  publicUrl: "https://$host/"
EOF

	echo "==> ${RELEASE_PREFIX}${name}  https://$host/  (组 dsh-$name)"
	$HELM upgrade --install "${RELEASE_PREFIX}${name}" "$CHART" \
		--namespace "$NAMESPACE" --create-namespace \
		-f "$BASE_VALUES" -f "$overlay" \
		$dry_run
	count=$((count + 1))
done <"$TEAMS"

echo ""
echo "完成 $count 个团队。首次进入每个实例还需要带 token 的链接，做法见 docs/07-多团队账号.md 的「token 与 SSO 的接缝」。"
