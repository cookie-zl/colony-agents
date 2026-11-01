SHELL := /bin/bash
.DEFAULT_GOAL := help

DSH_VERSION ?= 0.2.1-rc.5
IMAGE       ?= my-dsh:$(DSH_VERSION)
# 国内构建建议设成 mirrors.aliyun.com；官方源在部分网络下慢到不可用
APT_MIRROR  ?= mirrors.aliyun.com
NPM_REGISTRY ?= https://registry.npmmirror.com

COMPOSE     := docker compose -f deploy/compose/compose.yaml

HELM_CHART  := deploy/helm/my-dsh
# 没装 helm 也能校验：走容器里的 helm。本机已装 helm 时可用 HELM=helm 覆盖。
HELM        ?= docker run --rm -v $(CURDIR)/$(HELM_CHART):/apps alpine/helm:3.16.3

.PHONY: help
help: ## 列出所有目标
	@awk 'BEGIN {FS = ":.*?## "; print "用法: make <目标>\n"} \
	     /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# ---------- 本地运行（prod-like：插件以 tarball 装进 profile） ----------
.PHONY: up
up: ## 构建镜像并后台起服务 → http://dsh.localhost:8080/
	$(COMPOSE) up -d --build
	@echo ""
	@echo "入口:  http://dsh.localhost:8080/"
	@echo "取带 token 的首次访问链接: make token"

.PHONY: down
down: ## 停服务（保留数据卷）
	$(COMPOSE) down

.PHONY: logs
logs: ## 跟随日志
	$(COMPOSE) logs -f dsh

.PHONY: token
token: ## 打印当前实例带 token 的入口链接（token 会随每次启动变化）
	@$(COMPOSE) logs --no-log-prefix dsh 2>&1 | grep -o 'http[^ ]*token=[A-Za-z0-9_-]*' | tail -1

.PHONY: ps
ps: ## 看容器状态
	$(COMPOSE) ps

.PHONY: restart
restart: ## 重启 dsh（profile 会按 DSH_PROFILE_SEED 重新铺）
	$(COMPOSE) restart dsh

# ---------- 插件开发循环 ----------
# 插件必须从 profile 的 node_modules 里加载，宿主包（@deepseek-ai/dsh-*）才能被
# 正确地路由到 dsh 自带的那一份。所以改插件不能靠挂源码，只能重新打包进镜像。
# 好在这条路的缓存命中的部分很多：一次 reload 主要是镜像导出 + 容器重建。
.PHONY: reload
reload: ## 改完插件后重新构建并替换容器（保留数据卷与会话）
	$(COMPOSE) up -d --build dsh
	@sleep 6
	@$(COMPOSE) logs --no-log-prefix dsh 2>&1 | grep -E 'hello-dsh|listening' | tail -3

# ---------- 镜像 ----------
.PHONY: image
image: ## 构建可交付镜像（插件在镜像里自动打包安装）
	docker build -f deploy/image/Dockerfile \
	  --build-arg DSH_VERSION=$(DSH_VERSION) \
	  --build-arg APT_MIRROR=$(APT_MIRROR) \
	  --build-arg NPM_REGISTRY=$(NPM_REGISTRY) \
	  -t $(IMAGE) .
	@echo "已构建: $(IMAGE)"

.PHONY: verify
verify: ## 在运行中的容器里校验 profile 能否拼出来
	$(COMPOSE) exec -T dsh sh -lc 'dsh --profile web --dump-config | grep -n "^# =="'

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

# ---------- 清理 ----------
.PHONY: clean
clean: ## 停服务并删除数据卷（会话与凭据一并清掉）
	$(COMPOSE) down -v
