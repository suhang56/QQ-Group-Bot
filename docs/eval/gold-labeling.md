# R6.2 — Gold-label CLI

Human labeler for the R6.1c weak-labeled benchmark output. Produces
`data/eval/gold/*.jsonl` where each line is a `GoldLabel` record.

## Usage

```bash
npx tsx scripts/eval/label-gold.ts \
  --input data/eval/r6-1c/benchmark-weak-labeled.jsonl \
  --output data/eval/gold/gold-500.jsonl \
  --limit 500
```

Flags:

- `--input` (required) — path to R6.1c benchmark-weak-labeled.jsonl
- `--output` (required) — path to append-mode gold JSONL; directory is auto-created
- `--limit` (optional) — max samples to present (labeled + skipped combined)

Must be run in a TTY (interactive terminal). Piped stdin exits with error.

## Interactive keystrokes

| Key | Action |
|-----|--------|
| `r` / `s` / `d` | decision = reply / silent / defer |
| `1` – `9` | act = direct_chat / chime_in / conflict_handle / summarize / bot_status_query / relay / meta_admin_status / object_react / silence |
| `t` | toggle targetOk |
| `f` | toggle factNeeded |
| `b` | toggle allowSticker |
| `B` | toggle allowBanter (capital — avoids collision with `b`) |
| `n` | enter free-text notes (max 500 chars) |
| `k` | skip sample (not written to output) |
| `e` | edit one of the last 5 labels |
| `q` | quit (press `q` again within 3s to confirm) |
| `Ctrl+C` | quit immediately |

The current label auto-commits as soon as BOTH `goldAct` and `goldDecision`
are set. Other toggles and notes can be flipped before the last of those two
keys is pressed.

## Resume semantics

- Output is append-mode JSONL.
- On startup the tool reads all existing labels, builds a `Set<sampleId>`,
  and skips any input samples already labeled.
- Use `e` to revisit one of the last 5 labeled samples; its JSONL line is
  overwritten atomically (temp file + rename).

## GoldLabel schema

```ts
interface GoldLabel {
  sampleId: string;
  goldAct: 'direct_chat' | 'chime_in' | 'conflict_handle' | 'summarize'
         | 'bot_status_query' | 'relay' | 'meta_admin_status'
         | 'object_react' | 'silence';
  goldDecision: 'reply' | 'silent' | 'defer';
  targetOk: boolean;
  factNeeded: boolean;
  allowBanter: boolean;
  allowSticker: boolean;
  notes?: string;      // omitted from JSONL when unset
  labeledAt: string;   // ISO 8601, set by writer
}
```

## Out of scope (R6.2)

- No `generateReply` / LLM / DB calls.
- No replay runner — R6.3 consumes the gold JSONL.
- No metrics dashboard / web UI.
- Output files are gitignored; only scripts, docs, and tests are committed.
