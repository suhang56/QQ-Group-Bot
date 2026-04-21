# Feature: PR1 fix/sticker-token-leak — Send-Guard Chain + Sticker Strip

## Why

`bot-2026-04-20.log:4646` shows bot emitting raw `<sticker:34>` and `sticker:18` protocol tokens
in non-fact-hit paths where the existing per-path guard did not fire. Severity HIGH — protocol
token leaks are visible to group members as malformed text. Cited in plan section "PR1" and
struggle-log 2026-04-21 batch observation item #3.

**Shared-infra note**: `send-guard-chain.ts` introduced here is the single chain that PR2
(harassment-ceiling) and PR4 (persona-guard) will append to. PR1 only installs the scaffold
and the first guard; downstream PRs do not duplicate the chain.

## Scope IN

1. `src/utils/sticker-token-output-guard.ts` — pure `stripStickerTokens(text): string` predicate.
   Name is intentional and frozen: no `replace`/`fallback` overload allowed (prevents future
   callers from substituting surrogate text instead of stripping).
2. `src/utils/send-guard-chain.ts` — chain scaffold: `GuardResult`, `SendGuard`, `SendGuardCtx`
   types + `runSendGuardChain(guards, text, ctx): GuardResult` with first-fail short-circuit.
3. `src/modules/chat.ts` — all `adapter.send` call-sites wired through chain (main chat,
   sticker-first path, deflection-cache path, fallback path, mimic path).
4. `src/modules/deflection-engine.ts` `_validate` (line ~152) — add `sticker:\d+` rejection so
   sticker tokens are caught at cache-write time too.
5. `scripts/eval/violation-tags.ts` — register replay tag `sticker-token-leak`; guard fires
   emit this tag 1:1 (one tag per guard trigger, no batching).
6. Tests: `test/utils/sticker-token-output-guard.test.ts` (regex edge cases) +
   `test/modules/chat-sticker-leak.test.ts` (integration, mocked LLM returning sticker tokens).

## Scope OUT

- Harassment / hard-gate ceiling (PR2 owns `harassmentGuard` appended to same chain)
- Persona fabrication guard (PR4)
- Phrase-miner bot-output filter (PR3 — separate PR, no shared infra with this one)
- Any tone / behavior tuning
- Fallback text substitution (`stripStickerTokens` strips silently — no replacement text)
- Schema / DB changes

## Acceptance Criteria

- [ ] `tsc --noEmit` + `tsconfig.scripts.json` clean — zero errors
- [ ] All vitest tests pass (new + full suite)
- [ ] Replay tag `sticker-token-leak` count = 0 on real DB run
- [ ] Reviewer spot-check (a): every `adapter.send` call-site in chat.ts passes through chain
- [ ] Reviewer spot-check (b): chain first-fail short-circuit confirmed by unit test
- [ ] Reviewer spot-check (c): replay tag emission is 1:1 with guard fire (no tag without fire,
      no fire without tag)
- [ ] Regression: R2a fact-hit guard path still passes existing tests (no silent breakage)

## Edge Cases to Test

| Case | Input |
|---|---|
| Bare token | `sticker:18` |
| Bracketed token | `<sticker:34>` |
| Whitespace-padded | `  sticker:5  ` |
| Mid-sentence embed | `some text sticker:29 more text` |
| Token-only after strip | `sticker:12` → empty string |
| Deflection cache variant | cached reply containing `sticker:N` |
| Fact-hit path | existing guard path must NOT regress |
| Multi-sticker | `<sticker:1> some text <sticker:2>` |

## Open Questions for Designer

1. **`SendGuardCtx` fields**: which of `{ groupId, triggerMessage, recentMessages, isDirect,
   resultKind }` are required for PR1 sticker guard specifically vs deferred to PR2/PR4?
2. **`GuardResult.replacement` enum semantics**: exact boundary between `'silent'`,
   `'neutral-ack'`, and `'deflection'` — when does sticker-strip result in silent vs ack?
3. **Send entry-point grep list**: Designer to grep `adapter.send` in `chat.ts` and enumerate
   all call-site line numbers so Architect/Dev can confirm full coverage.
4. **Deflection-engine `_validate` scope**: is adding `sticker:\d+` rejection redundant with
   final-send guard or necessary defense-in-depth? Designer to decide and document the call.
