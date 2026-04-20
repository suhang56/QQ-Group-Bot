# Feature: R2a Emotive-Phrase Filter

## Why

`_buildOnDemandBlock` (chat.ts:3819) passes user messages through
`extractCandidateTerms → isValidStructuredTerm`. That predicate rejects grammar
fragments but passes pure-Han emotive phrases ("烦死了" / "不要烦") — valid Han
2-10 chars, no dirty-token hit. Gemini returns confidence=9 "meaning"; cached in
`learned_facts`; re-injected as "已知: 烦死了 = …" causing bot to fixate on 烦 theme.

Log evidence: `data/logs/bot-2026-04-20.log` 03:05–03:10, repeated 已知-block
injections from one emotive-venting session. North star: groupmates don't memorize
user frustration as jargon.

## Scope IN

1. **`src/utils/is-emotive-phrase.ts`** — pure predicate `isEmotivePhrase(term)`.
   Hard-pass ALLOWLIST: {笑死, 笑死我, 死鬼}. Rejects: exclamation (烦死了/气死了),
   intensifier (好烦/太无语), imperative (不要烦/别吵/不准烦). No DB or chat deps.
2. **`src/modules/chat.ts:3828`** — 1-line filter in `_buildOnDemandBlock` candidate
   chain: after `isValidStructuredTerm`, add `.filter(t => !isEmotivePhrase(t))`.
3. **`scripts/maintenance/purge-emotive-facts.ts`** — CLI tool, default dry-run,
   `--apply` required to write. Sets emotive on-demand rows to rejected status (no
   physical delete). Outputs affected row count.
4. **Tests**: is-emotive-phrase unit / candidate-filter integration /
   purge dry-run+apply fixture (vitest, no new deps).

## Out of scope

- `isValidStructuredTerm` — do NOT modify (its responsibility is grammar fragments)
- `extractCandidateTerms`, `on-demand-lookup` module, moderator, expression-learner,
  prompt templates, deflection, self-echo, direct dampener — untouched
- Runtime dampener for low-info repeat / self-echo / scope guard → R2.5, separate PR
- Physical delete from `learned_facts` — status flip only in purge script
- Any change to Gemini lookup confidence thresholds

## Acceptance criteria

- [ ] `isEmotivePhrase('烦死了')` → true; `isEmotivePhrase('笑死')` → false (ALLOWLIST)
- [ ] `_buildOnDemandBlock` with input "烦死了" produces empty candidate list (emotive filtered out)
- [ ] Existing valid jargon terms 'ykn' / 'lsycx' / '宿傩' / '120w' still pass filter unchanged
- [ ] Purge dry-run on fixture DB → logs count, zero rows modified
- [ ] Purge --apply on fixture DB → flips emotive on-demand rows to rejected; non-emotive rows untouched
- [ ] No physical delete from `learned_facts` in any code path
- [ ] `tsc` clean, `vitest` all pass

## Edge cases to test

- 笑死 / 笑死我 / 死鬼 → PASS (ALLOWLIST hard-pass)
- 烦死了 / 气死了 / 累死了 / 崩了 / 麻了 → REJECT (exclamation)
- 好烦 / 真累 / 太无语 / 最气 → REJECT (intensifier prefix)
- 不要烦 / 别吵 / 不准烦 / 别再闹 → REJECT (imperative negation)
- 单字 "烦" → predicate true; won't reach filter (isValidStructuredTerm len≥2 gate)
- 空字符串 / 空白 → false (no classification)
- ykn / lsycx / 宿傩 / 120w → PASS (not emotive shape)
- fandom names starting with 崩/麻 (e.g. 崩坏) → PASS; if corpus collision, add to ALLOWLIST

## Open questions for Designer

1. **Exact regex patterns** — user provided 3 templates (exclamation / intensifier /
   imperative); Designer finalizes anchoring, Unicode property escapes, and ordering.
2. **ALLOWLIST scope** — just {笑死, 笑死我, 死鬼} or broader? Designer decides based
   on corpus scan of false-positive candidates.
3. **Purge script schema** — does `learned_facts` use `status TEXT` or `is_active INTEGER`?
   Designer greps `src/storage/schema.sql` to confirm correct column + rejected sentinel value.
4. **Topic filter for purge** — target `topic LIKE 'ondemand-lookup:%'` rows only, or also
   empty-topic rows that originated from the on-demand path? Designer checks schema + log evidence.
