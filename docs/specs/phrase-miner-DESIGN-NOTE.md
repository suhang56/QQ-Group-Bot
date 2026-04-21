# DESIGN-NOTE: phrase-miner-skip-bot-output (PR3)

## Q1: Schema — bot-source field audit

| Table | Has source field | Field name | Decision |
|---|---|---|---|
| `learned_facts` | YES | `source_user_id TEXT` | filter write + purge |
| `jargon_candidates` | NO | — (contexts JSON has `user_id` per entry) | skip purge; filter write via `msg.userId` |
| `phrase_candidates` | NO | — (no user_id column) | skip purge; filter write via `msg.userId` |
| `meme_graph` | YES (nullable) | `origin_user_id TEXT` | skip purge (origin is incidental, demote by `status` not purge) |
| `groupmate_expression_samples` | YES (JSON list) | `speaker_user_ids TEXT` | skip purge (JSON array, no per-row bot-only flag) |

**Purge scope: `learned_facts` only** (sole table with a single scalar bot-source field).

## Q2: self-learning sub-pipelines

| Sub-pipeline | Method | source_user_id written | Filter needed |
|---|---|---|---|
| Correction | `detectCorrection()` | `correctionMsg.userId` | YES — already guards `=== botUserId` at line 242; **confirm guard covers insertOrSupersede** |
| Passive harvest | `harvestPassiveKnowledge()` | `null` (sourceUserId hardcoded null) | NO — not bot-authored; skip |
| Online research | `researchOnline()` | `null` (sourceUserId hardcoded null) | NO — bot-internal fetch; skip |

## Q3: Read-path filter — scope decision

**Write-path only this PR.** Purge clears existing bot-authored rows. Read-path filter is future work; not needed once write gate blocks new rows.

## Q4: Group-scoped purge

**Purge all groups.** bot `userId` is globally unique; no group scoping needed.

## Q5: FTS5 trigger sync

`learned_facts_au` trigger at schema.sql:261–266 auto-syncs FTS5 on UPDATE. Setting `status='rejected'` fires the trigger; FTS5 index updated automatically. No manual FTS sync needed. No other learner table has a paired FTS5 virtual table.

---

## Write-time filter pattern

```ts
// phrase-miner.ts — extractCandidatesFromMessages
for (const msg of msgs) {
  if (msg.userId === botUserId) continue;   // <-- add
  ...
}

// jargon-miner.ts — _upsertCandidate call site
if (msg.userId === this.botUserId) continue;  // before _upsertCandidate

// self-learning.ts — detectCorrection already guards line 242; no change
```

## Purge CLI design (matches purge-emotive-facts.ts)

```
purge-bot-facts.ts --db-path <path> [--apply] [--verbose]
```

- `--db-path` required; exits 2 on missing
- dry-run output:
  ```
  [DRY RUN] Rows that would be updated:
    learned_facts (source_user_id = '<botId>'): N found, 0 would update
  Skipped tables: jargon_candidates (no bot-source field)
                  phrase_candidates (no bot-source field)
                  meme_graph (no scalar bot-source field)
                  groupmate_expression_samples (no scalar bot-source field)
  TOTAL: N found, 0 would update
  ```
- `--apply`: `UPDATE learned_facts SET status='rejected', updated_at=<nowSec> WHERE source_user_id=?`
- FTS5 syncs automatically via `learned_facts_au` trigger
- transact in one BEGIN/COMMIT block; ROLLBACK on error
