# Feature: R6.1 — Offline Benchmark Sampling + Auto Weak Labels

## Product Context

Post-v8 paradigm shift: the primary verification method for R2–R5 changes is no longer 24h real-group smoke but an offline replay harness. Before that harness (R6.3) can run, we need a representative benchmark dataset drawn from the live 58w-message DB.

R6.1 is **sub-phase 1 of 4** within R6. It produces the raw sample + automatically labeled dataset that every downstream phase consumes. No gold UI, no replay runner, no metrics aggregation — those are R6.2, R6.3, R6.4 respectively.

The deliverables are pure scripts that run locally against the production DB in read-only mode. No runtime code changes; no messages sent; no LLM calls.

## User Stories

- As a developer, I want a deterministic, reproducible benchmark so that running the sampling script twice with the same seed produces the same JSONL output.
- As a developer, I want stratified samples across 10 failure-mode categories so that no category dominates and rare failure modes are represented.
- As a developer pre-merging R2/R4/R5, I want weak labels (expectedAct, expectedDecision, riskFlags, boolean signals) on each sample so that I can score a batch of ChatResults against them without manual review.
- As a developer, I want a `data/eval/summary.json` showing per-category counts and duplicate rate so that I can spot coverage gaps before committing to a review cycle.

## Acceptance Criteria

- [ ] `scripts/eval/sample-benchmark.ts` exists and is runnable via `npx ts-node scripts/eval/sample-benchmark.ts --seed <N>`.
- [ ] Script reads only from `messages`, `learned_facts`, and `chat_decision_events` tables — zero writes to any table.
- [ ] Given the same `--seed` and DB state, two runs produce byte-identical `benchmark-raw.jsonl`.
- [ ] Output contains 2000–3000 samples, with 200–300 per category (10 categories total). Shortfall categories (< 100 available rows) are flagged in `summary.json` rather than failing silently.
- [ ] Each sample record conforms to the `BenchmarkSample` schema in `scripts/eval/types.ts`.
- [ ] `scripts/eval/weak-label.ts` reads `benchmark-raw.jsonl` and writes `benchmark-weak-labeled.jsonl` + `summary.json`.
- [ ] Every record in `benchmark-weak-labeled.jsonl` has a valid `WeakReplayLabel` field populated by pure rule-based logic (no LLM, no DB calls after initial seed).
- [ ] `hasRealFactHit` is set equal to `hasKnownFactTerm` in R6.1 (real hit detection requires running the chat path, available only in R6.3; this is explicitly documented in the schema comment).
- [ ] `riskFlags` array is non-null on every record; may be empty `[]`.
- [ ] `data/eval/` directory is added to `.gitignore` (`*.jsonl`, `*.json` under that path); `scripts/eval/` and `docs/eval/` remain committable.
- [ ] Small synthetic fixture (`test/eval/fixtures/sample-fixture.jsonl`, ≥10 rows covering all 10 categories) is committed and used in unit tests — NOT derived from production data.
- [ ] Unit tests cover: all 10 weak-label classifiers, seed determinism, dedup logic, per-category count enforcement.
- [ ] `npx tsc --noEmit` passes with no new errors.

## Scope

### Included

- `scripts/eval/sample-benchmark.ts`: stratified sampler with seed-based determinism.
- `scripts/eval/weak-label.ts`: rule-based labeler producing `WeakReplayLabel` on each sample.
- `scripts/eval/types.ts`: shared TypeScript interfaces (`BenchmarkSample`, `WeakReplayLabel`, category enum).
- `.gitignore` update: `data/eval/*.jsonl`, `data/eval/*.json`.
- `test/eval/` unit tests using synthetic fixtures (no production data).
- `docs/eval/schema.md`: field-level documentation including the `hasRealFactHit = hasKnownFactTerm` interim caveat.
- `data/eval/` directory placeholder (`.gitkeep` only, the JSONL files are gitignored).

### Explicitly NOT included

- R6.2: Human gold-label UI (web or CLI) — separate PR.
- R6.3: Replay runner that actually invokes the chat path and emits `ChatResult` — separate PR.
- R6.4: Metrics aggregation dashboard / A/B runner — separate PR.
- Any modification to `src/` (runtime code) — hard constraint.
- LLM calls of any kind.
- `data/eval/` JSONL files committed to git.
- Real-group canary or smoke testing for R6.1 (scripts + types only, benchmark risk level = low).

## Deliverable Files

```
scripts/eval/types.ts
scripts/eval/sample-benchmark.ts
scripts/eval/weak-label.ts
docs/eval/schema.md
test/eval/fixtures/sample-fixture.jsonl
test/eval/sample-benchmark.test.ts
test/eval/weak-label.test.ts
data/eval/.gitkeep          (runtime output, not committed)
data/eval/benchmark-raw.jsonl           (gitignored)
data/eval/benchmark-weak-labeled.jsonl  (gitignored)
data/eval/summary.json                  (gitignored)
```

## Sampling Design (what, not how)

### 10 Categories (failure-mode oriented)

| # | Category key | Trigger signal | Target N |
|---|---|---|---|
| 1 | `direct_at_bot` | `isAtBot=true` OR `messageType=reply-to-bot` | 200–300 |
| 2 | `known_fact_term` | trigger tokens overlap `learned_facts` canonical terms | 200–300 |
| 3 | `rhetorical_banter` | patterns like `啥情况/什么情况/怎么了/真的假的/草` without question mark intent | 200–300 |
| 4 | `image_object` | message contains image/mface CQ code | 200–300 |
| 5 | `bot_status_context` | trigger or preceding 5 msgs contain `小号/bot/机器人/被禁/策略/停机/重启` | 200–300 |
| 6 | `burst_non_direct` | 15s window with ≥5 messages, trigger is not @bot | 200–300 |
| 7 | `relay_repeater` | duplicate or near-duplicate content within 30s window in same group | 200–300 |
| 8 | `conflict_heat` | trigger contains insult/probe/curse patterns (configurable list) | 200–300 |
| 9 | `chime_in_candidate` | active topic (3+ speakers in 120s window), not direct, not burst | 200–300 |
| 10 | `silence_candidate` | stale topic (last msg >300s ago) OR single-speaker monologue with no entities | 200–300 |

### Context Window Per Sample

Each sample captures:
- The trigger message.
- Up to 20 preceding messages in the same group (within a 10-minute window).
- Up to 3 following messages (ground-truth human follow-up — used for future reply-effect proxy in R7, stored now).
- `isAtBot`, `isImage`, `groupId`, `triggeredAt` timestamp.

### Deduplication

- A message may match multiple categories; it is sampled into at most one (priority order: 1 > 2 > 5 > 7 > 6 > 8 > 4 > 3 > 9 > 10).
- Dedup on `messageId` across categories after priority assignment.

### Determinism Contract

- Sampler accepts `--seed <integer>` CLI flag.
- Internally uses a seeded PRNG (e.g. `seedrandom` or similar pure-JS package) to shuffle candidates before LIMIT.
- Alternatively: deterministic ORDER BY (primary key ASC) + consistent LIMIT + OFFSET derived from seed — acceptable if documented.
- The same seed on the same DB snapshot must produce the same output. Seed value and DB row count are written into `summary.json` for reproducibility audit.

## WeakReplayLabel Rules

All rules are pure functions over the sample record (trigger + context). No DB lookups at label time.

| Field | Rule |
|---|---|
| `expectedAct` | `isDirect` → `direct_chat`; `isRelay` → `relay`; `isObjectReact` → `object_react`; `isBotStatusContext` → `bot_status_query` or `meta_admin_status`; conflict patterns → `conflict_handle`; chime-in candidate → `chime_in`; silence candidate omitted (no act needed); fallback → `chime_in` |
| `expectedDecision` | `isDirect` → `reply`; `isBurst && !isDirect` → `defer`; silence candidate → `silent`; conflict → `reply`; otherwise → `reply` |
| `hasKnownFactTerm` | trigger tokens overlap with any `learned_facts.canonical` term loaded at sample time (snapshot, not re-queried per label) |
| `hasRealFactHit` | **set equal to `hasKnownFactTerm` in R6.1** — real hit requires running chat path (R6.3) |
| `allowPluralYou` | `true` only if ≥3 unique speakers in context window |
| `isObjectReact` | trigger contains image/mface CQ code AND CQ-stripped text ≤12 chars AND no `?/吗/什么/怎么/谁/哪/为什么` |
| `isBotStatusContext` | category 5 flag |
| `isBurst` | category 6 flag |
| `isRelay` | category 7 flag |
| `isDirect` | category 1 flag |
| `riskFlags` | bag of strings: `legacy-few-shot-possible` (short phrase, no entities), `ambiguous-target` (3+ speakers same second), `stale-topic` (last msg >300s), `possible-jailbreak` (known jailbreak substrings in trigger), `has-url` (trigger contains URL) |

## BenchmarkSample Schema

Defined in `scripts/eval/types.ts`. Key fields:

```
sampleId        string          deterministic: sha1(groupId + messageId + seed)
category        CategoryKey     one of the 10 keys above
groupId         string
triggerId       string          source messageId of trigger
triggerContent  string          raw content (CQ codes intact)
triggerAt       number          unix seconds
contextMsgs     ContextMsg[]    up to 20 preceding messages
followUpMsgs    ContextMsg[]    up to 3 following messages
isAtBot         boolean
isImage         boolean
label           WeakReplayLabel populated by weak-label.ts; undefined in benchmark-raw.jsonl
```

`ContextMsg`: `{ messageId, senderId, content, timestamp, isAtBot }`.

## Edge Cases to Test

- Category 4 (image): message with `[CQ:image,...]` but long caption (>12 chars stripped) — should NOT be `isObjectReact=true`.
- Category 2 (fact term): trigger token is substring of a canonical but not equal — should NOT set `hasKnownFactTerm=true` (structural key match, not substring per feedback_fact_match_by_structural_key_not_substring.md).
- Category 6 (burst): exactly 5 messages in 15s window — boundary inclusion (≥5 = burst).
- Category 10 (silence): single speaker with 10 messages (monologue) — should be `silence_candidate`.
- Message matching multiple categories — dedup assigns to highest-priority category only.
- Group with <100 qualifying rows for a category — summary.json shows `gap: true` for that category, script does not fail.
- Seed reproducibility: run twice with same seed on same fixture, output identical.
- `hasRealFactHit` = `hasKnownFactTerm` capped at R6.1 — verified in schema test.
- `riskFlags`: message containing URL → `has-url` present; clean message → `[]`.
- CQ-strip for `isObjectReact`: `[CQ:image,url=...][CQ:at,qq=123]加油` → stripped = `加油` (2 chars) → `isObjectReact=true`.

## Open Questions (for Architect/Developer to resolve)

1. Which DB client / connection pattern does this project use for scripts (raw `better-sqlite3`, Kysely, Drizzle)? Architect should match the existing pattern in `scripts/`.
2. Does `learned_facts` have a snapshot-safe query (e.g., `WHERE active=1 AND rejected=0`)? Confirm exact column names.
3. `--seed` flag: pure seeded-PRNG shuffle vs. deterministic ORDER BY + LIMIT? Architect picks based on performance on 58w rows.
4. `test/eval/` — does the project already have a `vitest.config.ts` that auto-discovers `test/**/*.test.ts`? If yes, no config change needed.
5. `data/eval/.gitkeep` — confirm `.gitkeep` convention is already used elsewhere in repo, or use `README.md` placeholder instead.
