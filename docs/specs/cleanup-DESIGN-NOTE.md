# DESIGN-NOTE: legacy-classifier-junk purge

## Surface: CLI (scripts/maintenance/purge-legacy-classifier-junk.ts)

### CLI interface (mirrors PR5/PR#114 precedent)
- `--db-path <path>` required
- `--target 1|2|3|all` required
- `--apply` flag (dry-run default)
- `--verbose` flag
- Exit codes: 0 success, 1 runtime error, 2 bad args

### Target SQL WHERE clauses

**Target 1** (opus-ext-classified dead):
```sql
WHERE status = 'active'
  AND topic LIKE 'opus-ext-classified:%' ESCAPE '!'
```

**Target 2** (batch-harvest junk):
```sql
WHERE status = 'active'
  AND (source_user_nickname LIKE '[harvest:%' ESCAPE '!'
    OR source_user_nickname LIKE '[deep-tune:%' ESCAPE '!')
  AND topic NOT LIKE '群友别名%' ESCAPE '!'
  AND topic NOT LIKE '%lore:%' ESCAPE '!'
```

**Target 3** (opus-classified:slang dedup + noise):
```sql
WHERE status = 'active'
  AND topic LIKE 'opus-classified:slang:%' ESCAPE '!'
  AND topic NOT LIKE '%lore:%' ESCAPE '!'
```

### Dedup key & normalization
- Key: `term.trim().toLowerCase()` (ASCII only — no 繁→簡, scope out)
- Group by key; select winner per group

### Dedup tiebreaker (deterministic order)
| Priority | Rule |
|----------|------|
| 1 | Lexical preference: `NB`>`nb`, `哦耶`>`欧耶`, `到底是什么感觉`>`是什么感觉` |
| 2 | `occurrence_count` DESC |
| 3 | `speaker_count` DESC |
| 4 | `id` DESC |

- Conservative: if 2 rows both miss lexical table AND all counts tied → keep highest `id`

### Noise list (hardcoded, no CLI arg)
```ts
const OPUS_SLANG_NOISE_LIST = ['yes', '周六'];
```
- Noise terms → reject regardless of dedup winner status

### Output format (plain text stderr, mirrors PR5)
```
[DRY RUN] Rows that would be updated:
  Target 1 (opus-ext-classified dead): 467 found, 467 would update
  Target 2 (batch-harvest junk): 943 found, 943 would update
    (skipped [alias-miner]: 0 rows — preserved)
  Target 3 (opus-classified:slang dedup + noise): 8 found, 5 would update
    Kept winners: [NB, 哦耶, 到底是什么感觉]
    Rejected: [nb(4499), 欧耶(4487), 是什么感觉(4481), yes(4478), 周六(4520)]
TOTAL: 1418 found, 1415 would update
```

### Conflicts with existing convention
- NONE — SQL UPDATE only `status='rejected'`; no new columns; no FTS5 trigger changes
