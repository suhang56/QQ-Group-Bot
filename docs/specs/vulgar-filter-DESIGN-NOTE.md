# DESIGN-NOTE: R2.5.1-annex — Vulgar-Dismissal Filter + Purge

## Q-Resolution Table

| Q | Decision | Rationale |
|---|----------|-----------|
| Q1 Regex anchoring | Full exact-match `^(…)$` on extracted **term** (not raw input) | `_buildOnDemandBlock` receives already-tokenized term; full-match blocks `你懂个毛` standalone while `懂者自懂` (long-sentence embed) never becomes a bare term |
| Q2 Purge prefix scope | `ondemand-lookup:%` + `opus-classified:slang:%` + `opus-rest-classified:slang:%` | Same 3 auto-ingest prefixes as #107 / PR5; user-taught / lore: / 群内黑话: untouched |
| Q3 Lore allowlist | **No ALLOWLIST needed** — lore grep: zero exact matches for `懂个毛/屁/锤子`, `你个屁/傻/才傻`, `傻逼`, `二货`. `懂` in lore = `懂者自懂` / `zdjd`; `二` = `二次元`/`二选一` — never a bare dismissal term |
| Q4 Stem sharing | **New `src/utils/is-vulgar-dismissal.ts`** — separate family from `isEmotivePhrase` (emotive = 烦/累/崩; vulgar = 轻挑衅回怼); no cross-family stem sharing |

## Surface: `src/utils/is-vulgar-dismissal.ts`

```ts
// VULGAR_DISMISSAL_PATTERNS — exact term match only
const VULGAR_DISMISSAL_RE =
  /^(?:你?懂个(?:毛|屁|锤子|鬼|啥|蛋)|你(?:个|才)(?:屁|毛|傻|二|蠢)|去你的|滚你的|管你屁事)$/u;

export function isVulgarDismissal(term: unknown): boolean {
  if (typeof term !== 'string') return false;
  if (term.length === 0) return false;
  return VULGAR_DISMISSAL_RE.test(term);
}
```

- No `EMOTIVE_ALLOWLIST` import — separate family, no shared stem
- Empty / non-string guard mirrors `isEmotivePhrase` pattern
- `你?` optional: catches both `懂个毛` and `你懂个毛`

## Surface: `_buildOnDemandBlock` filter chain (chat.ts:4221)

```ts
candidates = candidates
  .filter(isValidStructuredTerm)
  .filter(t => !isEmotivePhrase(t))
  .filter(t => !isVulgarDismissal(t));  // R2.5.1-annex: vulgar-dismissal gate
```

## Surface: `scripts/maintenance/purge-vulgar-phrase-facts.ts`

- CLI: `--db-path <path>` required / `--apply` / `--verbose` (exact PR5 shape)
- SELECT: `status != 'rejected' AND (topic LIKE 'ondemand-lookup:%' OR topic LIKE 'opus-classified:slang:%' OR topic LIKE 'opus-rest-classified:slang:%') AND topic NOT LIKE '%lore:%'`
- UPDATE: `status='rejected'`, `updated_at=nowSec` — no DELETE
- Dry-run default; stdout format matches `purge-social-phrase-facts.ts` exactly
- Export `runPurge(opts)` + `PurgeResult` for testability (PR5 pattern)

## Must-NOT-fire verification

- `他懂个屁` → no `^` match (third-person prefix `他` not in regex) → pass ✓
- `你懂吗` → no trailing vulgar token → pass ✓
- `今天的演出真的懂个毛啊，是什么感觉` → long sentence never becomes bare term → pass ✓
- lore rows (topic contains `lore:`) → WHERE excludes unconditionally → pass ✓
