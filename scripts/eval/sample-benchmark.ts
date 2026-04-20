#!/usr/bin/env tsx
/**
 * R6.1a Benchmark Sampler
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
import { CATEGORY_LABELS, CATEGORY_PRIORITY_ORDER } from './types.js';
import { seededSample } from './seed.js';
import {
  queryCat1, queryCat2, queryCat3, queryCat4, queryCat5,
  queryCat6, queryCat7, queryCat8, queryCat9, queryCat10,
} from './categories/index.js';
import { CAT2_MAX } from './categories/cat2-known-fact-term.js';
import { applyWeakLabel } from './weak-label.js';
import { buildSummary } from './summary.js';

export { CATEGORY_LABELS };

/** Per-category content-hash cap: same hash may appear at most this many times per category. */
const CONTENT_HASH_CAP_PER_CATEGORY = 5;

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
  let perCategoryTarget = 200;
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

const MEDIA_CQ_RE = /\[CQ:(?:image|mface|face|video|record)[^\]]*\]/g;

/**
 * R6.1b: media-aware content hash.
 *
 * Empty-content media rows (e.g. raw_content = "[CQ:image,file=abc.jpg]")
 * all used to collapse to sha256("") and got capped at 5 per category. That
 * erased 80%+ of cat4 samples (9/50 observed).
 *
 * For rows with media CQ codes, hash a signature extracted from the CQ code
 * (file=, url=, id=, sub_type=) so different images with empty captions get
 * distinct hashes. For non-media rows, hash content (original behaviour).
 */
function extractMediaSignatures(raw: string): string[] {
  const sigs: string[] = [];
  const matches = raw.match(MEDIA_CQ_RE);
  if (!matches) return sigs;
  for (const m of matches) {
    // Pull file=, url=, id=, sub_type= values — any of them individuates the media.
    const parts: string[] = [];
    for (const key of ['file', 'url', 'id', 'sub_type'] as const) {
      const keyRe = new RegExp(`${key}=([^,\\]]+)`);
      const match = keyRe.exec(m);
      if (match?.[1]) parts.push(`${key}:${match[1]}`);
    }
    // Include CQ type as prefix; fall back to full CQ string when no keys parse out.
    const typeMatch = /\[CQ:([a-z]+)/.exec(m);
    const prefix = typeMatch?.[1] ?? 'media';
    sigs.push(parts.length > 0 ? `${prefix}|${parts.join('|')}` : m);
  }
  return sigs;
}

function makeContentHash(content: string, rawContent?: string | null): string {
  const raw = rawContent ?? '';
  const sigs = raw ? extractMediaSignatures(raw) : [];
  // If media CQ is present, prefer its signatures + content (so captioned
  // images still differ by caption). Otherwise hash content alone.
  const hashInput = sigs.length > 0 ? `${content}\x02${sigs.join('\x03')}` : content;
  return createHash('sha256').update(hashInput).digest('hex').slice(0, 16);
}

function makeContextHash(content: string, contextBefore: ContextMessage[]): string {
  const contextStr = contextBefore.map(c => c.content).join('\x00');
  return createHash('sha256').update(content + '\x01' + contextStr).digest('hex').slice(0, 16);
}

function fetchContext(
  db: DatabaseSync,
  groupId: string,
  rowId: number,
): { before: ContextMessage[]; after: ContextMessage[] } {
  type CtxRow = {
    id: number;
    user_id: string;
    nickname: string;
    content: string;
    raw_content: string | null;
    timestamp: number;
  };

  const before = (db.prepare(`
    SELECT id, user_id, nickname, content, raw_content, timestamp
    FROM messages
    WHERE group_id = ? AND id < ? AND deleted = 0
    ORDER BY id DESC LIMIT 5
  `).all(groupId, rowId) as CtxRow[])
    .reverse()
    .map(r => ({
      id: r.id,
      userId: r.user_id,
      nickname: r.nickname,
      content: r.content,
      rawContent: r.raw_content,
      timestamp: r.timestamp,
    }));

  const after = (db.prepare(`
    SELECT id, user_id, nickname, content, raw_content, timestamp
    FROM messages
    WHERE group_id = ? AND id > ? AND deleted = 0
    ORDER BY id ASC LIMIT 3
  `).all(groupId, rowId) as CtxRow[])
    .map(r => ({
      id: r.id,
      userId: r.user_id,
      nickname: r.nickname,
      content: r.content,
      rawContent: r.raw_content,
      timestamp: r.timestamp,
    }));

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
    contentHash: makeContentHash(row.content, row.raw_content),
    contextHash: makeContextHash(row.content, context.before),
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

/**
 * For each message, check which category predicates it matches (before primary-priority assignment).
 * Returns a Map<messageId, Set<category>> for overlap matrix computation.
 */
function computeCategoryMembership(
  db: DatabaseSync,
  groupId: string,
  botQQ: string,
  limit: number,
): Map<number, Set<number>> {
  const membership = new Map<number, Set<number>>();
  for (let cat = 1; cat <= 10; cat++) {
    const rows = getCategoryRows(db, cat, groupId, botQQ, limit);
    for (const row of rows) {
      const set = membership.get(row.id) ?? new Set<number>();
      set.add(cat);
      membership.set(row.id, set);
    }
  }
  return membership;
}

export async function runSampling(args: CliArgs): Promise<{ rawRows: SampledRow[]; exitCode: number }> {
  const { dbPath, groupId, botQQ, seed, perCategoryTarget, outputDir } = args;

  if (!existsSync(dbPath)) {
    console.error(`DB not found: ${dbPath}`);
    return { rawRows: [], exitCode: 1 };
  }

  const db = new DatabaseSync(dbPath, { readOnly: true } as Parameters<typeof DatabaseSync>[1]);

  // oversample factor: fetch 3× target so after dedupe we still have enough candidates
  const limit = perCategoryTarget * 3;

  // R6.1a: compute category membership for overlap matrix BEFORE primary-priority dedupe
  const membership = computeCategoryMembership(db, groupId, botQQ, limit);

  // R6.1a: compute overlap matrix (catA → catB → count of msgs that matched both)
  const overlapMatrix: Record<number, Record<number, number>> = {};
  for (const cats of membership.values()) {
    const catArr = [...cats];
    for (const a of catArr) {
      for (const b of catArr) {
        if (a === b) continue;
        if (!overlapMatrix[a]) overlapMatrix[a] = {};
        overlapMatrix[a]![b] = (overlapMatrix[a]![b] ?? 0) + 1;
      }
    }
  }

  // R6.1a: primary-priority dedupe — process categories in priority order
  // A message is assigned to the first (highest-priority) category that claims it.
  const globalAssigned = new Set<number>(); // messageId
  const categoryResults = new Map<number, SampledRow[]>();

  for (const cat of CATEGORY_PRIORITY_ORDER) {
    // cat2 target is capped at CAT2_MAX
    const catTarget = cat === 2 ? Math.min(perCategoryTarget, CAT2_MAX) : perCategoryTarget;

    const allCandidates = getCategoryRows(db, cat, groupId, botQQ, limit);

    // Filter out already-assigned from prior priority categories
    const fresh = allCandidates.filter(r => !globalAssigned.has(r.id));

    // Per-category content-hash cap: at most CONTENT_HASH_CAP_PER_CATEGORY rows per hash
    // R6.1b: same media-aware hash as SampledRow.contentHash — empty-content media
    // rows no longer collapse to a single hash.
    const hashCountInCat = new Map<string, number>();
    const capped = fresh.filter(r => {
      const h = makeContentHash(r.content, r.raw_content);
      const count = hashCountInCat.get(h) ?? 0;
      if (count >= CONTENT_HASH_CAP_PER_CATEGORY) return false;
      hashCountInCat.set(h, count + 1);
      return true;
    });

    const sampled = seededSample(
      capped.map(r => ({ ...r, messageId: r.id })),
      seed,
      catTarget,
    );

    const rows: SampledRow[] = [];
    for (const row of sampled) {
      globalAssigned.add(row.id);
      const ctx = fetchContext(db, groupId, row.id);
      rows.push(dbRowToSampledRow(row as DbRow, ctx, cat, seed));
    }

    categoryResults.set(cat, rows);
    console.log(`Cat ${cat} (${CATEGORY_LABELS[cat - 1]}): ${rows.length} sampled`);
  }

  // Reassemble in natural category order 1–10 for output
  const rawRows: SampledRow[] = [];
  for (let cat = 1; cat <= 10; cat++) {
    rawRows.push(...(categoryResults.get(cat) ?? []));
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

  const summary = buildSummary(rawRows, labeledRows, seed, perCategoryTarget, overlapMatrix);

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
