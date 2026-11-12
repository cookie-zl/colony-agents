<div align="center">

# Dockmaster

**Turn an AI agent into team infrastructure.**

One isolated instance per team. `@` it in DingTalk / Feishu. Accounts, access control,
sleep-wake, backups and a skill marketplace — all on your own machines.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-3c873a.svg)](https://nodejs.org)
[![Self-hosted](https://img.shields.io/badge/self--hosted-yes-111.svg)](#quickstart)

[中文](README.md) · [Docs](docs/features/README.md) · [Contributing](CONTRIBUTING.md)

</div>

![Main UI: chatting with the agent, with thinking, token usage and full session history](docs/images/hero.png)

## What it is

[Dockmaster](.) wraps [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh — an agent runtime
that can read/write files, run commands and load skills) into something **a team can actually operate**:

- **One team = one instance = one set of volumes.** No cross-team context bleed.
- **Accounts, roles and an audit log** — not "whoever has the URL gets in".
- **Sleep when idle, wake on access.** Several teams fit on one box.
- **The agent lives in your chat, too.** `@` the bot in DingTalk / Feishu; the reply lands in that group,
  same session. DingTalk uses a **Stream** long connection, so no public IP and no tunnel required.
- **Sessions survive restarts** — sessions and archives go to a content-addressed object layer, so the
  container is a disposable cache.
- **One-click team creation** — portal button → container, with quota checks and rollback.

It is *not* another chat front-end. It is the operations layer: how images ship, how teams are provisioned,
how model keys are stored, how data outlives a `docker rm`.

## Quickstart

Requires Docker and `make`.

```bash
git clone https://github.com/zhang-zi-long/my-dsh.git dockmaster && cd dockmaster
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
  STREAM --> CONSOLE[Control plane<br/>provision · quota · sleep/wake · assistant dispatch]
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

## Docs

- Design notes (why, and what broke): [`docs/01`–`docs/20`](docs/features/README.md)
- Feature inventory (what exists, where, and how it was verified): [`docs/features/`](docs/features/README.md)

Chinese is the primary documentation language; English translations are welcome.

## License

[Apache-2.0](LICENSE). dsh itself is not vendored here — it is pinned as an npm dependency under its own license.
