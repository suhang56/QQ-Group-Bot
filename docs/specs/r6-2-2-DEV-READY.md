# R6.2.2 DEV-READY — pretty-print CQ + sampler raw backfill

Codifies `r6-2-2-PLAN.md` + `r6-2-2-DESIGN-NOTE.md`. Developer follows this file for signatures, integration points, and acceptance.

Scope: CLI/scripts only. No `src/` runtime changes.

Schema verified: `messages.raw_content TEXT` exists at `src/storage/schema.sql:7` and `:275` (archive table). No migration needed.

---

## 1. New file — `scripts/eval/gold/pretty-cq.ts`

### Signature

```ts
export function prettyPrintCq(rawContent: string, botQQ: string | null): string;
```

Pure, no I/O, no imports beyond stdlib. Single caller → keep regex inline (per DESIGN §6).

### Algorithm (two-phase per DESIGN §1)

**Phase 1 — CQ walk.** Scan input with:

```ts
const CQ_RE = /\[CQ:([a-z]+)((?:,[^,\]]+=[^,\]]*)*)\]/g;
```

For each match, extract family + param blob, split params on `,`, split each pair on first `=`, build `Map<string,string>`. Emit per mapping table (§2). Non-matching text passes through unchanged.

**Phase 2 — entity decode** on the full emitted string (§3).

### §2. CQ family mapping (from DESIGN §1)

| family    | decision logic                                                                           | output                     |
|-----------|------------------------------------------------------------------------------------------|----------------------------|
| `at`      | `qq === botQQ && botQQ !== null`                                                          | `[@bot]`                   |
| `at`      | `qq === "all"`                                                                            | `[@全体]`                  |
| `at`      | otherwise                                                                                 | `[@user:<qq>]`             |
| `image`   | summary present, non-empty after decode+strip-surround-brackets                           | `[img:<summary>]`          |
| `image`   | summary missing OR empty after decode                                                     | `[img]`                    |
| `mface`   | summary present, non-empty                                                                | `[mface:<summary>]`        |
| `mface`   | summary missing OR empty                                                                  | `[mface]`                  |
| `face`    | `id` present                                                                              | `[face:<id>]`              |
| `face`    | `id` missing                                                                              | `[face]`                   |
| `reply`   | `id` present                                                                              | `[reply:<id>]`             |
| `reply`   | `id` missing                                                                              | `[reply]`                  |
| `video`   | —                                                                                         | `[video]`                  |
| `record`  | —                                                                                         | `[voice]`                  |
| **other** | any family not in list above (`forward`, `json`, `xml`, `share`, `location`, `rps`, etc) | `[cq:<family>]`            |

Summary inline-decode: the `summary` value arrives as `&#91;X&#93;`. Before using it, decode `&#91;`/`&#93;` then strip leading `[` and trailing `]` if both present (so output is `[img:X]` not `[img:[X]]`). If after decode+strip the result is empty, fall to the no-summary variant.

### §3. Phase-2 entity decode list + order (from DESIGN §3)

Applied sequentially on the whole output string:

```
1. &#91;  → [
2. &#93;  → ]
3. &#44;  → ,
4. &lt;   → <
5. &gt;   → >
6. &quot; → "
7. &amp;  → &        ← MUST BE LAST (prevents double-decode of &amp;#91;)
```

Implement as seven independent `.replace(/pattern/g, …)` calls in that order. Do NOT use an HTML entity library — 7 literals only.

### §4. Edge cases (must be test-covered)

- Empty input `""` → `""`.
- No CQ blocks → pass-through, still runs phase-2 decode (so free text entities decode too — per DESIGN §3 "scope" paragraph).
- Multiple CQ in one string → each replaced independently.
- Summary with empty brackets `&#91;&#93;` → treat as empty → `[img]`.
- `botQQ=null` → `[CQ:at,qq=N]` always → `[@user:N]`, never `[@bot]`.
- Malformed `[CQ:image` (no closing bracket) → regex won't match → left literal.
- Unknown family → `[cq:<family>]` lowercase, no params.

---

## 2. Renderer integration — `scripts/eval/gold/renderer.ts`

Today the renderer already reads `m.rawContent ?? m.content`. Three sites to wrap:

| site                       | current                                                          | updated                                                                           |
|----------------------------|------------------------------------------------------------------|-----------------------------------------------------------------------------------|
| L83 (context before)       | `truncate(m.rawContent ?? m.content, 60)`                        | `truncate(prettyPrintCq(m.rawContent ?? m.content, botQQ), 60)`                   |
| L87 (trigger)              | `truncate(sample.triggerRawContent ?? sample.triggerContent, 60)`| `truncate(prettyPrintCq(sample.triggerRawContent ?? sample.triggerContent, botQQ), 60)` |
| L92 (context after)        | `truncate(m.rawContent ?? m.content, 60)`                        | `truncate(prettyPrintCq(m.rawContent ?? m.content, botQQ), 60)`                   |

Pretty-print BEFORE truncate. Same transform for context and trigger (DESIGN §5). Inherit row color (DESIGN §4) — no added ANSI codes.

### Signature change

```ts
export function renderSample(
  sample: SampleRecord,
  state: LabelState,
  progress: Progress,
  botQQ: string | null,   // NEW
): void
```

Add `import { prettyPrintCq } from './pretty-cq.js';` at top.

### Caller update — `scripts/eval/gold/session.ts`

Single caller of `renderSample`. Thread a new `botQQ: string | null` through the session config. Source: CLI arg (existing) or env. If not provided, pass `null` (safe fallback per DESIGN §5 "Implementation note").

Grep the worktree for the `renderSample(` call site and add the arg.

---

## 3. Sampler change — `scripts/eval/sample-benchmark.ts`

### 3a. `fetchContext` (L128–151) — SELECT raw_content both branches

```sql
SELECT id, user_id, nickname, content, raw_content, timestamp
FROM messages
WHERE group_id = ? AND id < ? AND deleted = 0
ORDER BY id DESC LIMIT 5
```

Same addition to the `after` query (L142–148). The inline row type literal gains `raw_content: string | null`. The `.map(r => ({ … }))` adds `rawContent: r.raw_content`.

### 3b. `scripts/eval/types.ts` — `ContextMessage` gains non-optional `rawContent`

Per PLAN L30 + DESIGN "Alignment" bullet: `rawContent: string | null` is a REQUIRED property, not optional-key. Forces all producers to emit it.

Before (L53–59):
```ts
export interface ContextMessage {
  id: number;
  userId: string;
  nickname: string;
  content: string;
  timestamp: number;
}
```

After:
```ts
export interface ContextMessage {
  id: number;
  userId: string;
  nickname: string;
  content: string;
  rawContent: string | null;   // R6.2.2
  timestamp: number;
}
```

### 3c. Downstream callers of ContextMessage (grep confirms no-break)

- `scripts/eval/sample-benchmark.ts:123` `makeContextHash(content, contextBefore)` — reads `.content` only. Keep unchanged; do NOT fold `rawContent` into the hash (preserves R6.2 re-sample stability).
- `scripts/eval/gold/reader.ts:51` `mapContextMessage` — already dual-key guards (`rawContent`, `raw_content`); no change needed. The required field means new jsonl output always has it; old jsonl still falls through the `null` branch.
- `scripts/eval/weak-label.ts`, `scripts/eval/summary.ts` — read `row.content`/`row.rawContent` on `SampledRow`, not on `ContextMessage`. No change.

`SampledRow.rawContent: string | null` already exists (types.ts:70) — no change. `DbRow.raw_content: string | null` already exists (types.ts:155) — no change.

---

## 4. Test strategy

### 4a. New `test/eval/gold-pretty-cq.test.ts` (path per PLAN L24)

17-case flat table per DESIGN §7. Each row: `{ in: string, botQQ: string | null, out: string }`. Shape:

```ts
const cases: Array<{ in: string; botQQ: string | null; out: string }> = [
  { in: '[CQ:image,summary=&#91;动画表情&#93;,file=abc]', botQQ: null, out: '[img:动画表情]' },
  { in: '[CQ:image,file=abc]', botQQ: null, out: '[img]' },
  { in: '[CQ:mface,summary=&#91;哈哈&#93;,id=1]', botQQ: null, out: '[mface:哈哈]' },
  { in: '[CQ:mface,id=1]', botQQ: null, out: '[mface]' },
  { in: '[CQ:face,id=178]', botQQ: null, out: '[face:178]' },
  { in: '[CQ:at,qq=1705075399] 请我喝奶茶', botQQ: '1705075399', out: '[@bot] 请我喝奶茶' },
  { in: '[CQ:at,qq=1705075399]', botQQ: null, out: '[@user:1705075399]' },
  { in: '[CQ:at,qq=9999]', botQQ: '1705075399', out: '[@user:9999]' },
  { in: '[CQ:at,qq=all]', botQQ: null, out: '[@全体]' },
  { in: '[CQ:reply,id=42]', botQQ: null, out: '[reply:42]' },
  { in: '[CQ:video,file=x]', botQQ: null, out: '[video]' },
  { in: '[CQ:record,file=y]', botQQ: null, out: '[voice]' },
  { in: '[CQ:forward,id=q]', botQQ: null, out: '[cq:forward]' },
  { in: 'a&amp;b &#91;x&#93;', botQQ: null, out: 'a&b [x]' },
  { in: '[CQ:at,qq=1] hi [CQ:image,summary=&#91;pic&#93;,file=z] bye', botQQ: '1', out: '[@bot] hi [img:pic] bye' },
  { in: '', botQQ: null, out: '' },
  { in: 'hello world', botQQ: null, out: 'hello world' },
];
```

Iterate with `it.each(cases)(...)`. Add one extra assertion for the double-encode edge from DESIGN §7 closing note: `prettyPrintCq('&amp;#91;X&amp;#93;', null) === '&#91;X&#93;'` (shallow decode confirmation — `&amp;` runs last, so first pass produces `&#91;X&#93;` and the entity decode does not recurse). This validates the order-critical rule from §3.

### 4b. Integration — `test/eval/gold-label-cli.test.ts`

Add one case: feed a SampleRecord whose `triggerRawContent = '[CQ:image,summary=&#91;猫咪&#93;,file=abc] 看看'`. Capture stdout from `renderSample(sample, state, progress, null)`. Assert:
- stdout contains `[img:猫咪] 看看`
- stdout does NOT contain `[CQ:image`
- stdout does NOT contain `&#91;`

Also add an old-schema regression case (PLAN L31): feed a `contextBefore` row with no `rawContent` key — assert renderer falls through to `content`, no throw, no `undefined` leak.

### 4c. Sampler — `test/eval/sample-benchmark.test.ts`

Fixture INSERTs already have rows; confirm the in-memory schema declares `raw_content TEXT` (grep around L222 / L369 / L608 per PLAN). Add a row with `raw_content='[CQ:image,summary=&#91;X&#93;,file=y]'` that becomes a context neighbor of the sampled trigger. Assert:

```ts
expect(sampled.triggerContext[k].rawContent).toBe('[CQ:image,summary=&#91;X&#93;,file=y]');
```

Raw preserved — pretty-printing is render-time only.

---

## 5. Backward compatibility

- Old R6.2 / R6.2.1 jsonl where trigger has no `triggerRawContent` or context has no `rawContent`: reader `coerceSampleRecord` (L78–83) and `mapContextMessage` (L51–59) already null-coalesce. Renderer `m.rawContent ?? m.content` falls to stripped content; `prettyPrintCq` runs on it — no CQ left to find, so phase-1 is a no-op; phase-2 still runs entity decode (harmless on stripped content).
- New jsonl produced by the updated sampler carries `rawContent` on every context row, so pretty-print engages.
- Negative regression test (per PLAN L31) lives in `gold-label-cli.test.ts` as described in §4b.

---

## 6. Diff budget (≤100 lines per file per PLAN L34)

| file                                       | net ±lines    |
|--------------------------------------------|---------------|
| `scripts/eval/gold/pretty-cq.ts` (new)     | ~85           |
| `scripts/eval/gold/renderer.ts`            | ~6            |
| `scripts/eval/gold/session.ts`             | ~2            |
| `scripts/eval/sample-benchmark.ts`         | ~6            |
| `scripts/eval/types.ts`                    | ~1            |
| `test/eval/gold-pretty-cq.test.ts` (new)   | ~55           |
| `test/eval/gold-label-cli.test.ts`         | ~20           |
| `test/eval/sample-benchmark.test.ts`       | ~10           |

Every file ≤100 net lines.

---

## 7. Out of scope (enforce during review)

- LLM-aware reply preview resolution.
- Nickname lookup for non-bot `@user:N`.
- Re-running real DB sampling to regen `benchmark-weak-labeled.jsonl`.
- Any `src/` runtime change.
- Color tier for CQ tags (DESIGN §4 — row-color inheritance only).
- Line-wrapping long captions (DESIGN §2 — truncate-60 handles it).
- Additional entity beyond the seven in §3 (`&#39;`, `&nbsp;` etc — DESIGN §3 "Not included").

---

## 8. Acceptance gates (Reviewer)

1. `npm run typecheck` (= `tsc --noEmit`) green.
2. `npm test` full suite green — includes new `gold-pretty-cq.test.ts` 17+1 cases.
3. Spot-check output: render a captioned image sample and confirm `[img:caption text]` visible; render a multi-`@` row and confirm `[@bot]`/`[@user:N]` both appear; render an old-schema context row and confirm it still renders (falls through, no crash).
4. `git diff src/` returns empty (enforce zero src/ changes).
5. Diff per file ≤100 net lines.
6. These 4 assertions pass exactly (from PLAN L25–27, §4a row 1, 6, 8):
   - `prettyPrintCq("[CQ:image,summary=&#91;动画表情&#93;,file=abc123]", null) === "[img:动画表情]"`
   - `prettyPrintCq("[CQ:at,qq=1705075399] 请我喝奶茶", "1705075399") === "[@bot] 请我喝奶茶"`
   - `prettyPrintCq("[CQ:at,qq=999] hi", "1705075399") === "[@user:999] hi"`
   - `prettyPrintCq("a&amp;b &#91;x&#93;", null) === "a&b [x]"`

---

## 9. Developer implementation order (TDD per project rule)

1. Write `test/eval/gold-pretty-cq.test.ts` with all 18 cases (17 from table + double-encode). Confirm failing (no file yet).
2. Write `scripts/eval/gold/pretty-cq.ts`. Iterate until all green.
3. Update `scripts/eval/types.ts` `ContextMessage`.
4. Update `scripts/eval/sample-benchmark.ts` `fetchContext` + row mapper.
5. Update `test/eval/sample-benchmark.test.ts` fixture + assertion. Confirm green.
6. Update `scripts/eval/gold/renderer.ts` three sites + signature.
7. Update `scripts/eval/gold/session.ts` caller with botQQ.
8. Update `test/eval/gold-label-cli.test.ts` integration + old-schema regression.
9. `npm run typecheck && npm test` — must be green before handoff.
