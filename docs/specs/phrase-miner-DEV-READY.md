# DEV-READY: phrase-miner-skip-bot-output (PR3)

Write-time filter across 4 learners + conservative purge script (`learned_facts` only per Designer Q1).

## 1. File changes

**MODIFY**
- `src/modules/phrase-miner.ts` — add `botUserId?: string` to options + constructor field; filter at `extractCandidatesFromMessages` loop head (line 94).
- `src/modules/jargon-miner.ts` — add `botUserId?: string` to options + constructor field; filter at `extractCandidatesFromMessages` loop head (line 262).
- `src/modules/meme-clusterer.ts` — add `botUserId?: string` to options + constructor field; filter at `_gatherUnpromoted` rowToCandidate reads — **row-level filter via `contexts[*].user_id`** (`jargon_candidates.contexts` is JSON list with `user_id`; a row dominated by botUserId contexts is bot-authored).
- `src/modules/self-learning.ts` — **no change** per Designer flag resolution (see §4).
- `src/index.ts:497,503,467` — pass `botUserId` into all three miner constructors (value already in scope at line 174: `process.env['BOT_QQ_ID']`).

**NEW**
- `scripts/maintenance/purge-bot-output-phrases.ts` — CLI purge (`learned_facts` only).

**NEW tests** (vitest, `test/modules/` + `test/scripts/`)
- `test/modules/phrase-miner-bot-skip.test.ts`
- `test/modules/jargon-miner-bot-skip.test.ts`
- `test/modules/meme-clusterer-bot-skip.test.ts`
- `test/modules/self-learning-bot-skip.test.ts` — regression: existing guard at line 242 covers `insertOrSupersede`.
- `test/scripts/purge-bot-output-phrases.test.ts`

## 2. TypeScript signatures

Every learner adds `botUserId?: string` to its options interface + private field (mirror existing `self-learning.ts:176` pattern).

```ts
// phrase-miner.ts — constructor + extractCandidatesFromMessages (line 91)
readonly botUserId: string | undefined;  // field
// in constructor: this.botUserId = opts.botUserId;
extractCandidatesFromMessages(groupId, msgs) {
  for (const msg of msgs) {
    if (this.botUserId !== undefined && msg.userId === this.botUserId) continue;  // ADD
    const cleaned = msg.content.replace(CQ_CODE_RE, ' ');
    ...
  }
}
```

```ts
// jargon-miner.ts — same guard at loop head of extractCandidatesFromMessages (line 262)
for (const msg of msgs) {
  if (this.botUserId !== undefined && msg.userId === this.botUserId) continue;  // ADD
  const cleaned = msg.content.replace(CQ_CODE_RE, ' ');
  ...
}
```

```ts
// meme-clusterer.ts — filter row if >=50% of contexts are bot-authored
// in _gatherUnpromoted, after rowToCandidate / context parse, before results.push():
const isBotDominated = this.botUserId !== undefined
  && contexts.length > 0
  && contexts.filter(c => c.user_id === this.botUserId).length * 2 >= contexts.length;
if (isBotDominated) continue;
```

```ts
// purge script — matches #107 precedent (CLI signature identical)
interface Args { dbPath: string; apply: boolean; verbose: boolean; }
function parseArgs(argv: string[]): Args;
function findBotRows(db, botUserId): Array<{id; topic; fact; status}>;
function applyReject(db, ids: number[]): void;  // BEGIN/COMMIT, UPDATE status='rejected'
```

## 3. SQL queries

Schema verified (grep schema.sql:212–230):
- `learned_facts.source_user_id TEXT` ✓ nullable, scalar TEXT (line 217)
- `learned_facts.status TEXT` ✓ default 'active' (line 222)
- `learned_facts_au` trigger at line 261–266 auto-syncs FTS5 on UPDATE — no manual FTS rebuild

```sql
-- Select bot-authored rows (dry-run enumeration)
SELECT id, topic, fact, status FROM learned_facts
WHERE source_user_id = ? AND status != 'rejected';

-- Apply pass (inside BEGIN/COMMIT)
UPDATE learned_facts SET status = 'rejected', updated_at = ?
WHERE id = ?;
```

Required CLI arg: `--bot-user-id <id>` OR env `BOT_QQ_ID`; exit 2 if neither set (defense: 宁漏不错).

## 4. Integration — per-learner line refs

**phrase-miner.ts:94** — loop head of `extractCandidatesFromMessages`:
```diff
  for (const msg of msgs) {
+   if (this.botUserId !== undefined && msg.userId === this.botUserId) continue;
    const cleaned = msg.content.replace(CQ_CODE_RE, ' ');
```

**jargon-miner.ts:262** — same pattern at loop head:
```diff
  for (const msg of msgs) {
+   if (this.botUserId !== undefined && msg.userId === this.botUserId) continue;
    const cleaned = msg.content.replace(CQ_CODE_RE, ' ');
```

**meme-clusterer.ts:148** — after `rowToCandidate` contexts parse, before `results.push`:
```diff
  for (const row of jargonRows) {
    if (!row.meaning) continue;
    let contexts: string[] = [];
    try { contexts = JSON.parse(row.contexts); } catch { /* empty */ }
+   // Filter rows where >= 50% of contexts are bot-authored (jargon_candidates.contexts
+   // is JSON list of {user_id, content}; row-level filter since no scalar bot-source field)
+   if (this.botUserId !== undefined && contexts.length > 0) {
+     const botCount = (contexts as any[]).filter(c =>
+       typeof c === 'object' && c !== null && c.user_id === this.botUserId).length;
+     if (botCount * 2 >= contexts.length) continue;
+   }
    results.push({ ... source: 'jargon', ... });
  }
```

**self-learning.ts — Designer flag resolution**

Verified with grep `insertOrSupersede|sourceUserId` on file:
- **Line 242 guard** (`detectCorrection`) — `return null` at line 244; `insertOrSupersede` call is at **line 277**, AFTER the guard, INSIDE same function. Guard is on correct code path. ✓
- **Line 331 call** (`harvestPassiveKnowledge`, line 301 entry) — `sourceUserId: null` hardcoded. Not bot-authored by identity; this is distillation of user followups. Per Designer Q2: SKIP (no guard needed).
- **Line 827 call** (`researchOnline`, outside bot-message path) — `sourceUserId: null` hardcoded. Bot-internal fetch from web. Per Designer Q2: SKIP.

**Bot-reachable write paths**: only `detectCorrection`; guard already covers it. **No code change in self-learning.ts**. Add regression test only.

**Integration wiring** — `src/index.ts:467,497,503` add `botUserId` prop:
```ts
const jargonMiner = new JargonMiner({ ...existing, botUserId });
const phraseMiner = new PhraseMiner({ ...existing, botUserId });
const memeClusterer = new MemeClusterer({ ...existing, botUserId });
```

No schema migration (column exists). No ALTER.

## 5. Test contract (vitest)

**Must-fire** (each learner, spy on DB insert / repo.upsert):
- `phrase-miner`: inject 10 msgs with userId='user-1' → `repo.upsert` called ≥1 time.
- `phrase-miner`: inject 10 msgs with userId=botUserId → `repo.upsert` called 0 times.
- `jargon-miner`: same fixture shape, assert `INSERT INTO jargon_candidates` execution count 0 for bot path.
- `meme-clusterer`: seed `jargon_candidates` row with `contexts=[{user_id:botId,content:'...'}×3]`, `is_jargon=1`, `promoted=0` → `clusterAll` does not promote (neither `memeGraph.insert` nor `_addVariant` fires).
- `self-learning`: inject `correctionMsg` with `userId=botUserId` → `detectCorrection` returns `null`, `learnedFacts.insertOrSupersede` spy called 0 times. (regression guard on line 242 path.)

**Must-NOT-fire** (per PLAN ≥7):
1. `botUserId` undefined (no env) → all 4 learners process user msgs normally; 0 regressions (baseline 3914).
2. `botUserId` = `''` (empty string env) → filter no-op (msg.userId can be '' for legacy rows; conservative: guard is `!== undefined`, not truthy; empty string WILL match empty userId — spec: also skip when `botUserId === ''` via `if (this.botUserId && msg.userId === this.botUserId)`). **Decision**: use truthy guard `if (this.botUserId && ...)` to avoid empty-string footgun.
3. `msg.userId === null` (historical imports) → treated as non-bot; write proceeds.
4. User msg containing bot nickname text (e.g. `'@bot 别烦我'` plain text) → nickname ≠ userId; writes normally.
5. `meme_graph` / `groupmate_expression_samples` tables → purge script skips + logs `skipped: <table>`.
6. Purge dry-run (default) → 0 `UPDATE` statements executed (assert via `db.prepare` spy).
7. Purge `--apply` → only rows with `source_user_id = botUserId` flipped to `status='rejected'`; user-source rows UNCHANGED (before/after `SELECT COUNT` assertions).
8. `jargon_candidates` row with MIXED contexts (3 bot, 3 user) → `botCount*2 >= contexts.length` = 6 >= 6 → filtered (conservative: >=50% bot). Edge: 2 bot / 4 user → 4 < 6 → keeps. Document in test.

Fixture DB setup: create in-memory `DatabaseSync(':memory:')`, apply `schema.sql`, seed with both bot and user rows.

## 6. Acceptance + Reviewer spot-checks

**Dev raw paste**:
- `npx tsc --noEmit` × 2 (clean)
- `npx vitest run test/modules/phrase-miner-bot-skip.test.ts test/modules/jargon-miner-bot-skip.test.ts test/modules/meme-clusterer-bot-skip.test.ts test/modules/self-learning-bot-skip.test.ts test/scripts/purge-bot-output-phrases.test.ts` (all pass)
- `npx vitest run` full suite — new tests + 3914 baseline pass
- Purge dry-run on `/tmp/bot.db` copy → prints `N found, 0 would update` + `skipped: jargon_candidates, phrase_candidates, meme_graph, groupmate_expression_samples`
- Purge `--apply` on copy → bot rows flipped; re-run dry-run shows 0 found; user-source rows intact (`SELECT COUNT WHERE source_user_id=<user>` unchanged)
- Replay: no regress on `sticker-token-leak` / `hard-gate-blocked` / `direct-at-silenced-by-timing` / `silence_defer_compliance`

**Reviewer 3 spot-checks** (write into Reviewer task desc):
1. **Filter-at-write coverage**: `grep -n "msg.userId === this.botUserId" src/modules/{phrase,jargon}-miner.ts` returns ≥1 hit per file; `grep -n "user_id === this.botUserId" src/modules/meme-clusterer.ts` returns ≥1 hit.
2. **Purge script safety**: `grep -c "DELETE FROM" scripts/maintenance/purge-bot-output-phrases.ts` = **0** (UPDATE-only, no hard DELETE); default dry-run path (no `--apply`) executes 0 `UPDATE` statements; `grep "learned_facts"` in script shows it's the ONLY table touched.
3. **Designer flag**: `self-learning.ts` diff is empty OR test-only. Grep `insertOrSupersede` in self-learning.ts shows 3 call sites (lines 277/331/827); verify: line 277 is preceded by line 242 guard (`return null`), lines 331/827 hardcode `sourceUserId: null` (not bot-authored by identity). `test/modules/self-learning-bot-skip.test.ts` asserts guard covers line 277 path.

## Open questions resolved
- Q: meme_graph filter — A: row-level via contexts JSON (≥50% bot-authored), since no scalar source field per Designer.
- Q: botUserId empty string — A: truthy guard `if (this.botUserId && msg.userId === this.botUserId)` to avoid `''===''` footgun on legacy null userId.
- Q: self-learning scope — A: no code change; existing line 242 guard is on correct path (grep-verified 3 insertOrSupersede call sites).
- Q: purge script arg — A: `--bot-user-id <id>` required OR `BOT_QQ_ID` env fallback; exit 2 if missing.
