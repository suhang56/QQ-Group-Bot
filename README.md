<div align="center">

# QQ Group Bot

**A QQ group-chat bot that behaves like a real group member, not an assistant.**

*QQ 群聊机器人 — 像真人群友一样聊天，不是 AI 助手。*

[![Node.js](https://img.shields.io/badge/Node.js-22.5+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/Tests-1615_passing-brightgreen)](test/)
[![License](https://img.shields.io/badge/License-Personal-lightgrey)]()

</div>

---

## Overview | 概述

Built on NapCat (OneBot v11) with TypeScript. The bot scores every message with a weighted participation model and only speaks when it has something worth saying. It learns group slang, tracks relationships between members, adapts its tone per user, and builds a living knowledge base from group conversations.

基于 NapCat (OneBot v11) + TypeScript 构建。Bot 通过加权参与度模型评估每条消息，只在有话想说时才开口。它能学习群内黑话、追踪群友关系、根据不同用户调整语气、并从群聊中持续构建知识库。

---

## Features | 功能

### Core Chat | 核心聊天

| | |
|---|---|
| **Participation Scoring** | Weighted model: @-mentions, questions, silence bonus, lore keywords, topic continuity, burst penalty. Only speaks above threshold. |
| **Multi-Model Routing** | Claude Sonnet / Gemini Flash / Qwen3 / DeepSeek via `ModelRouter`. Sensitive topics auto-escalate to stronger models. |
| **Tiered Context** | Wide (30) / Medium (15) / Immediate (8) message windows. Bot's own messages marked `[你(nickname)]:` to prevent self-confusion. |
| **Sentinel Pipeline** | Strips assistant-speak, AI self-disclosure, hallucinated CQ codes, `<skip>` leaks, near-duplicate replies, and confabulation. |
| **参与度打分** | 加权模型：@提及、提问、沉默奖励、lore关键词、话题连续性、刷屏惩罚。只有超过阈值才说话。 |
| **多模型路由** | 通过 `ModelRouter` 支持 Claude Sonnet / Gemini Flash / Qwen3 / DeepSeek。敏感话题自动升级到更强模型。 |

### Self-Learning | 自我学习

| Module | What it does |
|--------|-------------|
| **Expression Learner** | Captures "user said X → bot replied Y" patterns. Zero API cost, pure rule extraction with time decay. |
| **Style Learner** | LLM distills each member's speech style (catchphrases, punctuation, tone) every 4 hours. |
| **Relationship Tracker** | Detects who's close, who's beefing, who's a couple. Hourly stats, daily LLM inference. 8 relationship types. |
| **Affinity System** | Per-user affinity score (0-100). Frequent chatters get warmer responses; strangers get cooler ones. 7-day decay. |
| **Jargon Miner** | Three-step detection: candidate extraction → threshold LLM inference → context vs. no-context comparison. Auto-discovers group-specific slang. |
| **Opportunistic Harvest** | Background fact extractor. Pulls fandom trivia, member info, group culture from normal chat. |
| **Self-Reflection** | Hourly review of bot's own replies. Generates short-term tuning + long-term permanent memory. |

| 模块 | 功能 |
|------|------|
| **表达学习器** | 捕获"群友说X → bot回Y"的模式对。零API成本，纯规则提取+时间衰减。 |
| **风格学习器** | 每4小时用LLM提炼每个群友的说话风格（口头禅、标点、语气）。 |
| **关系追踪器** | 自动检测谁和谁关系好、谁在互怼、谁是CP。每小时统计，每天LLM推断。8种关系类型。 |
| **好感度系统** | 每人好感度0-100。经常聊的更亲近，不熟的更冷淡。7天衰减。 |
| **黑话挖掘器** | 三步检测：候选提取→阈值LLM推断→有/无上下文对比。自动发现群内梗。 |

### Persona & Role-Play | 人设与角色扮演

| Feature | Description |
|---------|-------------|
| **Character Mode** | `/char_on` activates a BanG Dream character persona (default: 凑友希那). Per-character JSON profiles with grounding rules. |
| **Mimic Mode** | `/mimic_on @user` makes the bot talk like a specific group member. Few-shot filtered, lore-injected, 30% lurker rate. |
| **Sticker-First** | `/stickerfirst_on` — bot picks a matching sticker from its library instead of typing. Factual queries bypass. |
| **角色模式** | `/char_on` 激活邦多利角色人设（默认：凑友希那）。 |
| **模仿模式** | `/mimic_on @群友` 让bot模仿指定群友说话。过滤few-shot、注入lore、30%概率回复。 |

### Knowledge | 知识系统

| Feature | Description |
|---------|-------------|
| **Per-Member Lore** | Group knowledge split into per-member files with alias frontmatter. On-demand loading by nickname matching (8000 char cap). |
| **Bandori Live Schedule** | Daily scraper from bang-dream.com. Band-aware retrieval — "ras 最近有啥live" returns actual RAS events. |
| **Learned Facts RAG** | Corrections ("不是X是Y") get embedded and reused. Semantic retrieval with cosine floor + pinned newest. |
| **分群友Lore** | 群知识按群友拆分为独立文件，按昵称按需加载（8000字上限）。 |
| **邦多利Live日程** | 每日从bang-dream.com抓取。按乐队智能检索。 |

### Moderation | 审核系统

| Feature | Description |
|---------|-------------|
| **Auto-Moderation** | Every message scored by LLM (Qwen3). Sev 3+: admin DM approval → delete/warn/mute/kick. |
| **Admin Approval Flow** | Violations queued in `pending_moderation`. Admin `/approve` or `/reject` via DM within 10 min. |
| **Self-Learning Rejections** | Rejected violations feed back as negative examples. 30-day window, semantic top-5 injection. |
| **Web Review Panel** | `http://localhost:4000/mod` — review stats, filter by severity/action/status. |
| **Appeal System** | `/appeal` within 24h. LLM re-review + Opus double-check for sev 5 kicks. |

### Other Modules | 其他模块

- **Vision** — Gemini 2.5 Flash image descriptions for context enrichment + image moderation
- **Name-Images** — `/add <name>` collects photos tagged to a person, recalled on mention
- **Welcome** — Personalized new-member greetings
- **ID Guard** — Detects personal-info leaks in image uploads
- **Sequence Guard** — Blocks 接龙 relay exploits that try to break persona
- **Poke** — Responds to QQ poke notices with personality
- **Alias Miner** — Discovers nickname variants from chat history
- **Sticker Capture** — Auto-builds local sticker library from group messages

---

## Architecture | 架构

```
src/
├── adapter/          NapCat WebSocket client (OneBot v11)
├── core/             Router + rate limiter
├── ai/               Claude / Ollama / Gemini / DeepSeek + ModelRouter
│   └── providers/    Per-provider client implementations
├── storage/          SQLite (node:sqlite), repositories, embeddings
├── modules/          Feature modules (each independent, testable)
│   ├── chat.ts           Core chat with participation scoring
│   ├── moderator.ts      Auto-moderation pipeline
│   ├── mimic.ts          User-style mimicry
│   ├── char.ts           Character role-play
│   ├── self-learning.ts  Correction-driven fact learning
│   ├── expression-learner.ts   Situation→expression pattern pairs
│   ├── style-learner.ts        Per-user speech style distillation
│   ├── relationship-tracker.ts Social graph detection
│   ├── affinity.ts             Per-user affinity scoring
│   ├── jargon-miner.ts         Group slang auto-detection
│   └── ...             15+ more modules
├── server/           Rating portal + tuning generator
└── utils/            Logger, sentinel, CQ code helpers

data/
├── groups/{id}/lore/    Per-member lore files with alias frontmatter
├── knowledge/           External knowledge (moegirl, nga)
├── characters/          Character persona profiles
├── logs/                JSON logs (pino)
└── stickers-local/      Auto-captured sticker library
```

### Hard Invariants | 硬性约束

1. **One-way dependency**: `adapter → core → modules → ai/storage`. No reverse.
2. **System prompts are static**. User content always in user-role messages (prompt-injection defense).
3. **`node:sqlite` types stay in `src/storage/`**. No leak to modules.
4. **Schema changes require migrations**. Every column addition needs `ALTER TABLE` in `_runMigrations()`.
5. **Every background timer calls `.unref()`**. Prevents blocking process exit.

---

## Tech Stack | 技术栈

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22.5+ (built-in `node:sqlite`) |
| Language | TypeScript (strict), ESM |
| QQ Protocol | NapCat (OneBot v11 WebSocket) |
| LLM | Claude Sonnet 4.6 / Gemini 2.5 Flash / Qwen3 8B / DeepSeek |
| Embeddings | Xenova/all-MiniLM-L6-v2 (local, lazy-loaded) |
| Database | SQLite (node:sqlite, WAL mode) |
| Testing | Vitest (1615 tests, 70 test files) |
| Logging | pino (JSON, file transport) |
| Vision | Gemini 2.5 Flash (OpenAI-compat endpoint) |

---

## Setup | 部署

### Requirements | 前置条件

- Node.js 22.5+ (or 24.x)
- NapCat running with OneBot v11 WebSocket enabled
- At least one LLM provider (Gemini API key recommended for free tier)

### Install | 安装

```bash
git clone https://github.com/suhang56/QQ-Group-Bot.git
cd QQ-Group-Bot
npm install
cp .env.example .env
# Edit .env — see table below
```

### Environment Variables | 环境变量

| Variable | Default | Description |
|----------|---------|-------------|
| `NAPCAT_WS_URL` | *required* | NapCat WebSocket URL (`ws://localhost:3001`) |
| `NAPCAT_ACCESS_TOKEN` | — | NapCat auth token |
| `BOT_QQ_ID` | *required* | Bot's QQ number |
| `ACTIVE_GROUPS` | *required* | Comma-separated group IDs |
| `GEMINI_API_KEY` | — | Google AI Studio key (free tier: 1500 RPD) |
| `CHAT_MODEL` | `claude-sonnet-4-6` | Primary chat model |
| `CHAT_QWEN_MODEL` | `qwen3:8b` | Lurker-path model |
| `VISION_MODEL` | `gemini-2.5-flash` | Image description model |
| `MODERATOR_MODEL` | `qwen3:8b` | Text moderation model |
| `MOD_APPROVAL_ADMIN` | — | Admin QQ ID for moderation DMs |
| `DB_PATH` | `data/bot.db` | SQLite database path |
| `LOG_LEVEL` | `info` | Log level |

### Run | 运行

```bash
npm run dev       # Development (tsx, hot reload)
npm run build     # Compile to dist/
npm start         # Production
npm test          # Run all 1615 tests
```

---

## Commands | 命令

### Chat & Persona | 聊天与人设

| Command | Description | 说明 |
|---------|-------------|------|
| `/help` | Show all commands | 显示所有命令 |
| `/mimic @user [topic]` | One-shot mimicry | 单次模仿 |
| `/mimic_on @user` | Persistent mimic mode | 持续模仿模式 |
| `/mimic_off` | Stop mimic | 关闭模仿 |
| `/char_on` | Activate character mode | 激活角色模式 |
| `/char set <alias>` | Switch character | 切换角色 |
| `/char_off` | Deactivate character | 关闭角色 |
| `/stickerfirst_on` | Sticker-first replies | 表情包优先 |
| `/stickerfirst_off` | Text-first replies | 文字优先 |

### Moderation | 管理 (Admin only)

| Command | Description | 说明 |
|---------|-------------|------|
| `/rules` | List active rules | 查看群规 |
| `/rule_add <text>` | Add moderation rule | 添加群规 |
| `/appeal` | Challenge punishment | 申诉处罚 |
| `/approve <id>` | Approve pending moderation (DM) | 批准审核 |
| `/reject <id>` | Reject pending moderation (DM) | 驳回审核 |

### Knowledge | 知识管理 (Admin only)

| Command | Description | 说明 |
|---------|-------------|------|
| `/facts_pending` | View pending learned facts | 查看待审知识 |
| `/fact_approve <id>` | Approve a fact | 通过知识条目 |
| `/fact_approve_all` | Approve all pending | 批量通过 |
| `/fact_reject <id>` | Reject a fact | 拒绝知识条目 |
| `/add <name>` | Start image collection for a person | 开始收集图片 |
| `/add_stop` | Stop image collection | 停止收集 |

---

## How It Works | 工作原理

### Reply Pipeline | 回复流程

```
Message received
    │
    ├─ Participation scoring (weighted factors → skip or continue)
    │
    ├─ Adversarial pattern check (identity probe / task request / memory inject)
    │   └─ Match → deflection from cache (no LLM call)
    │
    ├─ Context assembly (tiered history + lore + facts + stickers + tuning)
    │
    ├─ LLM call (model picked by _pickChatModel routing rules)
    │
    ├─ Post-processing pipeline:
    │   ├─ postProcess (strip CQ leaks, context markers)
    │   ├─ sentinelCheck (forbidden content → hardened regen)
    │   ├─ echo detection (drop if parrot)
    │   ├─ self-dedup (drop if near-dup of recent reply)
    │   └─ sticker-first intercept (swap text for sticker if match)
    │
    └─ Send to group
```

### Learning Loop | 学习循环

```
Every 15 min:
    Opportunistic Harvest → extract facts from recent chat
    Expression Learner   → capture situation→expression pairs
    Jargon Miner         → detect new group slang

Every 1 hour:
    Self-Reflection      → review own replies, write tuning.md
    Relationship Tracker → update interaction stats

Every 4 hours:
    Style Learner        → distill per-user speech patterns

Every 24 hours:
    Relationship Tracker → infer relationship types (LLM)
    Affinity Decay       → reduce inactive users' affinity
    Bandori Live Scraper → refresh concert schedule
```

---

## Development | 开发

### Adding a Module | 添加模块

1. Create `src/modules/your-module.ts` with a narrow interface
2. Add DB migration in `src/storage/db.ts` (idempotent `ALTER TABLE`)
3. Wire in `src/index.ts` with lifecycle (start/dispose)
4. Register commands in `src/core/router.ts` if user-facing
5. Write tests in `test/your-module.test.ts` (edge cases mandatory)
6. Timer? Call `.unref()`. Always.

### Testing | 测试

```bash
npm test                    # Full suite (1615 tests, ~9s)
npx vitest run test/X.ts    # Single file
npx vitest --watch          # Watch mode
npx tsc --noEmit            # Type check
```

---

## License | 许可

Personal project. No license granted.

个人项目，未授予许可。
