#!/usr/bin/env tsx
/**
 * R6.1 Benchmark Sampler
 *
 * Usage:
 *   npx tsx scripts/eval/sample-benchmark.ts \
 *     --db-path /path/to/bot.db \
 *     --group-id <groupId> \
 *     --bot-qq <botQQ> \
 *     --seed 42 \
 *     --per-category-target 250 \
 *     --output-dir data/eval
 *
 * Outputs (gitignored):
 *   <output-dir>/benchmark-raw.jsonl
 *   <output-dir>/benchmark-weak-labeled.jsonl
 *   <output-dir>/summary.json
 *
 * Exit codes: 0=success, 1=DB not found, 2=no rows sampled, 3=write error
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { SampledRow, ContextMessage, DbRow } from './types.js';
import { CATEGORY_LABELS } from './types.js';
import { seededSample } from './seed.js';
import {
  queryCat1, queryCat2, queryCat3, queryCat4, queryCat5,
  queryCat6, queryCat7, queryCat8, queryCat9, queryCat10,
} from './categories/index.js';
import { applyWeakLabel } from './weak-label.js';
import { buildSummary } from './summary.js';

export { CATEGORY_LABELS };

interface CliArgs {
  dbPath: string;
  groupId: string;
  botQQ: string;
  seed: number;
  perCategoryTarget: number;
  outputDir: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let dbPath = '';
  let groupId = '';
  let botQQ = '';
  let seed = 42;
  let perCategoryTarget = 250;
  let outputDir = 'data/eval';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--db-path' && args[i + 1]) dbPath = args[++i]!;
    else if (args[i] === '--group-id' && args[i + 1]) groupId = args[++i]!;
    else if (args[i] === '--bot-qq' && args[i + 1]) botQQ = args[++i]!;
    else if (args[i] === '--seed' && args[i + 1]) seed = parseInt(args[++i]!, 10);
    else if (args[i] === '--per-category-target' && args[i + 1]) perCategoryTarget = parseInt(args[++i]!, 10);
    else if (args[i] === '--output-dir' && args[i + 1]) outputDir = args[++i]!;
  }

  if (!dbPath) {
    console.error('Missing --db-path');
    process.exit(1);
  }
  if (!groupId) {
    console.error('Missing --group-id');
    process.exit(1);
  }

  return { dbPath, groupId, botQQ, seed, perCategoryTarget, outputDir };
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function fetchContext(
  db: DatabaseSync,
  groupId: string,
  rowId: number,
): { before: ContextMessage[]; after: ContextMessage[] } {
  const before = (db.prepare(`
    SELECT id, user_id, nickname, content, timestamp
    FROM messages
    WHERE group_id = ? AND id < ? AND deleted = 0
    ORDER BY id DESC LIMIT 5
  `).all(groupId, rowId) as Array<{ id: number; user_id: string; nickname: string; content: string; timestamp: number }>)
    .reverse()
    .map(r => ({ id: r.id, userId: r.user_id, nickname: r.nickname, content: r.content, timestamp: r.timestamp }));

  const after = (db.prepare(`
    SELECT id, user_id, nickname, content, timestamp
    FROM messages
    WHERE group_id = ? AND id > ? AND deleted = 0
    ORDER BY id ASC LIMIT 3
  `).all(groupId, rowId) as Array<{ id: number; user_id: string; nickname: string; content: string; timestamp: number }>)
    .map(r => ({ id: r.id, userId: r.user_id, nickname: r.nickname, content: r.content, timestamp: r.timestamp }));

  return { before, after };
}

function dbRowToSampledRow(
  row: DbRow,
  context: { before: ContextMessage[]; after: ContextMessage[] },
  category: number,
  seed: number,
): SampledRow {
  return {
    id: `${row.group_id}:${row.id}`,
    groupId: row.group_id,
    messageId: row.id,
    sourceMessageId: row.source_message_id,
    userId: row.user_id,
    nickname: row.nickname,
    timestamp: row.timestamp,
    content: row.content,
    rawContent: row.raw_content,
    triggerContext: context.before,
    triggerContextAfter: context.after,
    category,
    categoryLabel: CATEGORY_LABELS[category - 1]!,
    samplingSeed: seed,
    contentHash: contentHash(row.content),
  };
}

function getCategoryRows(db: DatabaseSync, cat: number, groupId: string, botQQ: string, limit: number): DbRow[] {
  switch (cat) {
    case 1: return queryCat1(db, groupId, botQQ, limit);
    case 2: return queryCat2(db, groupId, limit);
    case 3: return queryCat3(db, groupId, limit);
    case 4: return queryCat4(db, groupId, limit);
    case 5: return queryCat5(db, groupId, limit);
    case 6: return queryCat6(db, groupId, limit);
    case 7: return queryCat7(db, groupId, limit);
    case 8: return queryCat8(db, groupId, limit);
    case 9: return queryCat9(db, groupId, limit);
    case 10: return queryCat10(db, groupId, limit);
    default: return [];
  }
}

export async function runSampling(args: CliArgs): Promise<{ rawRows: SampledRow[]; exitCode: number }> {
  const { dbPath, groupId, botQQ, seed, perCategoryTarget, outputDir } = args;

  if (!existsSync(dbPath)) {
    console.error(`DB not found: ${dbPath}`);
    return { rawRows: [], exitCode: 1 };
  }

  const db = new DatabaseSync(dbPath, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);
  const limit = perCategoryTarget * 5;
  const seen = new Set<number>();
  const rawRows: SampledRow[] = [];

  for (let cat = 1; cat <= 10; cat++) {
    const candidates = getCategoryRows(db, cat, groupId, botQQ, limit);

    // Deduplicate across categories — first category wins
    const fresh = candidates.filter(r => !seen.has(r.id));
    const sampled = seededSample(
      fresh.map(r => ({ ...r, messageId: r.id })),
      seed,
      perCategoryTarget,
    );

    for (const row of sampled) {
      seen.add(row.id);
      const ctx = fetchContext(db, groupId, row.id);
      rawRows.push(dbRowToSampledRow(row as DbRow, ctx, cat, seed));
    }

    console.log(`Cat ${cat} (${CATEGORY_LABELS[cat - 1]}): ${sampled.length} sampled`);
  }

  if (rawRows.length === 0) {
    console.error('No rows sampled — check --group-id and DB content');
    db.close();
    return { rawRows: [], exitCode: 2 };
  }

  // Apply weak labels (filter out admin commands)
  const labeledRows = rawRows
    .map(r => applyWeakLabel(r, db, botQQ))
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const summary = buildSummary(rawRows, labeledRows, seed, perCategoryTarget);

  try {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      path.join(outputDir, 'benchmark-raw.jsonl'),
      rawRows.map(r => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    );
    writeFileSync(
      path.join(outputDir, 'benchmark-weak-labeled.jsonl'),
      labeledRows.map(r => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    );
    writeFileSync(
      path.join(outputDir, 'summary.json'),
      JSON.stringify(summary, null, 2),
      'utf8',
    );
  } catch (err) {
    console.error('Write error:', err);
    db.close();
    return { rawRows, exitCode: 3 };
  }

  db.close();

  console.log(`\nTotal sampled: ${rawRows.length}`);
  console.log(`Total labeled: ${labeledRows.length}`);
  console.log(`Summary written to ${path.join(outputDir, 'summary.json')}`);

  return { rawRows, exitCode: 0 };
}

// Run when executed directly
const isMain = process.argv[1]?.includes('sample-benchmark');
if (isMain) {
  const args = parseArgs(process.argv);
  runSampling(args).then(({ exitCode }) => process.exit(exitCode));
}
