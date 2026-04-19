#!/usr/bin/env tsx
/**
 * R6.1 Benchmark Sampler
 *
 * Usage:
 *   npx tsx scripts/eval/sample-benchmark.ts \
 *     --db-path /path/to/bot.db \
 *     --seed <hex-string> \
 *     --per-category-target 250 \
 *     --output-dir data/eval \
 *     [--bot-user-id <qq-id>]
 *
 * Outputs (all in --output-dir):
 *   benchmark-raw.jsonl
 *   benchmark-weak-labeled.jsonl
 *   summary.json
 *
 * Do NOT commit *.jsonl or *.json outputs (see .gitignore).
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  BenchmarkRow,
  ContextMsg,
  DbMessageRow,
  SamplingCategory,
  SamplingConfig,
} from './types.js';
import { ALL_CATEGORIES, CONTEXT_BEFORE, CONTEXT_AFTER } from './types.js';
import { isDirectAtReply } from './categories/direct-at-reply.js';
import { hasKnownFactTermInDb } from './categories/known-fact-term.js';
import { isRhetoricalBanter } from './categories/rhetorical-banter.js';
import { isImageMface } from './categories/image-mface.js';
import { isBotStatusContext } from './categories/bot-status-context.js';
import { isBurstNonDirect } from './categories/burst-non-direct.js';
import { isRelayRepeater } from './categories/relay-repeater.js';
import { isConflictHeat } from './categories/conflict-heat.js';
import { isNormalChimeCandidate } from './categories/normal-chime-candidate.js';
import { isSilenceCandidate } from './categories/silence-candidate.js';
import { applyWeakLabel } from './weak-label.js';
import { buildSummary } from './summary.js';

// ---- CLI arg parsing ----

function parseArgs(argv: string[]): SamplingConfig {
  const args = argv.slice(2);
  let dbPath = '';
  let seed = '';
  let perCategoryTarget = 250;
  let outputDir = 'data/eval';
  let botUserId = '0';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--db-path' && args[i + 1]) dbPath = args[++i]!;
    else if (args[i] === '--seed' && args[i + 1]) seed = args[++i]!;
    else if (args[i] === '--per-category-target' && args[i + 1]) perCategoryTarget = parseInt(args[++i]!, 10);
    else if (args[i] === '--output-dir' && args[i + 1]) outputDir = args[++i]!;
    else if (args[i] === '--bot-user-id' && args[i + 1]) botUserId = args[++i]!;
  }

  if (!dbPath) {
    console.error('Usage: sample-benchmark.ts --db-path <path> [--seed <hex>] [--per-category-target N] [--output-dir dir] [--bot-user-id id]');
    process.exit(1);
  }
  if (!seed) {
    seed = randomBytes(16).toString('hex');
    console.log(`No seed provided — generated: ${seed}`);
  }

  return { dbPath, seed, perCategoryTarget, outputDir, botUserId };
}

// ---- Deterministic pseudo-random using seed ----

/**
 * Deterministic row-level RNG: sha256(seed:rowId) → BigInt → float in [0,1).
 * Same seed+rowId always produces the same value, enabling reproducible sampling.
 */
function deterministicRandom(seed: string, rowId: string): number {
  const hash = createHash('sha256').update(`${seed}:${rowId}`).digest('hex');
  const val = BigInt('0x' + hash.slice(0, 16));
  return Number(val) / Number(BigInt('0xffffffffffffffff'));
}

// ---- DB query helpers ----

function dbRowToContextMsg(r: DbMessageRow): ContextMsg {
  return {
    messageId: String(r.id),
    userId: r.user_id,
    nickname: r.nickname,
    timestamp: r.timestamp,
    content: r.content,
    rawContent: r.raw_content ?? r.content,
  };
}

function fetchContext(
  db: DatabaseSync,
  groupId: string,
  rowId: number,
  timestamp: number,
): { before: ContextMsg[]; after: ContextMsg[] } {
  const before = (db.prepare(
    `SELECT id, group_id, user_id, nickname, content, raw_content, timestamp, source_message_id
     FROM messages
     WHERE group_id = ? AND id < ? AND deleted = 0
     ORDER BY id DESC
     LIMIT ${CONTEXT_BEFORE}`
  ).all(groupId, rowId) as DbMessageRow[]).reverse().map(dbRowToContextMsg);

  const after = (db.prepare(
    `SELECT id, group_id, user_id, nickname, content, raw_content, timestamp, source_message_id
     FROM messages
     WHERE group_id = ? AND id > ? AND deleted = 0
     ORDER BY id ASC
     LIMIT ${CONTEXT_AFTER}`
  ).all(groupId, rowId) as DbMessageRow[]).map(dbRowToContextMsg);

  return { before, after };
}

// ---- Category assignment ----

function assignCategory(
  row: DbMessageRow,
  context: ContextMsg[],
  db: DatabaseSync,
  botUserId: string,
): SamplingCategory | null {
  if (isDirectAtReply(row, botUserId)) return 'direct_at_reply';
  if (hasKnownFactTermInDb(db, row)) return 'known_fact_term';
  if (isRelayRepeater(row, context)) return 'relay_repeater';
  if (isConflictHeat(row, context)) return 'conflict_heat';
  if (isBotStatusContext(row, context)) return 'bot_status_context';
  if (isImageMface(row)) return 'image_mface';
  if (isBurstNonDirect(row, context, botUserId)) return 'burst_non_direct';
  if (isRhetoricalBanter(row)) return 'rhetorical_banter';
  if (isSilenceCandidate(row, context)) return 'silence_candidate';
  if (isNormalChimeCandidate(row, context)) return 'normal_chime_candidate';
  return null;
}

// ---- UUID v4 stable per (groupId+messageId) ----

function stableUuid(seed: string, groupId: string, messageId: string): string {
  const hash = createHash('sha256').update(`${seed}:${groupId}:${messageId}`).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    ((parseInt(hash.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}

// ---- Main sampling loop ----

async function main(): Promise<void> {
  const config = parseArgs(process.argv);
  const { dbPath, seed, perCategoryTarget, outputDir, botUserId = '0' } = config;

  if (!existsSync(dbPath)) {
    console.error(`DB not found: ${dbPath}`);
    process.exit(1);
  }

  mkdirSync(outputDir, { recursive: true });

  const db = new DatabaseSync(dbPath, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);

  // Fetch all non-deleted messages, ordered by ID descending (recent-leaning)
  const allRows = db.prepare(
    `SELECT id, group_id, user_id, nickname, content, raw_content, timestamp, source_message_id
     FROM messages
     WHERE deleted = 0
     ORDER BY id DESC`
  ).all() as DbMessageRow[];

  console.log(`Total messages: ${allRows.length}`);

  const buckets: Map<SamplingCategory, BenchmarkRow[]> = new Map(
    ALL_CATEGORIES.map(cat => [cat, []])
  );
  const categoryCounts: Map<SamplingCategory, number> = new Map(
    ALL_CATEGORIES.map(cat => [cat, 0])
  );

  let processed = 0;
  for (const row of allRows) {
    // Check if all buckets are full — early exit
    const allFull = ALL_CATEGORIES.every(
      cat => (categoryCounts.get(cat) ?? 0) >= perCategoryTarget
    );
    if (allFull) break;

    const { before, after } = fetchContext(db, row.group_id, row.id, row.timestamp);
    const category = assignCategory(row, before, db, botUserId);
    if (!category) { processed++; continue; }

    const catCount = categoryCounts.get(category) ?? 0;
    if (catCount >= perCategoryTarget) { processed++; continue; }

    // Deterministic accept/reject via pseudo-random
    const rand = deterministicRandom(seed, `${row.group_id}:${row.id}`);
    // Always accept if bucket under 80% full; otherwise use random gate to spread coverage
    const threshold = catCount < perCategoryTarget * 0.8 ? 1.0 : 0.5;
    if (rand > threshold) { processed++; continue; }

    const benchmarkRow: BenchmarkRow = {
      id: stableUuid(seed, row.group_id, String(row.id)),
      groupId: row.group_id,
      messageId: String(row.id),
      userId: row.user_id,
      nickname: row.nickname,
      timestamp: row.timestamp,
      content: row.content,
      rawContent: row.raw_content ?? row.content,
      triggerContext: before,
      triggerContextAfter: after,
      category,
      samplingSeed: seed,
    };

    buckets.get(category)!.push(benchmarkRow);
    categoryCounts.set(category, catCount + 1);
    processed++;

    if (processed % 10000 === 0) {
      const totals = ALL_CATEGORIES.map(c => `${c}:${categoryCounts.get(c)}`).join(', ');
      console.log(`Processed ${processed}/${allRows.length} — ${totals}`);
    }
  }

  const rawRows: BenchmarkRow[] = [];
  for (const cat of ALL_CATEGORIES) {
    rawRows.push(...(buckets.get(cat) ?? []));
  }

  console.log(`Sampled ${rawRows.length} rows total`);

  // Write benchmark-raw.jsonl
  const rawPath = path.join(outputDir, 'benchmark-raw.jsonl');
  writeFileSync(rawPath, rawRows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  console.log(`Wrote ${rawPath}`);

  // Apply weak labels
  const historyLength = allRows.length;
  const labeledRows = rawRows.map(row =>
    applyWeakLabel(row, db, botUserId, historyLength)
  );

  const labeledPath = path.join(outputDir, 'benchmark-weak-labeled.jsonl');
  writeFileSync(labeledPath, labeledRows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  console.log(`Wrote ${labeledPath}`);

  // Build and write summary.json
  const summary = buildSummary(rawRows, labeledRows, seed, dbPath, perCategoryTarget);
  const summaryPath = path.join(outputDir, 'summary.json');
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`Wrote ${summaryPath}`);

  console.log('\n--- Summary ---');
  console.log(`Total sampled: ${summary.totalSampled}`);
  console.log(`Total labeled: ${summary.totalLabeled}`);
  if (summary.gaps.undersampled.length > 0) {
    console.log('Undersampled categories:');
    for (const g of summary.gaps.undersampled) {
      console.log(`  ${g.category}: ${g.sampled}/${g.target} (shortfall: ${g.shortfall})`);
    }
  }

  db.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
