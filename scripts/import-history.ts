#!/usr/bin/env tsx
/**
 * Import QQ group chat history from chunked JSONL export into the messages table.
 *
 * Usage:
 *   npx tsx scripts/import-history.ts \
 *     --source-dir "C:/path/to/export" \
 *     --target-group 484787509 \
 *     [--dry-run]
 *
 * Idempotent: re-runs skip duplicate source_message_id rows silently.
 * Timestamps: JSONL uses ms epoch; messages table stores seconds.
 */

import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { Database } from '../src/storage/db.js';

// ---- CLI arg parsing ----

function parseArgs(argv: string[]): { sourceDir: string; targetGroup: string; dryRun: boolean } {
  const args = argv.slice(2);
  let sourceDir = '';
  let targetGroup = '';
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source-dir' && args[i + 1]) { sourceDir = args[++i]!; }
    else if (args[i] === '--target-group' && args[i + 1]) { targetGroup = args[++i]!; }
    else if (args[i] === '--dry-run') { dryRun = true; }
  }

  if (!sourceDir || !targetGroup) {
    console.error('Usage: import-history.ts --source-dir <path> --target-group <group_id> [--dry-run]');
    process.exit(1);
  }

  return { sourceDir, targetGroup, dryRun };
}

// ---- JSONL record types ----

interface JsonlSender {
  uin?: string;
  name?: string;
  groupCard?: string;
}

interface JsonlContent {
  text?: string;
}

export interface JsonlRecord {
  id?: string;
  timestamp?: number;
  sender?: JsonlSender;
  type?: string;
  content?: JsonlContent;
  recalled?: boolean;
  system?: boolean;
}

// ---- Filter logic ----

const KEEP_TYPES = new Set(['text', 'reply']);

export function shouldKeep(record: JsonlRecord): boolean {
  if (record.recalled === true) return false;
  if (record.system === true) return false;
  if (!KEEP_TYPES.has(record.type ?? '')) return false;
  if (!record.sender?.uin) return false;
  const text = record.content?.text?.trim() ?? '';
  if (!text) return false;
  return true;
}

// ---- Stats ----

export interface ImportStats {
  linesRead: number;
  linesKept: number;
  inserted: number;
  skippedDuplicate: number;
  skippedFilter: number;
  errors: number;
}

export function makeStats(): ImportStats {
  return { linesRead: 0, linesKept: 0, inserted: 0, skippedDuplicate: 0, skippedFilter: 0, errors: 0 };
}

// ---- File streaming ----

export async function* streamFileLines(filePath: string): AsyncIterable<string> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  yield* rl;
}

// ---- Core import function ----

export interface ImportDeps {
  db: Database;
  dryRun: boolean;
  targetGroup: string;
  batchSize?: number;
  label?: string;
  onProgress?: (stats: ImportStats) => void;
  progressInterval?: number;
}

export async function importLines(
  lines: AsyncIterable<string>,
  deps: ImportDeps,
  stats: ImportStats
): Promise<void> {
  const { db, dryRun, targetGroup, batchSize = 5000, label = '', onProgress, progressInterval = 10_000 } = deps;

  let txOpen = false;
  let rowsSinceCommit = 0;

  const beginTx = () => { if (!txOpen) { db.exec('BEGIN IMMEDIATE'); txOpen = true; } };
  const commitTx = () => { if (txOpen) { db.exec('COMMIT'); txOpen = false; rowsSinceCommit = 0; } };

  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    stats.linesRead++;

    let record: JsonlRecord;
    try {
      record = JSON.parse(trimmed) as JsonlRecord;
    } catch {
      console.warn(`[WARN] Malformed JSON at line ${stats.linesRead}${label ? ` in ${label}` : ''} — skipping`);
      stats.errors++;
      continue;
    }

    if (!shouldKeep(record)) {
      stats.skippedFilter++;
      continue;
    }

    stats.linesKept++;

    if (!dryRun) {
      const tsSeconds = Math.floor(record.timestamp! / 1000);
      const userId = record.sender!.uin!;
      const nickname = (record.sender!.groupCard || record.sender!.name || userId)!;

      beginTx();
      const inserted = db.messages.insert(
        { groupId: targetGroup, userId, nickname, content: record.content!.text!.trim(), timestamp: tsSeconds, deleted: false },
        record.id!
      );

      if (inserted.id !== 0) {
        stats.inserted++;
        db.users.upsert({ userId, groupId: targetGroup, nickname, styleSummary: null, lastSeen: tsSeconds });
      } else {
        stats.skippedDuplicate++;
      }

      rowsSinceCommit++;
      if (rowsSinceCommit >= batchSize) {
        commitTx();
      }
    }

    if (onProgress && stats.linesRead % progressInterval === 0) {
      onProgress(stats);
    }
  }

  commitTx();
}

// ---- Main ----

async function main() {
  const { sourceDir, targetGroup, dryRun } = parseArgs(process.argv);

  const dbPath = process.env['DB_PATH'] ?? 'data/bot.db';
  console.log(`[INFO] Database: ${dbPath}`);
  console.log(`[INFO] Target group: ${targetGroup}`);
  console.log(`[INFO] Dry run: ${dryRun}`);

  const manifestPath = path.join(sourceDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  console.log(`[INFO] Manifest: ${JSON.stringify(manifest).slice(0, 300)}`);

  const chunksDir = path.join(sourceDir, 'chunks');
  const allFiles = await readdir(chunksDir);
  const chunkFiles = allFiles.filter(f => f.endsWith('.jsonl')).sort();
  console.log(`[INFO] Found ${chunkFiles.length} chunk file(s)`);

  const db = new Database(dbPath);

  // Bulk-import PRAGMAs — safe for import, reset on close
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA temp_store = MEMORY;');
  db.exec('PRAGMA mmap_size = 30000000000;');

  const stats = makeStats();
  const globalStart = Date.now();

  const onProgress = (s: ImportStats) => {
    const elapsed = (Date.now() - globalStart) / 1000;
    const rate = elapsed > 0 ? Math.round(s.linesRead / elapsed) : 0;
    console.log(
      `[PROGRESS] read=${s.linesRead} kept=${s.linesKept} inserted=${s.inserted} ` +
      `dup=${s.skippedDuplicate} skip=${s.skippedFilter} err=${s.errors} ` +
      `elapsed=${elapsed.toFixed(1)}s rate=${rate}/s`
    );
  };

  const deps: ImportDeps = { db, dryRun, targetGroup, onProgress, progressInterval: 10_000 };

  for (const chunkFile of chunkFiles) {
    console.log(`[INFO] Processing ${chunkFile}...`);
    await importLines(streamFileLines(path.join(chunksDir, chunkFile)), { ...deps, label: chunkFile }, stats);
  }

  const elapsed = ((Date.now() - globalStart) / 1000).toFixed(1);
  console.log('\n[DONE] Import complete');
  console.log(`  Lines read:        ${stats.linesRead}`);
  console.log(`  Lines kept:        ${stats.linesKept}`);
  console.log(`  Rows inserted:     ${stats.inserted}`);
  console.log(`  Skipped duplicate: ${stats.skippedDuplicate}`);
  console.log(`  Skipped filter:    ${stats.skippedFilter}`);
  console.log(`  Parse errors:      ${stats.errors}`);
  console.log(`  Elapsed:           ${elapsed}s`);
  if (dryRun) console.log('  [DRY RUN — no rows written]');

  db.close();
}

const isMain = process.argv[1]?.endsWith('import-history.ts') ||
               process.argv[1]?.endsWith('import-history.js');
if (isMain) {
  main().catch(err => {
    console.error('[FATAL]', err);
    process.exit(1);
  });
}
