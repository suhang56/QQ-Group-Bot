#!/usr/bin/env tsx
/**
 * R6.3 — Build the minimal synthetic sqlite fixture used by
 * test/eval/replay-runner-mock.test.ts and by the smoke runbook.
 *
 * Idempotent: if the target file exists it's replaced. Schema is seeded by
 * the real Database class, which runs src/storage/schema.sql on open, so
 * any schema drift post-merge is picked up automatically when this script
 * is re-run (`npm run gen:replay-fixture` — manual step, see
 * docs/eval/replay-runner.md).
 *
 * Usage:
 *   cross-env NODE_OPTIONS=--experimental-sqlite tsx scripts/eval/build-synthetic-replay-db.ts \
 *     [--output test/fixtures/replay-prod-db-synthetic.sqlite]
 */

import fs from 'node:fs';
import path from 'node:path';
import { Database } from '../../src/storage/db.js';

const DEFAULT_OUTPUT = path.resolve('test/fixtures/replay-prod-db-synthetic.sqlite');

function parseOutput(argv: string[]): string {
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) return path.resolve(args[i + 1]!);
  }
  return DEFAULT_OUTPUT;
}

export function buildSyntheticReplayDb(outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // Replace any stale fixture (incl. sqlite WAL siblings).
  for (const p of [outPath, `${outPath}-shm`, `${outPath}-wal`, `${outPath}-journal`]) {
    try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
  }

  const db = new Database(outPath);

  // Seed two messages that match the synthetic gold/benchmark fixtures.
  // sampleIds: '958751334:9001' (silent row) and '958751334:9002' (reply row)
  db.messages.insert(
    {
      groupId: '958751334',
      userId: 'U1001',
      nickname: '张三',
      content: '今天天气真好',
      rawContent: '今天天气真好',
      timestamp: 1_713_000_000,
      deleted: false,
    },
    'src-9001',
  );
  db.messages.insert(
    {
      groupId: '958751334',
      userId: 'U1002',
      nickname: '李四',
      content: '有人在吗',
      rawContent: '有人在吗',
      timestamp: 1_713_000_060,
      deleted: false,
    },
    'src-9002',
  );

  // Note: rawDb is exposed, DatabaseSync has .close(). Skip if unavailable.
  try {
    (db as unknown as { rawDb?: { close?: () => void } }).rawDb?.close?.();
  } catch { /* ignore */ }
}

function main(): void {
  const out = parseOutput(process.argv);
  buildSyntheticReplayDb(out);
  process.stderr.write(`synthetic replay fixture written: ${out}\n`);
}

const arg1 = process.argv[1] ?? '';
if (arg1.endsWith('build-synthetic-replay-db.ts') || arg1.endsWith('build-synthetic-replay-db.js')) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  }
}
