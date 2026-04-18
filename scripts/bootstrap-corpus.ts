#!/usr/bin/env tsx
/**
 * bootstrap-corpus.ts (W-D)
 *
 * One-shot backfill of derived corpora (jargon, phrases, memes, relationships,
 * expressions, honest-gaps) from the full messages table. Called manually
 * after a historical import so the bot starts with a warm corpus instead of
 * waiting for the opportunistic cron paths to catch up organically.
 *
 * CLI:
 *   node --experimental-sqlite dist/scripts/bootstrap-corpus.js \
 *     [--group <id>] [--step all|jargon|phrase|meme|relation|expression|honest-gaps] \
 *     [--resume] [--dry-run] [--chunk-size 10000] [--force]
 *
 * Cursor-based chunking uses composite (timestamp, id) so ties on timestamp
 * never skip rows. Progress persists as append-only JSONL; --resume reads the
 * latest entry per step and advances the cursor.
 *
 * Lockfile at data/groups/<gid>/bootstrap/.lock protects against concurrent
 * runs; stale locks (>6hr or dead pid) are cleaned automatically.
 */

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Message } from '../src/storage/db.js';

// ---- Public constants ----

export const STALE_LOCK_HOURS = 6;
export const DEFAULT_CHUNK_SIZE = 10000;
const DEFAULT_DATA_ROOT = 'data';

const VALID_STEPS = ['all', 'jargon', 'phrase', 'meme', 'relation', 'expression', 'honest-gaps'] as const;
export type Step = typeof VALID_STEPS[number];

// ---- CLI parsing ----

export interface BootstrapOpts {
  group: string | null;
  step: Step;
  resume: boolean;
  dryRun: boolean;
  chunkSize: number;
  force: boolean;
}

export type ParseResult =
  | { ok: true; opts: BootstrapOpts }
  | { ok: false; error: string };

export function parseArgs(argv: string[]): ParseResult {
  const args = argv.slice(2);
  let group: string | null = null;
  let step: Step = 'all';
  let resume = false;
  let dryRun = false;
  let chunkSize = DEFAULT_CHUNK_SIZE;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--group' && args[i + 1]) { group = args[++i]!; }
    else if (a === '--step' && args[i + 1]) {
      const s = args[++i]!;
      if (!VALID_STEPS.includes(s as Step)) {
        return { ok: false, error: `unknown --step: ${s} (valid: ${VALID_STEPS.join(', ')})` };
      }
      step = s as Step;
    }
    else if (a === '--resume') { resume = true; }
    else if (a === '--dry-run') { dryRun = true; }
    else if (a === '--chunk-size' && args[i + 1]) {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        return { ok: false, error: `--chunk-size must be a positive integer` };
      }
      chunkSize = Math.floor(n);
    }
    else if (a === '--force') { force = true; }
    else if (a && a.startsWith('--')) {
      return { ok: false, error: `unknown flag: ${a}` };
    }
  }

  return { ok: true, opts: { group, step, resume, dryRun, chunkSize, force } };
}

// ---- Lockfile ----

export interface LockOpts {
  dataRoot: string;
  force: boolean;
  nowMs: number;
}

export type LockResult =
  | { ok: true; release: () => void }
  | { ok: false; error: string };

function groupBootstrapDir(dataRoot: string, groupId: string): string {
  return path.join(dataRoot, 'groups', groupId, 'bootstrap');
}

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 does not send; returns true iff the target is reachable.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(groupId: string, opts: LockOpts): LockResult {
  const dir = groupBootstrapDir(opts.dataRoot, groupId);
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, '.lock');

  if (fs.existsSync(lockPath)) {
    let existing: { pid: number; mtime: number };
    try {
      existing = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number; mtime: number };
    } catch {
      // Corrupt lock — treat as stale.
      existing = { pid: -1, mtime: 0 };
    }
    const ageHours = (opts.nowMs - existing.mtime) / (60 * 60 * 1000);
    const stale = ageHours >= STALE_LOCK_HOURS || !isPidAlive(existing.pid);
    if (!stale && !opts.force) {
      return {
        ok: false,
        error: `lockfile held by pid ${existing.pid} (age ${ageHours.toFixed(1)}hr); use --force to override`,
      };
    }
    // Stale or forced — overwrite below.
  }

  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, mtime: opts.nowMs }));

  return {
    ok: true,
    release: () => {
      try { fs.unlinkSync(lockPath); } catch { /* noop */ }
    },
  };
}

// ---- Progress (append-only JSONL) ----

export interface Cursor { timestamp: number; id: number }

export interface ProgressEntry {
  step: string;
  cursor: Cursor | null;
  finishedAt: number;
  chunksProcessed: number;
}

export interface ProgressFileOpts { dataRoot: string }

function progressPath(opts: ProgressFileOpts, groupId: string): string {
  return path.join(groupBootstrapDir(opts.dataRoot, groupId), 'progress.jsonl');
}

export function appendProgress(groupId: string, opts: ProgressFileOpts, entry: ProgressEntry): void {
  const p = progressPath(opts, groupId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(entry) + '\n');
}

export interface ProgressSnapshot {
  entries: ProgressEntry[];
  latestByStep: Map<string, ProgressEntry>;
}

export function readProgress(groupId: string, opts: ProgressFileOpts): ProgressSnapshot {
  const p = progressPath(opts, groupId);
  const latestByStep = new Map<string, ProgressEntry>();
  const entries: ProgressEntry[] = [];
  if (!fs.existsSync(p)) return { entries, latestByStep };
  const raw = fs.readFileSync(p, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as ProgressEntry;
      entries.push(row);
      // Keep the most-recent entry per step (file is append-only, so later wins).
      latestByStep.set(row.step, row);
    } catch {
      // Skip corrupt lines.
    }
  }
  return { entries, latestByStep };
}

// ---- Cursor-based chunked iteration over messages ----

export interface ChunkOpts {
  chunkSize: number;
  startCursor: Cursor | null;
}

interface MessageRow {
  id: number; group_id: string; user_id: string; nickname: string;
  content: string; raw_content: string | null; timestamp: number; deleted: number;
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id, groupId: row.group_id, userId: row.user_id, nickname: row.nickname,
    content: row.content, rawContent: row.raw_content ?? row.content,
    timestamp: row.timestamp, deleted: row.deleted !== 0,
  };
}

/**
 * Yield chunks of messages in ascending (timestamp, id) order, starting strictly
 * after startCursor. Composite cursor avoids losing rows that share a timestamp.
 */
export function* iterChunksBy(
  db: DatabaseSync,
  groupId: string,
  opts: ChunkOpts,
): Generator<Message[]> {
  let cursor = opts.startCursor;
  // deleted=0 guard kept so behaviour matches MessageRepository.getRecent.
  const stmt = db.prepare(
    `SELECT id, group_id, user_id, nickname, content, raw_content, timestamp, deleted
     FROM messages
     WHERE group_id = ? AND deleted = 0
       AND (timestamp > ? OR (timestamp = ? AND id > ?))
     ORDER BY timestamp ASC, id ASC
     LIMIT ?`
  );

  while (true) {
    const ts = cursor ? cursor.timestamp : -1;
    const id = cursor ? cursor.id : -1;
    const rows = stmt.all(groupId, ts, ts, id, opts.chunkSize) as unknown as MessageRow[];
    if (rows.length === 0) return;
    const msgs = rows.map(rowToMessage);
    yield msgs;
    const last = msgs[msgs.length - 1]!;
    cursor = { timestamp: last.timestamp, id: last.id };
    if (rows.length < opts.chunkSize) return;
  }
}

// ---- Dry-run (no writes, no progress, no lock) ----

export interface DryRunOpts { dataRoot: string; chunkSize: number }

export async function runDryRun(db: DatabaseSync, groupId: string, opts: DryRunOpts): Promise<{ messageCount: number; chunkCount: number }> {
  let messageCount = 0;
  let chunkCount = 0;
  for (const chunk of iterChunksBy(db, groupId, { chunkSize: opts.chunkSize, startCursor: null })) {
    messageCount += chunk.length;
    chunkCount++;
  }
  return { messageCount, chunkCount };
}

// ---- Shutdown handlers (UR-N M1) ----

export interface ShutdownOpts {
  onShutdown: () => void;
  /** Injection point for tests — defaults to the real process. */
  target?: {
    on: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => void;
    exit: (code: number) => void;
  };
}

/**
 * Wire SIGINT + SIGTERM to invoke `onShutdown` (idempotent) and then exit
 * with POSIX-conventional codes (130 for SIGINT, 143 for SIGTERM). Exported
 * so tests can drive it against a fake `target`.
 */
export function registerShutdownHandlers(opts: ShutdownOpts): void {
  const target = opts.target ?? {
    on: (sig, listener) => { process.on(sig, listener); },
    exit: (code) => { process.exit(code); },
  };
  let signaled = false;
  const handleSignal = (code: number): void => {
    if (signaled) return;
    signaled = true;
    console.error(`[INFO] received signal ${code}; releasing resources and exiting`);
    try { opts.onShutdown(); } catch { /* noop */ }
    target.exit(code);
  };
  target.on('SIGINT', () => handleSignal(130));
  target.on('SIGTERM', () => handleSignal(143));
}

// ---- Main (live path) ----

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>(resolve => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

interface StepRunnerCtx {
  db: DatabaseSync;
  groupId: string;
  opts: BootstrapOpts;
  dataRoot: string;
  resumeCursor: Cursor | null;
}

interface StepResult {
  cursor: Cursor | null;
  chunksProcessed: number;
}

async function runJargonStep(ctx: StepRunnerCtx): Promise<StepResult> {
  const { JargonMiner } = await import('../src/modules/jargon-miner.js');
  const { Database } = await import('../src/storage/db.js');
  // We reuse the Database facade's repos but attach to our raw DatabaseSync.
  // Since bootstrap runs against the main bot.db, caller passes an opened DB.
  const wrapped = (ctx as { database?: unknown }).database as { messages: unknown; learnedFacts: unknown } | undefined;
  if (!wrapped) {
    // Minimal path: direct SQL. Jargon miner needs IMessageRepository etc.;
    // we defer wiring to the main() function which passes a proper Database.
    throw new Error('runJargonStep requires wrapped Database in ctx.database');
  }
  // Placeholder — main() composes the real runner.
  void Database;
  void JargonMiner;
  return { cursor: ctx.resumeCursor, chunksProcessed: 0 };
}

// The step runners above are wired in main(); exported helpers above are the
// testable surface. For the CLI path we compose everything once DB is open.

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  if (!parsed.ok) {
    console.error(`[FATAL] ${parsed.error}`);
    process.exit(2);
  }
  const opts = parsed.opts;
  if (!opts.group) {
    console.error('[FATAL] --group <id> is required');
    process.exit(2);
  }

  const dataRoot = process.env['DATA_ROOT'] ?? DEFAULT_DATA_ROOT;
  const dbPath = process.env['DB_PATH'] ?? path.join(dataRoot, 'bot.db');
  console.log(`[INFO] bootstrap-corpus group=${opts.group} step=${opts.step} chunkSize=${opts.chunkSize} dryRun=${opts.dryRun} resume=${opts.resume}`);
  console.log(`[INFO] db=${dbPath} dataRoot=${dataRoot}`);

  const { Database } = await import('../src/storage/db.js');
  const database = new Database(dbPath);
  const db = database.rawDb;

  if (opts.dryRun) {
    const { messageCount, chunkCount } = await runDryRun(db, opts.group, { dataRoot, chunkSize: opts.chunkSize });
    console.log(`[DRY RUN] would process ${messageCount} messages in ${chunkCount} chunks`);
    database.close();
    return;
  }

  const lock = acquireLock(opts.group, { dataRoot, force: opts.force, nowMs: Date.now() });
  if (!lock.ok) {
    console.error(`[FATAL] ${lock.error}`);
    database.close();
    process.exit(3);
  }

  // UR-N quality M1: Ctrl-C / SIGTERM must release the lockfile and close the
  // DB before exit; otherwise the next run trips on a stale lock until the
  // 6-hour timeout.
  registerShutdownHandlers({
    onShutdown: () => {
      try { lock.release(); } catch { /* noop */ }
      try { database.close(); } catch { /* noop */ }
    },
  });

  try {
    const progress = opts.resume ? readProgress(opts.group, { dataRoot }) : { entries: [], latestByStep: new Map<string, ProgressEntry>() };

    const stepsToRun: Step[] = opts.step === 'all'
      ? ['jargon', 'phrase', 'meme', 'relation', 'expression', 'honest-gaps']
      : [opts.step];

    for (const step of stepsToRun) {
      const prior = progress.latestByStep.get(step);
      const startCursor = opts.resume ? (prior?.cursor ?? null) : null;
      console.log(`[STEP] ${step} startCursor=${startCursor ? `${startCursor.timestamp}/${startCursor.id}` : 'null'}`);

      const result = await runStep(step, database, opts.group, { chunkSize: opts.chunkSize, startCursor });

      appendProgress(opts.group, { dataRoot }, {
        step,
        cursor: result.cursor,
        finishedAt: Math.floor(Date.now() / 1000),
        chunksProcessed: result.chunksProcessed,
      });
      console.log(`[STEP] ${step} done chunks=${result.chunksProcessed} cursor=${result.cursor ? `${result.cursor.timestamp}/${result.cursor.id}` : 'null'}`);
    }
  } finally {
    lock.release();
    database.close();
  }
}

// ---- Step runners (import heavy modules lazily so tests can import pure helpers fast) ----

interface RunStepOpts { chunkSize: number; startCursor: Cursor | null }

async function runStep(
  step: Exclude<Step, 'all'>,
  database: import('../src/storage/db.js').Database,
  groupId: string,
  opts: RunStepOpts,
): Promise<StepResult> {
  switch (step) {
    case 'jargon': return runJargon(database, groupId, opts);
    case 'phrase': return runPhrase(database, groupId, opts);
    case 'meme': return runMeme(database, groupId, opts);
    case 'relation': return runRelation(database, groupId, opts);
    case 'expression': return runExpression(database, groupId, opts);
    case 'honest-gaps': return runHonestGaps(database, groupId, opts);
  }
}

async function runJargon(
  database: import('../src/storage/db.js').Database,
  groupId: string,
  opts: RunStepOpts,
): Promise<StepResult> {
  const { JargonMiner } = await import('../src/modules/jargon-miner.js');
  const { ClaudeClient } = await import('../src/ai/claude.js');
  const claude = new ClaudeClient();
  const miner = new JargonMiner({
    db: database.rawDb,
    messages: database.messages,
    learnedFacts: database.learnedFacts,
    claude,
    activeGroups: [groupId],
  });

  let cursor: Cursor | null = opts.startCursor;
  let chunks = 0;
  for (const chunk of iterChunksBy(database.rawDb, groupId, opts)) {
    miner.extractCandidatesFromMessages(groupId, chunk);
    const last = chunk[chunk.length - 1]!;
    cursor = { timestamp: last.timestamp, id: last.id };
    chunks++;
    await sleep(500); // inter-cycle backoff
  }
  // One inference + promotion pass over everything just accumulated.
  await miner.inferJargon(groupId);
  miner.promoteToFacts(groupId);

  return { cursor, chunksProcessed: chunks };
}

async function runPhrase(
  database: import('../src/storage/db.js').Database,
  groupId: string,
  opts: RunStepOpts,
): Promise<StepResult> {
  const { PhraseMiner } = await import('../src/modules/phrase-miner.js');
  const { ClaudeClient } = await import('../src/ai/claude.js');
  const claude = new ClaudeClient();
  const miner = new PhraseMiner({
    messages: database.messages,
    claude,
    phraseCandidates: database.phraseCandidates,
    activeGroups: [groupId],
  });

  let cursor: Cursor | null = opts.startCursor;
  let chunks = 0;
  for (const chunk of iterChunksBy(database.rawDb, groupId, opts)) {
    miner.extractCandidatesFromMessages(groupId, chunk);
    const last = chunk[chunk.length - 1]!;
    cursor = { timestamp: last.timestamp, id: last.id };
    chunks++;
    await sleep(500);
  }
  await miner.inferPhrase(groupId);

  return { cursor, chunksProcessed: chunks };
}

async function runMeme(
  database: import('../src/storage/db.js').Database,
  groupId: string,
  _opts: RunStepOpts,
): Promise<StepResult> {
  const { MemeClusterer } = await import('../src/modules/meme-clusterer.js');
  const { ClaudeClient } = await import('../src/ai/claude.js');
  const claude = new ClaudeClient();
  const clusterer = new MemeClusterer({
    db: database.rawDb,
    memeGraph: database.memeGraph,
    phraseCandidates: database.phraseCandidates,
    claude,
  });

  // Loop clusterAll until it stops promoting candidates or 20 iter cap.
  const MAX_ITERS = 20;
  let iters = 0;
  for (let i = 0; i < MAX_ITERS; i++) {
    // Snapshot unpromoted count; if unchanged after a call, stop.
    const before = countUnpromoted(database.rawDb, groupId);
    await clusterer.clusterAll(groupId);
    iters++;
    const after = countUnpromoted(database.rawDb, groupId);
    if (after === 0 || after === before) break;
  }

  return { cursor: null, chunksProcessed: iters };
}

function countUnpromoted(db: DatabaseSync, groupId: string): number {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM jargon_candidates WHERE group_id = ? AND is_jargon = 1`
    ).get(groupId) as { n: number };
    const row2 = db.prepare(
      `SELECT COUNT(*) AS n FROM phrase_candidates WHERE group_id = ? AND is_jargon = 1 AND promoted = 0`
    ).get(groupId) as { n: number } | undefined;
    return row.n + (row2?.n ?? 0);
  } catch {
    return 0;
  }
}

async function runRelation(
  database: import('../src/storage/db.js').Database,
  groupId: string,
  opts: RunStepOpts,
): Promise<StepResult> {
  const { RelationshipTracker } = await import('../src/modules/relationship-tracker.js');
  const { ClaudeClient } = await import('../src/ai/claude.js');
  const claude = new ClaudeClient();
  const tracker = new RelationshipTracker({
    messages: database.messages,
    users: database.users,
    claude,
    activeGroups: [groupId],
    interPairDelayMs: 400,
    dbExec: (sql, ...params) => { database.rawDb.prepare(sql).run(...(params as never[])); },
    dbQuery: <T>(sql: string, ...params: unknown[]): T[] => {
      return database.rawDb.prepare(sql).all(...(params as never[])) as unknown as T[];
    },
  });

  let cursor: Cursor | null = opts.startCursor;
  let chunks = 0;
  for (const chunk of iterChunksBy(database.rawDb, groupId, opts)) {
    tracker.updateStats(groupId, chunk);
    const last = chunk[chunk.length - 1]!;
    cursor = { timestamp: last.timestamp, id: last.id };
    chunks++;
  }
  // One inference pass at the end (inter-pair delay enforced inside).
  await tracker.inferRelationships(groupId);

  return { cursor, chunksProcessed: chunks };
}

async function runExpression(
  database: import('../src/storage/db.js').Database,
  groupId: string,
  opts: RunStepOpts,
): Promise<StepResult> {
  const { ExpressionLearner } = await import('../src/modules/expression-learner.js');
  const botUserId = process.env['BOT_USER_ID'] ?? '';
  const learner = new ExpressionLearner({
    messages: database.messages,
    expressionPatterns: database.expressionPatterns,
    botUserId,
  });

  let cursor: Cursor | null = opts.startCursor;
  let chunks = 0;
  for (const chunk of iterChunksBy(database.rawDb, groupId, opts)) {
    learner.scanOnMessages(groupId, chunk);
    const last = chunk[chunk.length - 1]!;
    cursor = { timestamp: last.timestamp, id: last.id };
    chunks++;
  }
  return { cursor, chunksProcessed: chunks };
}

async function runHonestGaps(
  database: import('../src/storage/db.js').Database,
  groupId: string,
  opts: RunStepOpts,
): Promise<StepResult> {
  const { HonestGapsTracker } = await import('../src/modules/honest-gaps.js');
  const tracker = new HonestGapsTracker(database.honestGaps);

  let cursor: Cursor | null = opts.startCursor;
  let chunks = 0;
  for (const chunk of iterChunksBy(database.rawDb, groupId, opts)) {
    for (const m of chunk) {
      tracker.recordMessage(groupId, m.content, m.timestamp * 1000);
    }
    const last = chunk[chunk.length - 1]!;
    cursor = { timestamp: last.timestamp, id: last.id };
    chunks++;
  }
  return { cursor, chunksProcessed: chunks };
}

// Keep unused runner import from triggering dead-code TS warnings.
void runJargonStep;

const isMain = process.argv[1]?.endsWith('bootstrap-corpus.ts')
  || process.argv[1]?.endsWith('bootstrap-corpus.js');
if (isMain) {
  main().catch(err => {
    console.error('[FATAL]', err);
    process.exit(1);
  });
}
