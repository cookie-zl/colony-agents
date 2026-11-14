<div align="center">

# Colony

**Turn an AI agent into team infrastructure.**

Deploy one dsh on your own machines and share it with the whole team — one isolated
instance per tenant; skills and MCP connectors distributed through a marketplace with
versions; `@` the bot in DingTalk / Feishu and a digital employee picks it up.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-3c873a.svg)](https://nodejs.org)
[![Self-hosted](https://img.shields.io/badge/self--hosted-yes-111.svg)](#quickstart)

[中文](README.md) · [Docs](docs/features/README.md) · [Contributing](CONTRIBUTING.md)

</div>

![Main UI: chatting with the agent, with thinking, token usage and full session history](docs/images/hero.png)

## What it is

In one sentence: **turn [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh)
into an agent host a team can share — tenant-isolated, with distributable capabilities, reachable
from your chat.**

dsh is built for one person: one process, one session, one `$DSH_HOME`. That is great solo and
breaks down for a team — anyone can walk in, sessions bleed into each other, capabilities scatter
across laptops, and nobody dares restart the box. This project fills that gap: **tenancy,
capability distribution, chat entry points, durable state.**

It does not rewrite the agent, and it is not another chat front-end. It is the agent's
*building management* — access control, utilities, upkeep.

## Three problems it solves

### 1. A shared agent, with tenants kept apart

You want the agent to read logs, edit config and run scripts for the team — but group A must not
see group B's sessions or artifacts, and you are not handing everyone their own box.

**One team = one instance = one set of volumes.** Not a `team_id` column in a shared process:
process, filesystem, entry hostname and database rows are all separated.

| Dimension | Granularity |
| --- | --- |
| Runtime | One compose project (`dsh-<team>`) / one Helm release, one container per team |
| Files | Dedicated named volumes; deleting a team deletes them, nothing is shared |
| Sessions & artifacts | Own `$DSH_HOME` + own object layer; the sidebar only lists its own |
| Web entry | Own subdomain (`team-a.localhost:8080`), own login state and dsh token |
| Data | Fact DB partitioned by `team_id`: members, skill ledger, secrets, message log, audit |
| Secrets | Model keys sealed in the DB; the container only holds a revocable short token ([docs/18](docs/18-密钥网关.md)) |
| Compute | Idle 30 min → stop; access → wake (5.8s to healthy, users see a page in 2–4s, [docs/09](docs/09-休眠与唤醒.md)) |

That layer also answers "who gets in": accounts, passwords, team roles, joining a team,
cross-team tickets, and an audit row for every entry. dsh's own token stays behind the reverse
proxy ([docs/07](docs/07-多团队账号.md), [docs/06](docs/06-访问控制.md)). Provisioning a team is one
button: port allocation, volume creation, container start, quota check, rollback on failure
([docs/08](docs/08-动态建团队.md)).

### 2. Capabilities as versioned, distributable assets (skills + MCP)

Every team writes its own prompts and wires its own connectors; changing one means emailing
everyone, nobody knows which version is installed, and tokens live in personal config files.

**Package the capability together with its credentials, version it, and distribute it.**

| Capability | Detail |
| --- | --- |
| Two package kinds | `skill` (prompts / procedures) and `mcp` (connectors: GitHub, filesystem, …), same index and install flow |
| Versions | Every package carries a `version`; the install ledger records which version, who, and from where. The index keeps one current version per name, so upgrading means reinstalling rather than picking among versions |
| Upgrades | Reinstalling replaces the marked block instead of appending a second one (stacking yields "upgraded but still running the old version"), then `dsh --dump-config` validates; failure rolls back |
| Distribution | Public, team-private, or **point-to-point share** which the receiving team can accept or reject |
| Credentials | MCP env vars (e.g. `GITHUB_TOKEN`) are entered at install time, stored in the team's own volume, never logged by the control plane |
| Isolation | One ledger per team; uninstall only affects that team; private packages are invisible to others |
| Truth in the DB | Skills are not read from disk: `@colony/dsh-market-skill` pulls them from the control plane at runtime and materialises multi-file bundles as `<name>@<version>-<digest>`, deduplicated by digest — so "disabled in the portal but still active in the container" cannot happen |

Install, toggle and uninstall live in the sidebar marketplace panel; no container restart needed
([docs/11](docs/11-技能与连接器.md)).

### 3. Digital employees in your group chats — several per team

Someone asks a question in the group, a human copies it into a web page and pastes the answer
back; or the bot goes silent and nobody knows whether it is working, broken, or never received
the message.

**Each digital employee = one bot + one persona + one dedicated session.** `@` it in the group;
the answer returns to that group with the same context.

| Capability | Detail |
| --- | --- |
| Several employees | A team can create multiple assistants, each bound to its own bot (DingTalk AppKey / Feishu App ID) with independent persona, session and message log |
| Scope to one group | Optionally bind an assistant to a single group; unbound assistants answer wherever they are invited |
| Custom prompt | Each assistant carries a `system_prompt`, injected on the first turn to set the tone, then carried by session context (not repeated on every message) |
| No public IP needed | DingTalk uses a **Stream** long connection — the internal host dials out; Feishu uses an HTTP callback |
| No expiring reply address | An `access_token` plus OpenAPI active send, so replies do not depend on the ~1.5h `sessionWebhook` |
| No duplicates, no silence | `msgId` idempotency; serial per assistant, global concurrency 2; failures and timeouts get a reply instead of nothing |
| Observable | Every turn is logged (question, thinking, answer, token usage, latency) and the assistant session shows up as an ordinary session under "agent workspace" in the sidebar |

A real path, verified end to end:

```
@bot in the group
  → DingTalk pushes one event over the Stream connection (no public callback)
  → control plane normalises it → message log row (deduplicated by msgId)
  → docker exec dsh --profile headless (session pinned to that assistant / group)
  → reply sent back via OpenAPI (not the 1.5h sessionWebhook)
```

### Three cross-cutting guarantees

All three sit on the same substrate, and none of them is an afterthought:

- **Sessions do not disappear** — sessions and archives go to a content-addressed object layer;
  the container is a disposable cache ([docs/14](docs/14-对象层.md), [docs/15](docs/15-会话存算分离.md)).
- **You can see what changed** — `changes-collector` records which files each turn touched
  ([docs/20](docs/20-产物归因与配置热生效.md)); the platform keeps an access and operation audit.
- **Capabilities arrive as plugins** — six first-party plugins, pure ESM, zero dependencies, no build
  step, `make reload` swaps them in ~10s. Since installing a community plugin means letting its author
  run code on your server, `plugins.txt` pins exact versions ([docs/03](docs/03-社区插件.md)).

## Two repositories

| Repo | Contains | For |
| --- | --- | --- |
| **this one** (platform) | image, profile, control plane, account service, assistants, market — plus the six plugins | running the team edition with one command |
| [colony-dsh-plugins](https://github.com/cookie-zl/colony-dsh-plugins) | just the six plugin packages | you already run dsh and only want, say, `workspace-guard` |

The dependency is one-way: the plugin repo does not know the platform exists. Plugins are still
developed and tested here (their behaviour tests need a dsh container and DB fixtures), then
exported with `make mirror-plugins`, with `make mirror-check` guarding against drift.

No git submodules on purpose: private submodules need extra credentials, and a `git clone` without
`--recurse-submodules` yields a build that fails — the classic open-source turn-off.

## Quickstart

Requires Docker and `make`.

```bash
git clone https://github.com/cookie-zl/colony.git && cd colony
make seed      # generate accounts.json / nodes.json / .env (demo login admin / demo1234)
make up        # build image, start team-a → http://team-a.localhost:8080/
```

A model key is optional — the default lane is a free model. To bring your own:

```bash
make team-key TEAM=team-a KEY=sk-xxx   # encrypted at rest, never visible inside the container
```

`make help` lists every target; `make reload` swaps in plugin changes in ~10s.

## Architecture

```mermaid
flowchart TB
  B[Browser] -->|cookie / login| EDGE[Edge proxy<br/>session → membership → dsh token]
  G[DingTalk / Feishu] -->|@bot| STREAM[Stream connection<br/>or HTTP callback]
  EDGE --> AUTH[Account service]
  EDGE -->|reverse proxy| DSH[Team instance<br/>dsh + plugins]
  STREAM --> CONSOLE[Control plane<br/>provision · quota · sleep/wake · dispatch · market]
  CONSOLE -->|docker / k8s| DSH
  AUTH --> DB[(Fact DB<br/>teams · skills · secrets · messages)]
  CONSOLE --> DB
  DSH --> OBJ[(Object layer<br/>sessions · archives · artifacts)]
```

## Honest limitations

1. **Stateful, single replica.** dsh keeps sessions in memory + `$DSH_HOME`, so `replicas: 1`,
   `ReadWriteOnce`, and `Recreate` on upgrade. Scale by adding instances, not replicas.
2. **Plugins are in-process code, not a sandbox.** `apply(ctx)` runs with dsh's own privileges.
   Installing a community plugin means trusting its author with code execution — `plugins.txt` pins exact versions.
3. **One auth layer, outside dsh.** dsh identifies visitors by "token in URL → signed cookie".
   Real access control belongs in the proxy / gateway (see [docs/06](docs/06-访问控制.md)).
4. **Maturity: production-own-use, not 1.0.** Single maintainer, interfaces will move.
   DingTalk is verified end-to-end; Feishu uses an HTTP callback and needs a public endpoint.
5. **Only `@`-mentions are processed.** Full group message access is a sensitive scope on both platforms.
6. **One bot = one digital employee.** `UNIQUE(platform, robot_key)`: the same AppKey / AppID cannot back
   two assistants. Extra roles mean extra apps — which buys isolated permissions, personas and sessions.
7. **Context is per assistant, not per group.** An assistant has a single `session_id`, shared by every
   group it is invited to. To isolate a group, create an assistant bound to that group.

## Docs

- Design notes (why, and what broke): [`docs/01`–`docs/20`](docs/features/README.md)
- Feature inventory (what exists, where, and how it was verified): [`docs/features/`](docs/features/README.md)
- Roadmap, known gaps and things we deliberately did **not** build: [`docs/ROADMAP.md`](docs/ROADMAP.md)

Chinese is the primary documentation language; English translations are welcome.

## License

[Apache-2.0](LICENSE). dsh itself is not vendored here — it is pinned as an npm dependency under its own license.
