# DESIGN-NOTE: R2a Emotive-Phrase Filter

## Surface: Predicate — `src/utils/is-emotive-phrase.ts`

### Regex finals (anchored, Unicode mode)

```ts
// Hard-pass before any regex check
const EMOTIVE_ALLOWLIST = new Set(['笑死', '笑死我', '死鬼']);

// Exclamation: root + optional suffix
const EMOTIVE_EXCLAMATION_RE =
  /^(?:烦|气|累|困|哭|崩|麻|无语|烦死|气死|累死|困死|麻了|崩了)(?:了|死了|啊|呀|吧|呢|哦)?$/u;

// Intensifier: degree prefix + root + optional suffix
const EMOTIVE_INTENSIFIER_RE =
  /^(?:好|真|太|最|很)(?:烦|气|累|困|无语)(?:了|死了|啊|呀|吧|呢)?$/u;

// Imperative negation: prefix + up to 6 chars + emotive root (unanchored end)
const EMOTIVE_IMPERATIVE_RE =
  /^(?:不要|别|不准|别再).{0,6}(?:烦|吵|闹|说|回|叫|发|刷)/u;
```

### Predicate logic

```
isEmotivePhrase(term):
  if EMOTIVE_ALLOWLIST.has(term) → false
  if EXCLAMATION | INTENSIFIER | IMPERATIVE → true
  → false
```

### Edge case verification

| Term | Matched by | Result |
|---|---|---|
| 笑死 / 笑死我 / 死鬼 | ALLOWLIST | PASS |
| 烦死了 | EXCLAMATION (`烦死` + `了`) | REJECT |
| 气死了 / 累死了 | EXCLAMATION | REJECT |
| 崩了 / 麻了 | EXCLAMATION (root IS `崩了`/`麻了`) | REJECT |
| 好烦 / 真累 / 太无语 / 最气 | INTENSIFIER | REJECT |
| 不要烦 / 别吵 / 不准烦 / 别再闹 | IMPERATIVE | REJECT |
| 崩坏 | none (no suffix, not intensifier/imperative) | PASS |
| 麻弥 | none | PASS |
| ykn / lsycx / 宿傩 / 120w | none | PASS |

---

## Surface: Filter chain — `src/modules/chat.ts:3828`

```ts
// after existing isValidStructuredTerm filter:
candidates = candidates.filter(t => !isEmotivePhrase(t));
```

One line. No other changes to `_buildOnDemandBlock`.

---

## Surface: CLI — `scripts/maintenance/purge-emotive-facts.ts`

### Flags

| Flag | Required | Default | Notes |
|---|---|---|---|
| `--db-path <path>` | yes | — | absolute path to bot.db |
| `--apply` | no | dry-run | omit = dry-run, include = write |
| `--verbose` | no | false | print each affected row id + term |

### SQL target

```sql
-- Primary: structured on-demand rows
WHERE topic LIKE 'ondemand-lookup:%'
  AND status = 'active'
  AND isEmotivePhrase(extractTermFromTopic(topic))

-- No null-topic fallback: source_user_nickname='[ondemand-lookup]' rows
-- have topic=NULL only when isValidStructuredTerm rejected them at insert time.
-- Those rows never had a valid topic:term and can't be emotive in the target sense.
-- Single path keeps purge scope auditable.
```

### Write operation (--apply)

```sql
UPDATE learned_facts
SET status = 'rejected', updated_at = <now_sec>
WHERE id IN (<matched_ids>)
```

Status sentinel: `'rejected'` — consistent with `pending_moderation.status` and existing `meme_graph` convention.

### Output format (mirrors purge-honest-gaps-noise.ts)

```
[DRY RUN] Rows that would be updated:
  ondemand-lookup emotive: 14 found, 0 would update
  TOTAL: 14 found, 0 would update
```

With `--verbose`, append one line per row: `  [id=1234] 烦死了 (topic=ondemand-lookup:烦死了)`

### Pino log payload (for --apply path)

```ts
logger.info({ event: 'purge-emotive-facts', affectedIds: number[], dryRun: boolean }, 'purge complete');
```

---

## Surface: Schema — `learned_facts`

- Column: `status TEXT NOT NULL DEFAULT 'active'` (line 222, schema.sql) — confirmed.
- Sentinel for purge: `status = 'rejected'` — no new column, no physical delete.
- FTS5 `learned_facts_au` trigger fires on UPDATE, keeps FTS in sync automatically.

---

## Q-resolutions

1. **Regex** — finalized above. `崩了`/`麻了` are roots in EXCLAMATION_RE (not suffixes), so `崩坏`/`麻弥` are structurally safe: they don't match any pattern.
2. **ALLOWLIST** — corpus grep of `data/lore/958751334.md` found `崩坏三九年`, `麻弥` — neither is a false positive for the three regexes. ALLOWLIST stays {笑死, 笑死我, 死鬼} only.
3. **Purge schema** — `status TEXT` col, `'rejected'` sentinel. No `is_active` integer exists.
4. **Topic filter** — `topic LIKE 'ondemand-lookup:%'` only. Null-topic rows with `source_user_nickname='[ondemand-lookup]'` were already blocked by `isValidStructuredTerm` at insert time and are not emotive contamination vectors.
