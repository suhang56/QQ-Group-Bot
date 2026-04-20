# R6.2 Gold-Label CLI — UX Design Note

## 1. Screen Layout (ASCII Mockup)

Full terminal render per sample (80-col reference width):

```
================================================================================
 Labeled: 47/500 | Skipped: 3 | sampleId: abc-123-def | seed: 42
================================================================================
 CONTEXT (5 prior):
   14:01  UserA      hey what time is the meetup
   14:02  UserB      not sure ask admin
   14:02  UserC      probably 7pm
   14:03  UserA      ok thanks
   14:04  UserD      anyone know the venue?

 >>>  14:05  UserB   @bot what's the venue for tonight?  <<<

 AFTER (3):
   14:05  UserC      yeah bot tell us
   14:06  UserA      ...
   14:07  UserD      anyone?

--------------------------------------------------------------------------------
 WEAK LABEL:
   category:          bot_status_query
   expectedAct:       bot_status_query
   expectedDecision:  reply
   riskFlags:         FACT_NEEDED  TARGET_BOT

--------------------------------------------------------------------------------
 CURRENT GOLD:
   goldAct:       [not set]         goldDecision:  [not set]
   targetOk:      true   [t]        factNeeded:    false  [f]
   allowBanter:   false  [B]        allowSticker:  false  [b]
   notes:         (none)            [n] to add

--------------------------------------------------------------------------------
 DECISION  [r]eply  [s]ilent  [d]efer
 ACT       [1]direct_chat  [2]chime_in  [3]conflict_handle  [4]summarize
           [5]bot_status_query  [6]relay  [7]meta_admin_status
           [8]object_react  [9]silence
 OTHER     [k]skip  [e]edit-prev  [n]notes  [q]quit
================================================================================
```

### Layout notes
- Top bar: single line, always visible — progress + sampleId
- Context block: dim/gray, left-padded 3 spaces, timestamp + nickname + content
- TRIGGER line: bright white, `>>>` prefix and `<<<` suffix, visually boxed by blank lines
- After block: same style as context but labeled AFTER
- Weak label block: category value in cyan, riskFlags each in yellow-bold
- Current gold block: two-column layout, set values in green, `[not set]` in dim-red
- Action prompt: bottom 4 lines, always fully visible — never scrolled off

---

## 2. Color Scheme (ANSI terminal colors)

| Element                   | Color                    | ANSI code            |
|---------------------------|--------------------------|----------------------|
| Top bar / dividers        | Bold white               | `\x1b[1;37m`        |
| Context messages          | Dim gray                 | `\x1b[2;37m`        |
| Context nickname (bot)    | Cyan                     | `\x1b[36m`          |
| Trigger line (full row)   | Bold white + BG dark     | `\x1b[1;37;40m`     |
| `>>>` / `<<<` markers     | Bold yellow              | `\x1b[1;33m`        |
| After messages            | Dim gray                 | `\x1b[2;37m`        |
| Weak label category       | Cyan                     | `\x1b[36m`          |
| riskFlags                 | Bold yellow              | `\x1b[1;33m`        |
| Risk flag DANGER/HIGH     | Bold red                 | `\x1b[1;31m`        |
| Gold value set            | Green                    | `\x1b[32m`          |
| Gold `[not set]`          | Dim red                  | `\x1b[2;31m`        |
| Toggle ON                 | Green bold               | `\x1b[1;32m`        |
| Toggle OFF                | Dim gray                 | `\x1b[2;37m`        |
| Shortcut key brackets     | Dim white                | `\x1b[2;37m`        |
| Notes text                | Italic white             | `\x1b[3;37m`        |
| Confirmation line (ok)    | Bold green               | `\x1b[1;32m`        |
| Error / warning line      | Bold red                 | `\x1b[1;31m`        |
| Section headers           | Bold white               | `\x1b[1;37m`        |

---

## 3. Shortcut Key Layout (grouping rationale)

### Decision keys — home row left hand
```
  r = reply      (index finger, home row)
  s = silent     (ring finger, home row)
  d = defer      (middle finger, home row)
```
Three most frequent actions. All reachable without lifting hand from home.

### Toggle keys — home row right hand extensions
```
  t = targetOk       (index finger, home row)
  f = factNeeded     (index finger, upper row — natural reach)
  b = allowSticker   (index finger, lower row)
  B = allowBanter    (shift+b — capital prevents collision)
  n = notes          (middle finger, lower row)
```

### Act keys — number row
```
  1 = direct_chat          2 = chime_in
  3 = conflict_handle      4 = summarize
  5 = bot_status_query     6 = relay
  7 = meta_admin_status    8 = object_react
  9 = silence
```
Number row is contiguous; 1–9 maps left-to-right. Labeler uses number row
only after home-row decision is set.

### Control keys — far positions (rare use)
```
  k = skip           (right index, home row)
  e = edit-prev      (left ring, upper row)
  q = quit           (left pinky, upper row — hard to hit by accident)
```

### Commit trigger
Auto-commit when BOTH act (1–9) AND decision (r/s/d) are set. No Enter required.
Order doesn't matter: act-first or decision-first both work.
This is the minimum-keystrokes path. Decision matches recommendation in PLAN.md Open Q#1.

---

## 4. Confirmation Flow

After auto-commit (both act + decision set), a single confirmation line replaces
the action prompt area for 0.8 seconds before clearing and loading the next sample:

```
  ✓  abc-123-def  |  act: bot_status_query  |  decision: reply  |  next in 0.8s
```

- Color: bold green
- Shows sampleId + final act + final decision
- Timer counts down if user watches; next sample auto-loads after 0.8s
- No keypress required to advance — reduces fatigue over 500 samples
- If user presses any key during the 0.8s window: immediately advance (do not re-label)

---

## 5. Edit-Previous Flow (`e` key)

Pressing `e` at the action prompt shows a mini-list of the last 5 written labels
(most recent at top):

```
  EDIT PREVIOUS LABEL  (select with j/k or 1-5, Enter to edit, Esc to cancel)
  ──────────────────────────────────────────────────────────────────
  1  abc-123  |  act: bot_status_query  |  decision: reply    [just now]
  2  xyz-456  |  act: direct_chat       |  decision: silent   [1 back]
  3  ijk-789  |  act: chime_in          |  decision: reply    [2 back]
  4  lmn-012  |  act: relay             |  decision: defer    [3 back]
  5  opq-345  |  act: silence           |  decision: silent   [4 back]
```

- If no previous labels exist: shows `  (no previous labels to edit)` and returns.
- j/k = vim-style cursor; 1–5 = direct select; Enter = confirm; Esc = cancel.
- After selecting, the full labeling screen loads for that sample with all previously
  saved field values pre-filled (act, decision, toggles, notes all restored).
- The CURRENT GOLD block shows values in green (pre-filled), not dim-red `[not set]`.
- User must re-press act + decision to commit (pre-filled values are not auto-committed).
- On commit, the edited label overwrites the previous entry by sampleId in memory;
  deduplication on final write ensures last write wins.
- After editing, flow returns to the sample that was interrupted (the queue is not lost).

---

## 6. Error Handling

### Ambiguous / unrecognized key
- No beep, no crash.
- A dim warning line appears below the action prompt for 1.5s then clears:
  ```
    ? Unknown key 'x' — use r/s/d for decision, 1-9 for act
  ```

### Accidental quit (`q`)
- Pressing `q` does NOT immediately exit.
- Shows confirmation prompt (replaces action row):
  ```
    Quit? Progress saved (47 labeled). Press q again to confirm, any other key to cancel.
  ```
- Second `q` within 3s: save + exit cleanly.
- Any other key or 3s timeout: dismiss, return to labeling screen.

### Malformed JSONL line on input
- Skip the line silently; print a startup warning before entering interactive mode:
  ```
    WARNING: 2 malformed line(s) skipped in input (lines 14, 87)
  ```
- Labeling continues with valid lines only.

### `e` on very first sample (no previous)
- Shows: `  (no previous labels — nothing to edit)` for 1.5s, then returns.
- No crash, no state change.

### `n` notes — empty input
- User presses Enter with no text → notes field stays undefined (not set to "").
- Shown as `(none)` in the CURRENT GOLD block.

### `n` notes — oversized input (>500 chars)
- After Enter, truncate to 500 chars.
- Show warning line: `  ! Notes truncated to 500 characters.`

### `q` mid-sample (incomplete label)
- Incomplete label (act set but no decision, or vice versa) is discarded.
- Confirmation prompt reflects this: `Quit? 47 labeled, current sample discarded.`

---

## 7. Empty Input / End-of-Input Handling

### All samples already labeled (resume with nothing to do)
- On startup, after reading existing output:
  ```
    All 500 samples already labeled. Nothing to do. Exiting.
  ```
- Exit code 0.

### Input file has fewer samples than --limit
- Label all available; stop when input is exhausted.
- Final message: `  All 12 samples labeled (--limit 500 not reached). Done.`

### End of session (all presented samples labeled or skipped)
- After the last sample is committed or skipped:
  ```
  ================================================================================
   Session complete!  Labeled: 47  |  Skipped: 3  |  Total presented: 50
   Output: data/eval/gold/gold-500.jsonl
  ================================================================================
  ```
- Exit cleanly. No confirmation required — session is naturally complete.

### `--limit` reached mid-input
- After N samples presented (labeled + skipped combined), show session complete screen.
- Do not present sample N+1 even if unlabeled.

### Input file missing / unreadable
- Print error before entering interactive mode and exit non-zero:
  ```
    ERROR: Cannot read input file: data/eval/r6-1c/benchmark-weak-labeled.jsonl
  ```

### Output directory missing
- Create `data/eval/gold/` automatically; do not error.
