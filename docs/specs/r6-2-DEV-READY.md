# R6.2 Gold-Label CLI — DEV-READY

**Architect sign-off date**: 2026-04-20
**Scope**: `scripts/eval/label-gold.ts` + `scripts/eval/gold/*` + `test/eval/gold-label-cli.test.ts` + `.gitignore` update
**Hard constraints**: zero `src/` changes, zero LLM calls, zero DB writes, no new runtime npm deps

---

## 0. Open Questions — Resolved

| # | Question | Resolution |
|---|---|---|
| 1 | Commit trigger | **Auto-commit** when BOTH act (1–9) AND decision (r/s/d) are set. Order irrelevant. No Enter required. Matches DESIGN-NOTE §3 recommendation. |
| 2 | Dedup input | First occurrence of sampleId wins. Second occurrence skipped with no warning. |
| 3 | Terminal library | `node:readline` + raw TTY mode. No new dependencies. |
| 4 | `e` depth | Single-level: select from last 5 written labels, not just the immediately previous one. Full mini-list UI per DESIGN-NOTE §5. |
| 5 | tsconfig | Add `"scripts/**/*"` to root tsconfig `include` (separate from `src/`). Do NOT change `rootDir` — tsc type-check only; tsx is the runtime. `test/` is already excluded. |
| 6 | gitignore | `data/eval/*.jsonl` already covers `data/eval/gold/*.jsonl` because `data/eval/gold/` falls under `data/` ignore + `!data/eval/` un-ignore makes the directory visible, and `data/eval/*.jsonl` only matches the top-level. Add explicit `data/eval/gold/*.jsonl` AND `!data/eval/gold/` (to un-ignore the directory) so `mkdir -p data/eval/gold` works without git issues. |

---

## 1. Module Layout

```
scripts/eval/
  label-gold.ts              # CLI entry: argv parse, TTY guard, run session
  gold/
    types.ts                 # GoldLabel interface + GoldAct/GoldDecision types + validator
    reader.ts                # JSONL async line iterator, dedup-by-sampleId (first wins)
    writer.ts                # append (fast path) + atomic update-by-sampleId
    renderer.ts              # full-screen ANSI render per sample + edit menu + summary
    shortcuts.ts             # keyBuffer → Action mapping, HELP text
    session.ts               # main loop: resume, label, skip, edit-prev, quit

test/eval/
  gold-label-cli.test.ts     # Vitest 2.x integration tests (see §7)
```

**No files in `src/` are touched.**

---

## 2. Type Contracts (`scripts/eval/gold/types.ts`)

```typescript
export type GoldAct =
  | 'direct_chat' | 'chime_in' | 'conflict_handle' | 'summarize'
  | 'bot_status_query' | 'relay' | 'meta_admin_status' | 'object_react' | 'silence';

export type GoldDecision = 'reply' | 'silent' | 'defer';

export interface GoldLabel {
  sampleId: string;
  goldAct: GoldAct;
  goldDecision: GoldDecision;
  targetOk: boolean;
  factNeeded: boolean;
  allowBanter: boolean;
  allowSticker: boolean;
  notes?: string;         // max 500 chars, undefined if not set
  labeledAt: string;      // ISO 8601, set by writer
}

// Throws with descriptive message on invalid input
export function validateGoldLabel(raw: unknown): GoldLabel
```

`notes` is `undefined` (not `""`) when user presses Enter with no text. Writer never writes `notes: undefined` — omit the key entirely.

---

## 3. Reader (`scripts/eval/gold/reader.ts`)

```typescript
export interface SampleRecord {
  sampleId: string;
  // fields from R6.1c benchmark-weak-labeled.jsonl
  triggerContent: string;
  triggerUser: string;
  triggerTs: number;
  contextBefore: MessageRow[];   // up to 5
  contextAfter: MessageRow[];    // up to 3
  weakLabel: WeakReplayLabel;    // from existing types.ts
  [key: string]: unknown;        // pass-through any extra fields
}

export interface MessageRow {
  content: string;
  user: string;
  ts: number;
}

// Async generator — streams lines, never loads full file into memory
export async function* readSamples(
  filePath: string
): AsyncGenerator<SampleRecord>
// Malformed lines: print to stderr, skip (do not throw)
// Dedup by sampleId: first occurrence wins, subsequent silently dropped
// Collects malformed line numbers, prints startup warning before first sample

export async function countSamples(filePath: string): Promise<number>
// For progress denominator. Can be approximate (line count) if file is huge.
```

**Import path note**: uses `import type { WeakReplayLabel } from '../types.js'` — relative, `.js` extension required for NodeNext resolution.

---

## 4. Writer (`scripts/eval/gold/writer.ts`)

```typescript
// Append new label (fast path — O(1))
export async function appendLabel(outputPath: string, label: GoldLabel): Promise<void>

// Atomic replace by sampleId (O(n) file read + write)
export async function updateLabel(outputPath: string, label: GoldLabel): Promise<void>

// Read all existing labels; returns Map for O(1) lookup + ordered history
export async function readExistingLabels(outputPath: string): Promise<Map<string, GoldLabel>>
```

**appendLabel**: `fs.appendFile(outputPath, JSON.stringify(label) + '\n')` — creates file if absent.

**updateLabel** (atomic):
```
1. Read full file as string
2. Split by \n, filter empty
3. Parse each line; replace matching sampleId; non-JSON lines: keep as-is with stderr warning
4. Write result to outputPath + '.tmp'
5. fs.rename(tmpPath, outputPath)   ← atomic on same volume (NTFS + ext4 both support this)
```

**readExistingLabels**: returns empty Map if file absent (no error). Populates in file order (first-in = oldest).

---

## 5. Renderer (`scripts/eval/gold/renderer.ts`)

All output to `process.stdout`. Clear screen per sample with `\x1b[2J\x1b[H`.

### Color constants (no deps)
```typescript
const C = {
  reset:     '\x1b[0m',
  bold:      '\x1b[1m',
  dim:       '\x1b[2m',
  italic:    '\x1b[3m',
  boldWhite: '\x1b[1;37m',
  dimGray:   '\x1b[2;37m',
  cyan:      '\x1b[36m',
  boldYellow:'\x1b[1;33m',
  boldRed:   '\x1b[1;31m',
  green:     '\x1b[32m',
  boldGreen: '\x1b[1;32m',
  dimRed:    '\x1b[2;31m',
};
```

### Functions
```typescript
export function renderSample(sample: SampleRecord, state: LabelState, progress: Progress): void
// Full-screen render: header bar, context, trigger, after, weak label, current gold, action prompt

export function renderEditMenu(history: GoldLabel[]): void
// Mini-list of last 5 labels; j/k or 1-5 to select; Enter=confirm; Esc=cancel

export function renderConfirmation(label: GoldLabel): void
// Single bold-green line for 0.8s after auto-commit

export function renderSummary(stats: SessionStats): void
// Session complete screen (stdout) + stats to stderr

export function renderWarning(msg: string): void
// Dim warning line below action prompt, cleared after 1.5s

export function renderQuitConfirm(labeled: number, currentIncomplete: boolean): void
// "Quit? Press q again to confirm" prompt

interface LabelState {
  goldAct?: GoldAct;
  goldDecision?: GoldDecision;
  targetOk: boolean;
  factNeeded: boolean;
  allowBanter: boolean;
  allowSticker: boolean;
  notes?: string;
}

interface Progress {
  current: number;   // 1-based presented count
  total: number;     // total in input (or limit if --limit set)
  labeled: number;
  skipped: number;
}

interface SessionStats {
  labeled: number;
  skipped: number;
  totalPresented: number;
  actDist: Partial<Record<GoldAct, number>>;
  outputPath: string;
}
```

**Layout per DESIGN-NOTE §1** (80-col reference):
```
================================================================================
 Labeled: 47/500 | Skipped: 3 | sampleId: abc-123-def
================================================================================
 CONTEXT (5 prior):
   14:01  UserA      hey what time is the meetup
   ...

 >>>  14:05  UserB   @bot what's the venue?  <<<

 AFTER (3):
   ...
--------------------------------------------------------------------------------
 WEAK LABEL:
   category:          bot_status_query
   ...
--------------------------------------------------------------------------------
 CURRENT GOLD:
   goldAct:  [not set]      goldDecision:  [not set]
   targetOk: true [t]       factNeeded: false [f]
   ...
--------------------------------------------------------------------------------
 DECISION  [r]eply  [s]ilent  [d]efer
 ACT       [1]direct_chat  [2]chime_in  ...  [9]silence
 OTHER     [k]skip  [e]edit-prev  [n]notes  [q]quit
================================================================================
```

---

## 6. Shortcuts (`scripts/eval/gold/shortcuts.ts`)

```typescript
export type Action =
  | { type: 'decision'; value: GoldDecision }
  | { type: 'act'; value: GoldAct }
  | { type: 'toggle'; field: 'targetOk' | 'factNeeded' | 'allowBanter' | 'allowSticker' }
  | { type: 'notes' }
  | { type: 'skip' }
  | { type: 'edit' }
  | { type: 'quit' }
  | { type: 'unknown'; key: string }

export function keyToAction(key: Buffer): Action
```

**Mapping** (from PLAN §Keyboard Shortcut Reference):

| Key bytes | Action |
|-----------|--------|
| `r` | decision=reply |
| `s` | decision=silent |
| `d` | decision=defer |
| `1`–`9` | act=direct_chat..silence |
| `b` | toggle allowSticker |
| `B` (0x42) | toggle allowBanter |
| `f` | toggle factNeeded |
| `t` | toggle targetOk |
| `n` | notes |
| `k` | skip |
| `e` | edit |
| `q` | quit |
| `\x03` (Ctrl+C) | quit (treated same as `q`) |
| anything else | unknown |

---

## 7. Session (`scripts/eval/gold/session.ts`)

```typescript
export async function runSession(opts: SessionOpts): Promise<SessionStats>

interface SessionOpts {
  inputPath: string;
  outputPath: string;
  limit?: number;          // max samples to present (labeled + skipped combined)
}
```

### Startup sequence
1. Read existing labels: `existingLabels = await readExistingLabels(outputPath)` → Map<sampleId, GoldLabel>
2. Collect history: `history = [...existingLabels.values()]` (ordered, oldest first)
3. If no unlabeled samples remain after filter: print "all done", exit 0
4. Print malformed-line warning if any (collected by reader)

### Main loop
```
presented = 0
for await sample of readSamples(inputPath):
  if existingLabels.has(sample.sampleId): continue   // skip already-labeled
  if limit && presented >= limit: break
  presented++

  state = defaultLabelState()     // targetOk=true, all others false
  renderSample(sample, state, progress)

  // Key loop for this sample
  while true:
    key = await readOneKey()
    action = keyToAction(key)

    switch action.type:
      'decision' → state.goldDecision = action.value; renderSample(...)
      'act'      → state.goldAct = action.value; renderSample(...)
      'toggle'   → state[action.field] = !state[action.field]; renderSample(...)
      'notes'    → await promptNotes(state); renderSample(...)
      'skip'     → stats.skipped++; break (do not write)
      'edit'     → await handleEdit(history, outputPath); renderSample(sample, state, ...)
      'quit'     → await handleQuit(state, stats); return stats
      'unknown'  → renderWarning(...)

    if state.goldAct && state.goldDecision:
      label = buildLabel(sample.sampleId, state)
      await appendLabel(outputPath, label)
      history.push(label)
      existingLabels.set(label.sampleId, label)
      stats.labeled++
      stats.actDist[label.goldAct]++
      renderConfirmation(label)
      await delay(800)
      break   // advance to next sample
```

### `handleEdit(history, outputPath)`
1. `renderEditMenu(history.slice(-5))` 
2. Read selection (j/k or 1–5 + Enter, or Esc to cancel)
3. Load selected label into editState (pre-fill all fields)
4. `renderSample(selectedSample, editState, progress)` — needs sample data; keep `sampleRecordMap: Map<sampleId, SampleRecord>` built during startup or lazy-load
5. Key loop until act + decision set → `updateLabel(outputPath, newLabel)`
6. Update in-memory `history` and `existingLabels`
7. Return to interrupted sample

**`e` on first sample (history empty)**: show "(no previous labels — nothing to edit)" for 1.5s via `renderWarning`, return immediately.

### `handleQuit(state, stats)`
1. `renderQuitConfirm(stats.labeled, !!(state.goldAct || state.goldDecision))`
2. Set 3s timeout
3. Read key: if `q` → break; if timeout → dismiss and return (continue labeling)
4. On confirmed quit: `renderSummary(stats)`, restore stdin, `process.exit(0)`

### `promptNotes(state)`
1. `process.stdin.setRawMode(false)` — switch to line mode
2. Show prompt line: `  Enter notes (max 500 chars, Enter to confirm): `
3. `readline.createInterface` for one line of input
4. Restore `process.stdin.setRawMode(true)` after
5. Trim; if empty → `state.notes = undefined`; if >500 chars → truncate + `renderWarning`

---

## 8. Entry Point (`scripts/eval/label-gold.ts`)

```typescript
// Usage: npx tsx scripts/eval/label-gold.ts --input <path> --output <path> [--limit <N>]
```

**Startup checks**:
1. Parse argv (manual, no new deps): require `--input` and `--output`
2. Check `process.stdin.isTTY` — if false, print error + exit 1
3. Check input file readable — if not, print error + exit 1
4. `fs.mkdirSync(path.dirname(outputPath), { recursive: true })` — auto-create output dir

**stdin setup**:
```typescript
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');   // NOT binary — Buffer needed for raw mode

// Ctrl+C handler (backup, in case keyToAction check misses it)
process.on('SIGINT', () => {
  process.stdin.setRawMode(false);
  process.exit(0);
});
```

**Exit**: always restore `process.stdin.setRawMode(false)` before any `process.exit()`.

**`readOneKey()` helper** (used by session):
```typescript
async function readOneKey(): Promise<Buffer> {
  return new Promise(resolve => {
    process.stdin.once('data', (chunk) => resolve(Buffer.from(chunk)));
  });
}
```

---

## 9. tsconfig Change

Current `tsconfig.json` has `include: ["src/**/*"]` and `rootDir: "src"`. Scripts live outside `src/`. `npx tsc --noEmit` currently ignores scripts/.

**Change**: Add `"scripts/**/*"` to `include`. Do NOT add `test/**/*` (test is already excluded, vitest handles it with its own config). Do NOT change `rootDir` — would break dist output path calculations.

```json
{
  "include": ["src/**/*", "scripts/**/*"]
}
```

This lets `tsc --noEmit` type-check scripts while keeping `outDir: "dist"` pointing at src output only.

**Note**: `noUnusedLocals` and `noUnusedParameters` are `true` in root tsconfig. Scripts must not have unused imports/parameters.

---

## 10. gitignore Changes

Current `.gitignore` relevant section:
```
data/
!src/data/
# R6.1 evaluation data (local-only, group chat history not committed)
!data/eval/
data/eval/*.jsonl
data/eval/*.json
```

`data/eval/gold/` is blocked by `data/` ignore and NOT un-ignored by `!data/eval/` (that un-ignores the dir itself but not subdirectories). Add:

```gitignore
!data/eval/gold/
data/eval/gold/*.jsonl
```

This un-ignores the `gold/` subdirectory so git doesn't refuse to create it, and explicitly ignores the JSONL files within it.

---

## 11. Test Contract (`test/eval/gold-label-cli.test.ts`)

Framework: **Vitest 2.x** (already installed). Pattern follows `test/eval/sample-benchmark.test.ts`.

Do NOT use real stdin. Mock via a readable stream or direct function calls into session internals. Prefer testing `writer.ts`, `reader.ts`, `session.ts` at the function level — not the CLI entry point.

Use `os.tmpdir()` for output files. Clean up in `afterEach`.

### TC-1: Label 5 samples (happy path)
```
- Create 5-line input JSONL (synthetic SampleRecord)
- Simulate: decision=r, act=1 per sample (5 times)
- readExistingLabels(output) → Map with 5 entries
- All goldDecision=reply, goldAct=direct_chat
- labeledAt is valid ISO string
```

### TC-2: Resume — label 3, restart, label remaining 2
```
- Run 1: label samples 1–3, quit on sample 4
- Run 2: same output file
- readExistingLabels → sampleIds 1-3 present
- Reader skips 1-3; presents 4 and 5
- Final output: 5 entries, no duplicates
```

### TC-3: Skip (`k`)
```
- 3 samples; skip sample 2 (k), label 1 and 3
- readExistingLabels → Map size 2; sampleId-2 absent
- stats.skipped === 1
```

### TC-4: Edit previous — overwrite by sampleId
```
- Label sample 1 (act=direct_chat, decision=reply)
- Edit: change to act=chime_in
- updateLabel called
- readExistingLabels → Map size 1; entry has goldAct=chime_in
- No duplicate lines in output file
```

### TC-5: Malformed input line
```
- Input: 5 lines, line 3 is "{bad json"
- 4 samples presented (valid ones), no crash
- Warning logged to stderr
- Output has up to 4 entries
```

### TC-6: End of input — exit 0
```
- 3 samples; label all 3
- session returns stats with labeled=3, skipped=0
- No error thrown
```

### TC-7: Output file absent on first run
```
- appendLabel with non-existent path
- File created, 1 entry written
- readExistingLabels → Map size 1
```

### TC-8: Duplicate sampleId in input
```
- Input: sample-1 appears at line 1 and line 4
- Only presented once (line 4 silently dropped by reader dedup)
- Output has 1 entry for sample-1
```

### TC-9: Edge — `e` on first sample (history empty)
```
- No labels written yet
- handleEdit called with empty history
- Returns immediately (no crash, no state change)
```

### TC-10: `--limit` cap
```
- Input: 10 samples
- limit=3
- Session presents exactly 3 samples
- Returns after 3 presented regardless of remaining input
```

### TC-11: Notes — empty input stays undefined
```
- promptNotes called with empty string input
- state.notes === undefined (not "")
```

### TC-12: Notes — truncation
```
- Input: 600-char string
- state.notes has length 500
- Warning emitted
```

---

## 12. Dependency Check

| Package | Status |
|---------|--------|
| `vitest` | Already installed at ^2.1.2 — do NOT add again |
| `@vitest/coverage-v8` | Already installed |
| `node:readline` | stdlib — no install |
| `node:fs/promises` | stdlib — no install |
| `node:path` | stdlib — no install |
| `node:os` | stdlib — no install (used in tests for tmpdir) |

**Zero new npm deps (runtime or dev).**

---

## 13. Iteration Contract

| Item | Decision |
|------|----------|
| Commit trigger | Auto on act+decision both set (order irrelevant) |
| `e` depth | Last 5 labels (mini-list), not just 1 |
| Quit guard | Two-`q` confirmation, 3s timeout |
| notes empty | `undefined`, not `""` |
| notes max | 500 chars, truncate with warning |
| tsconfig | Add `"scripts/**/*"` to include; keep rootDir=src |
| Vitest version | 2.x (existing) — no change to package.json |
| gitignore | Add `!data/eval/gold/` + `data/eval/gold/*.jsonl` |
| Progress output | Rendered in main ANSI screen (stdout); session stats to stdout on completion |
| stdin restore | Always `setRawMode(false)` before any exit |
| Import extensions | `.js` required (NodeNext moduleResolution) |

Developer must acknowledge this contract before coding.
