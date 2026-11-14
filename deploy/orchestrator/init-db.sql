-- 技能 / 连接器 / 分享 / 操作日志的数据模型。设计说明见 docs/12-数据模型.md，
-- 技能包的多文件分发见 docs/13-技能包与对象存储.md。
--
-- 执行方式：`node deploy/orchestrator/migrate-db.mjs` 会读这个文件并 db.exec()，
-- 全部语句都是 IF NOT EXISTS，可以重复跑。
--
-- 与文档的一处差异：team_mcps 也加了 version 冗余列，理由同 team_skills。
--
-- 表一览（按角色分四类，不是按建表顺序）：
--   人员 / 组织（谁属于谁）
--     users              用户基础表：一行 = 一个可登录账号
--     teams              团队基础信息表：一行 = 一个团队（= 一套独立实例）
--     team_members       团队成员表：一行 = 某人在某团队里的角色（唯一关系源）
--   基础表（包是什么）
--     market_items       skill / 连接器基础表：一行 = 一个包的一个版本
--     market_item_files  skill 包内容表（替身对象存储）：一行 = 包内一个文件
--   关系表（谁装了什么）
--     team_skills        团队 × skill 安装关系表：锁版本 + 启停
--     team_mcps          团队 × 连接器安装关系表：带渲染指纹
--     team_secrets       连接器凭证明细表：一个 env key 一行（密文）
--     market_tokens      机器身份表：一个团队一枚只读市场 token
--   状态 / 流水表（发生过什么）
--     market_current     市场发布指针表：某包当前对外是哪一版
--     shares             分享流水表（同时是授权凭证）
--     ops                操作日志表：谁 / 何时 / 对谁 / 做了什么
--   会话数据（容器可丢的前提）
--     team_sessions      会话索引表：一行 = 团队里一个会话（侧栏列表 + 正文指针）
--     session_sync       会话同步进度表：一行 = 一个会话已上推到哪个字节（增量游标）
--     session_artifacts  产物归因表：一行 = 一个会话的一轮（改了哪些文件 + 详情对象键）
--
-- 核心关系（全部用 id 关联，不用 name 关联）：
--   team_members.team_id ──→ teams.id
--   team_members.user_id ──→ users.id
--   team_skills.team_id、team_mcps.team_id、team_secrets.team_id、market_tokens.team_id
--                        ──→ teams.id（暂时没加外键，见 docs/12 §2 末尾）
--   market_current.item_id ──┐
--   team_skills.item_id    ──┼──→ market_items.id ──→ market_item_files.item_id
--   team_mcps.item_id      ──┤
--   shares.item_id         ──┘
-- name / version 在 team_skills / shares 里是快照，只为不 JOIN 就能读，
-- 不作为连接条件（id 才能区分「同名同版本的另一份包」）。

-- users · 用户基础表：一行 = 一个可登录账号（登录名即主键，账号本身没有独立 id）
CREATE TABLE IF NOT EXISTS users (
  id               TEXT PRIMARY KEY,              -- 登录名 'alice'
  display_name     TEXT NOT NULL,                 -- 'Alice'
  password_salt    TEXT NOT NULL,
  password_hash    TEXT NOT NULL,
  password_version INTEGER NOT NULL DEFAULT 0,    -- 改密后旧会话立即失效（原 pv 字段）
  is_admin         INTEGER NOT NULL DEFAULT 0,    -- 全局管理员：能建团队、能管所有团队
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_login_at    TEXT
);

-- teams · 团队基础信息表：一行 = 一个团队（= 一套独立实例 + 独立数据卷 + 独立入口）
CREATE TABLE IF NOT EXISTS teams (
  id          TEXT PRIMARY KEY,                   -- 'team-a'
  name        TEXT NOT NULL,                      -- '广告组'
  description TEXT,
  host        TEXT,                               -- 入口 'team-a.localhost'
  port        INTEGER,                            -- 实例端口 8080
  node_id     TEXT,                               -- 落在哪个节点，对应 nodes.json 的 id
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','sleeping','archived')),
  created_by  TEXT REFERENCES users (id),
  created_at  TEXT NOT NULL,
  archived_at TEXT
);

-- team_members · 团队成员表：一行 = 某人在某团队里的角色；人员与团队的唯一关系源
CREATE TABLE IF NOT EXISTS team_members (
  team_id    TEXT NOT NULL REFERENCES teams (id),
  user_id    TEXT NOT NULL REFERENCES users (id),
  role       TEXT NOT NULL CHECK (role IN ('owner','member')),
  joined_at  TEXT NOT NULL,
  invited_by TEXT REFERENCES users (id),
  PRIMARY KEY (team_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members (user_id);

-- market_items · skill/连接器基础表（市场包元数据）：一行 = 一个包的一个版本，只存索引不存正文
CREATE TABLE IF NOT EXISTS market_items (
  id           TEXT PRIMARY KEY,               -- 'skill:hologres-query@1.0.0'
  kind         TEXT NOT NULL CHECK (kind IN ('skill','mcp')),
  name         TEXT NOT NULL,
  version      TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL,                  -- 给模型看的路由摘要
  when_to_use  TEXT,                           -- 技能专用
  config       TEXT,                           -- 连接器：JSON {spec, env}
  digest       TEXT NOT NULL,                  -- sha256(kind|name|version|文件清单|config)，不含 mtime
  rank         INTEGER NOT NULL DEFAULT 550,
  visibility   TEXT NOT NULL CHECK (visibility IN ('public','private')),
  owner_team   TEXT NOT NULL DEFAULT '_system',
  status       TEXT NOT NULL CHECK (status IN ('draft','published','deprecated')),
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  published_at TEXT,
  UNIQUE (kind, name, version)
);

CREATE INDEX IF NOT EXISTS idx_market_items_name ON market_items (kind, name);

-- market_current · 市场发布指针表：一行 = 一个包当前对外发布的那一版
CREATE TABLE IF NOT EXISTS market_current (
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  item_id    TEXT NOT NULL REFERENCES market_items (id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, name)
);

-- market_item_files · skill 包内容表（暂时扮演对象存储）：一行 = 包内一个文件，PK 即逻辑对象键
-- 正文不再存 market_items.content：一个包的正文只允许有一处事实，否则「表里说的」和
-- 「物化到磁盘的」迟早对不上。storage/object_key 是接 OSS 的预留位（docs/13 §11），
-- 现在只有 'db' 一种取值。
CREATE TABLE IF NOT EXISTS market_item_files (
  item_id    TEXT NOT NULL REFERENCES market_items (id),
  path       TEXT NOT NULL,                    -- 相对路径，如 'references/sql-style.md'
  content    BLOB NOT NULL,                    -- 原始字节（含 frontmatter），不剥不转码
  sha256     TEXT NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  executable INTEGER NOT NULL DEFAULT 0,       -- 来自 tar mode 或文件系统的可执行位
  mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
  storage    TEXT NOT NULL DEFAULT 'db',       -- 'db' | 'oss'
  object_key TEXT,                             -- storage='oss' 时的对象键
  PRIMARY KEY (item_id, path)
);

-- team_skills · 团队×skill 安装关系表：一行 = 某团队装了某技能（锁版本 + 启停）
CREATE TABLE IF NOT EXISTS team_skills (
  team_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  item_id      TEXT NOT NULL REFERENCES market_items (id),
  version      TEXT NOT NULL,                  -- 冗余自 item_id，为了不 JOIN 就能读
  enabled      INTEGER NOT NULL DEFAULT 0,     -- 装了 ≠ 启用
  source       TEXT NOT NULL CHECK (source IN ('market','share','manual')),
  source_team  TEXT,
  share_id     TEXT,
  installed_by TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  enabled_by   TEXT,
  enabled_at   TEXT,
  PRIMARY KEY (team_id, name)
);

-- team_mcps · 团队×连接器安装关系表：一行 = 某团队装了某 MCP（带渲染指纹）
CREATE TABLE IF NOT EXISTS team_mcps (
  team_id         TEXT NOT NULL,
  name            TEXT NOT NULL,
  item_id         TEXT NOT NULL REFERENCES market_items (id),
  version         TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 0,
  source          TEXT NOT NULL CHECK (source IN ('market','share','manual')),
  source_team     TEXT,
  share_id        TEXT,
  config_override TEXT,                        -- JSON，覆盖市场默认 spec
  rendered_digest TEXT,                        -- 已落进 cordis.patch.yml 的块指纹
  installed_by    TEXT NOT NULL,
  installed_at    TEXT NOT NULL,
  enabled_by      TEXT,
  enabled_at      TEXT,
  PRIMARY KEY (team_id, name)
);

-- team_secrets · 连接器凭证明细表：一行 = 某团队某连接器的一个 env key（密文）
CREATE TABLE IF NOT EXISTS team_secrets (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL,
  scope      TEXT NOT NULL,                    -- 'mcp:github'
  key        TEXT NOT NULL,                    -- 'GITHUB_TOKEN'
  ciphertext BLOB NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (team_id, scope, key)
);

-- shares · 分享流水表（同时是授权凭证）：一行 = 一次点对点投递及其状态
CREATE TABLE IF NOT EXISTS shares (
  id          TEXT PRIMARY KEY,
  from_team   TEXT NOT NULL,
  to_team     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('skill','mcp')),
  item_id     TEXT REFERENCES market_items (id),  -- 唯一关联键：指向被分享的那一版
  name        TEXT NOT NULL,                      -- 快照，仅展示：包被改名/下架后这条流水仍要可读
  version     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending','enabled','rejected')),
  note        TEXT,
  env_keys    TEXT,                            -- JSON array：只留键名
  by          TEXT NOT NULL,
  at          TEXT NOT NULL,
  enabled_at  TEXT,
  enabled_by  TEXT,
  rejected_at TEXT,
  rejected_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_shares_to ON shares (to_team, status);
-- shares(item_id) 的索引建在 db.mjs 的 ensureColumns 里：老库的这张表还没这一列，
-- 在本文件建会因「no such column」直接失败（schema 先于补列执行）。

-- ops · 操作日志表：一行 = 一次变更（谁 / 何时 / 对谁 / 做了什么）
CREATE TABLE IF NOT EXISTS ops (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL,
  team      TEXT NOT NULL,
  action    TEXT NOT NULL,
  kind      TEXT,
  name      TEXT,
  by        TEXT,
  note      TEXT,
  detail    TEXT,
  from_team TEXT,                              -- 分享类操作：来源团队
  to_team   TEXT                               -- 分享类操作：目标团队
);

CREATE INDEX IF NOT EXISTS idx_ops_team_at ON ops (team, at DESC);

-- market_tokens · 机器身份表：一行 = 一个团队的只读市场 token
CREATE TABLE IF NOT EXISTS market_tokens (
  team_id    TEXT PRIMARY KEY,
  token      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

-- team_sessions · 会话索引表：一行 = 团队里的一个会话（侧栏列表来源 + 正文指针）
CREATE TABLE IF NOT EXISTS team_sessions (
  id             TEXT PRIMARY KEY,               -- dsh 的 session id（路径里那个编码段解码后）
  team_id        TEXT NOT NULL,
  project        TEXT NOT NULL,                  -- 项目目录 `--<normalized-cwd>--`
  cwd            TEXT,                           -- 归一化后的工作目录
  title          TEXT,
  generation     INTEGER NOT NULL DEFAULT 3,     -- session.vN 的 N，恢复时要还原成同一个文件名
  log_path       TEXT NOT NULL,                  -- 卷内相对路径（相对会话根）
  log_bytes      INTEGER NOT NULL DEFAULT 0,
  digest         TEXT,                           -- 清单摘要：各分段 sha256 按顺序再取 sha256
  last_active_at TEXT,                           -- 取文件 mtime，侧栏按它倒序
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  archived_at    TEXT,                           -- dsh 侧栏归档标记，与平台归档不是一回事
  missing_at     TEXT                            -- 卷里已找不到：记录留、内容在对象层
);

CREATE INDEX IF NOT EXISTS idx_team_sessions_team ON team_sessions (team_id, last_active_at DESC);

-- session_sync · 会话同步进度表：一行 = 一个会话推到了第几个字节（增量上传的游标）
CREATE TABLE IF NOT EXISTS session_sync (
  session_id     TEXT PRIMARY KEY REFERENCES team_sessions (id),
  team_id        TEXT NOT NULL,
  uploaded_bytes INTEGER NOT NULL DEFAULT 0,     -- 连续前缀长度，分段严格对齐到这里
  segment_count  INTEGER NOT NULL DEFAULT 0,
  synced_at      TEXT,
  status         TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','syncing','error')),
  error          TEXT
);

CREATE INDEX IF NOT EXISTS idx_session_sync_team ON session_sync (team_id, synced_at);

-- session_artifacts · 产物归因表：一行 = 一个会话的一轮改动。
-- 为什么需要：会话日志里 `workspace/changes` 事件只带轮号，文件清单与 diff 原本只在
-- Host 内存和 Session 临时目录里，Session 释放即删、进程重启即无。这张表把「第几轮
-- 改了哪些文件」变成持久事实，逐文件 hunks 另存对象层（detail_key），点开才读。
-- files 是快照数组（path/display/action/added/deleted/kind），不含 hunks——它要能被 SQL 查。
CREATE TABLE IF NOT EXISTS session_artifacts (
  id            TEXT PRIMARY KEY,                 -- <team>:<session>:<turn>，唯一入口别手拼
  team_id       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  turn          INTEGER NOT NULL,                 -- 顶层轮号，从 1 开始
  seq           INTEGER NOT NULL DEFAULT 0,       -- 宣告这条摘要的事件序号（同一轮可能补一条）
  cwd           TEXT,                             -- 该轮的工作目录
  files         TEXT NOT NULL DEFAULT '[]',       -- JSON 数组：文件清单（无 hunks）
  total         INTEGER NOT NULL DEFAULT 0,       -- 摘要报告的文件总数（files 可能被 maxFiles 截断）
  added         INTEGER NOT NULL DEFAULT 0,       -- 本轮新增行数合计
  deleted       INTEGER NOT NULL DEFAULT 0,       -- 本轮删除行数合计
  detail_key    TEXT,                             -- 对象层键：完整记录（含 hunks）
  detail_bytes  INTEGER NOT NULL DEFAULT 0,
  detail_digest TEXT,                             -- 记录内容的 sha256，用来判「要不要重传」
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (team_id, session_id, turn)
);

CREATE INDEX IF NOT EXISTS idx_session_artifacts_session ON session_artifacts (team_id, session_id, turn DESC);

-- team_agent_config · 团队级 agent 参数（profile 用户层）：一行 = 一个版本。
-- 为什么不放卷里就够：卷是可丢的（归档 down -v / 换节点），而「这个团队的模型、
-- preset、工具开关」是用户配出来的资产，必须和会话一样有卷外副本。
-- rows 存的是 patch 条目数组（[{id, kind:'patch'|'insert', value}]），不含镜像基线；
-- 镜像基线每次 seed 自带，合并由容器启动时的 profile-patch.mjs 完成。
CREATE TABLE IF NOT EXISTS team_agent_config (
  team_id    TEXT NOT NULL,                       -- 团队 id；真源在 accounts.json，这里不挂外键
  revision   INTEGER NOT NULL,
  rows       TEXT NOT NULL,                       -- JSON 数组，用户层覆盖项
  digest     TEXT NOT NULL,                       -- rows 的 sha256，用来判「有没有变」
  source     TEXT NOT NULL DEFAULT 'ui' CHECK (source IN ('ui','api','restore')),
  created_at TEXT NOT NULL,
  created_by TEXT,
  PRIMARY KEY (team_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_team_agent_config_team ON team_agent_config (team_id, revision DESC);

-- team_llm_tokens · 每团队一枚的模型网关 token。
-- 为什么不复用 market_tokens：那枚是「只读技能目录」，这枚能消耗 LLM 额度，
-- 权限不同就该是两枚凭证，泄漏时能单独吊销。容器里只拿这一枚，拿不到真 API Key。
CREATE TABLE IF NOT EXISTS team_llm_tokens (
  team_id    TEXT PRIMARY KEY,
  token      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

-- assistants · 一个 IM 机器人的**配置**。对话不在这里：一个群一条线程，见 assistant_threads。
-- 一个机器人只能有一份配置（UNIQUE platform+robot_key）——否则同一机器人的消息会被两份配置抢。
-- 凭据不进这张表：出站 webhook / 应用密钥走 team_secrets，scope = 'assistant:<id>'。
CREATE TABLE IF NOT EXISTS assistants (
  id              TEXT PRIMARY KEY,
  team_id         TEXT NOT NULL,
  name            TEXT NOT NULL,
  platform        TEXT NOT NULL CHECK (platform IN ('dingtalk','feishu')),
  robot_key       TEXT NOT NULL,                -- 钉钉 robotCode / 飞书 app_id
  system_prompt   TEXT,                        -- 附在用户消息前的助理人设/约束
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (platform, robot_key)
);

CREATE INDEX IF NOT EXISTS idx_assistants_team ON assistants (team_id);

-- assistant_threads · 一个群一条对话 = 一条 dsh 会话。
-- 对话的唯一键是「机器人 + 群」：`(assistant_id, conversation_id)`。
-- 为什么 conversation_id 用空串而不是 NULL：SQLite 的 UNIQUE 不约束 NULL，
-- 用 NULL 会让同一个群在并发里插出两条线程。空串表示「拿不到群 id 的兜底线程」（模拟消息/测试）。
-- 之所以不直接拼 (platform, robot_key, conversation_id)：robot_key 已经由 assistant_id 唯一确定。
CREATE TABLE IF NOT EXISTS assistant_threads (
  id              TEXT PRIMARY KEY,
  assistant_id    TEXT NOT NULL REFERENCES assistants (id),
  team_id         TEXT NOT NULL,                -- 冗余一份，按团队查线程不用回 join
  platform        TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',     -- 钉钉 conversationId / 飞书 chat_id
  title           TEXT,                         -- 群名（平台给了才有），展示用
  session_id      TEXT,                         -- 首轮 headless 建好后回写，之后一直续聊
  created_at      TEXT NOT NULL,
  last_active_at  TEXT NOT NULL,
  UNIQUE (assistant_id, conversation_id),
  UNIQUE (session_id)
);

CREATE INDEX IF NOT EXISTS idx_assistant_threads_assistant ON assistant_threads (assistant_id, last_active_at DESC);

-- assistant_channels · 「只服务这几个群」的白名单。
-- 空表 = 不限群（机器人被拉进哪个群都处理）。有行时，只有列进来的群能触发。
-- 这是**准入**，和 assistant_threads 的**分对话**是两件事，不要合并：
-- 前者决定「这个群能不能用」，后者决定「这个群用哪条会话」。
CREATE TABLE IF NOT EXISTS assistant_channels (
  assistant_id    TEXT NOT NULL REFERENCES assistants (id),
  conversation_id TEXT NOT NULL,
  title           TEXT,
  added_by        TEXT,
  added_at        TEXT NOT NULL,
  PRIMARY KEY (assistant_id, conversation_id)
);

-- assistant_messages · 消息流水：一行 = 一条入站消息及其处理结果。
-- UNIQUE(assistant_id, platform, msg_id) 同时承担幂等：钉钉/飞书都可能重推同一条消息，
-- 插入冲突即视为已处理，不再跑第二次 dsh。
CREATE TABLE IF NOT EXISTS assistant_messages (
  id              TEXT PRIMARY KEY,
  assistant_id    TEXT NOT NULL REFERENCES assistants (id),
  thread_id       TEXT,                        -- 归属的群线程；老库由 ensureColumns 补
  platform        TEXT NOT NULL,
  msg_id          TEXT NOT NULL,
  conversation_id TEXT,
  sender_id       TEXT,
  sender_name     TEXT,
  inbound         TEXT NOT NULL,
  outbound        TEXT,
  -- 模型这一轮的思考过程（headless 的 thinking 事件）。展示在「沟通记录」里，可折叠。
  thinking        TEXT,
  -- status.step_end.usage 原样存 JSON：inputTokens / outputTokens / reasoningTokens
  usage           TEXT,
  status          TEXT NOT NULL CHECK (status IN ('queued','running','done','ignored','failed','timeout')),
  error           TEXT,
  elapsed_ms      INTEGER,
  created_at      TEXT NOT NULL,
  UNIQUE (assistant_id, platform, msg_id)
);

CREATE INDEX IF NOT EXISTS idx_assistant_messages_assistant ON assistant_messages (assistant_id, created_at DESC);
-- thread_id 的索引不在这里建：老库还没有这一列，schema 先于补列执行会直接报错。
-- 统一由 db.mjs 的 ensureColumns 在补完列之后建。
