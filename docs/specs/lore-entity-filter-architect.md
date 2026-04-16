# Architect Notes: Entity-Filtered Lore Injection

Status: **APPROVED** (with notes below for developer)

---

## 1. Cache Strategy Decision

**Recommendation: Option (c) -- keep group-cached identity-core, compute per-query filtered chunks on top.**

Justification:

- The alias map (alias -> chunkIndex) is built once per group and cached, same lifecycle as current `loreAliasIndex`. This is the expensive parse step -- do it once.
- The identity core is a static string constant per group. Cache it or load from `_identity_core.md` once. No per-query variance.
- The per-query work is: tokenize trigger+context, look up tokens in the alias map (O(n) hash lookups), read matched chunks from the already-parsed jsonl. This is microsecond-scale and does not need caching.
- The current `loreCache` (Map<string, string | null>) stores one entry per group. The monolithic fallback path currently sets it once and returns it for all subsequent calls. The new filtered path should NOT write to `loreCache` at all for the monolithic fallback, because the result varies per query. Instead:
  - `loreCache` continues to serve the per-member-dir path (unchanged).
  - For the monolithic fallback with chunks.jsonl present: skip `loreCache` entirely. The alias map + parsed chunks are cached per group; the assembly is per-query.
  - For the monolithic fallback WITHOUT chunks.jsonl: current behavior (full file cached in `loreCache`).
- `loreKeywordsCache` must still be populated for `_hasLoreKeyword` / `loreKw` scoring. Build it from the FULL lore file content (unchanged), not from the filtered subset. The spec already calls this out (section "Out of Scope", point about `loreKw`).

**New cache fields on ChatModule:**
- `private readonly loreChunksCache = new Map<string, LoreChunk[]>()` -- parsed chunks.jsonl per group
- `private readonly loreChunkAliasMap = new Map<string, Map<string, number[]>>()` -- alias -> chunk indices per group
- `private readonly loreIdentityCore = new Map<string, string>()` -- identity core string per group

All three invalidated in `invalidateLore()` alongside existing caches.

---

## 2. Module Placement

**Recommendation: `src/modules/lore-retrieval.ts`**

Reasoning:
- `src/ai/` contains LLM client wrappers (`claude.ts`, `model-router.ts`, `providers/`). Lore retrieval is not an AI/LLM concern -- it is keyword matching and text assembly.
- `src/modules/` is where all domain modules live (`chat.ts`, `lore-updater.ts`, `bandori-live-scraper.ts`, etc.). A lore retrieval helper is a natural peer.
- The new file should export pure functions (no class needed): `buildAliasMap`, `extractEntities`, `buildLorePayload`, `parseIdentityCore`.
- `chat.ts` imports and calls these functions from `_loadLoreFallback` (or a new `_loadLoreFiltered` method that replaces the fallback when chunks.jsonl exists).

File structure:
```
src/modules/lore-retrieval.ts   -- pure functions: buildAliasMap, extractEntities, buildLorePayload
```

---

## 3. Alias Index Build Strategy

**Recommendation: Lazy on first call, cached per group, invalidated with `invalidateLore()`.**

This matches the existing pattern used by `_buildLoreAliasIndex` (line 2031-2077 in chat.ts) -- built on first access, stored in a Map, evicted by `invalidateLore()`.

When `invalidateLore(groupId)` fires (called by `lore-updater.ts` line 141 after a lore file update), ALL per-group caches are cleared including the new ones. Next message triggers a rebuild.

There is NO file watcher in chat.ts (confirmed: no `fs.watch`/`chokidar` usage). The lore-updater calls `invalidateLore()` after it rewrites the lore file. This is sufficient -- no need to add a file watcher.

Developer note: when parsing `{groupId}.md.chunks.jsonl`, the alias map should be built from the `summary` field of each chunk line. The chunks.jsonl file is 52 lines for group 958751334. Parsing is trivial and synchronous (readFileSync + split lines + JSON.parse per line).

---

## 4. Reuse Check

**Existing code to reuse:**
- `tokenizeLore(text)` (chat.ts line 468) -- already exported, splits on whitespace/punctuation, returns Set<string> with length >= 2 filter. Reuse directly for tokenizing query messages.
- `_buildLoreAliasIndex` (chat.ts line 2031) -- this is for the per-member-dir path (reads YAML frontmatter from individual .md files). It is NOT reusable for chunks.jsonl parsing. The new `buildAliasMap` function is a different algorithm (parses bold tokens and slash-separated clusters from chunk summaries).

**No existing entity extraction from user messages.** The `_hasLoreKeyword` method (line 2012) checks for token intersection between message and lore tokens, but it does not extract entity names or map them to chunks. Fresh helper needed.

---

## 5. Risk Checklist

Developer MUST avoid:

- **(a) Smart quotes**: All string literals in `lore-retrieval.ts` must use straight quotes (`'` or `"`). No curly/smart quotes. The project uses single quotes per existing convention.
- **(b) setTimeout without .unref()**: This feature should NOT need any timers. If for any reason a timer is introduced, `.unref?.()` is mandatory.
- **(c) Schema changes without ALTER migration**: This feature introduces NO database schema changes. It reads from filesystem only (lore .md and .chunks.jsonl). No SQLite involvement.
- **(d) Synthetic fixtures**: Tests MUST use the real `data/lore/958751334.md.chunks.jsonl` file as fixture. Do NOT create synthetic/mock chunk files. Copy the real file into a test fixture directory if needed, but the content must be from the real production file.

---

## 6. Test Strategy Sign-Off

**APPROVED with refinements:**

The spec's test plan is solid. Refinements:

1. Unit tests should import from `src/modules/lore-retrieval.ts` directly (pure functions, no ChatModule instantiation needed).
2. Fixture: use the real `data/lore/958751334.md.chunks.jsonl`. For tests that run in CI, copy it to a test fixtures directory at test setup time rather than hardcoding an absolute path.
3. The `buildAliasMap` test should verify:
   - `mhy` is NOT a key in the alias map (the core bug prevention).
   - `hyw` IS a key (explicit alias).
   - `kisa` IS a key.
   - Single-char tokens are excluded.
4. The short-token guard (2-3 char tokens: exact match only; 4+ chars: substring containment within alias) needs dedicated edge case tests:
   - `mhy` (3 chars) does NOT match `mmhyw` (not an exact alias).
   - `hyw` (3 chars) DOES match (it IS an exact alias).
   - `ygfn` (4 chars) matches via substring containment in alias entries.
5. Integration tests: the spec lists sending messages to a real group. These are valuable but should be run manually (not in CI). Mark them as manual test steps in the test file comments.

---

## 7. Additional Architectural Notes

### 7a. Integration Point in chat.ts

The cleanest integration is to modify `_loadLoreFallback` (or create a new `_loadLoreFiltered` called before the fallback):

```
_loadRelevantLore(groupId, triggerContent, immediateContext):
  1. Try per-member-dir path (existing, unchanged)
  2. Try monolithic + chunks.jsonl path (NEW: entity-filtered)
  3. Fall back to monolithic raw file (existing _loadLoreFallback, unchanged)
```

Step 2 is the new code path. It should:
- Check if `{groupId}.md.chunks.jsonl` exists (cached check)
- If yes: build alias map, extract entities, build filtered payload
- Return the filtered payload (identity core + matched chunks)
- Still populate `loreKeywordsCache` from the FULL file for `loreKw` scoring

### 7b. Identity Core as File

**Recommend `data/lore/{groupId}_identity_core.md`** (not a subdirectory, alongside the existing `{groupId}.md`). Operator-editable, no redeploy needed. Developer writes the initial content by extracting it from the existing lore file header.

If the file doesn't exist, fall back to extracting from chunk 0's first 800 chars (graceful degradation).

### 7c. Chunk Ordering for Multi-Entity

**Document order** (by chunkIndex ascending). This preserves the narrative structure of the lore file. No scoring/ranking needed since we are doing exact alias matching, not relevance scoring.

### 7d. Logging

The spec calls for logging `{ groupId, matchedChunks, totalChars, fallbackUsed }`. This is correct. Use `this.logger.debug()` for normal operation, `this.logger.info()` only for the zero-match fallback case (useful for monitoring how often the identity-core-only path fires).

---

## Summary

| Decision | Choice |
|----------|--------|
| Cache strategy | (c) Cached alias map + identity core; per-query chunk assembly (no result cache) |
| Module placement | `src/modules/lore-retrieval.ts` (pure functions) |
| Alias index build | Lazy first-call, cached per group, invalidated with `invalidateLore()` |
| Entity extraction reuse | None exists; fresh helper using existing `tokenizeLore()` for tokenization |
| Identity core storage | `data/lore/{groupId}_identity_core.md` file, operator-editable |
| Chunk ordering | Document order (chunkIndex ascending) |
| Test fixtures | Real `958751334.md.chunks.jsonl`, no synthetic |

**APPROVED for development.** No changes needed from planner.
