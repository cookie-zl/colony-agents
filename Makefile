SHELL := /bin/bash
.DEFAULT_GOAL := help

DSH_VERSION ?= 0.2.1-rc.5
IMAGE       ?= my-dsh:$(DSH_VERSION)
# 国内构建建议设成 mirrors.aliyun.com；官方源在部分网络下慢到不可用
APT_MIRROR  ?= mirrors.aliyun.com
NPM_REGISTRY ?= https://registry.npmmirror.com
# agent 跑 pip install 用的索引，烘焙进镜像的 PIP_INDEX_URL
PIP_INDEX_URL ?= https://pypi.tuna.tsinghua.edu.cn/simple

# 本地默认操作 team-a 这个团队实例（一个团队 = 一个 compose 项目）。
# 多团队用 ./deploy/compose/team-up.sh，见 docs/07-多团队账号.md
TEAM      ?= team-a
TEAM_PORT ?= 8080

COMPOSE     := docker compose -f deploy/compose/compose.yaml -p dsh-$(TEAM)
TEAM_SCRIPT := ./deploy/compose/team-up.sh

# 账号体系与入口需要的变量。shell 导出优先于 deploy/compose/.env，避免两处配置打架
export DSH_TEAM ?= $(TEAM)
export DSH_SITE_HOST ?= $(TEAM).localhost
export DSH_TRUSTED_HOST ?= $(TEAM).localhost
export DSH_PUBLIC_URL ?= http://$(TEAM).localhost:$(TEAM_PORT)/
export EDGE_PORT ?= $(TEAM_PORT)

HELM_CHART  := deploy/helm/my-dsh
# 没装 helm 也能校验：走容器里的 helm。本机已装 helm 时可用 HELM=helm 覆盖。
HELM        ?= docker run --rm -v $(CURDIR)/$(HELM_CHART):/apps alpine/helm:3.16.3

.PHONY: help
help: ## 列出所有目标
	@awk 'BEGIN {FS = ":.*?## "; print "用法: make <目标>\n"} \
	     /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# ---------- 本地运行（prod-like：插件以 tarball 装进 profile） ----------
# 运行时文件（账号库、节点清单）不入库，首次运行从 .example 复制一份，已有就不动。
.PHONY: seed
seed: ## 首次运行：从 .example 生成 accounts.json / nodes.json / .env（已存在则跳过）
	@[ -f deploy/auth/accounts.json ] || ( cp deploy/auth/accounts.example.json deploy/auth/accounts.json && echo "已生成 deploy/auth/accounts.json（演示账号 admin / demo1234）" )
	@[ -f deploy/orchestrator/nodes.json ] || ( cp deploy/orchestrator/nodes.example.json deploy/orchestrator/nodes.json && echo "已生成 deploy/orchestrator/nodes.json（按本机 CPU/内存改预算）" )
	@[ -f deploy/compose/.env ] || ( cp deploy/compose/.env.example deploy/compose/.env && echo "已生成 deploy/compose/.env（模型 Key 可留空，默认免费车道）" )

.PHONY: up
up: seed ## 起默认团队实例（team-a）→ http://team-a.localhost:8080/
	$(TEAM_SCRIPT) up $(TEAM) $(TEAM_PORT)

.PHONY: down
down: ## 停服务（保留数据卷）
	$(TEAM_SCRIPT) down $(TEAM)

.PHONY: logs
logs: ## 跟随日志
	$(COMPOSE) logs -f dsh

.PHONY: token
token: ## 打印绕过登录的原始 token 链接（排障用；正常入口走登录页）
	@$(TEAM_SCRIPT) token $(TEAM)

.PHONY: ps
ps: ## 看容器状态
	$(COMPOSE) ps

.PHONY: restart
restart: ## 重启 dsh（profile 会按 DSH_PROFILE_SEED 重新铺），并重新同步 token
	$(COMPOSE) restart dsh
	@sleep 6
	@$(TEAM_SCRIPT) sync $(TEAM)

# ---------- 插件开发循环 ----------
# 插件必须从 profile 的 node_modules 里加载，宿主包（@deepseek-ai/dsh-*）才能被
# 正确地路由到 dsh 自带的那一份。所以改插件不能靠挂源码，只能重新打包进镜像。
# 好在这条路的缓存命中的部分很多：一次 reload 主要是镜像导出 + 容器重建。
.PHONY: reload
reload: ## 改完插件后重新构建并替换容器（保留数据卷与会话）
	$(COMPOSE) up -d --build dsh
	@sleep 6
	@$(TEAM_SCRIPT) sync $(TEAM)
	@$(COMPOSE) logs --no-log-prefix dsh 2>&1 | grep -E 'hello-dsh|listening' | tail -3

# ---------- 镜像 ----------
.PHONY: image
image: ## 构建可交付镜像（插件在镜像里自动打包安装）
	docker build -f deploy/image/Dockerfile \
	  --build-arg DSH_VERSION=$(DSH_VERSION) \
	  --build-arg APT_MIRROR=$(APT_MIRROR) \
	  --build-arg NPM_REGISTRY=$(NPM_REGISTRY) \
	  --build-arg PIP_INDEX_URL=$(PIP_INDEX_URL) \
	  -t $(IMAGE) .
	@echo "已构建: $(IMAGE)"

.PHONY: verify
verify: ## 在运行中的容器里校验 profile 能否拼出来
	$(COMPOSE) exec -T dsh sh -lc 'dsh --profile web --dump-config | grep -n "^# =="'

# 全部离线自测：不联网、不依赖 docker、不碰生产库。CI 与提交前都跑这一个。
# verify-profile 要从镜像借一份 yaml 库（.verify-yaml/，见上面 verify-profile 目标），
# 没准备就跳过它——其余脚本必须全绿。
.PHONY: verify-all
verify-all: ## 跑全部离线自测（15 个脚本，失败即退出）
	@fail=0; skipped=""; \
	for f in deploy/orchestrator/verify-*.mjs; do \
	  name=$$(basename $$f); \
	  if [ "$$name" = "verify-profile.mjs" ] && [ ! -f .verify-yaml/package.json ]; then \
	    skipped="$$skipped $$name"; continue; \
	  fi; \
	  out=$$(DSH_YAML_ROOT=$(CURDIR)/.verify-yaml/package.json node "$$f" 2>&1); code=$$?; \
	  printf '%-36s %s\n' "$$name" "$$(printf '%s' "$$out" | tail -1)"; \
	  if [ $$code -ne 0 ]; then fail=1; printf '%s\n' "$$out" | tail -20; fi; \
	done; \
	[ -n "$$skipped" ] && echo "已跳过不存在依赖的自测：$$skipped（需要时先跑 make verify-profile）"; \
	if [ $$fail -ne 0 ]; then echo "自测有失败项"; exit 1; fi; echo "全部自测通过"

.PHONY: shell
shell: ## 进容器
	$(COMPOSE) exec dsh sh

.PHONY: pack
pack: ## 本地打出插件 tarball 到 dist/（仅用于检查产物，镜像里会自动打包）
	@mkdir -p dist
	@for dir in plugins/*/; do \
	  [ -f "$${dir}package.json" ] || continue; \
	  ( cd "$$dir" && npm pack --pack-destination ../../dist --silent ); \
	done
	@ls -l dist

# ---------- Helm ----------
.PHONY: helm-template
helm-template: ## 渲染 Helm 模板（本地校验用）
	$(HELM) template my-dsh /apps --namespace ai-tools

.PHONY: helm-lint
helm-lint: ## Helm lint
	$(HELM) lint /apps

# ---------- 多团队（一个团队一个实例） ----------
# 本地验证用；线上走 deploy/helm/deploy-teams.sh。详见 docs/07-多团队账号.md

.PHONY: console
console: ## 起本地控制面：门户里点「新建团队」会真的创建容器（Ctrl-C 停）
	@[ -s deploy/orchestrator/console-token ] || \
	  (openssl rand -hex 32 > deploy/orchestrator/console-token && \
	   chmod 600 deploy/orchestrator/console-token && \
	   echo "已生成 deploy/orchestrator/console-token")
	node deploy/orchestrator/console.mjs

.PHONY: team-up
team-up: ## 起一个团队实例（TEAM=team-b TEAM_PORT=8081）
	./deploy/compose/team-up.sh up $(TEAM) $(TEAM_PORT)

.PHONY: team-token
team-token: ## 打印某个团队实例的带 token 入口
	@./deploy/compose/team-up.sh token $(TEAM)

.PHONY: team-down
team-down: ## 停某个团队实例（保留数据卷）
	./deploy/compose/team-up.sh down $(TEAM)

.PHONY: sleep
sleep: ## 休眠某个团队实例（TEAM=team-b）：只停 dsh，入口/账号/卷全留着
	./deploy/compose/team-up.sh sleep $(TEAM)

.PHONY: wake
wake: ## 唤醒某个团队实例：起 dsh、等健康、重新同步 token
	./deploy/compose/team-up.sh wake $(TEAM)

.PHONY: state
state: ## 看控制面视角的活跃度、配额与休眠状态（需要 make console 在跑）
	@curl -s --noproxy '*' -H "X-Console-Token: $$(cat deploy/orchestrator/console-token)" \
	  http://127.0.0.1:9700/state

# ---------- 平台运维（配额 / 对账 / 归档 / 观测） ----------
# 详见 docs/10-平台运维.md。都需要 make console 在跑，token 从 deploy/orchestrator/console-token 读。

CONSOLE_URL := http://127.0.0.1:9700
CONSOLE_AUTH = -H "X-Console-Token: $$(cat deploy/orchestrator/console-token)"

.PHONY: nodes
nodes: ## 看各节点配额余量（已用/总量）
	@curl -s --noproxy '*' $(CONSOLE_AUTH) $(CONSOLE_URL)/nodes

.PHONY: metrics
metrics: ## 打印 Prometheus 指标（Grafana 抓的就是这个）
	@curl -s --noproxy '*' $(CONSOLE_AUTH) $(CONSOLE_URL)/metrics

.PHONY: reconcile-check
reconcile-check: ## 对账只看不动：容器与注册表的漂移、孤儿卷
	@curl -s --noproxy '*' $(CONSOLE_AUTH) $(CONSOLE_URL)/reconcile

.PHONY: reconcile
reconcile: ## 对账并修复：缺失容器重建、state 以容器为准；孤儿卷只报告
	@curl -s --noproxy '*' $(CONSOLE_AUTH) -H 'Content-Type: application/json' \
	  -d '{}' $(CONSOLE_URL)/reconcile

reclaim: ## 回收孤儿卷：删掉注册表里没有的团队的卷（被容器占用的会自动跳过）
	@echo "先看清楚要删什么：make reconcile-check"
	@curl -s --noproxy '*' $(CONSOLE_AUTH) -H 'Content-Type: application/json' \
	  -d '{"cleanupVolumes":true}' $(CONSOLE_URL)/reconcile

.PHONY: archive
archive: ## 归档某个团队（TEAM=team-b）：卷打 tar → 删容器删卷
	@curl -s --noproxy '*' $(CONSOLE_AUTH) -H 'Content-Type: application/json' \
	  -d '{"team":"$(TEAM)","reason":"make archive"}' $(CONSOLE_URL)/archive

.PHONY: restore
restore: ## 从归档恢复某个团队（TEAM=team-b）
	@curl -s --noproxy '*' $(CONSOLE_AUTH) -H 'Content-Type: application/json' \
	  -d '{"team":"$(TEAM)"}' $(CONSOLE_URL)/restore

.PHONY: snapshot
snapshot: ## 立刻给 accounts/state/nodes 拍快照（每小时也会自动拍）
	@curl -s --noproxy '*' -X POST $(CONSOLE_AUTH) $(CONSOLE_URL)/snapshot

.PHONY: backups
backups: ## 看已有快照
	@ls -lt deploy/orchestrator/backups 2>/dev/null | head -12 || echo "还没有快照（make console 启动时会拍一次）"

# ---------- 技能与连接器市场 ----------
# 详见 docs/11-技能与连接器.md。市场仓库在 deploy/market/，团队侧落在各自的卷里。

.PHONY: market
market: ## 看市场里有哪些技能/连接器（TEAM=team-a 时附带该团队已装版本）
	@curl -s --noproxy '*' $(CONSOLE_AUTH) "$(CONSOLE_URL)/market?team=$(TEAM)"

.PHONY: packages
packages: ## 看某个团队已装的技能与连接器（TEAM=team-a）
	@curl -s --noproxy '*' $(CONSOLE_AUTH) "$(CONSOLE_URL)/packages?team=$(TEAM)"

.PHONY: install
install: ## 装一个包：make install TEAM=team-a KIND=skill NAME=hologres-query
	@curl -s --noproxy '*' --max-time 300 $(CONSOLE_AUTH) -H 'Content-Type: application/json' \
	  -d '{"team":"$(TEAM)","kind":"$(or $(KIND),skill)","name":"$(NAME)"}' $(CONSOLE_URL)/market/install

.PHONY: uninstall
uninstall: ## 卸一个包：make uninstall TEAM=team-a KIND=mcp NAME=filesystem
	@curl -s --noproxy '*' --max-time 300 $(CONSOLE_AUTH) -H 'Content-Type: application/json' \
	  -d '{"team":"$(TEAM)","kind":"$(or $(KIND),skill)","name":"$(NAME)","by":"make"}' $(CONSOLE_URL)/market/uninstall

.PHONY: publish
publish: ## 把团队的私有包发到市场：make publish TEAM=team-a KIND=skill NAME=x VISIBILITY=private
	@curl -s --noproxy '*' $(CONSOLE_AUTH) -H 'Content-Type: application/json' \
	  -d '{"team":"$(TEAM)","kind":"$(or $(KIND),skill)","name":"$(NAME)","version":"$(or $(VERSION),1.0.0)","visibility":"$(or $(VISIBILITY),private)"}' \
	  $(CONSOLE_URL)/market/publish

.PHONY: share
share: ## 投递一个包（对方要启用才生效）：make share FROM=team-a TO=team-b KIND=skill NAME=x NOTE=原因
	@test -n "$(FROM)" -a -n "$(TO)" -a -n "$(NAME)" || { echo "用法：make share FROM=team-a TO=team-b KIND=skill NAME=hologres-query [NOTE=原因]"; exit 1; }
	@curl -s --noproxy '*' --max-time 300 $(CONSOLE_AUTH) -H 'Content-Type: application/json' \
	  -d '{"from":"$(FROM)","to":"$(TO)","kind":"$(or $(KIND),skill)","name":"$(NAME)","note":"$(NOTE)","by":"make"}' $(CONSOLE_URL)/market/share

.PHONY: shares
shares: ## 看某个团队相关的分享与待接收：make shares TEAM=team-b
	@curl -s --noproxy '*' $(CONSOLE_AUTH) "$(CONSOLE_URL)/shares?team=$(TEAM)"

.PHONY: share-enable
share-enable: ## 接收方启用一条分享：make share-enable TEAM=team-b ID=<分享id>
	@test -n "$(TEAM)" -a -n "$(ID)" || { echo "用法：make share-enable TEAM=team-b ID=<分享id>（先 make shares TEAM=team-b 找 id）"; exit 1; }
	@curl -s --noproxy '*' --max-time 300 $(CONSOLE_AUTH) -H 'Content-Type: application/json' \
	  -d '{"id":"$(ID)","team":"$(TEAM)","by":"make"}' $(CONSOLE_URL)/market/share/enable

.PHONY: share-reject
share-reject: ## 接收方拒收一条分享：make share-reject TEAM=team-b ID=<分享id>
	@test -n "$(TEAM)" -a -n "$(ID)" || { echo "用法：make share-reject TEAM=team-b ID=<分享id>"; exit 1; }
	@curl -s --noproxy '*' --max-time 300 $(CONSOLE_AUTH) -H 'Content-Type: application/json' \
	  -d '{"id":"$(ID)","team":"$(TEAM)","by":"make"}' $(CONSOLE_URL)/market/share/reject

# ---------- 团队级模型凭据 ----------
# 不设的话所有团队共用 deploy/compose/.env 里的 DEEPSEEK_API_KEY。

.PHONY: team-key
team-key: ## 给团队单独配模型 key（TEAM=team-a KEY=sk-xxx；不传 KEY 就清除）。加密入库，不重启实例
	@curl -s --noproxy '*' --max-time 150 $(CONSOLE_AUTH) -H 'Content-Type: application/json' \
	  -d '{"team":"$(TEAM)","deepseekApiKey":"$(KEY)"}' $(CONSOLE_URL)/secrets

.PHONY: team-key-rotate
team-key-rotate: ## 轮换团队的模型网关 token（TEAM=team-a）：旧 token 立即失效，实例自动重启
	@curl -s --noproxy '*' --max-time 150 $(CONSOLE_AUTH) -H 'Content-Type: application/json' \
	  -d '{"team":"$(TEAM)"}' $(CONSOLE_URL)/llm-token

.PHONY: team-key-show
team-key-show: ## 看某个团队是否配了独立 key（只显示有没有，不显示内容）
	@curl -s --noproxy '*' $(CONSOLE_AUTH) "$(CONSOLE_URL)/secrets?team=$(TEAM)"

# ---------- 事实库 ----------
# 技能/连接器/分享/日志的唯一来源。JSON 时代的数据靠 db-init 灌进来，之后就以库为准。

.PHONY: db-init
db-init: ## 建表并把现有市场与 JSON 灌进库（幂等；原文件不动，作为回退基线）
	@node deploy/orchestrator/migrate-db.mjs

.PHONY: db-init-reset
db-init-reset: ## 清空重建后重新导入（会丢掉库里的改动，只在迁移调试时用）
	@node deploy/orchestrator/migrate-db.mjs --reset

.PHONY: db
db: ## 用 SQL 查事实库：make db SQL="SELECT team_id,name,version,enabled FROM team_skills"
	@node -e "import('./deploy/orchestrator/db.mjs').then(m=>{const db=m.openDb();const q=process.argv[1]||'SELECT team_id,name,version,enabled FROM team_skills ORDER BY team_id,name';const rows=db.prepare(q).all();console.table(rows.length?rows:[\"(空)\"])})" "$(SQL)"

.PHONY: market-token
market-token: ## 看某个团队的只读市场 token（给 dsh 容器拉技能用）：make market-token TEAM=team-a
	@test -n "$(TEAM)" || { echo "用法：make market-token TEAM=team-a"; exit 1; }
	@node deploy/orchestrator/market-token.mjs "$(TEAM)"

.PHONY: verify-ownership
verify-ownership: ## 自测名称唯一 + id 关联 + 授权（临时库，不碰生产数据）
	@node deploy/orchestrator/verify-ownership.mjs

.PHONY: verify-sessions
verify-sessions: ## 自测「会话增量同步与重建」（临时卷 + 临时对象库 + 临时库，不需要 docker）
	@node deploy/orchestrator/verify-sessions.mjs

.PHONY: verify-shadow
verify-shadow: ## 自测「本地同名技能遮蔽」拦截（临时库 + 临时工作区）
	@node deploy/orchestrator/verify-shadow.mjs

# 核心是「密钥不进容器」：加密只解决平台侧存放，网关才解决 agent 读得到读不到。
# 假上游本地跑，不发真实请求、不碰生产库。
.PHONY: verify-gateway
verify-gateway: ## 自测密钥网关：信封加密 + 团队 token + SSE 不缓冲
	@node deploy/orchestrator/verify-gateway.mjs

# 归档包已经不再落在 archives/，而是进内容寻址对象层；换个后端（OSS）时靠这套断言兜底。
.PHONY: verify-objects
verify-objects: ## 自测对象层：寻址/去重/取回一致 + 上传失败降级不丢数据
	@node deploy/orchestrator/verify-objects.mjs

# 这两个脚本跑在容器启动路径上，写坏了容器起不来，所以必须能在宿主上单独验。
# yaml 库不额外装：从运行镜像里借一份（与 dsh 用的是同一个解析器），放进 .verify-yaml/。
.PHONY: verify-profile
verify-profile: ## 自测「agent 参数跨重启保留 + 会话 cwd 补建」（借用运行镜像里的 yaml）
	@[ -f .verify-yaml/package.json ] || ( \
	  mkdir -p .verify-yaml/node_modules && \
	  docker run --rm --entrypoint sh "my-dsh:$${DSH_VERSION:-0.2.1-rc.5}" \
	    -c 'cd /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules && tar cf - yaml' \
	    | tar xf - -C .verify-yaml/node_modules && \
	  printf '{"name":"verify-yaml"}\n' > .verify-yaml/package.json && \
	  echo "已从镜像取得 yaml 库" )
	@DSH_YAML_ROOT=$(CURDIR)/.verify-yaml/package.json node deploy/orchestrator/verify-profile.mjs

# 工作区落点决定产物能不能活过发版，判断错是静默丢数据，所以单独立一条自测。
.PHONY: verify-workspace-guard
verify-workspace-guard: ## 自测 workspace-guard：路径归一化到 /workspace/<name>、目录预建、卸载还原
	@node deploy/orchestrator/verify-workspace-guard.mjs

.PHONY: verify-workspace-migrate
verify-workspace-migrate: ## 自测 migrate-workspaces：旧工作区摘除、会话归档、空目录清理
	@node deploy/orchestrator/verify-workspace-migrate.mjs

# 产物归因是「这一轮改了哪些文件」的唯一持久来源：抄错/丢文件都是静默的。
.PHONY: verify-artifacts
verify-artifacts: ## 自测产物归因：采集 → 上推对象层 → 查询，含幂等、坏数据、体积兜底
	@node deploy/orchestrator/verify-artifacts.mjs

# 热重载判错的两个方向都很难受：谎报成功（装了不生效）或过度重建（白等 40 秒）。
.PHONY: verify-reload
verify-reload: ## 自测热重载判定：子进程出现/消失、超时降级、无子进程那一档
	@node deploy/orchestrator/verify-reload.mjs

# 空集合怎么表示踩过两次坑（空文件 / [] 又被追加），且都是「实例起不来」级别。
.PHONY: verify-market-patch
verify-market-patch: ## 自测 cordis.patch.yml 拼接与规范化（含卸载后回到 []）
	@node deploy/orchestrator/verify-market-patch.mjs

# 解包是最容易被塞进恶意路径的一层；digest 是「要不要重下」的唯一判据，两个都不能靠真机试错。
.PHONY: verify-bundle
verify-bundle: ## 自测多文件技能包：打包/解包/路径安全/digest/入库/读闸门（不需要 docker）
	@node deploy/orchestrator/verify-bundle.mjs

# 助理的隔离语义（一机器人一助理一会话、同助理串行、msgId 幂等、非 @ 不进 dsh）
# 全靠约束而不是靠约定，必须离线可复现。
.PHONY: verify-assistants
verify-assistants: ## 自测助理：双平台 @ 判定、验签、串行队列、首建会话、分片、幂等（不需要 docker）
	@node deploy/orchestrator/verify-assistants.mjs

.PHONY: verify-stream
verify-stream: ## 自测钉钉 Stream：建连、探活回执、换票重连、按 clientId 去重（不需要网络）
	@node deploy/orchestrator/verify-stream.mjs

.PHONY: verify-openapi
verify-openapi: ## 自测钉钉主动发送：token 缓存、群/单聊参数、401 重试（不需要网络）
	@node deploy/orchestrator/verify-openapi.mjs

# docker cp 进容器的文件属主是宿主 uid（501），dsh 是 1000 且会话文件 600，
# 一读就 EACCES，workspaceRegistry 起不来，侧栏显示「暂无会话」——看起来像数据被删。
.PHONY: fix-perms
fix-perms: ## 体检 ~/.dsh 里属主异常的文件（只报告）；加 APPLY=1 修复
	@node deploy/orchestrator/fix-session-perms.mjs $(if $(APPLY),--apply,) $(if $(TEAM),--team $(TEAM),)

# 人员/团队三张表目前是影子数据：accounts.json 仍是事实源，这个只是本地同步一份便于连表查询。
.PHONY: accounts-sync
accounts-sync: ## 把 accounts.json 的人员/团队/成员关系同步进 users/teams/team_members（幂等）
	@node deploy/orchestrator/migrate-accounts.mjs

.PHONY: accounts-dry
accounts-dry: ## 只看会往 users/teams/team_members 写什么，不落库
	@node deploy/orchestrator/migrate-accounts.mjs --dry-run

# ---------- 清理 ----------
.PHONY: clean
clean: ## 停服务并删除数据卷（会话与凭据一并清掉）
	$(COMPOSE) down -v
