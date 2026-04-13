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
 * Applies a one-time schema migration (source_message_id column + unique index)
 * before importing, making re-runs fully idempotent via INSERT OR IGNORE.
 */

import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
  uid?: string;
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

// ---- Migration: add source_message_id for idempotency ----

export function applyMigration(db: DatabaseSync): void {
  // Column may already exist on re-run — catch the error and proceed
  try {
    db.exec('ALTER TABLE messages ADD COLUMN source_message_id TEXT');
  } catch {
    // Already exists
  }
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_source_id ON messages(source_message_id) WHERE source_message_id IS NOT NULL'
  );
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

// ---- File line streaming helper ----

export async function* streamFileLines(filePath: string): AsyncIterable<string> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  yield* rl;
}

// ---- Core import function (accepts any AsyncIterable<string> — injectable for tests) ----

export interface ImportDeps {
  db: DatabaseSync;
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

  const insertMsg = db.prepare(
    `INSERT OR IGNORE INTO messages (group_id, user_id, nickname, content, timestamp, deleted, source_message_id)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
  );
  const upsertUser = db.prepare(
    `INSERT INTO users (user_id, group_id, nickname, style_summary, last_seen)
     VALUES (?, ?, ?, NULL, ?)
     ON CONFLICT(user_id, group_id) DO UPDATE SET
       nickname = CASE WHEN excluded.last_seen > last_seen THEN excluded.nickname ELSE nickname END,
       last_seen = MAX(last_seen, excluded.last_seen)`
  );

  type BatchRow = { userId: string; nickname: string; content: string; timestamp: number; sourceId: string };
  let batch: BatchRow[] = [];

  const flushBatch = () => {
    if (batch.length === 0) return;
    db.exec('BEGIN');
    try {
      for (const row of batch) {
        const tsSeconds = Math.floor(row.timestamp / 1000);
        const result = insertMsg.run(targetGroup, row.userId, row.nickname, row.content, tsSeconds, row.sourceId);
        if ((result as { changes: number }).changes > 0) {
          stats.inserted++;
          upsertUser.run(row.userId, targetGroup, row.nickname, tsSeconds);
        } else {
          stats.skippedDuplicate++;
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    batch = [];
  };

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
      batch.push({
        userId: record.sender!.uin!,
        nickname: (record.sender!.groupCard || record.sender!.name || record.sender!.uin)!,
        content: record.content!.text!.trim(),
        timestamp: record.timestamp!,
        sourceId: record.id!,
      });

      if (batch.length >= batchSize) {
        flushBatch();
      }
    }

    if (onProgress && stats.linesRead % progressInterval === 0) {
      onProgress(stats);
    }
  }

  if (!dryRun) flushBatch();
}

// ---- Main entry point ----

async function main() {
  const { sourceDir, targetGroup, dryRun } = parseArgs(process.argv);

  const dbPath = process.env['DB_PATH'] ?? 'data/bot.db';
  console.log(`[INFO] Database: ${dbPath}`);
  console.log(`[INFO] Target group: ${targetGroup}`);
  console.log(`[INFO] Dry run: ${dryRun}`);

  const manifestPath = path.join(sourceDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  const manifestPreview = JSON.stringify(manifest).slice(0, 300);
  console.log(`[INFO] Manifest: ${manifestPreview}`);

  const chunksDir = path.join(sourceDir, 'chunks');
  const allFiles = await readdir(chunksDir);
  const chunkFiles = allFiles.filter(f => f.endsWith('.jsonl')).sort();
  console.log(`[INFO] Found ${chunkFiles.length} chunk file(s)`);

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');

  if (!dryRun) {
    applyMigration(db);
    console.log('[INFO] Schema migration applied');
  }

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

  const totalElapsed = ((Date.now() - globalStart) / 1000).toFixed(1);

  console.log('\n[DONE] Import complete');
  console.log(`  Lines read:        ${stats.linesRead}`);
  console.log(`  Lines kept:        ${stats.linesKept}`);
  console.log(`  Rows inserted:     ${stats.inserted}`);
  console.log(`  Skipped duplicate: ${stats.skippedDuplicate}`);
  console.log(`  Skipped filter:    ${stats.skippedFilter}`);
  console.log(`  Parse errors:      ${stats.errors}`);
  console.log(`  Elapsed:           ${totalElapsed}s`);
  if (dryRun) console.log('  [DRY RUN — no rows written]');

  db.close();
}

// Run only when executed directly (not when imported by tests)
const isMain = process.argv[1]?.endsWith('import-history.ts') ||
               process.argv[1]?.endsWith('import-history.js');
if (isMain) {
  main().catch(err => {
    console.error('[FATAL]', err);
    process.exit(1);
  });
}
