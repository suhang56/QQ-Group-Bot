# R3 Facts Gate — Design Note

## Scope

Internal prompt restructuring only. No user-facing UI surface exists or is added.

---

## (a) System Message Block Convention — Confirmed

Source: `src/modules/chat.ts` lines 2523–2543 (`generateReply` flow).

Existing `system` array block shape:

```ts
{ text: string, cache: true | false }
```

- `cache: true` — cached block (prompt cache hit eligible)
- `cache: false` — uncached block (dynamic, per-call content)
- Field name for uncached: **`cache: false`** (explicit boolean false, NOT absent)

Current uncached blocks in the non-hardened path:
- `onDemandFactBlock` → `{ text: onDemandFactBlock, cache: false }`
- `webLookupBlock`   → `{ text: webLookupBlock, cache: false }`

Current uncached block in hardened path:
- `onDemandFactBlock` → `{ text: onDemandFactBlock, cache: false }`

R3 must use the same `{ text, cache: false }` shape for any new independent/dynamic system block it inserts. No new field names or wrapper objects.

---

## (b) No Dashboard Surface

R3 is a pure internal change. Confirmed:
- No admin panel, settings screen, or user-visible output changes
- No new commands, no new bot reply formats
- Only the `system[]` array assembly in `generateReply` changes

---

## (c) Cache Schema Version Bump — Invisible to Users

Any cache key change (e.g. reordering or splitting blocks in `system[]`) affects only Claude's prompt cache internally. Users see no change in bot behavior surface, reply format, or response latency difference that is user-observable. Cache misses on first deploy are a one-time cost, not a user-facing regression.

---

## Convention Summary for Architect/Dev

| Item | Value |
|------|-------|
| Block field names | `text: string`, `cache: boolean` |
| Uncached marker | `cache: false` (explicit, not absent) |
| Cached marker | `cache: true` or `cache: true as const` |
| Insertion pattern | spread into `system[]` array with conditional spread |
| New blocks must follow | same `{ text, cache }` shape — no deviation |
