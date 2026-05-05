# R4.5 Gold Set — Curation Runbook

Output path: `data/eval/gold/r4-5-utterance-act-gold-200.jsonl` (gitignored;
local-only). The gates CLI (`scripts/eval/r4-5-shadow-gates.ts`) reads it as
the gate-2 distribution comparison source.

Human-labelling is out-of-band. Until it's complete, gate-2 metrics for
production are not auditable — Reviewer should flag any gate report that ran
against an unlabelled or stub gold set.

## How to populate

1. Run the curator against a production DB snapshot:
   ```
   npx tsx scripts/eval/r4-5-curate-gold.ts data/bot.db data/eval/gold/r4-5-utterance-act-gold-200.jsonl
   ```
2. Open `data/eval/gold/r4-5-utterance-act-gold-200.jsonl`. Every row has `gold: null`.
3. Human-edit each row's `gold` field to one of:
   `direct_chat | chime_in | conflict_handle | summarize | bot_status_query | relay | meta_admin_status | object_react`.
4. After ALL 200 rows have non-null `gold`, the file is ready for gate CLI consumption.

## Schema (locked, DESIGN §10.2)

```jsonl
{"event_id":184234,"group_id":"958751334","trigger_msg_id":"12345","trigger_user_id":"987654321","trigger_content":"...","recent5":[{"user_id":"111","content":"..."},...],"rule_based":"chime_in","gold":"object_react","captured_at_sec":1746200000,"stratum":"oversample_image","notes":"..."}
```

Required keys: `event_id`, `trigger_msg_id`, `trigger_content`, `recent5`, `rule_based`, `gold`.

## Stratification (locked, DESIGN §10.3)

| Stratum | N |
|---|---|
| chime_in | 80 |
| direct_chat | 30 |
| meta_admin_status | 25 |
| relay | 15 |
| bot_status_query | 10 |
| oversample_image (chime_in + CQ:image/mface) | 20 |
| oversample_conflict (chime_in + 吵/怼/杠/撕) | 10 |
| oversample_summary (chime_in + 前情/复盘/啥情况/总结) | 10 |
| **total** | **200** |

## Status

Not yet curated. Gate CLI gate-2 distribution comparison MUST use this gold set
once labelled. Until then, `--gold` arg can point to a synthetic fixture for
gate CLI smoke-test purposes only — the production gate report requires the
real labelled set.
