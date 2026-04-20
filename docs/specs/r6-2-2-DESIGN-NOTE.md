# R6.2.2 CQ Pretty-Print — Design Note

Reference: Planner `r6-2-2-PLAN.md` (published 2026-04-20) + Task #2 open Qs.
This note resolves the five open design questions Planner deferred to Designer.

All examples assume input strings are OneBot/go-cqhttp CQ-code format as
stored in `message_history.raw_content`.

### Alignment with PLAN.md

- Signature `prettyPrintCq(rawContent: string, botQQ: string | null): string` — matches PLAN acceptance criteria line 23.
- Unknown-CQ fallback `[cq:<family>]` — matches PLAN Half A line 46.
- HTML entity decode runs AFTER CQ replacement — matches PLAN line 44.
- Entity list `&#91; &#93; &amp;` is PLAN minimum; Designer adds `&#44; &lt; &gt; &quot;` (see §3) as non-blocking extensions. Architect may drop extras if tests get noisy.
- `ContextMessage.rawContent: string | null` non-optional — matches PLAN line 53.

---

## 1. Final CQ Family Mapping Table

`prettyPrintCq(rawContent, botQQ)` transforms each CQ segment left-to-right,
non-matching text passes through unchanged. After **all** CQ segments are
rewritten, the whole string is HTML-entity-decoded (see §3). Truncation to 60
cols is applied by the caller (`renderer.ts`), AFTER pretty-print.

| CQ family | Input shape | Output | Notes |
|---|---|---|---|
| `at` | `[CQ:at,qq=<botQQ>]` | `[@bot]` | Compare qq param literally against `botQQ` arg (string eq). If `botQQ` is null, never rewrite as `[@bot]`. |
| `at` | `[CQ:at,qq=N]` (N ≠ botQQ) | `[@user:N]` | `N` is the raw qq number, no nickname resolve (out of scope per Planner). |
| `at` | `[CQ:at,qq=all]` | `[@全体]` | Common in group announcements. |
| `image` | `[CQ:image,summary=&#91;X&#93;,file=…]` | `[img:X]` | `X` = decoded summary text. If summary is `&#91;&#93;` (empty brackets) or missing, fall back to `[img]`. |
| `image` | `[CQ:image,file=…]` (no summary) | `[img]` | |
| `mface` | `[CQ:mface,summary=&#91;X&#93;,…]` | `[mface:X]` | Market sticker. Summary usually present (e.g. `[哈哈]`, `[加油]`). |
| `mface` | `[CQ:mface,id=…]` (no summary) | `[mface]` | |
| `face` | `[CQ:face,id=N]` | `[face:N]` | Classic QQ emoji index. Keep numeric — labeler can memorize common ones (178=lol, 0=微笑). |
| `reply` | `[CQ:reply,id=N]` | `[reply:N]` | Message-id reference. Resolving to preview deferred (out of scope). |
| `video` | `[CQ:video,file=…]` | `[video]` | |
| `record` | `[CQ:record,file=…]` | `[voice]` | Word "voice" is clearer than "record" for a labeler. |
| **unknown** | `[CQ:<family>,…]` | `[cq:<family>]` | Fallback per Planner PLAN.md §Half A: lowercase `cq:` prefix + family name, drop params. Prevents hex-id leak for families we haven't mapped yet (e.g. `forward`, `json`, `xml`, `share`, `location`). |

### Parameter parsing rules

- Params are `,`-separated `key=value` pairs. Values may contain `&#44;` for
  literal commas but in practice rarely do; split on `,` naively, accept the
  occasional edge case.
- Extract only the params we need per family (`qq`, `summary`, `id`). Ignore
  the rest (`file`, `url`, `subType`, `sub_type`, `type`, …).
- `summary` value arrives HTML-encoded (`&#91;动画表情&#93;`). Strip the
  surrounding `&#91;`/`&#93;` before emitting the inner label, then re-wrap
  with real `[` `]` in the output. This avoids "double brackets" like
  `[img:[动画表情]]`.

### Regex sketch (non-normative — Architect owns final form)

```ts
const CQ_RE = /\[CQ:([a-z]+)((?:,[^,\]]+=[^,\]]*)*)\]/g;
```

Match family + raw param list, then parse params with a second split. This
avoids lookbehind and handles missing params gracefully.

### Ordering matters

Pretty-print must run **before** HTML entity decode on the OUTER string,
because CQ-code brackets themselves are literal `[` `]` (never entity-encoded
in the outer wrapper — only param values are encoded). But the summary **value
we lift out** is entity-encoded, so we decode it when constructing the `[img:X]`
label.

Two-phase algorithm:

1. Walk `rawContent` with the CQ regex. For each match, parse params, decode
   summary/qq values as needed, emit `[label:value]`.
2. On the final emitted string, run the entity-decode pass (§3) to catch any
   stray `&amp;` / `&#91;` that survived in free text surrounding CQ blocks.

---

## 2. Long-Caption Handling — DO NOT line-break

**Decision**: let truncate-60 handle it. No line-breaking in the pretty-printer.

### Reasoning

The renderer's column layout (`renderer.ts:83,87,92`) is one message per line
with `ts + padEnd(12) user + truncate(content, 60)`. A two-line caption would
break that invariant and require layout-wide changes (line continuation
indent, vertical alignment of `>>>` markers, context/after padding). Net cost
outweighs benefit — a 40+ char image summary is rare, and when it happens
the labeler only needs to know "image with a long caption", not the full
caption, to decide gold label.

### What the labeler actually sees

Input: `[CQ:image,summary=&#91;这是一张很长的动图描述超过四十个字符的那种&#93;,file=abc] 大家看这个`

After pretty-print: `[img:这是一张很长的动图描述超过四十个字符的那种] 大家看这个`

After truncate-60: `[img:这是一张很长的动图描述超过四十个字符的那种] 大家…`

The `[img:...]` marker still signals "image content" even if the trailing
caption is truncated, which is the labeler-relevant signal.

### Guard for pathological cases

If `summary` text alone is >60 chars (rare), the entire pretty-printed prefix
would fill the row and the user's caption gets obliterated. Acceptable —
still strictly better than raw hex file-id eating 60 chars with zero
signal. No special case needed.

---

## 3. HTML Entity Decode List

Decode these entities in pretty-printer output. Order-independent.

| Entity | Decoded | Rationale |
|---|---|---|
| `&#91;` | `[` | Square bracket — used by OneBot to escape brackets inside param values. |
| `&#93;` | `]` | Paired with `&#91;`. |
| `&amp;` | `&` | Ampersand — must decode LAST (otherwise `&amp;#91;` would double-decode to `[`). |
| `&#44;` | `,` | Comma — used in param values that legitimately contain commas. |
| `&lt;` | `<` | Rare but seen in forwarded web URLs / xml segments. |
| `&gt;` | `>` | Paired with `&lt;`. |
| `&quot;` | `"` | Rare but appears in some forwarded json segments. |

### Decode order (IMPORTANT)

```
1. &#91; → [
2. &#93; → ]
3. &#44; → ,
4. &lt;  → <
5. &gt;  → >
6. &quot; → "
7. &amp; → &       ← MUST BE LAST
```

Why last: `&amp;` → `&`. If decoded first, any sequence like `&amp;lt;` in
the source (double-encoded) would turn into `&lt;` and then into `<`, when
the original intent may have been literal `&lt;`. Doing `&amp;` last is the
conventional "shallow decode" that matches how these sources emit the
entities in practice (single-encoded).

### Scope

Apply only inside pretty-printer output, NOT to the full raw_content
globally. If a message literally contained the string `&#91;` as user text
(unlikely), we still decode it — acceptable tradeoff for simpler code. The
labeler can spot the confusion from context.

### Not included

- `&#39;` (apostrophe), `&nbsp;` — not seen in real CQ payloads in this
  project's corpus. If they show up later, add them without breaking this
  interface.
- Full HTML entity table (hundreds of named entities). Overkill.

---

## 4. Color Coding — pretty-printed CQ tags stay in the row's base color

**Decision**: no dedicated color for `[img:X]` / `[@bot]` / etc. The
pretty-printed CQ tag inherits whatever color the surrounding row uses.

### Reasoning

- Context/after rows are already `C.dim` (gray). Making `[img:X]` dim too
  keeps the "this is background" signal intact. The user's caption text is
  also dim; nothing competes for attention.
- Trigger row is `C.boldYellow`. A `[img:X]` tag inside a trigger will appear
  in bold yellow, which is fine — the trigger block is meant to pop.
- Adding a third color tier (e.g. cyan for CQ tags) would triple-color the
  trigger row (yellow row + cyan tag + yellow user) and muddy the hierarchy.
- The visual structure of `[square brackets]` already signals "synthetic
  marker, not user text" — we don't need color to re-signal that.

### Exception (deferred — not this PR)

If future iteration adds a bot-self `[@bot]` marker that needs to stand out
(e.g. to make bot mentions instantly findable), switch ONLY that one tag to
`C.cyan` (matching the existing bot-nickname cyan convention, DESIGN-NOTE
§2). Not in R6.2.2 scope.

---

## 5. Context vs Trigger — same pretty-print, different ambient style

**Decision**: identical pretty-print transform for context, trigger, and
after. No special case.

### Reasoning

- The transform is semantic ("what does this CQ mean?"), not presentational.
  Context and trigger both need to tell the labeler the same thing: "there's
  an image here, captioned X".
- The visual distinction between context (dim) and trigger (bold yellow) is
  already carried by the row-level color scheme in renderer.ts. Pretty-print
  doesn't need to double-signal that.
- Same transform = same `prettyPrintCq` helper called from all three code
  paths in renderer.ts (lines 83, 87, 92 of current renderer). Single code
  path → fewer test cases, fewer drift risks.

### Implementation note for Architect/Developer

All three renderer call sites should read:

```ts
truncate(prettyPrintCq(m.rawContent ?? m.content, botQQ), 60)
```

`botQQ` is a new session-level parameter threaded from
`session.ts`/CLI arg. Default `null` when unknown — that case just means
`[CQ:at,qq=…]` always resolves to `[@user:N]` (never `[@bot]`), which is a
safe fallback for users running the tool on an archive from a different
bot account.

---

## 6. Open Questions for Architect

(None that block dev-ready. The following are Architect's call.)

- Should `prettyPrintCq` be pure (no deps) or accept a logger for unknown
  CQ families? Suggest: pure. Unknown families silently fall through to the
  `[family]` fallback; no logging needed in a read-only CLI tool.
- Does the CQ regex belong inlined in `pretty-cq.ts` or as a shared export?
  Suggest: inline. Only one caller. Ship simple.
- Test fixture shape: plain string pairs `{in, out, botQQ}`, or structured
  per-family blocks? Suggest: flat pairs. ~12–15 cases cover the table.

---

## 7. Test Coverage the Designer Wants to See

(Feeds Architect's DEV-READY acceptance list.)

Minimum cases in `test/eval/pretty-cq.test.ts`:

1. `[CQ:image,summary=&#91;动画表情&#93;,file=abc]` + null → `[img:动画表情]`
2. `[CQ:image,file=abc]` + null → `[img]`
3. `[CQ:mface,summary=&#91;哈哈&#93;,id=1]` + null → `[mface:哈哈]`
4. `[CQ:mface,id=1]` + null → `[mface]`
5. `[CQ:face,id=178]` + null → `[face:178]`
6. `[CQ:at,qq=1705075399] 请我喝奶茶` + `"1705075399"` → `[@bot] 请我喝奶茶`
7. `[CQ:at,qq=1705075399]` + null → `[@user:1705075399]` (botQQ null)
8. `[CQ:at,qq=9999]` + `"1705075399"` → `[@user:9999]`
9. `[CQ:at,qq=all]` + null → `[@全体]`
10. `[CQ:reply,id=42]` + null → `[reply:42]`
11. `[CQ:video,file=x]` + null → `[video]`
12. `[CQ:record,file=y]` + null → `[voice]`
13. `[CQ:forward,id=q]` + null → `[cq:forward]` (unknown-family fallback, per PLAN.md)
14. `a&amp;b &#91;x&#93;` + null → `a&b [x]` (entity decode on raw text)
15. Mixed: `[CQ:at,qq=1] hi [CQ:image,summary=&#91;pic&#93;,file=z] bye` +
    `"1"` → `[@bot] hi [img:pic] bye`
16. Empty string + null → empty string
17. String with no CQ codes `hello world` + null → `hello world` (passthrough)

Edge case to confirm with Architect:

- Double-encoded summary: `&amp;#91;X&amp;#93;` → should output `&#91;X&#93;`
  (shallow decode). Verify this is the actual corpus reality before asserting.

---

## Decision Summary (for Architect)

| Q | Decision |
|---|---|
| 1. Mapping table | Per §1 table above; unknown-family fallback = `[family]`. |
| 2. Long caption wrap | No line-break. Truncate-60 handles it. |
| 3. Entity list | `&#91; &#93; &#44; &lt; &gt; &quot; &amp;`. `&amp;` decoded LAST. |
| 4. Color of CQ tags | Inherit row color. No dedicated color tier. |
| 5. Context vs trigger | Identical transform. Visual differentiation is row-level, not per-tag. |

Ready for Architect DEV-READY.
