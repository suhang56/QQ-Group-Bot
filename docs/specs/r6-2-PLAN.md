# Feature: R6.2 — Human Gold-Label CLI

## Product Context

R6.1c produced `data/eval/r6-1c/benchmark-weak-labeled.jsonl`: ~2000–3000 auto-labeled samples with weak heuristic labels. Those labels are noisy by design. Before R6.3's replay runner can score model outputs, humans must hand-verify a representative subset and write authoritative ground-truth labels ("gold labels") that become the eval benchmark.

R6.2 is the tool that makes that manual review fast, accurate, and resumable. It is a pure terminal CLI — no web UI, no LLM calls, no DB writes. The output is a JSONL file of `GoldLabel` records that R6.3 and R6.4 will consume.

## User Stories

- As a developer reviewing bot behavior, I want to quickly see a sample's full message context, the weak label, and press a few keys to write a gold label, so that I can label 50 samples in one sitting without losing focus.
- As a developer who was interrupted mid-session, I want the CLI to resume where I left off and skip already-labeled samples, so that no work is duplicated.
- As a developer who made a labeling mistake, I want to press `e` to go back and fix the previous sample's label before moving on.
- As a developer, I want a smoke run of 50 samples first to catch any schema or display issues before committing to a 500-sample run.

## GoldLabel Schema (exact — do not diverge)

```ts
interface GoldLabel {
  sampleId: string;
  goldAct: 'direct_chat' | 'chime_in' | 'conflict_handle' | 'summarize' | 'bot_status_query' | 'relay' | 'meta_admin_status' | 'object_react' | 'silence';
  goldDecision: 'reply' | 'silent' | 'defer';
  targetOk: boolean;
  factNeeded: boolean;
  allowBanter: boolean;
  allowSticker: boolean;
  notes?: string;
}
```

## Acceptance Criteria

- [ ] `scripts/eval/label-gold.ts` runs via `npx tsx scripts/eval/label-gold.ts --input <path> --output <path> --limit <N>`
- [ ] Interactive display per sample shows: trigger message (content, user, timestamp), 5 prior context messages, 3 next messages, weak label fields (category, expectedAct, expectedDecision, riskFlags), with category and riskFlags visually highlighted
- [ ] All keyboard shortcuts work: `r`/`s`/`d` for decision, `1`–`9` for act, `b` toggleBanter... wait — per spec: `b`=allowSticker, `B`=allowBanter, `f`=factNeeded, `t`=targetOk, `n`=notes, `k`=skip, `e`=edit previous, `q`=quit+save
- [ ] `n` prompts for free-text notes input (line editor), then returns to normal shortcut mode
- [ ] `k` skips the current sample — it is NOT written to output
- [ ] `e` opens the most recently written label for editing; saves the corrected version (overwrite by sampleId)
- [ ] `q` saves progress and exits cleanly
- [ ] On startup with an existing output file, already-labeled sampleIds are read and skipped; labeling resumes at the first unlabeled sample in input order
- [ ] Output file is written in append mode; deduplication by sampleId is enforced on final write (last write for a sampleId wins)
- [ ] `--limit N` caps total samples presented (not total labeled — skipped samples count against limit)
- [ ] `data/eval/gold/` directory is gitignored (JSONL output never committed)
- [ ] `docs/eval/gold-labeling.md` exists with usage instructions and field definitions
- [ ] `test/eval/gold-label-cli.test.ts` covers: resume-skip logic, edit/overwrite, skip-does-not-write, output schema validity, dedup-on-write
- [ ] `npx tsc --noEmit` passes with zero new errors

## Scope

### Included

- `scripts/eval/label-gold.ts` — the CLI entry point (pure Node/tsx, no framework)
- `data/eval/gold/` — output directory, gitignored
- `docs/eval/gold-labeling.md` — usage doc
- `test/eval/gold-label-cli.test.ts` — unit tests (use synthetic fixtures, not production data)
- `.gitignore` update: `data/eval/gold/*.jsonl`

### Explicitly NOT included

- No LLM calls of any kind
- No `generateReply` invocation
- No replay runner (R6.3)
- No metrics dashboard (R6.4)
- No web UI
- No sampler changes (R6.1c is locked)
- No modification to `src/` runtime code
- Gold JSONL files are never committed to git

## Keyboard Shortcut Reference (authoritative)

| Key | Action |
|-----|--------|
| `r` | goldDecision = reply |
| `s` | goldDecision = silent |
| `d` | goldDecision = defer |
| `1` | goldAct = direct_chat |
| `2` | goldAct = chime_in |
| `3` | goldAct = conflict_handle |
| `4` | goldAct = summarize |
| `5` | goldAct = bot_status_query |
| `6` | goldAct = relay |
| `7` | goldAct = meta_admin_status |
| `8` | goldAct = object_react |
| `9` | goldAct = silence |
| `b` | toggle allowSticker |
| `B` | toggle allowBanter |
| `f` | toggle factNeeded |
| `t` | toggle targetOk |
| `n` | enter free-text notes |
| `k` | skip (not written) |
| `e` | edit previous label |
| `q` | quit and save |

A sample is committed to output only when a decision key (`r`/`s`/`d`) is pressed AND an act key (`1`–`9`) is pressed. The label is written when both are set. Display should show current state of all toggles and the pending act/decision as the user presses keys, so they can confirm before committing. Committing happens when the user presses Enter or automatically after both decision and act are set (developer to decide — Open Question #1).

## Interactive Display Layout (per sample)

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Sample 47 / 500   [sampleId: abc-123]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXT (5 prior):
  [14:01 UserA] hey what time is the meetup
  [14:02 UserB] not sure ask admin
  [14:02 UserC] probably 7pm
  [14:03 UserA] ok thanks
  [14:04 UserD] anyone know the venue?

>>> TRIGGER [14:05 UserB]: @bot what's the venue for tonight?

AFTER (3):
  [14:05 UserC] yeah bot tell us
  [14:06 UserA] ...
  [14:07 UserD] anyone?

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WEAK LABEL:
  category:         [bot_status_query]
  expectedAct:      bot_status_query
  expectedDecision: reply
  riskFlags:        [FACT_NEEDED, TARGET_BOT]

CURRENT GOLD:
  goldAct:       [not set]
  goldDecision:  [not set]
  targetOk:      true   (t to toggle)
  factNeeded:    false  (f to toggle)
  allowBanter:   false  (B to toggle)
  allowSticker:  false  (b to toggle)
  notes:         (n to add)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[r]eply [s]ilent [d]efer  |  1-9 act  |  [k]skip [e]edit-prev [q]uit
```

## Edge Cases to Test

- Input file with 0 unlabeled samples (all already in output) → prints "all done" and exits
- `--limit 10` with input of 500 → stops after 10 samples presented
- `e` on the very first sample (no previous) → shows "no previous label" message, no crash
- Output file missing on first run → creates it; no crash
- `n` with empty input (user presses Enter with no text) → notes field stays undefined
- sampleId appears twice in input → show it once (deduplicate input by sampleId, first occurrence wins)
- Malformed line in input JSONL → skip with warning, continue
- `q` mid-sample (act set but no decision, or vice versa) → discard incomplete label, save completed ones, exit cleanly
- Large notes string (>500 chars) → truncated to 500 chars with warning

## Open Questions

1. **Commit trigger**: does writing the label to output happen automatically when both act + decision are set, or does the user press Enter to confirm? Recommendation: auto-commit on second of the two required keys — reduces keystrokes. Developer decides.
2. **Dedup input order**: if sampleId appears twice in input JSONL, which occurrence is shown? Recommendation: first occurrence.
3. **Terminal library**: `readline` (built-in) vs `blessed`/`ink` for display. Recommendation: use `readline` + raw TTY mode for simplicity — no new dependencies. Developer decides.
4. **`e` depth**: does `e` allow editing only the immediately previous sample, or a stack of N? Spec says "previous sample" (singular) — implement single-level undo only.
