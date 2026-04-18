<div align="center">

# QQ Group Bot

**A QQ group-chat bot that behaves like a real group member, not an assistant.**

*QQ 群聊机器人 — 像真人群友一样聊天,不是 AI 助手。*

[![Node.js](https://img.shields.io/badge/Node.js-22.5+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/Tests-2727_passing-brightgreen)](test/)
[![License](https://img.shields.io/badge/License-Personal-lightgrey)]()

</div>

---

## Overview | 概述

Built on NapCat (OneBot v11) with TypeScript. Every message is LLM-judged AND weighted-scored before the bot even thinks about replying — busy groups get higher thresholds, dead groups get lower ones, and 1-on-1 conversations between peers are left alone. The bot learns group slang, tracks relationships, adapts its tone per user, remembers mood across restarts, and will occasionally break silence in dead groups with a casual first-person aside (never "大家在干嘛").

基于 NapCat (OneBot v11) + TypeScript 构建。Bot 在动念回复前,每条消息都要过 LLM 预判 + 加权打分两关 —— 活跃群门槛抬高、死群门槛降低、群友在 1-on-1 时 bot 闭嘴不插。Bot 能学群黑话、记关系、按人调语气、心情跨重启保留,还会在静默的死群里偶尔用第一人称自言自语开个话头(不会有"大家在干嘛"这种外人口气)。

---

## Features | 功能

### Decision Layer | 决策层(M6–M7)

| | |
|---|---|
| **Participation Scoring** | Weighted model: @-mentions, questions, silence bonus, lore keywords, topic continuity, burst penalty. Only speaks above threshold. |
| **Pre-Chat LLM Judge** (M7.1/3/4) | Single Flash call returns 3 signals: `shouldEngage` / `addressee` / `awkward`. Skip if addressee is a specific peer or the moment is awkward (冷场/跑题/刚发过). Direct triggers bypass. |
| **Activity-Aware Thresholds** (M7.2) | Tracker classifies group as idle/normal/busy. Busy → 1.4x threshold. Idle → 0.75x. |
| **Consecutive-Reply Cap** (M6.4) | Hard anti-monologue gate — after 3 bot replies without a peer message, non-direct triggers are suppressed. |
| **Mood Tint** (M9.2) | valence < -0.4 → 1.2x threshold + route to primary model (avoid fast-path blurting when irritable). valence > 0.4 → 0.9x. Persisted across restarts. |
| **Relationship-Aware Addressing** (M6.5) | Per-user affinity + relationship type shape tone on direct trigger. |
| **Multi-Model Routing** | Claude Opus/Sonnet / Gemini Flash / Qwen3 / DeepSeek via `ModelRouter`. Sensitive topics escalate; fast-path for low-risk chatter. |
| **Sentinel Pipeline** | Strips assistant-speak, AI self-disclosure, hallucinated CQ codes, `<skip>` leaks, near-duplicate replies, confabulation, AND over-denial (`我是真人`/`我不是bot`). Regen loop capped at 2 iterations. |

### Self-Learning | 自我学习

| Module | What it does |
|--------|-------------|
| **Expression Learner** | Captures `user said X → bot replied Y` patterns. System-block few-shot injection (M8.3) makes bot actually reuse its own past phrasing. |
| **Style Learner** | LLM distills each member's style (catchphrases / punctuation / tone) every 4h. **M8.2 aggregate** builds a group-level "vibe" block from all members' styles, injected as static system context. |
| **Relationship Tracker** | Detects bond strength + type (close/beef/CP/mentor/...) — 8 slash-aliased labels. Hourly stats, daily LLM inference. |
| **Affinity System (M8.4)** | 10 interaction types (chat/at_friendly/reply/correction/praise/mock/joke_share/question_ask/thanks/farewell) with anti-farm: 5-min cooldown on praise/mock/thanks/farewell + daily +10 net positive cap (mock exempt). 7-day decay. |
| **Jargon Miner** | Candidate extraction → threshold LLM inference → context vs. no-context comparison. Auto-discovers group-specific slang. |
| **Opportunistic Harvest** | Background fact extractor. Pulls fandom trivia, member info, group culture from normal chat. **All harvested facts land `pending` — admin approval required** (UR-H closed an auto-activation regression). |
| **Alias Miner** | Discovers nickname variants from chat history — feeds lore per-member lookup. |
| **Meme Clusterer** | Groups variants of the same meme, tracks origin event, exposes top memes to `banter` variant. |
| **Phrase Miner** | Detects recurring inside phrases beyond single-word jargon. |
| **Self-Reflection** | Hourly review of bot's own replies. **Weekly deep pass (M8.1)** with Jaccard-bigram identity-drift rail prevents abrupt persona collapse. Output is persona-patch proposals — admin manually approves via `/persona_apply`. |
| **Cross-Group Recognition (M9.3)** | Privacy-first, bilateral opt-in. Hint is vague (`在其它 N 个群也有互动`) — never names source groups. Audit logged, 90-day purge. |

### Persona & Role-Play | 人设与角色扮演

| Feature | Description |
|---------|-------------|
| **BanG Dream Persona** | Default persona grounded in 邦多利 fandom. Admits being a bot when asked (`废话`/`对啊`), denies being Claude/"模型"/"AI"/"助手". |
| **Character Mode** | `/char_on` activates a BanG Dream character persona. Per-character JSON profiles with grounding rules. Different mention-spam handling from default mode. |
| **Mimic Mode** | `/mimic_on @user` makes the bot talk like a specific group member. Few-shot filtered, lore-injected. |
| **Sticker-First** | `/stickerfirst_on` — bot picks a matching sticker from its library instead of typing. Factual queries bypass. |
| **Prompt Variants** | `default` / `careful` / `banter` — picked by detected context. `banter` has a sparsity rule for ambient peer chat (90% pure observation). |

### Emergent Behavior | 涌现行为

| Feature | Description |
|---------|-------------|
| **Silence-Breaker (M9.1)** | Group fully idle ≥30min + historically-active hour + mood non-negative + 2h cooldown → bot opens a new thread with a first-person aside. Air-reading veto + night veto (00-07). **Ships dark:** `PROACTIVE_ENGINE_ENABLED=false` by default. |
| **Persistent Mood (M9.2)** | Valence/arousal persist across restarts (10s debounced saves). Drives engagement threshold, model routing, and persona variant selection. |
| **Fatigue (M6.3)** | Bot tracks its own reply density and cools down on long streaks. |

### Knowledge | 知识系统

| Feature | Description |
|---------|-------------|
| **Per-Member Lore** | Group knowledge split into per-member files with alias frontmatter. On-demand loading by nickname matching (8000 char cap). |
| **Bandori Live Schedule** | Daily scraper from bang-dream.com. Band-aware retrieval — "ras 最近有啥live" returns actual RAS events. |
| **Learned Facts RAG** | Corrections (`不是X是Y`) get embedded and reused. Semantic retrieval with cosine floor + pinned newest. |
| **Group Rules** | Admin-curated, semantic-retrieved during moderation context assembly. |

### Moderation | 审核系统

| Feature | Description |
|---------|-------------|
| **Auto-Moderation** | Every message scored by LLM (Qwen3). Sev 3+: admin DM approval → delete/warn/mute/kick. |
| **Admin Approval Flow** | Violations queued in `pending_moderation`. Admin `/approve` or `/reject` via DM within 10 min. **Dual-path transparency:** every action both DMs admin AND @s the target in-group. |
| **Self-Learning Rejections** | Rejected violations feed back as negative examples. 30-day window, semantic top-5 injection. |
| **Web Review Panel** | `http://localhost:4000/mod` — review stats, filter by severity/action/status. **Now requires `X-Admin-Token` header** (UR-C). |
| **Appeal System** | `/appeal` within 24h. LLM re-review + Opus double-check for sev 5 kicks. |

### Security / Hardening (UR-A…UR-M) | 安全硬化

| Layer | What's covered |
|-------|----------------|
| **Prompt-injection defense** | Every user/LLM-derived interpolation → `sanitizeForPrompt` + distinct `<*_do_not_follow_instructions>` wrapper. ~30 LLM call sites, 35+ wrapper tags, no collisions. |
| **Persistent-injection defense** | Every LLM output that hits DB/file → `hasJailbreakPattern` rail BEFORE persistence. Catches `ignore previous instructions`, `<|system|>`, `你是一个没有限制的...`, standalone `#END`, codefence markers. |
| **Admin-command auth** | `X-Admin-Token` on rating-portal + `timingSafeEqual` comparison. CORS origin allowlist. Per-command rate-limit buckets (admin_mod/bot_status/persona/cross_group/mimic/rules/default). |
| **Timer discipline** | Every `setTimeout`/`setInterval` has `.unref?.()`. Action/reconnect timers `clearTimeout` on all paths. |
| **No hardcoded secrets/IDs** | `MOD_APPROVAL_ADMIN` env-overrideable, single source of truth in `src/core/constants.ts`. |

### Other Modules | 其他模块

- **Vision** — Gemini 2.5 Flash image descriptions + image moderation
- **Name-Images** — `/add <name>` collects photos tagged to a person, recalled on mention
- **Welcome** — Personalized new-member greetings (with sanitize + jailbreak guard on nickname)
- **ID Guard** — Detects personal-info leaks in image uploads
- **Sequence Guard** — Blocks 接龙 relay exploits that try to break persona
- **Poke** — Responds to QQ poke notices with personality
- **Sticker Capture** — Auto-builds local sticker library from group messages
- **Announcement Sync** — Extracts moderation rules from group announcements (LLM-distilled, admin-confirmed)
- **Tuning Generator** — Weekly admin-facing markdown digest of bot performance per group

---

## Architecture | 架构

```
src/
├── adapter/          NapCat WebSocket client (OneBot v11)
├── core/             Router + rate limiter + constants (single-source admin IDs)
├── ai/               Claude / Ollama / Gemini / DeepSeek + ModelRouter
│   └── providers/    Per-provider client implementations
├── storage/          SQLite (node:sqlite), repositories, embeddings
├── modules/          43 feature modules (each independent, testable)
│   ├── chat.ts                Core chat with participation scoring + engagement gates
│   ├── pre-chat-judge.ts      M7.1/3/4 LLM pre-pass
│   ├── group-activity-tracker M7.2 heatmap
│   ├── engagement-decision.ts Gate order (skip/lurk/react/engage decision)
│   ├── moderator.ts           Auto-moderation pipeline (text + image)
│   ├── mood.ts                Persistent valence/arousal (M9.2)
│   ├── proactive-engine.ts    M9.1 silence-breaker
│   ├── self-learning.ts       Correction-driven fact + meme learning
│   ├── self-reflection.ts     Daily+weekly persona patch proposals
│   ├── style-aggregator.ts    M8.2 group-level style vibe
│   ├── expression-learner.ts  Situation→expression pairs (+ M8.3 few-shot)
│   ├── relationship-tracker   Social graph (8 labels)
│   ├── affinity.ts            M8.4 10-type classifier + anti-farm + M9.3 cross-group
│   ├── jargon-miner.ts        Group slang auto-detection
│   └── ... 29 more modules
├── server/           Rating portal (X-Admin-Token auth) + tuning generator
└── utils/            Logger, sentinel, CQ helpers, prompt-sanitize, mention-spam

data/
├── groups/{id}/lore/        Per-member lore files with alias frontmatter
├── groups/{id}/tuning.md    Self-reflection output
├── groups/{id}/tuning-permanent.md   Admin-curated long-term memory
├── knowledge/               External knowledge (moegirl, nga, bandori.ceikor)
├── characters/              Character persona profiles
├── logs/                    JSON logs (pino)
└── stickers-local/          Auto-captured sticker library
```

### Hard Invariants | 硬性约束

1. **One-way dependency**: `adapter → core → modules → ai/storage`. No reverse.
2. **System prompts are static**. User content always in user-role messages OR wrapped in `<*_do_not_follow_instructions>` tags (prompt-injection defense).
3. **`node:sqlite` types stay in `src/storage/`**. No leak to modules.
4. **Schema changes require migrations**. Every column addition needs idempotent `ALTER TABLE` in `_runMigrations()`.
5. **Every background timer calls `.unref?.()`**. Prevents blocking process exit.
6. **LLM output persisted to DB/file must pass `hasJailbreakPattern` rail**. No exceptions.
7. **LLM input of user/LLM-derived content must go through `sanitizeForPrompt`/`sanitizeNickname` + be wrapped**. Single-line hints also sanitize (wrapper optional for ephemeral single-liners).

---

## Tech Stack | 技术栈

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22.5+ (built-in `node:sqlite`) |
| Language | TypeScript (strict), ESM |
| QQ Protocol | NapCat v4.18+ (OneBot v11 WebSocket) |
| LLM | Claude Opus/Sonnet 4.6 / Gemini 2.5 Flash / Qwen3 8B / DeepSeek |
| Embeddings | Xenova/all-MiniLM-L6-v2 (local, lazy-loaded) |
| Database | SQLite (`node:sqlite`, WAL mode) |
| Testing | Vitest (2727 tests, 124 test files) |
| Logging | pino (JSON, file transport) |
| Vision | Gemini 2.5 Flash (OpenAI-compat endpoint) |

---

## Setup | 部署

### Requirements | 前置条件

- Node.js 22.5+ (or 24.x)
- NapCat v4.18+ running with OneBot v11 WebSocket enabled
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

**Core / required:**

| Variable | Default | Description |
|----------|---------|-------------|
| `NAPCAT_WS_URL` | *required* | NapCat WebSocket URL (`ws://localhost:3001`) |
| `NAPCAT_ACCESS_TOKEN` | — | NapCat auth token |
| `BOT_QQ_ID` | *required* | Bot's QQ number |
| `ACTIVE_GROUPS` | *required* | Comma-separated group IDs |
| `MOD_APPROVAL_ADMIN` | — | Admin QQ ID for moderation DMs + /bot_status + /persona_* |
| `GEMINI_API_KEY` | — | Google AI Studio key (free tier: 1500 RPD) |

**Models:**

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAT_MODEL` | `claude-sonnet-4-6` | Primary chat model |
| `CHAT_QWEN_MODEL` | `qwen3:8b` | Lurker-path model |
| `VISION_MODEL` | `gemini-2.5-flash` | Image description model |
| `MODERATOR_MODEL` | `qwen3:8b` | Text moderation model |
| `REFLECTION_MODEL` | `gemini-2.5-flash` | Self-reflection model |

**Kill switches / feature flags:**

| Variable | Default | Description |
|----------|---------|-------------|
| `PROACTIVE_ENGINE_ENABLED` | `false` | M9.1 silence-breaker (ships dark) |
| `PRE_CHAT_JUDGE_DISABLED` | `0` | M7 pre-chat LLM judge |
| `ALIAS_MINER_ENABLED` | `true` | Nickname variant discovery |
| `OPPORTUNISTIC_HARVEST_ENABLED` | `true` | Background fact extractor |
| `SELF_REFLECTION_ENABLED` | `true` | Hourly+weekly reflection |
| `BANDORI_SCRAPE_ENABLED` | `true` | Daily live schedule scraper |

**Admin surface (rating portal):**

| Variable | Default | Description |
|----------|---------|-------------|
| `RATING_PORTAL_TOKEN` | — | Required for mod-review / memes panel write ops |
| `RATING_PORTAL_ORIGINS` | `http://localhost:4000` | CORS allowlist (comma-separated) |
| `RATING_PORT` | `4000` | Portal port |

**Persona (M6.6 + M8.1):**

| Variable | Default | Description |
|----------|---------|-------------|
| `PERSONA_PATCH_DAILY_CAP` | `1` | Max proposals per group per day |
| `PERSONA_PATCH_WEEKLY_MAX_LEN` | `12000` | Weekly persona max chars |
| `PERSONA_PATCH_WEEKLY_TTL_DAYS` | `14` | Weekly proposal expiry |
| `PERSONA_PATCH_WEEKLY_IDENTITY_FLOOR` | `0.3` | Jaccard drift floor (weekly only) |
| `PERSONA_PATCH_WEEKLY_DISABLED` | `0` | Weekly kill switch |

Full env var reference: see `.env.example` (55+ variables grouped by topic).

### Run | 运行

```bash
npm run dev       # Development (tsx, hot reload)
npm run build     # Compile to dist/
npm start         # Production
npm test          # Run all 2727 tests (~9s)
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

### Moderation | 管理(管理员)

| Command | Description | 说明 |
|---------|-------------|------|
| `/rules` | List active rules | 查看群规 |
| `/rule_add <text>` | Add moderation rule | 添加群规 |
| `/appeal` | Challenge punishment | 申诉处罚 |
| `/approve <id>` | Approve pending moderation (DM) | 批准审核 |
| `/reject <id>` | Reject pending moderation (DM) | 驳回审核 |
| `/mod_on` / `/mod_off` | Toggle moderation per group | 开关审核 |
| `/idguard_on` / `/idguard_off` | Toggle ID-leak guard | 开关身份证检测 |
| `/welcome_on` / `/welcome_off` | Toggle new-member greetings | 开关新人欢迎 |

### Persona Patch | 人格补丁(管理员 DM)

| Command | Description | 说明 |
|---------|-------------|------|
| `/persona_review` | List pending patches (weekly-first) | 查看待审补丁 |
| `/persona_apply <id>` | Apply a patch (weekly auto-rejects stale daily) | 应用补丁 |
| `/persona_reject <id>` | Reject a patch | 拒绝补丁 |
| `/persona_history` | Recent applied/rejected history | 历史记录 |
| `/persona_diff <id>` | Show patch diff | 查看 diff |

### Knowledge | 知识管理(管理员)

| Command | Description | 说明 |
|---------|-------------|------|
| `/facts_pending` | View pending learned facts | 查看待审知识 |
| `/fact_approve <id>` | Approve a fact | 通过知识条目 |
| `/fact_approve_all` | Approve all pending | 批量通过 |
| `/fact_reject <id>` | Reject a fact | 拒绝知识条目 |
| `/add <name>` | Start image collection for a person | 开始收集图片 |
| `/add_stop` | Stop image collection | 停止收集 |

### Observability | 可观测性(管理员 DM, M9.3/9.4)

| Command | Description | 说明 |
|---------|-------------|------|
| `/bot_status [groupId]` | Snapshot: mood / affinity top-3 / fatigue / consecutive / activity / persona last-5 | 状态快照 |
| `/cross_group_audit [@user]` | Cross-group recognition audit log (30d) | 跨群识别审计 |
| `/forget_me_cross_group <uid>` | Clear user's cross-group rows except current group | 跨群遗忘 |

---

## How It Works | 工作原理

### Reply Pipeline | 回复流程

```
Message received
    │
    ├─ Adversarial pattern check (identity probe / task / memory inject)
    │   └─ Match → deflection from cache (no LLM call)
    │
    ├─ Pre-chat LLM judge (M7.1/3/4): shouldEngage / addressee / awkward
    │
    ├─ Engagement gates (engagement-decision.ts):
    │   ├─ Short-ack / meta / pic-bot → skip
    │   ├─ Adversarial → react (deflection)
    │   ├─ Addressee is other user + not direct → skip  (M7.3)
    │   ├─ Awkward moment + not direct → skip            (M7.4)
    │   ├─ LLM judge: skip + not direct → skip           (M7.1)
    │   ├─ Low comprehension → skip / react
    │   ├─ Last speech ignored → skip                    (R3)
    │   ├─ Consecutive-reply cap → skip                  (M6.4)
    │   └─ Score >= effectiveMinScore (direct × activity × mood) → engage
    │
    ├─ Context assembly (tiered history + sanitized+wrapped user content
    │    + lore + facts + stickers + group aggregate style + few-shot
    │    + tuning + mood section + rules)
    │
    ├─ LLM call (model picked by _pickChatModel: direct / sensitive / low-mood → primary;
    │    otherwise fast-path)
    │
    ├─ Post-processing (up to 2 regen passes):
    │   ├─ postProcess (strip CQ leaks, context markers)
    │   ├─ sentinelCheck (forbidden content incl. over-denial → regen)
    │   ├─ outsider-tone check (你们/大家 ambient → regen)
    │   ├─ insult-echo check (bot mirror-agreeing with insults → regen)
    │   ├─ coreference self-reference check → regen
    │   ├─ self-dedup (drop if near-dup of recent reply)
    │   └─ sticker-first intercept (swap text for sticker if match)
    │
    └─ Send to group + bump consecutive-reply counter + mood update
```

### Learning Loop | 学习循环

```
Every 15 min:
    Opportunistic Harvest → extract facts (→ pending, admin confirms)
    Expression Learner   → capture situation→expression pairs
    Jargon Miner         → detect new group slang (pending → admin confirms)
    Phrase Miner         → recurring inside phrases

Every 1 hour:
    Self-Reflection      → review own replies, write tuning.md + propose daily persona patch
    Relationship Tracker → update interaction stats
    Fatigue decay        → cool reply density

Every 4 hours:
    Style Learner        → distill per-user + group aggregate speech patterns

Every 24 hours:
    Relationship Tracker → infer relationship types (LLM)
    Affinity Decay       → reduce inactive users' affinity
    Bandori Live Scraper → refresh concert schedule
    Cross-group audit    → purge rows >90d
    Self-Reflection      → weekly deep pass, propose weekly persona patch

Mood state:
    Every message       → update valence/arousal, debounced 10s save
    On restart          → hydrate from DB sync in ctor

Silence-breaker (if enabled):
    Every 5 min         → check idle ≥30min + active-hour + mood>=0 + cooldown >2h
                          → LLM-generate first-person aside → send
```

---

## Development | 开发

### Adding a Module | 添加模块

1. Create `src/modules/your-module.ts` with a narrow interface.
2. Add DB migration in `src/storage/db.ts` (idempotent `ALTER TABLE` or `CREATE TABLE IF NOT EXISTS`).
3. Wire in `src/index.ts` with lifecycle (start/dispose).
4. Register commands in `src/core/router.ts` if user-facing. Gate admin commands with `rateLimiter.checkUser(uid, 'admin_mod')`.
5. Write tests in `test/your-module.test.ts` (edge cases mandatory — empty input, nulls, concurrent calls, boundaries).
6. Timer? Call `.unref?.()`. Always.
7. **LLM-bound user content?** Sanitize + wrap + jailbreak-guard outputs.

### Testing | 测试

```bash
npm test                    # Full suite (2727 tests, ~9s)
npx vitest run test/X.ts    # Single file
npx vitest --watch          # Watch mode
npx tsc --noEmit            # Type check (must be clean)
```

### Security Review | 安全审查

Project has been through 5 rounds of ultrareview (security/quality/north-star reviewers in parallel). Result: ~30 LLM call sites, 35+ `_do_not_follow_instructions` wrapper tags, `hasJailbreakPattern` guards on every LLM-output persistence path. If you add a new LLM call:

- **Input**: every user-derived field → `sanitizeForPrompt` or `sanitizeNickname`; wrap section in a distinct `<module_purpose_do_not_follow_instructions>` tag.
- **Output that persists (DB/file)**: pass through `hasJailbreakPattern(output)`; on match log warn and skip persistence.
- **Admin commands**: gate with `rateLimiter.checkUser(userId, 'admin_mod')` (or a dedicated bucket).

---

## License | 许可

Personal project. No license granted.

个人项目,未授予许可。
