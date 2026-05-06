# C-3 Replay Smoke — 2026-05-06

Branch: feat/r9-c3-alias-fuzzy
Commit: (see git log)
Runner version: r6.4.0
LLM mode: mock

## Command

```
tsx D:/QQ-Group-Bot/.claude/worktrees/r9-c3-alias-fuzzy/scripts/eval/replay-runner.ts \
  --gold test/fixtures/replay-gold-synthetic.jsonl \
  --benchmark test/fixtures/replay-benchmark-synthetic.jsonl \
  --output-dir /tmp/c3-replay-out \
  --llm-mode mock \
  --prod-db test/fixtures/replay-prod-db-synthetic.sqlite \
  --bot-qq 12345 \
  --group-id g1 \
  --limit 30
```

## Counts

- totalRows: 2
- errorRows: 0
- elapsed: 0.02s
- compliance (silence/defer): 1.0 (1/1)
- mockClaudeCalls: 0 (mock mode — no real LLM)

## CJK-alias rows in fixture

**0 / 2 rows contain CJK-variant meme_graph entries.**

The synthetic fixture (`replay-prod-db-synthetic.sqlite`) does not seed any meme_graph
rows with CJK typo variants (e.g. canonical=羊宫妃娜, variants=[羊宫妃那]). This is the
same fixture gap as C-1 and C-2 smoke runs. As a result, the C-3 CJK-variant expansion
path was NOT exercised in this replay run.

**hasRealFactHit on CJK-alias rows: N/A — 0 eligible rows in fixture.**

The authoritative end-to-end proof for C-3 is unit test A1 in
`test/extract-candidate-terms-cjk-alias.test.ts`, which seeds both meme_graph rows
and a learned_facts row in-memory and verifies that `findActiveByTopicTerm(g1,'羊宫妃娜')`
returns >= 1 hit after querying `羊宫妃那是谁`.

## Production note

Code ships with C-3 PR. CJK-typo variant rows in production meme_graph must be manually
seeded per entity (e.g. `canonical='羊宫妃娜', variants=['羊宫妃那']`). The C-3 code
path is entity-agnostic and will activate for any meme_graph row with CJK variants once
seeded.
