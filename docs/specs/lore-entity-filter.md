# Feature: Entity-Filtered Lore Injection

## Problem Statement

**Root cause of `mhy` → `mmhyw` bug:**
- User sent `mhy` (meant 米哈游/MiHoYo).
- `_loadLoreFallback` injected the entire `data/lore/958751334.md` (~658 lines) into the system prompt.
- The meme table at line 136 lists `hyw / mmhyw / ohnmmhyw / onmmhyw` as "群第一高频反应词".
- LLM saw `mhy`, fuzzy-matched to the dense `hyw` alias cluster, and parroted `mmhyw`.

**Structural cause:** The fallback path treats lore as a static blob. It has no awareness of what the query is about. Any short token can accidentally overlap with a meme alias in a 15,000-char document.

---

## User Stories

- As a group member, when I mention a person or topic, I want the bot to have relevant lore context — not the entire meme dictionary.
- As a group member, when I send a short or ambiguous message, I want the bot to use its identity core, not try to match my input against every known alias.
- As the operator, I want this to be always-on — no toggle, no command needed.

---

## Acceptance Criteria

- [ ] When a user message contains a named entity (person, band, term) that exists in the lore, only lore chunks relevant to that entity are injected.
- [ ] When no entity matches (e.g. `mhy`, sticker-only, poke), bot receives only the identity core — not the full meme table.
- [ ] Identity core is ≤ 800 chars: group description + bot-self section from lore header, no meme rows.
- [ ] Multi-entity queries inject chunks for all matched entities, subject to token cap.
- [ ] Total injected lore stays within current cap (8,000 chars for monolithic fallback path).
- [ ] Bandori-live factual injection path is unaffected.
- [ ] `loreKw` trigger scoring continues to work (still fires on keyword match for participation probability).
- [ ] No new admin commands, config flags, or per-group toggles.

---

## Scope

**In:**
- Entity extraction from trigger message + last N=5 context messages.
- Chunk-level filtering of `data/lore/{groupId}.md` using the existing `.chunks.jsonl` index.
- Alias/short-form matching: entries in `.chunks.jsonl` carry a `summary` field; extract entity names from chunk headers and match against query tokens.
- Identity core fallback for zero-match queries.
- Logging of which chunks were injected (for debugging future regressions).

**Out:**
- Re-embedding or re-chunking the lore file.
- Changing the embedding model or vector similarity math.
- UI, admin commands, per-group feature flags.
- Modifying the per-member directory path (`data/groups/{groupId}/lore/`) — that path already filters by member; this spec only addresses the monolithic fallback.
- Changing the `loreKw` participation scoring logic (it can keep using the full token set).

---

## Entity Extraction Strategy

**What counts as an entity:**
- Nickname/alias tokens from the query message and last 5 context messages.
- Match against a pre-built alias map constructed from the lore chunks.

**Alias map construction (built once, cached per group):**
Parse `{groupId}.md.chunks.jsonl`. Each line is a JSON object with at least `{ chunkIndex, summary }`. From each chunk's `summary` (which is a condensed version of the chunk), extract:
- All `**bold**` tokens — these are the primary names and aliases.
- Slash-separated variant clusters: `hyw / 何意味 / mmhyw / ohnmmhyw` → all map to the same chunk.
- CJK runs ≥ 2 chars, Latin runs ≥ 2 chars, and mixed abbreviations ≥ 2 chars.
- Single-character tokens are always excluded from the alias map.

**Minimum token length for entity matching: 2 chars.**

**Matching:**
- Tokenize the query using the existing `tokenizeLore()` function (already handles CJK runs + Latin).
- For each token of length ≥ 2: check if it appears as a key in the alias map.
- A match = the chunk index that alias maps to.

**Short-token guard (3-letter/numeric tokens like `mhy`, `ras`, `bot`):**
- Tokens of length 2–3 are matched only if they appear verbatim as a documented alias in the chunk's alias list, not via substring/fuzzy match.
- Tokens of length ≥ 4 may use substring containment within an alias entry.
- This prevents `mhy` from matching `mmhyw` because `mhy` is not a listed alias — only `hyw`, `mmhyw`, etc. are.

---

## Retrieval Flow

```
1. Build alias map from {groupId}.md.chunks.jsonl (cache per group, invalidate with loreCache)
2. Extract tokens from: trigger message + last 5 context messages (nicknames + content)
3. Match tokens against alias map → collect matched chunk indices
4. If matched chunks > 0:
   a. Always prepend identity core (≤ 800 chars)
   b. Add matched chunks in order, stopping at 8,000 char cap
   c. If multiple aliases point to same chunk → deduplicate
5. If matched chunks = 0:
   a. Return identity core only (≤ 800 chars)
6. Cache result as current loreCache entry for this group+query cycle
7. Log: { groupId, matchedChunks: [...indices], totalChars, fallbackUsed: bool }
```

**No semantic/vector search.** Matching is alias-exact (as described above). The existing `.chunks.jsonl` is used purely as a structured alias index, not for embedding retrieval. This keeps the retrieval synchronous and avoids adding a vector DB dependency.

---

## Identity Core

The identity core is a minimal, always-injected subset for zero-match queries. It should answer: "Who are you and what is this group?"

Derive it from the lore file header (first chunk in `chunks.jsonl`, which contains the group-level description paragraph). Target: ≤ 800 chars.

**Identity core contents:**
- Group identity paragraph (1–2 sentences: 北美炸梦同好会, 留学生社群, 邦多利/Love Live 内核).
- Bot self-description: "戸山香澄 AI bot, 西瓜部署, 女同, 攻击性强" — so the bot knows who it is even with no lore context.

**Identity core does NOT include:**
- The meme/slang table.
- Any member profiles.
- BanG Dream terminology dictionary.

The identity core is hardcoded as a curated excerpt, not dynamically extracted each call. It is written once by the developer from the existing lore file content and stored as a constant or a dedicated `_identity_core.md` file in the lore directory.

---

## Token Budget

| Component | Target size |
|-----------|-------------|
| Identity core (always) | ≤ 800 chars |
| Matched lore chunks | ≤ 7,200 chars (to stay within 8,000 total) |
| **Total injected** | **≤ 8,000 chars** |

This matches the current `TOTAL_CAP = 8000` used by `_loadRelevantLoreFromDir`. The monolithic fallback currently injects up to `loreSizeCapBytes` (likely 15KB+). This spec reduces that significantly for non-matching queries.

---

## Fallback Behavior Decision Tree

```
Query arrives
  ├─ Has per-member lore dir? → use existing _loadRelevantLoreFromDir (unchanged)
  └─ Uses monolithic file?
       ├─ chunks.jsonl exists?
       │    ├─ Alias match found → identity core + matched chunks (≤ 8,000 chars)
       │    └─ No match → identity core only (≤ 800 chars)
       └─ chunks.jsonl missing → current _loadLoreFallback behavior (full file, unchanged)
```

---

## Edge Cases

| Case | Input example | Expected behavior |
|------|--------------|-------------------|
| 3-letter short token | `mhy` | Not matched (not a listed alias). Bot gets identity core only. Does NOT pull meme table. |
| Numeric short token | `228` | Matched if `228` is an explicit alias in a chunk (it is: 228 = 横滨K十周年). Pulls that chunk. |
| 2-char token | `常山` | Matched to member profile chunk. Correct. |
| Empty/sticker-only message | `[CQ:image,...]` or poke | No tokens extracted. Identity core only. |
| Multi-entity query | `kisa 和 lag 昨天去现地了` | Match both kisa chunk + lag chunk + 現地 chunk if present. Inject all (within cap). |
| Unknown entity | `mhy` (米哈游) | No match. Identity core only. Bot replies from its own persona without meme contamination. |
| Alias cluster collision | `hyw` | Matched to the hyw/mmhyw chunk in the meme table — **correctly**. User explicitly mentioned the meme, bot knows the meme. |
| Kana/kanji/English mix | `ygfn の新 live` | `ygfn` (4 chars) matches 羊宫妃那 alias. `live` matches 演唱会 chunk. Both injected. |
| All context messages are noise | 5 context messages with only `g` `g啊` `666` | `g` is 1 char, filtered. No match. Identity core only. |
| Chunk cap hit mid-multi-entity | 8+ entities mentioned | Stop adding chunks when char cap reached. Earlier chunks (by match score or document order) take priority. |

---

## Test Plan

**Unit tests** (use `data/lore/958751334.md` and `958751334.md.chunks.jsonl` as real fixtures — no synthetic fixtures per `feedback_html_scraper_fixtures`):

- `buildAliasMap(chunksPath)` returns correct alias→chunkIndex map for known entries (e.g. `hyw` → chunk N, `kisa` → chunk M).
- `extractEntities('mhy', [])` returns empty set (no match).
- `extractEntities('hyw', [])` returns the hyw chunk index.
- `extractEntities('kisa', [])` returns kisa's chunk index.
- `extractEntities('kisa 和 lag', [])` returns both chunk indices.
- `extractEntities('[CQ:image,file=xxx]', [])` returns empty set.
- Short-token guard: `mhy` does not substring-match `mmhyw`.
- Token `228` matches if present as explicit alias.
- `buildLorePayload(groupId, entities=[])` returns identity core only, length ≤ 800.
- `buildLorePayload(groupId, entities=[hywChunkIdx])` returns identity core + hyw chunk, total ≤ 8000.
- Multi-entity payload respects 8000 char cap (truncates, not crashes).

**Integration tests** (against real group, real message flow):

- Send `mhy` to bot in group 958751334. Assert injected lore does NOT contain `mmhyw`. Assert bot reply does not contain `mmhyw`.
- Send `kisa 最近在干嘛` to bot. Assert injected lore contains kisa's profile chunk.
- Send `hyw` to bot. Assert injected lore contains the meme table chunk for hyw (user explicitly invoked it).
- Send sticker-only message. Assert injected lore equals identity core.
- Send `lag 和 飞鸟` multi-entity. Assert both member chunks present in injection.

**Regression:**
- Bandori-live injection fires independently for live-keyword messages — confirm it still works alongside entity-filtered lore.
- `loreKw` participation scoring still fires for known keywords (uses separate `loreKeywordsCache` from full token set — keep that unchanged).

---

## Open Questions for Architect/Developer

1. Should `_identity_core.md` be a file in `data/lore/` (operator-editable) or a hardcoded constant (simpler)? Recommend file so operator can tune it without redeploying.
2. The `loreCache` currently stores the full assembled text per group (not per-query). Entity-filtered lore is query-dependent — the cache must become per-query-entity-set or be dropped for the monolithic fallback path. Architect should decide cache invalidation strategy (LRU with key = groupId+entityHash, or no cache).
3. Chunk ordering for multi-entity: inject in document order (preserves narrative) or by match-score descending (most relevant first)? Recommend document order for coherence.
4. Does `loreKeywordsCache` need to stay built from the full file (for `loreKw` scoring)? Yes — keep it separate from the injection path. The scoring path should remain unchanged.

---

## Out of Scope

- No new commands (`/lore`, `/filter`, etc.).
- No per-group toggle — always-on per `feedback_behavior_not_mode.md`.
- No new embedding model calls.
- No changes to `data/lore/958751334.md.chunks.jsonl` format.
- No changes to the per-member lore directory path.
- No changes to bandori-live factual injection.
