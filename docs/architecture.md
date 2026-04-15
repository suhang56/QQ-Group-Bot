# QQ Group Bot — Architecture

## Architectural Issues Flagged

1. **`node-napcat-ts` maturity risk**: The plan references `node-napcat-ts ^1.x` but this library has limited documentation and an unstable API surface. The adapter must isolate this behind a clean interface so it can be swapped for a raw `ws` implementation with zero module-level changes. Developer must not let `node-napcat-ts` types leak beyond `src/adapter/`.

2. **`@xenova/transformers` load time**: The local embedding model takes 2–10 seconds to initialise on first run. Learner module must lazy-load it and the bot must be fully online before embedding is ready (non-blocking startup). Embeddings unavailable at startup ≠ bot crash.

3. **Severity escalation state**: The plan says "warn_count >= 3 within 7 days → auto-escalate next offense by +1 severity" but the spec stores warnings only in `moderation_log`, not a dedicated counter column. The Moderator module must query `moderation_log` at runtime; no in-memory state may be used for this (restart-safe).

4. **`mimic_active_user_id` persistence gap**: The spec says "Bot restarts mid-session → session state lost; next message treated as no mimic mode (persisted in group_config)." These are contradictory. Decision: persist in `group_config` on every `/mimic_on` and `/mimic_off`; Router reads `group_config` on startup. No in-memory mimic session state.

5. **Rate limiter is in-memory only**: Acceptable per spec, but the daily punishment cap must be read from DB on every moderation action (not cached in process) to be restart-safe.

---

## 1. Module Boundaries and Dependency Direction

```
adapter/ ──► core/ ──► modules/ ──► ai/
                  │              └──► storage/
                  └──► storage/
utils/ (imported by all — no upward deps)
config.ts (imported by all — no upward deps)
```

**Strict one-way rule**: no module may import from a layer above it. Specifically:
- `adapter/` imports nothing from `core/`, `modules/`, `ai/`, `storage/`
- `core/` imports from `modules/` and `storage/` only
- `modules/` imports from `ai/` and `storage/` only
- `ai/` imports from nothing in src (only Anthropic SDK)
- `storage/` imports from nothing in src (only better-sqlite3)
- `utils/` and `config.ts` are leaves — import nothing from src

**Circular imports are a build error.** tsconfig `paths` aliases are forbidden; use relative paths so the compiler catches violations.

---

## 2. TypeScript Interface Signatures

### 2.1 NapCatAdapter (`src/adapter/napcat.ts`)

```typescript
export interface GroupMessage {
  messageId: string;
  groupId: string;
  userId: string;
  nickname: string;
  role: 'owner' | 'admin' | 'member';
  content: string;       // plain text, already stripped of CQ codes
  rawContent: string;    // original CQ-code string
  timestamp: number;     // unix seconds
}

export interface AdapterEvents {
  'message.group': (msg: GroupMessage) => void;
  'notice.group_increase': (groupId: string, userId: string) => void;
  'notice.group_decrease': (groupId: string, userId: string) => void;
  'error': (err: Error) => void;
  'close': () => void;
}

export interface INapCatAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on<K extends keyof AdapterEvents>(event: K, handler: AdapterEvents[K]): void;
  /** Send a group message, optionally quoting replyToMsgId. Returns the OneBot message_id, or null if unavailable. */
  send(groupId: string, text: string, replyToMsgId?: number): Promise<number | null>;
  ban(groupId: string, userId: string, durationSeconds: number): Promise<void>;
  kick(groupId: string, userId: string): Promise<void>;
  deleteMsg(messageId: string): Promise<void>;
  sendPrivate(userId: string, text: string): Promise<void>;
  /** Resolve a CQ image file token via OneBot get_image — bypasses QQ CDN auth restrictions. */
  getImage(file: string): Promise<{ filename: string; url: string; size: number; base64?: string }>;
  /** Fetch group metadata including description. Tries _get_group_detail_info first (NapCat), falls back to get_group_info. */
  getGroupInfo(groupId: string): Promise<{ groupId: string; name: string; description: string; memberCount: number }>;
}
```

**Implementation note**: `NapCatAdapter` is a `class` that emits typed events. All OneBot action failures throw `NapCatActionError` (see §4). The adapter is the only file that knows about OneBot protocol; it exposes `GroupMessage` not raw OneBot frames.

---

### 2.2 Router (`src/core/router.ts`)

```typescript
export interface IRouter {
  dispatch(msg: GroupMessage): Promise<void>;
}

export type CommandHandler = (
  msg: GroupMessage,
  args: string[],
  config: GroupConfig
) => Promise<void>;
```

Router internals (not exported as interface, but constrained by Iteration Contract):
- Commands registered via a `Map<string, CommandHandler>` keyed by command name (e.g. `'mimic'`, `'rules'`).
- Non-command messages pass through: Moderator → (if chat trigger) Chat/Mimic → Learner (persist).
- Rate limiter checked before any handler runs; returns early on limit exceeded.

---

### 2.3 Chat Module (`src/modules/chat.ts`)

```typescript
export interface IChatModule {
  /**
   * Returns a reply string, or null if the bot should stay silent.
   * Caller decides whether to send.
   */
  generateReply(
    groupId: string,
    triggerMessage: GroupMessage,
    recentMessages: GroupMessage[]
  ): Promise<string | null>;
}
```

---

### 2.4 Mimic Module (`src/modules/mimic.ts`)

```typescript
export interface IMimicModule {
  /**
   * One-shot mimic: generate a reply in targetUserId's style.
   * topic is optional — if absent, reply to the latest group message.
   */
  generateMimic(
    groupId: string,
    targetUserId: string,
    topic: string | null,
    recentMessages: GroupMessage[]
  ): Promise<MimicResult>;
}

export type MimicResult =
  | { ok: true; text: string; historyCount: number }
  | { ok: false; errorCode: BotErrorCode };
```

---

### 2.5 Moderator Module (`src/modules/moderator.ts`)

```typescript
export interface ModerationVerdict {
  violation: boolean;
  severity: 1 | 2 | 3 | 4 | 5 | null;
  reason: string;
  confidence: number;
}

export interface IModerator {
  /**
   * Assess a message. If violation, execute the punishment ladder.
   * Returns the verdict regardless of whether punishment was applied
   * (e.g. whitelist or cap may suppress it).
   */
  assess(msg: GroupMessage, config: GroupConfig): Promise<ModerationVerdict>;
}
```

The punishment ladder (delete/ban/kick) is encapsulated inside `Moderator`; it calls `INapCatAdapter` directly via constructor injection. `Moderator` does NOT return after assessing — it also executes side effects.

---

### 2.6 Learner Module (`src/modules/learner.ts`)

```typescript
export interface ILearner {
  /** Persist a new rule with its embedding. */
  addRule(groupId: string, content: string, type: 'positive' | 'negative'): Promise<AddRuleResult>;

  /** Return top-k rules most similar to the query text. */
  retrieveRelevant(groupId: string, query: string, topK: number): Promise<Rule[]>;

  /** Check cosine similarity against existing rules; returns best match if >0.95. */
  findDuplicate(groupId: string, content: string): Promise<Rule | null>;
}

export type AddRuleResult =
  | { ok: true; ruleId: number }
  | { ok: false; errorCode: BotErrorCode; duplicateId?: number };

export interface Rule {
  id: number;
  groupId: string;
  content: string;
  type: 'positive' | 'negative';
  embedding: Float32Array;
}
```

---

### 2.7 ClaudeClient (`src/ai/claude.ts`)

```typescript
export type ClaudeModel = 'claude-sonnet-4-6' | 'claude-opus-4-6';

export interface CachedSystemBlock {
  text: string;
  cache: true;   // always sets cache_control: {type: 'ephemeral'}
}

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ClaudeRequest {
  model: ClaudeModel;
  maxTokens: number;
  system: CachedSystemBlock[];
  messages: ClaudeMessage[];
}

export interface ClaudeResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface IClaudeClient {
  complete(req: ClaudeRequest): Promise<ClaudeResponse>;
}
```

**Prompt caching**: Every call where `system` contains a `CachedSystemBlock` with `cache: true` must set `cache_control: {type: 'ephemeral'}` on that content block. The client must NOT add caching to user-turn messages. Response usage fields must be logged at DEBUG level on every call.

**Retry policy**: One automatic retry on HTTP 529 (overloaded) with 2-second delay. All other errors propagate as `ClaudeApiError`. No retry on 400/401/403.

---

### 2.8 Database Layer (`src/storage/db.ts`)

```typescript
// --- Domain types ---

export interface Message {
  id: number;
  groupId: string;
  userId: string;
  nickname: string;
  content: string;
  timestamp: number;
  deleted: boolean;
}

export interface User {
  userId: string;
  groupId: string;
  nickname: string;
  styleSummary: string | null;
  lastSeen: number;
}

export interface ModerationRecord {
  id: number;
  msgId: string;
  groupId: string;
  userId: string;
  violation: boolean;
  severity: number | null;
  action: 'warn' | 'delete' | 'ban' | 'kick' | 'none';
  reason: string;
  appealed: 0 | 1 | 2;  // 0=no, 1=pending, 2=denied
  reversed: boolean;
  timestamp: number;
}

export interface GroupConfig {
  groupId: string;
  enabledModules: string[];
  autoMod: boolean;
  dailyPunishmentLimit: number;
  punishmentsToday: number;
  punishmentsResetDate: string;
  mimicActiveUserId: string | null;
  mimicStartedBy: string | null;
  chatTriggerKeywords: string[];
  chatTriggerAtOnly: boolean;
  chatDebounceMs: number;
  modConfidenceThreshold: number;
  modWhitelist: string[];
  appealWindowHours: number;
  kickConfirmModel: ClaudeModel;
  createdAt: string;
  updatedAt: string;
}

// --- Repository interfaces ---

export interface IMessageRepository {
  insert(msg: Omit<Message, 'id'>): Message;
  getRecent(groupId: string, limit: number): Message[];
  getByUser(groupId: string, userId: string, limit: number): Message[];
  softDelete(msgId: string): void;
}

export interface IUserRepository {
  upsert(user: Omit<User, never>): void;
  findById(userId: string, groupId: string): User | null;
}

export interface IModerationRepository {
  insert(record: Omit<ModerationRecord, 'id'>): ModerationRecord;
  findById(id: number): ModerationRecord | null;
  findByMsgId(msgId: string): ModerationRecord | null;
  findRecentByUser(userId: string, groupId: string, windowMs: number): ModerationRecord[];
  findPendingAppeal(userId: string, groupId: string): ModerationRecord | null;
  update(id: number, patch: Partial<Pick<ModerationRecord, 'appealed' | 'reversed'>>): void;
  countWarnsByUser(userId: string, groupId: string, withinMs: number): number;
}

export interface IGroupConfigRepository {
  get(groupId: string): GroupConfig | null;
  upsert(config: GroupConfig): void;
  incrementPunishments(groupId: string): void;
  resetDailyPunishments(groupId: string): void;
}

export interface IRuleRepository {
  insert(rule: Omit<Rule, 'id'>): Rule;
  findById(id: number): Rule | null;
  getAll(groupId: string): Rule[];
  getPage(groupId: string, offset: number, limit: number): { rules: Rule[]; total: number };
}
```

All repository methods are **synchronous** (better-sqlite3 is sync). No Promises in the storage layer.

---

### 2.9 Logger (`src/utils/logger.ts`)

```typescript
import pino from 'pino';

export type Logger = pino.Logger;

export function createLogger(name: string): Logger;
```

Each module creates its own child logger: `createLogger('moderator')`, `createLogger('chat')`, etc.

---

## 3. Error Handling Strategy

### 3.1 Error Taxonomy

```typescript
// src/utils/errors.ts

export enum BotErrorCode {
  PERMISSION_DENIED     = 'E001',
  USER_NOT_FOUND        = 'E002',
  INSUFFICIENT_HISTORY  = 'E003',
  DAILY_CAP_REACHED     = 'E004',
  APPEAL_EXPIRED        = 'E005',
  APPEAL_DUPLICATE      = 'E006',
  NO_PUNISHMENT_RECORD  = 'E007',
  ALREADY_REVERSED      = 'E008',
  CLAUDE_API_ERROR      = 'E009',
  CLAUDE_PARSE_ERROR    = 'E010',
  DB_ERROR              = 'E011',
  NAPCAT_ACTION_FAIL    = 'E012',
  MIMIC_SESSION_ACTIVE  = 'E013',
  RULE_TOO_LONG         = 'E014',
  RULE_DUPLICATE        = 'E015',
  WHITELIST_MEMBER      = 'E016',
  SELF_MIMIC            = 'E017',
}

export class BotError extends Error {
  constructor(
    public readonly code: BotErrorCode,
    message: string,
    public readonly cause?: unknown
  ) { super(message); this.name = 'BotError'; }
}

export class ClaudeApiError extends BotError {
  constructor(cause: unknown) {
    super(BotErrorCode.CLAUDE_API_ERROR, 'Claude API call failed', cause);
    this.name = 'ClaudeApiError';
  }
}

export class ClaudeParseError extends BotError {
  constructor(raw: string) {
    super(BotErrorCode.CLAUDE_PARSE_ERROR, `Failed to parse Claude response: ${raw.slice(0, 100)}`);
    this.name = 'ClaudeParseError';
  }
}

export class NapCatActionError extends BotError {
  constructor(action: string, cause: unknown) {
    super(BotErrorCode.NAPCAT_ACTION_FAIL, `OneBot action '${action}' failed`, cause);
    this.name = 'NapCatActionError';
  }
}

export class DbError extends BotError {
  constructor(cause: unknown) {
    super(BotErrorCode.DB_ERROR, 'Database error', cause);
    this.name = 'DbError';
  }
}
```

### 3.2 Where Errors Are Caught

| Throw site | Caught at | Action |
|---|---|---|
| `ClaudeApiError` / `ClaudeParseError` | Caller module (Moderator, Chat, Mimic) | Fail-safe: treat as no-violation / no-reply; log ERROR |
| `NapCatActionError` | `Moderator.assess()` or command handler in Router | Log ERROR; send admin notification via adapter |
| `DbError` | Repository caller (module or command handler) | Log ERROR; reply "service unavailable" to user |
| `BotError` (domain) | Command handler in Router | Reply with UX template for that error code |
| Unhandled `Error` | `Router.dispatch()` top-level try/catch | Log FATAL; do not crash process |

**Process does not exit on any single-message error.** The only acceptable crashes are: DB file corrupt at startup, adapter cannot connect after 3 retries.

### 3.3 Retry Policy

| Situation | Retry | Delay |
|---|---|---|
| Claude HTTP 529 | 1 retry | 2s |
| Claude HTTP 4xx | 0 (throw immediately) | — |
| OneBot action fail | 0 (throw, let admin handle) | — |
| DB write fail | 0 (throw `DbError`) | — |
| Adapter WebSocket disconnect | Reconnect loop: 3 attempts, backoff 2s/5s/10s | — |

---

## 4. Logging Conventions

### 4.1 Pino Levels

| Level | When to use |
|---|---|
| `trace` | Per-message routing decisions, rate limiter checks |
| `debug` | Claude API request/response summaries (model, token counts, cache hit) |
| `info` | Moderation actions taken, commands dispatched, bot started/stopped |
| `warn` | Soft failures: rate limit reached, daily cap warning, `INSUFFICIENT_HISTORY` |
| `error` | `ClaudeApiError`, `NapCatActionError`, `DbError` — with full `err` object |
| `fatal` | Uncaught exceptions in `Router.dispatch()`, startup failures |

### 4.2 Structured Fields

Every log entry must include these fields where applicable:

```typescript
// Mandatory on every moderation-related log
{
  groupId: string,
  userId: string,
  messageId: string,
  module: 'moderator' | 'chat' | 'mimic' | 'learner' | 'router' | 'adapter',
}

// Claude calls — logged at DEBUG
{
  model: ClaudeModel,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  durationMs: number,
}

// Punishment actions — logged at INFO
{
  action: 'warn' | 'delete' | 'ban' | 'kick',
  severity: number,
  reason: string,
  durationSeconds?: number,
  reversedBy?: string,
}
```

Log output goes to stdout (pino default). A transport (`pino/file`) writing to `data/logs/bot-YYYY-MM-DD.log` is configured in `src/index.ts` only, not in modules.

**Never log raw message content at INFO or above.** Log message IDs only; content goes to `trace` level where PII risk is documented.

---

## 5. DI / Composition Pattern

Constructor injection is used throughout. No service locator, no global singletons except the logger.

### 5.1 Dependency Graph

```
Database (better-sqlite3 instance)
  └─► MessageRepository, UserRepository, ModerationRepository,
      GroupConfigRepository, RuleRepository

ClaudeClient (Anthropic SDK instance)

EmbeddingService (@xenova/transformers, lazy-loaded)

NapCatAdapter (ws connection)

Learner(RuleRepository, EmbeddingService)
Moderator(ClaudeClient, ModerationRepository, MessageRepository, GroupConfigRepository, NapCatAdapter)
Chat(ClaudeClient, MessageRepository, GroupConfigRepository)
Mimic(ClaudeClient, MessageRepository, GroupConfigRepository)

RateLimiter()  — no deps

Router(
  NapCatAdapter,
  Moderator, Chat, Mimic, Learner,
  MessageRepository, UserRepository, GroupConfigRepository,
  RateLimiter
)
```

### 5.2 Bootstrap Order (`src/index.ts`)

```typescript
// 1. Load config (env vars)
// 2. Open SQLite, run migrations
// 3. Instantiate repositories
// 4. Instantiate ClaudeClient
// 5. Instantiate EmbeddingService (do NOT await — lazy)
// 6. Instantiate modules (Learner, Moderator, Chat, Mimic)
// 7. Instantiate RateLimiter
// 8. Instantiate Router
// 9. Instantiate NapCatAdapter; call adapter.connect()
// 10. Register adapter.on('message.group', router.dispatch)
// 11. Start midnight cron for punishments_today reset
```

All instantiation is in `src/index.ts`. No module creates its own dependencies.

---

## 6. Configuration Loading Order

```
1. .env file (via dotenv.config() at process start)
   NAPCAT_WS_URL, ANTHROPIC_API_KEY, LOG_LEVEL, DB_PATH, NODE_ENV

2. Process environment (overrides .env — for CI/production)

3. group_config table in SQLite (per-group runtime config)
   Loaded fresh from DB on every Router.dispatch() call.
   Never cached in memory for longer than one message-handling cycle.
```

**Hard rules**:
- `ANTHROPIC_API_KEY` must never appear in `group_config` or any DB column.
- `DB_PATH` defaults to `data/bot.db` if not set.
- Missing `NAPCAT_WS_URL` or `ANTHROPIC_API_KEY` at startup → log FATAL + `process.exit(1)`.

---

## 7. Test Strategy

### 7.1 Framework and Coverage

- **Vitest** for all unit and integration tests.
- **Minimum 80% line coverage** enforced via `vitest --coverage` with `coverageThreshold: { global: { lines: 80 } }`.
- Edge cases listed in the plan are **mandatory** — failing edge tests block milestone sign-off.

### 7.2 Mocking Strategy

- `IClaudeClient` is an interface; tests inject a `MockClaudeClient` that returns canned JSON responses. No HTTP calls in unit tests.
- `INapCatAdapter` is an interface; tests inject a `MockNapCatAdapter` that records calls.
- Repository interfaces allow `MockMessageRepository` etc. — in-memory Maps.
- **No mocking of SQLite** in integration tests — use a real `:memory:` database.

### 7.3 Test Files and What They Must Cover

| Test file | Covers |
|---|---|
| `test/moderator.test.ts` | All 6 edge cases from plan; severity ladder; whitelist bypass; daily cap; Opus double-check flow; Claude error → fail-safe |
| `test/mimic.test.ts` | Zero history (E002); <5 messages (E003); self-mimic (E017); session active (E013); session persistence across restart |
| `test/chat.test.ts` | Debounce; bot mention loop prevention; group rate limit; Claude error → silent |
| `test/learner.test.ts` | RAG retrieval correctness; duplicate detection (similarity >0.95); rule too long; embedding unavailable at startup |
| `test/router.test.ts` | Command parsing; rate limiter; unknown command; private message rejection |
| `test/adapter.test.ts` | Reconnect on disconnect; action error wraps to NapCatActionError |
| `test/db.test.ts` | Repository CRUD; midnight reset logic; soft delete |

### 7.4 Integration Test for Adapter

One integration test connects to a local NapCat mock WebSocket server (test spins up a `ws.Server` on an ephemeral port) and verifies:
1. `adapter.connect()` succeeds.
2. Incoming OneBot `message_type: 'group'` frame triggers `'message.group'` event with parsed `GroupMessage`.
3. `adapter.send()` emits correct OneBot action frame.
4. WebSocket close triggers `'close'` event and automatic reconnect attempt.

This test is tagged `@integration` and excluded from default `pnpm test`; run via `pnpm test:integration`.

---

## 8. Iteration Contract

### What Developer Can Change Without Re-Approval

- Implementation details inside any module that do not change its exported interface.
- SQL queries inside repositories (schema must not change without approval).
- Prompt wording inside `chat.ts`, `mimic.ts`, `moderator.ts` — as long as the JSON schema Claude is asked to return is unchanged.
- Logger call sites (adding/removing log lines, changing levels within reason).
- Internal helper functions not exported from a module.
- Test implementations (new test cases always welcome).
- Error message strings passed to `BotError` (not the error codes).

### What Requires Architect Re-Approval

- **Any change to exported interfaces** in §2 (adding/removing/renaming methods or fields).
- **Dependency direction violations** — importing from a higher layer.
- **Schema changes** to any SQLite table (columns added, renamed, removed, type changed).
- **Claude API call structure** changes: system prompt structure, JSON response schema, model selection logic.
- **New external dependencies** (adding a package to `dependencies` or `devDependencies`).
- **Rate limiter semantics** changes (window type, limits, cooldown durations).
- **Punishment ladder logic** changes (severity thresholds, action types, Opus double-check trigger).
- **Startup/bootstrap order** changes in `src/index.ts`.
- **Config loading order** or new env vars.
- **Error codes** (`BotErrorCode` enum) — adding or changing codes.

### Milestone Gate Rule

Developer may not begin milestone M(n+1) until Reviewer has issued **APPROVED** for milestone M(n) in `.claude/code-reviews.md`. Partial approvals ("APPROVED with notes") are acceptable only if the noted issues are tracked as tasks for the current milestone and do not block correctness.

---

## 9. /char Feature — Iteration Contract

This section is the authoritative contract for the `/char` (BanG Dream character role-play) feature. Developer may not begin implementation until team-lead has acknowledged this section.

### 9.1 Architectural Issues Flagged

1. **`chatPersonaText` vs `activeCharacterId` precedence**: The existing `chatPersonaText` field in `GroupConfig` allows a raw text persona override. When `activeCharacterId` is non-null, it must take precedence over `chatPersonaText`. The hook in `chat.ts` line 2134 (`personaBase = config?.chatPersonaText ?? BANGDREAM_PERSONA`) must be extended to a three-way branch: char mode → char persona, else chatPersonaText → custom, else → BANGDREAM_PERSONA. Developer must not break the existing `chatPersonaText` path.

2. **tuning.md suppression while char active**: Spec decision (spec §10.7): when `activeCharacterId` is non-null, the `tuningBlock` injected at `chat.ts` line 1250 **must be skipped** (tuning.md disabled while character is active). Reason: tuning.md is calibrated to the 邦批 persona; injecting it alongside a character persona creates prompt conflict. The existing normal-chat path is unchanged.

3. **aliases.json loaded at startup**: `CharModule` loads `data/characters/aliases.json` once in its constructor. If the file is absent, log FATAL and throw at startup. This is a required data file, not optional.

4. **State invariant — dual-active bug**: `mimic_active_user_id IS NOT NULL` and `active_character_id IS NOT NULL` must never both be true simultaneously. Enforcement is in command handlers only (no DB constraint). If both are somehow set (upgrade-in-place from corrupt state), mimic takes precedence for reply generation; log `error` with `{ groupId, bug: 'dual_active_state' }`.

5. **`groupIdentityCache` invalidation**: `ChatModule` caches the composed system prompt per group (`groupIdentityCache`, TTL 1 hour). Any `/char*` command that changes `activeCharacterId` must call `chatModule.invalidateLore(groupId)` (existing method) so the next reply picks up the new persona. Router already does this for `/persona`; char commands must do the same.

---

### 9.2 Module List with Paths

| File | Status | Change |
|---|---|---|
| `src/modules/char.ts` | NEW | `CharModule` — alias resolution, state management, persona composition |
| `src/storage/db.ts` | MODIFY | Add `activeCharacterId` + `charStartedBy` to `GroupConfig` interface; add migration |
| `src/config.ts` | MODIFY | Add `activeCharacterId: null` + `charStartedBy: null` to `defaultGroupConfig()` |
| `src/core/router.ts` | MODIFY | Register `/char`, `/char_on`, `/char_off`, `/char_set`, `/char_status` command handlers; add char mutual-exclusion check to `/mimic_on` handler |
| `src/modules/chat.ts` | MODIFY | Three-way persona branch at line 2134; skip tuningBlock when char active |
| `src/storage/schema.sql` | MODIFY | Add `active_character_id TEXT` + `char_started_by TEXT` columns to `group_config` |
| `scripts/distill-character.ts` | NEW | CLI script: reads `data/lore/moegirl/<name>.md`, calls Claude, writes `data/characters/<name>.json` |
| `data/characters/aliases.json` | NEW | Static alias map (pre-shipped, contents defined in spec §10.5) |
| `data/characters/凑友希那.json` | NEW | Pre-shipped ykn profile (generated by distill script, committed) |
| `test/char.test.ts` | NEW | Unit + integration tests for CharModule |

**No new npm dependencies required.** The distill script uses the existing `IClaudeClient` / Anthropic SDK already in the project.

---

### 9.3 TypeScript Interface Signatures

#### 9.3.1 `CharacterProfile` (data shape, not a class)

```typescript
// Matches data/characters/<name>.json on disk
export interface CharacterProfile {
  characterName: string;        // canonical Chinese name, e.g. "凑友希那"
  alias: string;                // primary short alias, e.g. "ykn"
  band: string;                 // e.g. "Roselia"
  position: string;             // e.g. "主唱/作词作曲"
  cv: string;                   // e.g. "相羽あいな"
  imageColor: string;           // hex, e.g. "#881188"
  age: string;                  // e.g. "17（高中3年级→大学1年级）"
  catchphrases: string[];       // e.g. ["就这样决定了。", "音乐不容妥协。"]
  profile: string;              // ≤800 chars, third-person voice/style/quirks block
  toneNotes: string;            // ≤200 chars, LLM tone hints (words to avoid, common errors)
  distilledAt: string;          // ISO 8601
  sourceFile: string;           // e.g. "data/lore/moegirl/凑友希那.md"
}
```

#### 9.3.2 `CharacterRegistry`

```typescript
// Internal to CharModule, not exported — exposed only via CharModule methods
interface CharacterRegistry {
  // alias (lowercased) → canonical name
  readonly aliasMap: ReadonlyMap<string, string>;
  // canonical name → profile (loaded lazily on first /char set, cached thereafter)
  readonly profileCache: Map<string, CharacterProfile>;
}
```

#### 9.3.3 `ICharModule`

```typescript
export interface ICharModule {
  /**
   * Resolve alias → canonical name. Returns null if unknown.
   * Input is lowercased + trimmed before lookup.
   */
  resolveAlias(input: string): string | null;

  /**
   * Load and cache CharacterProfile for canonicalName.
   * Returns null if data/characters/<canonicalName>.json is absent.
   */
  loadProfile(canonicalName: string): CharacterProfile | null;

  /**
   * Compose the system prompt persona block for a character.
   * Returns the full system prompt string to replace BANGDREAM_PERSONA.
   * Throws BotError(E022) if profile file missing.
   */
  composePersonaPrompt(canonicalName: string): string;

  /**
   * Return a list of aliases that have a corresponding lore file present.
   * Used by /char status to list available characters.
   */
  listAvailableAliases(): string[];
}
```

#### 9.3.4 `GroupConfig` additions (in `src/storage/db.ts`)

Add to the existing `GroupConfig` interface:

```typescript
activeCharacterId: string | null;   // canonical character name, NULL = char mode off
charStartedBy: string | null;       // QQ ID of activating admin
```

Add to `defaultGroupConfig()` in `src/config.ts`:

```typescript
activeCharacterId: null,
charStartedBy: null,
```

---

### 9.4 Data Shapes

#### aliases.json (`data/characters/aliases.json`)

```json
{
  "ykn": "凑友希那",
  "yukina": "凑友希那",
  "友希那": "凑友希那",
  "sayo": "冰川纱夜",
  "纱夜": "冰川纱夜",
  "risa": "今井莉莎",
  "莉莎": "今井莉莎",
  "rinko": "白金燐子",
  "燐子": "白金燐子",
  "ako": "宇田川亚子",
  "亚子": "宇田川亚子"
}
```

(Full alias list per spec §10.5. File committed to repo at `data/characters/aliases.json`. Not generated at runtime.)

#### Character Profile JSON (`data/characters/<canonicalName>.json`)

Shape matches `CharacterProfile` interface above. Pre-shipped for `凑友希那` only. All others generated on-demand via `scripts/distill-character.ts`.

---

### 9.5 Migration SQL

Two new columns on `group_config`. Both wrapped in try/catch per project convention (§feedback_sqlite_schema_migration):

**schema.sql** — add to `CREATE TABLE group_config`:
```sql
active_character_id TEXT,
char_started_by     TEXT
```

**db.ts `applyMigrations()`** — add at end of migration block:
```typescript
try { this._db.exec(`ALTER TABLE group_config ADD COLUMN active_character_id TEXT`); } catch { /* already exists */ }
try { this._db.exec(`ALTER TABLE group_config ADD COLUMN char_started_by TEXT`); } catch { /* already exists */ }
```

`configFromRow()` must map `row.active_character_id → config.activeCharacterId` and `row.char_started_by → config.charStartedBy`. The `upsert()` SQL must include both columns.

---

### 9.6 System-Prompt Composition Diagram

```
On each chat reply, ChatModule._buildGroupIdentityPrompt(groupId) runs:

  config = db.groupConfig.get(groupId)
  
  ┌─ config.activeCharacterId !== null ─────────────────────────────────┐
  │  personaBlock = charModule.composePersonaPrompt(activeCharacterId)  │
  │  tuningBlock  = null   ← SUPPRESSED (persona conflict risk)         │
  └─────────────────────────────────────────────────────────────────────┘
  ┌─ config.chatPersonaText !== null (and no char active) ──────────────┐
  │  personaBlock = config.chatPersonaText                              │
  │  tuningBlock  = _loadTuning()   ← normal path                      │
  └─────────────────────────────────────────────────────────────────────┘
  ┌─ default ───────────────────────────────────────────────────────────┐
  │  personaBlock = BANGDREAM_PERSONA                                   │
  │  tuningBlock  = _loadTuning()   ← normal path                      │
  └─────────────────────────────────────────────────────────────────────┘

  systemBlocks = [
    { text: personaBlock,          cache: true },
    ...(moodSection ? [...]        : []),
    ...(contextStickerSection      : []),
    ...(rotatedStickerSection      : []),
    ...(factsBlock                 : []),
    ...(tuningBlock                : []),   ← omitted when char active
  ]

CharModule.composePersonaPrompt(canonicalName) returns:

  你是{characterName}（{band}）。{profile}

  【角色设定】乐队：{band} / 职位：{position} / 代表色：{imageColor}
  口头禅/标志：{catchphrases.join("、")}

  【圈内底线】即使在角色扮演中，绝对不攻击或贬低其他乐队、角色、声优，
  不散布声优相关谣言，不涉及恶意黑料。角色可以有个性和执念，但不得越过此线。

  【诚实底线】不捏造角色不可能知道的事实，不对现实声优或圈内八卦作出断言。

  【回复风格】绝对不要输出问答菜单式的列举；可以只发贴图反应（用<sticker>标记）；
  回复长度3-15字，重要时可多行；不要解释自己为什么回复。如果不想回复，输出 <skip>。

  (+ toneNotes block if non-empty)
```

The user-role message shape is **unchanged** — char mode only affects `system`, never `messages`.

---

### 9.7 Test Plan

| Test file | Unit/Integration | What it covers |
|---|---|---|
| `test/char.test.ts` | Unit | Alias resolution: known alias → canonical; unknown → null; case-insensitive; full Chinese name reverse-lookup (EC-19) |
| `test/char.test.ts` | Unit | `loadProfile()`: present file → profile; absent file → null |
| `test/char.test.ts` | Unit | `composePersonaPrompt()`: output contains characterName, band, catchphrases, 圈内底线, 诚实底线, 回复风格 blocks |
| `test/char.test.ts` | Unit | `listAvailableAliases()`: returns only aliases with present lore files |
| `test/char.test.ts` | Unit | EC-1: `/char set unknown_alias` → E021, no state change |
| `test/char.test.ts` | Unit | EC-2: `/char_on` while mimic active → E020, mimic unchanged |
| `test/char.test.ts` | Unit | EC-3: `/mimic_on` while char active → E020, char unchanged |
| `test/char.test.ts` | Unit | EC-4: `/char_off` when not active → E024 |
| `test/char.test.ts` | Unit | EC-6: `/char set ykn` when lore file deleted → E022 |
| `test/char.test.ts` | Unit | EC-10: `/char set <51-char input>` → E025 |
| `test/char.test.ts` | Unit | EC-11: member-role sender → router silently ignores (no reply) |
| `test/char.test.ts` | Unit | EC-12: dual-active state → char takes precedence, error logged |
| `test/char.test.ts` | Unit | EC-13: character persona returns `<skip>` → reply suppressed |
| `test/char.test.ts` | Unit | EC-18: `/char` with no prior character → defaults to ykn |
| `test/char.test.ts` | Unit | EC-23: same char already active → E023, no state change |
| `test/char.test.ts` | Integration | `/char set ykn` → groupConfig.activeCharacterId = "凑友希那" persisted in :memory: DB |
| `test/char.test.ts` | Integration | `/char_off` → activeCharacterId = null persisted |
| `test/char.test.ts` | Integration | groupIdentityCache invalidated on char activation |
| `test/chat.test.ts` | Unit (add) | Chat uses char persona when activeCharacterId set; tuningBlock absent in that path |
| `test/chat.test.ts` | Unit (add) | Chat falls back to chatPersonaText when activeCharacterId null |
| `test/distill-character.test.ts` | Unit | EC-16: empty source .md file → script exits non-zero, no JSON written |
| `test/distill-character.test.ts` | Unit | EC-17: second run overwrites first without error |
| `test/distill-character.test.ts` | Unit | Output JSON validates against CharacterProfile schema |
| `test/db.test.ts` | Integration (add) | Migration: ALTER TABLE adds active_character_id + char_started_by; existing DB rows default to NULL |

**Coverage target**: ≥80% line coverage for `src/modules/char.ts` and `scripts/distill-character.ts`.

---

### 9.8 Risks and Mitigations

| Risk | Decision | Mitigation |
|---|---|---|
| Persona conflict: tuning.md injected alongside character persona | **tuning.md disabled when char active** | Skip tuningBlock in chat.ts when activeCharacterId non-null. Document in comment at injection site. |
| Persona conflict: chatPersonaText + char mode simultaneously | char mode takes precedence | Three-way branch replaces two-way. chatPersonaText only applies when activeCharacterId is null. |
| groupIdentityCache serves stale persona after char switch | Invalidate on every char command | Router calls `chatModule.invalidateLore(groupId)` after any `/char*` state change. Same pattern as existing `/persona` command. |
| aliases.json absent at startup | FATAL + process.exit | CharModule constructor throws if file missing. Bot cannot run without alias map. |
| Character profile file absent (E022) | Reject at command time | `loadProfile()` returns null → command handler replies E022 and does not update state. |
| Dual-active state (bug) | Char takes precedence | Log error, proceed with char persona. Document as known-bad state; admin uses `/char_off` to resolve. |
| sentinelCheck rejects character output | Silent suppression, no reply | Same as normal chat path — character output is not exempt from sentinel. |

---

### 9.9 Dependency Graph Update

```
CharModule(db: Database, charDataDir: string)
  — reads aliases.json once at init from charDataDir
  — reads profile JSON on demand from charDataDir
  — no AI dependency (persona composed from static data)
  — no adapter dependency

Router(
  NapCatAdapter,
  Moderator, Chat, Mimic, Learner,
  CharModule,                        ← NEW
  MessageRepository, UserRepository, GroupConfigRepository,
  RateLimiter
)
```

Bootstrap order addition (after step 6 in §5.2):
```
// 6b. Instantiate CharModule (after DB repositories)
const charModule = new CharModule(db, 'data/characters');
## 9. Sticker-First Mode — Iteration Contract

### 9.1 Feature Summary

A per-group toggle that makes the bot prefer sending a sticker over sending text. When enabled, the bot runs its full normal reply pipeline and generates the text it *would have sent*. That intended text is then used as the embedding query against the local sticker library (`local_stickers` table). If the best-matching sticker scores at or above the configured threshold, the bot sends the sticker CQ code only; the intended text is discarded. If no sticker qualifies, the text is sent as normal. The feature is additive — it can only replace a text reply with a sticker, never convert a non-null reply into null output.

---

### 9.2 Design Decisions

#### Decision 1 — Scoring target: bot's intended text, not the trigger message

The user's request is "按照它想说的话发表情包" — send a sticker based on *what the bot would have said*, not based on what the user said. The embedding query is therefore `processedText` (the bot's final cleaned reply text), computed after the full LLM pipeline completes.

Call path:
```
ChatModule.generateReply()
  → LLM call → raw reply
  → sentinelCheck (+ hardened regen if needed)
  → postProcess (strip <skip>, "...", normalise)
  → [sticker-first intercept fires here, using processedText as query]
  → _recordOwnReply + return
```

`IEmbeddingService.embed(processedText)` is already available inside `ChatModule` (the `embedder` field injected at construction). `ILocalStickerRepository.getTopByGroup` is already available if `localStickerRepo` is injected. No new infrastructure is needed.

#### Decision 2 — Threshold default: 0.55 (conservative; needs live tuning)

**Measured from live data**: 16 (intendedText, sticker) pairs computed on the actual `local_stickers` table using `EmbeddingService` (MiniLM-L6-v2). Scoring method: embed `processedText`, embed `[summary, ...contextSamples].join(' ')` as a single string, cosine similarity.

Selected measurements:

| Pair | Category | Score |
|---|---|---|
| "哈哈哈笑死了" vs "笑死了 我要笑死了" | GOOD | 0.331 |
| "这是什么操作" vs "震惊 什么感觉" | GOOD | 0.459 |
| "哎我真无语了" vs "无语吐槽 神人 唉" | GOOD | 0.324 |
| "唉不想干了摆烂吧" vs "摆烂 还真是" | GOOD | 0.332 |
| "完蛋了这下完了" vs "完蛋了 报警了" | GOOD | 0.420 |
| "绷不住了哈哈哈哈" vs "绷不住 这波cxy来了都绷不住" | GOOD | 0.502 |
| "今天天气不错" vs "笑死了 我要笑死了" | BAD | 0.389 |
| "好的明白了" vs "震惊 什么感觉" | BAD | 0.334 |
| "我吃饭了" vs "完蛋了 报警了" | BAD | 0.417 |
| "这个代码有bug" vs "才怪 记住了 ohno" | BAD | 0.411 |

**Finding**: MiniLM-L6-v2 inflates cosine scores for short Chinese text. "你好啊" vs "无语吐槽" (single-string) scores 0.96; bad-match pairs cluster 0.33–0.42, overlapping with good-match pairs. No threshold below ~0.50 cleanly separates the distributions.

**Chosen default: 0.55** — at this level, only near-literal lexical overlap fires (bot says "完蛋了" → matches "完蛋了 报警了" sticker at 0.42; narrowly misses, which is correct). The intent is a conservative v1 default: occasional confirmed matches are better than frequent jarring mismatches. Admins who want more liberal matching use `/stickerfirst_threshold 0.3`.

**Architecture supersedes spec §11.9 placeholder**: `docs/spec.md §11.9` lists `0.20` as a placeholder pending architect investigation. That number is superseded by this measured decision. The authoritative implementation default is **0.55**, reflected in both the `ALTER TABLE` migration `DEFAULT 0.55` and `defaultGroupConfig()` in `src/config.ts`. Developer implements 0.55; the spec's 0.20 is a stale placeholder. No spec re-open needed — the architecture document is the binding contract.

**Scoring deviation from spec §11.4 draft**: the spec proposes scoring bot-text vs each `context_sample` individually and taking the max. Measured behaviour: individual 1–3 character context samples ("唉", "神人") produce pathological scores (0.75+ for unrelated queries) because MiniLM has insufficient signal. **Required deviation**: score against `[summary, ...contextSamples].filter(s => s.trim().length >= 2).join(' ')` as one concatenated string. Also skip any sticker whose total scorable text is < 6 characters. This is architecturally safer and produces more stable score distributions.

#### Decision 3 — Hook point in `chat.ts`

The intercept is inserted **after** `postProcess` and all null/echo/self-dedup checks, **before** `_recordOwnReply`. Pseudocode:

```typescript
// inside generateReply(), after processedText is finalised and non-null:
const groupConf = this.db.groupConfig.get(groupId);
if (groupConf?.stickerFirstEnabled && this.embedder?.isReady && this.localStickerRepo) {
  const choice = await this.stickerFirst
    .pickSticker(groupId, processedText, groupConf.stickerFirstThreshold)
    .catch(err => { this.logger.error({ err, groupId }, 'sticker-first pick failed'); return null; });
  if (choice) {
    this._recordOwnReply(groupId, choice.cqCode);
    return choice.cqCode;
  }
}
this._recordOwnReply(groupId, processedText);
return processedText;
```

Rationale: (a) we need the final cleaned text as the query; (b) we must not record a text that was not sent; (c) one conditional at one point minimises blast radius — the entire rest of `generateReply` is untouched.

#### Decision 4 — New module: `src/modules/sticker-first.ts`

Extracted into its own module to keep `chat.ts` from accumulating scoring + suppression state. Pure: no AI calls, no side effects on chat state, no adapter dependency.

```typescript
export interface IStickerFirstModule {
  pickSticker(
    groupId: string,
    intendedText: string,
    threshold: number,
  ): Promise<StickerChoice | null>;
}

export type StickerChoice = {
  key: string;       // sticker key (SHA-256 prefix or mface key)
  cqCode: string;    // ready-to-send CQ code string
  score: number;     // cosine similarity that won
};
```

`StickerFirstModule` constructor receives `ILocalStickerRepository` and `IEmbeddingService`. It owns the repeat-suppression map. No `IClaudeClient`, no `INapCatAdapter`, no `IGroupConfigRepository`.

Dependency direction: `modules/sticker-first.ts` → `storage/` + `storage/embeddings.ts`. No upward imports. Clean.

#### Decision 5 — Repeat suppression

In-memory map owned by `StickerFirstModule`:

```typescript
private readonly _cooldown = new Map<string, Map<string, number>>();
// groupId → Map<stickerKey, expiresAtMs>
```

- Before scoring: filter out keys where `Date.now() < expiresAtMs`
- After a sticker is chosen: set `key → Date.now() + 5 * 60_000`
- Cap: 50 entries per group; on overflow evict the entry with the smallest `expiresAtMs` (oldest expiry)
- Resets on process restart — acceptable for a 5-minute window
- If top pick is suppressed: **try next-best candidate** if it is still ≥ threshold; fall through to text only if no unsuppressed candidate meets threshold. Rationale: next-best is almost certainly contextually appropriate too; falling through immediately wastes the feature when only one sticker is on cooldown out of a library of 30.

#### Decision 6 — `GroupConfig` additions

```typescript
// src/storage/db.ts — GroupConfig interface
stickerFirstEnabled: boolean;    // default false
stickerFirstThreshold: number;   // default 0.55
```

`defaultGroupConfig()` in `src/config.ts` is the single source of truth:

```typescript
stickerFirstEnabled: false,
stickerFirstThreshold: 0.55,
```

#### Decision 7 — Migration SQL

Added in `applyMigrations()` in `src/storage/db.ts` only. `schema.sql` gets comment-only documentation (not executable migration). Per project convention (feedback_sqlite_schema_migration): `schema.sql` changes silently skip existing DBs; `ALTER TABLE` in `applyMigrations()` is the only safe path.

```sql
ALTER TABLE group_config ADD COLUMN sticker_first_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_config ADD COLUMN sticker_first_threshold REAL NOT NULL DEFAULT 0.55;
```

Each wrapped in a `try { } catch { /* duplicate column */ }` block, matching the existing pattern for `live_sticker_capture_enabled`.

#### Decision 8 — Router wiring

Four new command handlers registered in `Router` using the existing `Map<string, CommandHandler>` pattern. All four are guarded by the existing admin/owner role check at the router gate — no new permission infrastructure.

| Command | Effect |
|---|---|
| `/stickerfirst_on` | Set `stickerFirstEnabled = true`; idempotent; warn if sticker library empty for this group |
| `/stickerfirst_off` | Set `stickerFirstEnabled = false`; idempotent |
| `/stickerfirst_threshold <val>` | Parse float, validate [0.0, 1.0], set `stickerFirstThreshold`; `E030` on invalid |
| `/stickerfirst_status` | Read config + `localStickers.getTopByGroup(groupId, 9999).length`; format status block per UX spec §9 |

`/help` text block updated: four new lines appended to the 【聊天 & 模仿】 section as specified in `docs/ux.md §9`.

#### Decision 9 — Interaction with `/char` and `/mimic`

**`/char` persona**: sticker-first is persona-agnostic. The `/char` command injects a persona into the LLM system prompt, but still routes through `ChatModule.generateReply`. The LLM produces the char's intended reply text; sticker-first scores that text. The sticker represents the character's emotional intent — behaviourally correct. No special handling required.

**`/mimic_on`**: router dispatches to `MimicModule.generateMimic`, not `ChatModule.generateReply`. `StickerFirstModule` has no hook into `MimicModule`. Sticker-first does not apply in mimic mode. This is explicit and intentional: mimic replicates a specific user's textual register; silently substituting a sticker would break the persona contract. No interaction handling required because the paths never meet.

---

### 9.3 Interface Signatures (canonical, Developer must not deviate)

```typescript
// src/modules/sticker-first.ts

export type StickerChoice = {
  key: string;
  cqCode: string;
  score: number;
};

export interface IStickerFirstModule {
  pickSticker(
    groupId: string,
    intendedText: string,
    threshold: number,
  ): Promise<StickerChoice | null>;
}

export class StickerFirstModule implements IStickerFirstModule {
  constructor(
    private readonly repo: ILocalStickerRepository,
    private readonly embedder: IEmbeddingService,
  ) {}

  async pickSticker(groupId: string, intendedText: string, threshold: number): Promise<StickerChoice | null>;
  // Full implementation in src/modules/sticker-first.ts — not in chat.ts
}
```

```typescript
// src/storage/db.ts — GroupConfig additions
stickerFirstEnabled: boolean;
stickerFirstThreshold: number;

// src/utils/errors.ts — BotErrorCode addition
STICKER_THRESHOLD_INVALID = 'E030',
```

---

### 9.10 What Developer Can Change Without Re-Approval (this feature)

- Prompt wording inside `composePersonaPrompt()` as long as the six blocks (A–F from spec §10.4) are all present and in order.
- Internal alias normalisation logic (trim, lowercase) as long as the spec behaviour is preserved.
- distill-character.ts prompt wording sent to Claude, as long as output JSON validates against `CharacterProfile`.
- Test implementations beyond the mandatory edge cases listed above.
- Log message strings (not log levels or structured fields).

### 9.11 What Requires Architect Re-Approval (this feature)

- Any change to `ICharModule`, `CharacterProfile`, or `CharacterRegistry` interface shapes.
- Adding or removing columns from `group_config` (beyond the two specified in §9.5).
- Changing the three-way persona branch logic in `chat.ts` to anything other than `char > chatPersonaText > default`.
- Changing the tuning.md suppression rule (currently: always suppressed when char active).
- Adding runtime RAG or dynamic lookups to character persona composition (static-only is an invariant per `feedback_distill_over_retrieve`).
- Any new external npm dependencies.
### 9.4 Files Changed

| File | Change |
|---|---|
| `src/modules/sticker-first.ts` | New module: `StickerFirstModule`, `IStickerFirstModule`, `StickerChoice` |
| `src/modules/chat.ts` | Inject `IStickerFirstModule`; insert sticker-first intercept block in `generateReply`; no other changes |
| `src/storage/db.ts` | `GroupConfig` interface additions; `GroupConfigRow` raw row additions; `applyMigrations()` two ALTER statements; upsert/get mapping for both new fields |
| `src/storage/schema.sql` | Comment-only documentation of two new columns |
| `src/config.ts` | `defaultGroupConfig()` additions |
| `src/core/router.ts` | 4 new command handlers; `/help` text update |
| `src/utils/errors.ts` | `STICKER_THRESHOLD_INVALID = 'E030'` |
| `test/sticker-first.test.ts` | New test file — all 21 EC cases from spec §11.13 |
| `test/router.test.ts` | Sticker-first command registration + permission + E030 validation |

---

### 9.5 Test Plan

**Unit tests** (`test/sticker-first.test.ts`, Vitest + in-memory mocks):

| ID | Scenario |
|---|---|
| EC-1 | Mode OFF: `pickSticker` never called when `stickerFirstEnabled = false` |
| EC-2 | Mode ON, library empty → null → text fallthrough |
| EC-3 | Mode ON, all scores below threshold → null → text |
| EC-4 | Mode ON, one sticker above threshold → `StickerChoice` returned |
| EC-5 | Multiple stickers above threshold → highest score wins |
| EC-6 | Top sticker suppressed, next-best above threshold → next-best returned |
| EC-6b | All candidates suppressed → null → text |
| EC-7 | `/stickerfirst_threshold 0.0` → accepted (boundary) |
| EC-8 | `/stickerfirst_threshold 1.0` → accepted (boundary) |
| EC-9 | `/stickerfirst_threshold -0.1` → E030 |
| EC-10 | `/stickerfirst_threshold 1.5` → E030 |
| EC-11 | `/stickerfirst_threshold abc` → E030 |
| EC-12 | `/stickerfirst_on` already on → idempotent |
| EC-13 | `/stickerfirst_off` already off → idempotent |
| EC-14 | `applyMigrations()` called twice → no crash ("duplicate column" swallowed) |
| EC-15 | Non-admin `/stickerfirst_on` → silently ignored at router gate |
| EC-16 | `/stickerfirst_status` accuracy after on + threshold change |
| EC-17 | Static system prompt invariant: zero user content in any system block |
| EC-18 | `/mimic_on` active + sticker-first ON → `generateReply` never called |
| EC-19 | `/char` persona + sticker-first ON → sticker scored against char's intended text |
| EC-20 | LLM returns `<skip>` → `generateReply` returns null before intercept |
| EC-21 | `embedder.isReady = false` → text fallthrough, no error |

**Integration tests** (`test/router.test.ts` additions): command registration; admin gate; E030 validation pipeline.

**Coverage requirement**: `test/sticker-first.test.ts` must contribute to the project's ≥80% line coverage gate. All 21 EC cases are mandatory — failing any one blocks Reviewer sign-off.

---

### 9.6 Fail-Safe Invariants

These must hold unconditionally. Developer must not weaken any of them:

| Condition | Required behaviour |
|---|---|
| `embedder.isReady === false` | Skip intercept; return text |
| `localStickerRepo` not injected | Skip intercept; return text |
| `local_stickers` empty for group | `pickSticker` returns null; return text |
| All candidates below threshold | `pickSticker` returns null; return text |
| All candidates in suppression cooldown | `pickSticker` returns null; return text |
| `localPath` file does not exist on disk | Exclude that sticker from candidates |
| DB read throws | Log WARN; `pickSticker` returns null; return text |
| Any uncaught exception in `pickSticker` | Outer catch in `generateReply` logs ERROR; returns text |
| LLM returns `<skip>` or null | `generateReply` returns null before intercept fires |
| Sticker send path | Can only replace a non-null text reply; cannot produce null output |

---

### 9.7 Risk Table

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Score distribution: good/bad overlap at default 0.55 | High (measured) | Medium — occasional jarring sticker | Admin tunable via `/stickerfirst_threshold`; conservative default reduces frequency |
| MiniLM inflates scores for short Chinese (<6 chars) | High (measured) | Medium — false positives | Minimum scorable-text length filter (≥6 chars total); skip sticker otherwise |
| Sticker library empty for new groups | High | Low — graceful fallthrough to text | EC-2 covers this; `/stickerfirst_on` warns if library is empty |
| Embedder not ready at startup | Medium | Low — feature silently inactive | `isReady` guard in intercept; EC-21 covers this |
| Threshold 0.55 too conservative (feature rarely fires) | Medium | Low — feature appears inactive | Document in `/stickerfirst_status` output; admin can lower threshold |
| `context_samples` JSON parse failure | Low | Low — sticker excluded from candidates | Developer must JSON.parse inside try/catch; exclude malformed rows |
| Sticker file missing from disk after DB record exists | Low | Low — sticker excluded | `existsSync(localPath)` filter before scoring |

---


## 11. BanG Dream Live Scraper — Iteration Contract

### 11.1 Feature Summary

A daily background scraper that fetches the official BanG Dream event listing (`https://bang-dream.com/events/`), parses upcoming/ongoing live events, and stores them in a new `bandori_lives` SQLite table. No user-facing commands. No push broadcast. No per-group toggle — feature is always-on; only env var gating via `BANDORI_SCRAPE_ENABLED`. Knowledge is injected passively into the LLM's user-role context when the incoming message contains live-related keywords, allowing the bot to mention upcoming lives organically.

**No `ScoreFactors.liveKw` field.** Keyword detection gates injection only — it does not affect the reply-or-skip score.

---

### 11.2 HTML Parser Choice

**Decision: node-html-parser** (new `dependencies` entry in package.json).

Rationale:
- `package.json` currently has no DOM parser (no cheerio, no node-html-parser, no happy-dom, no jsdom).
- node-html-parser: pure JS, zero native deps, ~100 KB, CSS selector support sufficient for event card extraction.
- jsdom is explicitly rejected — too heavy, browser emulation not needed.
- cheerio: acceptable but heavier than node-html-parser for this use case.

**Parse strategy**: DOM selector parsing only. Strip `<script>`, `<style>`, `<nav>`, `<footer>`, `<header>` before parsing. Look for `<article>`, `div.event-card`, or equivalent containers. If 0 events parsed, log WARN (E042) at HIGH severity and return 0 — do NOT throw, do NOT call Claude (no fallback in v1, per spec §12.15).

---

### 11.3 Fetch Strategy

```
User-Agent: BanGDreamFanBot/1.0 (QQ group assistant; non-commercial)
Timeout: 15 000 ms
Retry: none — on any error, log WARN and skip until next cycle
Robots.txt: respect; if events path disallowed, log WARN and skip
```

One GET request per scrape cycle. No session cookies. Network error → E040. HTTP non-2xx → E041. No retry — reschedule is handled by the cron loop.

---

### 11.4 Module Interface

**src/modules/bandori-live-scraper.ts**

```typescript
export interface BandoriLiveScraperOptions {
  enabled?: boolean;          // default true (from BANDORI_SCRAPE_ENABLED env)
  intervalMs?: number;        // default 86_400_000 (from BANDORI_SCRAPE_INTERVAL_MS env)
  initialDelayMs?: number;    // default 60_000 — avoids blocking boot
  sourceUrl?: string;         // default "https://bang-dream.com/events/"
  requestTimeoutMs?: number;  // default 15_000
}

export class BandoriLiveScraper {
  constructor(
    private readonly repo: IBandoriLiveRepository,
    options?: BandoriLiveScraperOptions,
  ) {}

  /** Start the scheduled loop. Synchronous and non-blocking — first run fires after initialDelayMs. */
  start(): void;

  /** Stop the loop (for graceful shutdown). */
  stop(): void;

  /**
   * Run one full scrape cycle immediately.
   * Returns number of events upserted. Does NOT throw on network/parse failures — logs WARN and returns 0.
   */
  async scrape(): Promise<number>;
}

/** Flat keyword list for injection trigger detection. Exported for chat.ts to import. */
export const BANDORI_LIVE_KEYWORDS: string[];
```

**Cron loop pattern** (follows `SelfReflectionLoop` — setTimeout + reschedule-after-completion, NOT setInterval):

```typescript
start(): void {
  if (!this.enabled) { logger.info('bandori-live scraper disabled (BANDORI_SCRAPE_ENABLED=false)'); return; }
  this.timer = setTimeout(() => void this._runAndSchedule(), this.initialDelayMs);
  logger.info({ intervalMs: this.intervalMs, initialDelayMs: this.initialDelayMs }, 'bandori-live scraper started');
}

private async _runAndSchedule(): Promise<void> {
  try {
    const n = await this.scrape();
    logger.info({ eventsUpserted: n }, 'bandori-live scrape complete');
  } catch (err) {
    logger.error({ err }, 'bandori-live scrape failed');
  }
  // Always reschedule, even on error
  this.timer = setTimeout(() => void this._runAndSchedule(), this.intervalMs);
}
```

setTimeout (not setInterval) avoids overlap on slow scrapes.

**src/storage/db.ts** — new domain type and repository interface:

```typescript
export interface BandoriLiveRow {
  id: number;
  eventKey: string;         // SHA-256 hex of detail_url (first 16 chars), stable dedup key
  title: string;
  startDate: string | null; // YYYY-MM-DD
  endDate: string | null;   // YYYY-MM-DD
  venue: string | null;
  city: string | null;
  bands: string[];          // deserialized from JSON column
  detailUrl: string | null;
  ticketInfoText: string | null;
  fetchedAt: number;        // unix seconds
  lastSeenAt: number;       // unix seconds
  rawHash: string;          // SHA-256 of sorted canonical JSON of parsed fields
}

export interface IBandoriLiveRepository {
  /** Insert new or update existing row matched by event_key. See upsert semantics below. */
  upsert(row: Omit<BandoriLiveRow, 'id'>): void;

  /**
   * Events where start_date >= todayIso AND (start_date <= todayIso + 60 days OR start_date IS NULL),
   * ordered ascending by start_date (NULLs last). Default limit: 3.
   * The 60-day window per UX section 10.5; NULL-date events always included (date TBD).
   */
  getUpcoming(todayIso: string, limit?: number): BandoriLiveRow[];

  /**
   * Events where bands JSON array contains bandQuery (case-insensitive substring).
   * Ordered ascending by start_date (NULLs last). Default limit: 10.
   */
  searchByBand(bandQuery: string, limit?: number): BandoriLiveRow[];

  /** All rows ordered by start_date ascending (NULLs last). No hard limit. For diagnostics. */
  getAll(): BandoriLiveRow[];
}
```

**`event_key`**: `createHash('sha256').update(detailUrl ?? title).digest('hex').slice(0, 16)`

**`raw_hash`**: `createHash('sha256').update(JSON.stringify({ title, startDate, endDate, venue, city, bands: bands.slice().sort(), ticketInfoText })).digest('hex')` — bands sorted for determinism (EC-19).

**Upsert semantics**:
- `event_key` absent: INSERT full row; `fetchedAt = lastSeenAt = nowUnixSecs`.
- `event_key` present, `raw_hash` unchanged: UPDATE `lastSeenAt` only; do not touch `fetchedAt`.
- `event_key` present, `raw_hash` changed: UPDATE all fields except `fetchedAt`; update `lastSeenAt`.
- Events absent from the current scrape are NOT touched — `lastSeenAt` is not decremented (historical retention, EC-4).

---

### 11.5 Database Schema

**schema.sql addition** (fresh-install path — `CREATE TABLE IF NOT EXISTS` is idempotent):

```sql
CREATE TABLE IF NOT EXISTS bandori_lives (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key        TEXT    NOT NULL UNIQUE,
  title            TEXT    NOT NULL,
  start_date       TEXT,                          -- YYYY-MM-DD, NULL if unparseable
  end_date         TEXT,                          -- YYYY-MM-DD, NULL if single-day or unknown
  venue            TEXT,
  city             TEXT,
  bands            TEXT    NOT NULL DEFAULT '[]', -- JSON array
  detail_url       TEXT,
  ticket_info_text TEXT,
  fetched_at       INTEGER NOT NULL,              -- unix seconds
  last_seen_at     INTEGER NOT NULL,              -- unix seconds
  raw_hash         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bandori_lives_start_date ON bandori_lives(start_date);
CREATE INDEX IF NOT EXISTS idx_bandori_lives_last_seen  ON bandori_lives(last_seen_at);
```

**Migration** (`src/storage/db.ts` → `_runMigrations()`): Add an identical `CREATE TABLE IF NOT EXISTS` block following the existing `name_images` / `live_stickers` pattern. No `ALTER TABLE` required — this is a wholly new table; `CREATE TABLE IF NOT EXISTS` handles both fresh and existing DBs idempotently (EC-11).

---

### 11.6 Chat Injection Hook

**Location**: `src/modules/chat.ts` — inside `generateReply()`, user-role context assembly. NOT the system prompt — per project invariant §1: static system prompts, user content in user-role (same pattern as existing `factsBlock`).

**Keyword detection** — flat substring match, no compound threshold:

```typescript
// Constant defined and exported from bandori-live-scraper.ts:
export const BANDORI_LIVE_KEYWORDS = [
  'live', 'ライブ', '演唱会', '公演', '演出', '场', '会场', '场馆',
  '票', 'チケット', 'ticket',
  "Roselia", "MyGO!!!!!", "Ave Mujica", "Poppin'Party", "Afterglow",
  "Hello Happy World!", "HHW", "Pastel Palettes", "Morfonica",
  "RAISE A SUILEN", "RAS", "CRYCHIC",
  "波普派对", "余晖", "彩色调色板", "彩帕", "玫瑰利亚",
];

function _hasBandoriLiveKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return BANDORI_LIVE_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}
```

**Injection step** (single conditional block, minimal blast radius):

```typescript
let liveBlock = '';
if (this.bandoriLiveRepo && _hasBandoriLiveKeyword(triggerMessage.content)) {
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = this.bandoriLiveRepo.getUpcoming(today, 3);
  if (upcoming.length > 0) {
    liveBlock = _formatLiveBlock(upcoming) + '\n\n';
  }
}
const userContent = `${liveBlock}${replyContextBlock}${keywordSection}...`;
```

Cap: `getUpcoming(today, 3)` — maximum 3 entries (EC-16). Prepended before conversation history.

**New optional constructor option** in `ChatModule`:

```typescript
bandoriLiveRepo?: IBandoriLiveRepository;
```

No change to `IChatModule` interface. If undefined, injection path is skipped silently.

**No `GroupConfig` change.** No `bandoriLiveEnabled` field. Not in `defaultGroupConfig`. Feature is global, env-var-gated only.

---

### 11.7 Context Block Format

Per spec §12.7.3 and UX §10.1–§10.2:

```typescript
function _formatLiveBlock(events: BandoriLiveRow[]): string {
  const lines = events.map(e => {
    const dateStr = e.startDate
      ? (e.endDate && e.endDate !== e.startDate ? `${e.startDate} ~ ${e.endDate}` : e.startDate)
      : '日程未定';
    const bandsStr = e.bands.length > 0 ? e.bands.join(' / ') : '未知乐队';
    const venueStr = [e.venue, e.city].filter(Boolean).join('・') || '场馆未定';
    const ticketStr = e.ticketInfoText ? `（${e.ticketInfoText.slice(0, 40)}）` : '';
    return `- ${e.title}｜${dateStr}｜${bandsStr}｜${venueStr}${ticketStr}`;
  });
  // UX §10.2 guidance fragment — exact text mandated by Designer; do not paraphrase
  const guidance = '（以上是刚拿到的 Live 排期信息，仅供你参考。如果和话题相关，可以像群里的粉丝一样自然聊几句——比如说说哪场你期待或者票还有没有；如果话题无关，就当没看到。绝对不要把上面的信息当成列表原文输出，要融入对话语气。）';
  return `【近期 BanG Dream! Live 信息】\n${lines.join('\n')}\n${guidance}`;
}
```

**Past event handling** (UX §10.5 decision): v1 does NOT inject past events. `getUpcoming` filters `start_date >= today`. Past-event injection deferred to v2.

---

### 11.8 Bootstrap Wiring (index.ts)

```typescript
const bandoriEnabled = process.env.BANDORI_SCRAPE_ENABLED !== 'false';
const bandoriLiveRepo = db.bandoriLives; // via Database facade

const bandoriScraper = new BandoriLiveScraper(bandoriLiveRepo, {
  enabled: bandoriEnabled,
  intervalMs: parseInt(process.env.BANDORI_SCRAPE_INTERVAL_MS ?? '86400000', 10),
});
bandoriScraper.start(); // synchronous, non-blocking; first scrape after 60s

const chatModule = new ChatModule({
  ...existingOptions,
  bandoriLiveRepo: bandoriEnabled ? bandoriLiveRepo : undefined,
});
```

---

### 11.9 Environment Variables

| Variable | Type | Default | Description |
|---|---|---|---|
| `BANDORI_SCRAPE_ENABLED` | `'true'`/`'false'` | `'true'` | Set `'false'` to disable scraper and injection entirely |
| `BANDORI_SCRAPE_INTERVAL_MS` | integer string | `'86400000'` (24h) | Scrape repeat interval in milliseconds |

Both read from `process.env` in `src/index.ts`. Not stored in `group_config` or `defaultGroupConfig`. Document in `.env.example` with timezone caveat: scraper fires relative to process startup time, not at a fixed wall-clock time.

---

### 11.10 Error Handling

| Code | Name | Cause | Behavior |
|---|---|---|---|
| E040 | BANDORI_NETWORK_ERROR | Fetch threw (DNS/timeout) | Log WARN; `scrape()` returns 0; existing DB rows retained; reschedule normally |
| E041 | BANDORI_HTTP_ERROR | HTTP response status >= 400 | Log WARN with status code; `scrape()` returns 0; existing DB rows retained |
| E042 | BANDORI_PARSE_ZERO | Valid HTML but zero event cards found | Log WARN HIGH with first 200 chars of HTML; `scrape()` returns 0 |
| E043 | BANDORI_DATE_PARSE | Individual event date string unparseable | Log WARN with raw dateText; set `startDate`/`endDate` to null; continue inserting row |

Scraper always reschedules after any error. No crash on any of the above.

---

### 11.11 Risk Table

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| bang-dream.com HTML structure changes | High (external site) | Medium — zero events parsed | E042 WARN HIGH logged; existing DB rows retained for injection; admin sees log |
| Robots.txt disallows events path | Low (1 req/day, identified bot UA) | Medium | Respect disallow; log WARN; document in `.env.example` |
| Live keyword injection over-triggers | Medium | Low — occasional live mention | Flat keyword list carefully scoped; hard cap at 3 entries |
| Timezone drift | Low | Low | Timer relative to startup; once-per-day cadence sufficient per spec |
| DB grows with stale past events | Low | Low | `getUpcoming` filters by date; live events per year are finite |
| `rawHash` non-determinism | Low | Medium — spurious updates | Bands sorted before hashing; EC-19 is mandatory |
| Scraper blocks bot startup | N/A (mitigated) | High if triggered | `start()` returns synchronously; first scrape after 60s delay |
| Injection tone regresses | Low | Low | `_formatLiveBlock` embeds exact UX §10.2 guidance fragment; Reviewer validates sentinel |

---

### 11.12 Test Plan

**Single test file**: `test/bandori-live.test.ts` (unit + integration; real `:memory:` SQLite for repo tests).

**Fixtures**:
- `test/fixtures/bandori-events-normal.html` — valid page with 3 events (one with date range, one no date)
- `test/fixtures/bandori-events-empty.html` — valid HTML, zero event cards
- `test/fixtures/bandori-events-malformed.html` — truncated/invalid HTML

**Edge case coverage (all 19 mandatory — SOUL RULE)**:

| EC | Description |
|---|---|
| EC-1 | Fresh DB: `scrape()` stores all events; `eventsUpserted > 0`; `fetchedAt = lastSeenAt = now` |
| EC-2 | Re-scrape identical HTML: all rows' `lastSeenAt` updated; no new rows; `rawHash` unchanged |
| EC-3 | Re-scrape with changed event field: `rawHash` changes; all fields updated except `fetchedAt`; `lastSeenAt` advances |
| EC-4 | Event absent from scrape: `lastSeenAt` NOT updated; row retained in DB |
| EC-5 | Network error: E040 WARN logged; `scrape()` returns 0; no crash; no rows modified |
| EC-6 | HTTP 500: E041 WARN logged; same as EC-5 |
| EC-7 | Malformed HTML: 0 rows inserted; E042 WARN logged; no crash |
| EC-8 | Zero-event HTML: E042 WARN HIGH logged; `scrape()` returns 0; existing rows untouched |
| EC-9 | Event with no date: `startDate = null`, `endDate = null`; E043 WARN; row still inserted with null dates |
| EC-10 | Date range `"2026.05.10~2026.05.11"`: `startDate = "2026-05-10"`, `endDate = "2026-05-11"` |
| EC-11 | Migration on pre-existing DB: `CREATE TABLE IF NOT EXISTS` adds table; existing tables unaffected |
| EC-12 | `getUpcoming`: returns only events where `start_date >= today`, ASC order; past rows excluded |
| EC-13 | `searchByBand("Roselia")`: returns matching entries; case-insensitive; non-matching excluded |
| EC-14 | Trigger "Roselia live": `_hasBandoriLiveKeyword = true`; `liveBlock` injected into `userContent` |
| EC-15 | Trigger "今天吃啥": `_hasBandoriLiveKeyword = false`; `liveBlock` empty; `userContent` unchanged |
| EC-16 | 10 upcoming events in DB: only 3 rows injected via `getUpcoming(today, 3)` |
| EC-17 | `start()` returns synchronously; first scrape fires after 60s (verified via fake timers) |
| EC-18 | `BANDORI_SCRAPE_ENABLED=false`: `start()` logs disabled and returns; no timer set; `bandoriLiveRepo` undefined in `ChatModule`; no injection |
| EC-19 | `rawHash` identical across two calls with identical input (bands sorted in canonical JSON) |

Coverage target: >=80% line coverage for `src/modules/bandori-live-scraper.ts` and the `IBandoriLiveRepository` implementation. All 19 ECs mandatory before Reviewer sign-off.
