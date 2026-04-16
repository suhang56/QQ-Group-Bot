# QQ Group Bot

A group-chat bot for QQ that behaves like a real group member instead of an assistant. Built in TypeScript on NapCat (OneBot v11) with a router that dispatches to a dozen modules: conversational chat, user-mimicry, character role-play, sticker reactions, live-schedule knowledge injection, and a content-moderation pipeline with appeal flow.

Not an "AI assistant in a group". The design goal is that group members can't tell it apart from a lurker who occasionally speaks up. Everything from participation scoring to sticker picking to persona-dropping is tuned against that.

## What it does

### Chat — conversational lurker

Default reply behavior, not a command. The bot scores every incoming message against a weighted participation model (@-mentions, questions, silence bonuses, lore keyword hits, topic continuity, burst penalties, implicit `你`-addressed probes) and only speaks when the score clears a threshold. Backed by Claude Sonnet 4.6 by default, with Qwen3 / DeepSeek / Gemini as alternatives via `ModelRouter`. Context is tiered into wide / medium / immediate windows, and the bot's own messages are marked `[你(nickname)]:` so the LLM doesn't confuse them with group members.

Output is passed through a sentinel layer that strips assistant-speak, AI self-disclosure, hallucinated CQ codes, `<skip>` leaks, and near-duplicates of the bot's recent replies. A per-user tease counter flips the bot into "annoyed" mode when someone @-spams it.

### /char — BanG Dream character role-play

`/char_on` activates a canonical-character persona (default `ykn` = 凑友希那, Roselia vocalist). Reads a per-character JSON profile from `data/characters/` plus a shared `aliases.json`. The persona is composed at runtime with bot-identity grounding, 圈内底线 (no attacks on rival bands/seiyuu), 诚实底线 (no fabricated canon), and a reply-style menu. Additional characters can be distilled from the moegirl lore pages via `scripts/distill-character.ts`.

`/char set <alias>`, `/char_off`, `/char_status`. Mutually exclusive with `/mimic_on`.

### /mimic — user-style mimicry

`/mimic @user` picks a real group member and generates replies in their speech style using few-shot sampling from their last 50 messages. Prompt is constrained to "respond to THIS exact trigger" to prevent unconditioned topic drift. Empty triggers (sticker-only messages) are refused to avoid hallucinating random phrases from the target's history.

`/mimic_on` / `/mimic_off` / `/mimic_status`.

### /stickerfirst — sticker-first replies

`/stickerfirst_on` makes the bot score its intended reply text against the local sticker library via embeddings; if the top match clears `/stickerfirst_threshold`, the sticker goes out *instead of* the text. Factual queries bypass the substitution automatically — if bandori-live knowledge was injected for the turn, text wins. Repeat suppression keeps the bot from sending the same sticker twice within a window.

### bandori-live — live-schedule knowledge base

Daily scraper pulls https://bang-dream.com/events/ into a SQLite table (`bandori_lives`) via `node-html-parser` against the real BEM selectors. Supports Japanese date formats including range shorthand (`2026年8月29日(土)・30日(日)`). When a user message mentions live/公演/活动/band-name keywords (or shortforms like `ppp`/`ras`/`mygo`), matching events are injected as reference data into the chat context.

No user-facing command — always on, gated by the `BANDORI_SCRAPE_ENABLED` env var. Entity-aware retrieval filters by mentioned band instead of returning the 3 soonest events globally.

### Moderator — automated punishment with appeals

`ModeratorModule` runs every non-command group message through a local text moderator (Qwen3 by default) and an image vision moderator (Gemini Flash) to classify severity 1–5. Sev 1–2 auto-deletes with a warning, sev 3 ban 10m, sev 4 ban 1h, sev 5 gets a second-pass Opus 4.6 check before kick. Hard safety rails: admin/owner whitelist, configurable daily cap, Claude-error fail-safe (no action on API failure), and `/appeal` within a 24h window that gets another LLM review.

### Learner — self-learning RAG

`/rule_add` lets admins add group rules in natural language. They're embedded locally via `Xenova/all-MiniLM-L6-v2` and retrieved at moderation time via cosine top-K. Facts the bot learned from group corrections are stored in `learned_facts` with confidence scoring and re-used in future prompts. `/rule_false_positive` flags rules that keep over-triggering.

### Other modules

- **vision** — image/mface sticker description cache via Gemini 2.5 Flash, used for context enrichment and moderation
- **name-images** — `/set_name <name>` starts an admin collection mode; subsequent images get tagged to that name and posted back when someone later mentions the name in chat
- **self-reflection** — hourly loop that has the LLM review its own recent replies and writes a short tuning file that feeds into the next persona pass
- **self-learning** — correction-driven RAG: when someone tells the bot "that's wrong, it's actually X", a learned fact is extracted, embedded, and reused
- **lore-updater** — distills group chat history into a per-group lore file that gets injected as background context in chat prompts
- **alias-miner** — mines romaji/kanji/hanzi variants of recurring names from group history
- **opportunistic-harvest** — background extractor that pulls high-confidence facts out of normal chat
- **sticker-capture** — auto-builds a local sticker library from messages seen in active groups
- **welcome** — new-member greeting composition
- **id-guard** — detects obvious ID-card / personal-info leaks in image uploads
- **sequence-guard** — detects cross-message 接龙 relay exploits (recitation-based persona breaks)

## Architecture

### Module layers

```
src/adapter/   NapCat WebSocket client (OneBot v11), image fetch
src/core/      Router, rate limiter
src/ai/        Claude / Ollama / Gemini / DeepSeek clients + ModelRouter
src/storage/   SQLite (node:sqlite), repositories, embeddings
src/modules/   Feature modules (each independent, testable in isolation)
src/utils/     Logger, sentinel, error codes, stickers helper
```

Hard invariants (enforced by code review + tests):

1. **One-way dependency**: `adapter → core → modules → ai/storage`. No reverse imports.
2. **System prompts are static**. User content is always placed in user-role messages, never interpolated into system blocks. Prompt-injection defense.
3. **`node:sqlite` types stay in `src/storage/`**. No leak to modules.
4. **`defaultGroupConfig()`** in `src/config.ts` is the single source of truth for GroupConfig defaults.
5. **Schema changes require migrations**. `schema.sql` alone silently skips existing DBs — every column addition needs an `ALTER TABLE` in `applyMigrations()`.
6. **Every background timer calls `timer.unref?.()`**. Blocks process exit otherwise.

### Tech stack

- **Node.js 22.5+** (for built-in `node:sqlite` — no native compile)
- **TypeScript** (strict), **ESM**
- **Vitest** for tests (1364 tests, ~82% line / 82% branch coverage, mandatory edge tests per feature)
- **pino** for JSON logging
- **@anthropic-ai/claude-agent-sdk** for Claude (reads Claude Code CLI credentials, no API key required)
- **@xenova/transformers** for local embeddings (MiniLM-L6-v2, lazy-loaded)
- **node-html-parser** for the bandori-live scraper (no jsdom, no cheerio)
- **NapCat** as the QQ protocol adapter (OneBot v11 WebSocket)
- **cross-env** handles `--experimental-sqlite` flag automatically in all npm scripts (Node 22.x compatibility)

## Setup

### Requirements

- Node.js 22.5+ (or 24.x)
- NapCat running locally with OneBot v11 WebSocket enabled
- Claude Code CLI logged in (`claude` command — provides credentials for `@anthropic-ai/claude-agent-sdk`)
- Optionally: Ollama for local text moderation, Google AI Studio key for Gemini vision, DeepSeek key for cheap chat

### Install

```bash
npm install
cp .env.example .env
# edit .env with your NapCat URL, bot QQ ID, active groups
```

### Environment

| Var | Default | Purpose |
|---|---|---|
| `NAPCAT_WS_URL` | — | NapCat WebSocket URL (e.g. `ws://localhost:3001`) |
| `NAPCAT_ACCESS_TOKEN` | — | NapCat access token if configured |
| `BOT_QQ_ID` | — | Bot's QQ account number (required for @-mention detection) |
| `ACTIVE_GROUPS` | — | Comma-separated group IDs the bot participates in |
| `DB_PATH` | `data/bot.db` | SQLite database path |
| `LOG_LEVEL` | `info` | `trace/debug/info/warn/error/fatal` |
| `CHAT_MODEL` | `claude-sonnet-4-6` | Chat model ID |
| `VISION_MODEL` | `gemini-2.5-flash` | Image description model (gemini or claude) |
| `MODERATOR_MODEL` | `qwen3:8b` | Text moderation model (high-volume) |
| `OLLAMA_ENABLED` | `0` | Set to `1` to register Ollama provider |
| `GEMINI_ENABLED` | `0` | Set to `1` to register Gemini provider |
| `DEEPSEEK_API_KEY` | — | Set to register DeepSeek provider |
| `BANDORI_SCRAPE_ENABLED` | `true` | Daily bang-dream.com scraper |
| `BANDORI_SCRAPE_INTERVAL_MS` | `86400000` | Scrape interval |
| `NAME_IMAGES_DIR` | `data/name-images` | Name-image library path |

### Run

```bash
npm run dev            # tsx src/index.ts (hot TypeScript, --experimental-sqlite auto-set via cross-env)
npm run build          # compile to dist/
npm start              # production (cross-env NODE_OPTIONS=--experimental-sqlite node dist/index.js)
npm run typecheck      # tsc --noEmit
```

### Test

```bash
npm test                  # full suite with coverage (vitest)
npm run test:watch        # watch mode
```

## Commands

All commands are prefixed with `/` and restricted to admin/owner unless noted.

| Command | Purpose |
|---|---|
| `/help` | Show command reference |
| `/stats` | Bot message counts + last-active per group |
| `/rules` | List active moderation rules |
| `/rule_add <rule>` | Add a rule (indexed for RAG retrieval) |
| `/rule_false_positive <rule-id>` | Flag a noisy rule |
| `/appeal <reason>` | Challenge a moderation action within 24h |
| `/mimic @user` | Generate one reply in @user's style |
| `/mimic_on` | Persistent mimic mode |
| `/mimic_off` | Stop mimic mode |
| `/char` / `/char_on` | Activate character mode (default ykn) |
| `/char set <alias>` | Switch character |
| `/char_off` | Stop character mode |
| `/char_status` | Show current character state |
| `/stickerfirst_on` | Enable sticker-first reply mode |
| `/stickerfirst_off` | Disable sticker-first mode |
| `/stickerfirst_threshold <0-1>` | Set similarity threshold |
| `/stickerfirst_status` | Show sticker-first state |
| `/set_name <name>` | Start collecting images for `<name>` |
| `/stop_name` | Stop collecting |

## Development notes

### Prompt-injection defense

User content never enters system prompts. Any string derived from a group message is concatenated into the user-role message only. Regression tests in `test/chat.test.ts`, `test/char.test.ts`, `test/mimic.test.ts` explicitly assert `systemText` does not contain injection payloads.

### Context grounding

The chat module stamps `[你(nickname)]:` on messages authored by the bot itself and `[peer-nickname]:` on everyone else. The prompt explicitly tells the LLM to attribute speakers correctly and never claim to have said things that aren't in marked history. Char/mimic modes carry this grounding over via `composePersonaPrompt` / `triggerLine`.

### Layer ordering

Reply generation goes through several layers; the order matters:

```
trigger → participation score → (skip or continue)
         → LLM call
         → postProcess (strip CQ leaks, <skip>, context markers)
         → sentinelCheck (regenerate on forbidden content, fallback to "...")
         → echo detection (drop if trigger echo)
         → self-dedup (drop if near-dup of recent own reply)
         → sticker-first intercept (skipped when factual injection present)
         → _recordOwnReply + send
```

Each layer has its own gate. Adding a new layer means deciding where it sits and which prior layers its decision overrides.

### Adding a new feature module

1. Drop a new `src/modules/X.ts` implementing a narrow interface
2. Wire it in `src/index.ts` after dependencies are built
3. Register any router commands in `src/core/router.ts`
4. Add DB migration + schema.sql entry if stateful
5. Write tests in `test/X.test.ts` with mandatory edge cases
6. Update this README's command table if the feature adds user-facing commands

## License

Personal project. No license granted.
