import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  parseArgs,
  acquireLock,
  readProgress,
  appendProgress,
  iterChunksBy,
  runDryRun,
  registerShutdownHandlers,
  STALE_LOCK_HOURS,
} from '../scripts/bootstrap-corpus.js';
import type { Message } from '../src/storage/db.js';

// ---- Helpers ----

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-test-'));
}

function groupDir(root: string, groupId: string): string {
  return path.join(root, 'groups', groupId, 'bootstrap');
}

function makeMessage(id: number, timestamp: number, userId = 'u1', content = 'hello'): Message {
  return {
    id, groupId: 'g1', userId, nickname: `user${userId}`,
    content, rawContent: content, timestamp, deleted: false,
  };
}

function makeDbWithMessages(msgs: Message[]): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      nickname TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      raw_content TEXT,
      timestamp INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      source_message_id TEXT
    );
    CREATE INDEX idx_messages_group ON messages(group_id, timestamp, id);
  `);
  const stmt = db.prepare(
    'INSERT INTO messages (id, group_id, user_id, nickname, content, raw_content, timestamp, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
  );
  for (const m of msgs) {
    stmt.run(m.id, m.groupId, m.userId, m.nickname, m.content, m.rawContent, m.timestamp);
  }
  return db;
}

// ============================================================================
// Test 6: unknown --step rejects with non-zero exit (parseArgs level)
// ============================================================================

describe('bootstrap-corpus CLI arg parsing', () => {
  it('unknown --step rejects with non-zero exit', () => {
    // parseArgs returns { ok: false } on invalid step; caller does process.exit
    const res = parseArgs(['node', 'bootstrap.ts', '--group', 'g1', '--step', 'bogus-step']);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/step/i);
  });

  it('accepts all known steps', () => {
    const steps = ['all', 'jargon', 'phrase', 'meme', 'relation', 'expression', 'honest-gaps'];
    for (const s of steps) {
      const res = parseArgs(['node', 'b.ts', '--group', 'g1', '--step', s]);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.opts.step).toBe(s);
    }
  });

  it('defaults step to all when omitted', () => {
    const res = parseArgs(['node', 'b.ts', '--group', 'g1']);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.opts.step).toBe('all');
  });

  it('parses chunk-size and resume/dry-run/force flags', () => {
    const res = parseArgs([
      'node', 'b.ts', '--group', 'g1', '--chunk-size', '500',
      '--resume', '--dry-run', '--force',
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.opts.chunkSize).toBe(500);
      expect(res.opts.resume).toBe(true);
      expect(res.opts.dryRun).toBe(true);
      expect(res.opts.force).toBe(true);
    }
  });
});

// ============================================================================
// Test 3: composite (timestamp, id) cursor de-duplicates timestamp ties
// Test 7: chunk boundary correct: exactly chunk-size msgs processed
// ============================================================================

describe('iterChunksBy cursor-based chunking', () => {
  it('composite (timestamp, id) cursor de-duplicates timestamp ties', () => {
    // Four messages: two share timestamp=100, ids 1 and 2
    const db = makeDbWithMessages([
      makeMessage(1, 100),
      makeMessage(2, 100),
      makeMessage(3, 200),
      makeMessage(4, 300),
    ]);
    const chunks = [...iterChunksBy(db, 'g1', { chunkSize: 2, startCursor: null })];
    // Flatten all messages seen
    const ids = chunks.flat().map(m => m.id);
    // Must contain each id exactly once
    expect(ids).toEqual([1, 2, 3, 4]);
    expect(new Set(ids).size).toBe(4);
  });

  it('chunk boundary correct: exactly chunk-size msgs processed per iter, no drop', () => {
    const msgs: Message[] = [];
    for (let i = 1; i <= 7; i++) msgs.push(makeMessage(i, 100 + i));
    const db = makeDbWithMessages(msgs);
    const chunks = [...iterChunksBy(db, 'g1', { chunkSize: 3, startCursor: null })];
    expect(chunks.length).toBe(3); // 3 + 3 + 1
    expect(chunks[0]!.length).toBe(3);
    expect(chunks[1]!.length).toBe(3);
    expect(chunks[2]!.length).toBe(1);
    const allIds = chunks.flat().map(m => m.id);
    expect(allIds).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('cursor-based chunking skips past startCursor', () => {
    const msgs: Message[] = [];
    for (let i = 1; i <= 5; i++) msgs.push(makeMessage(i, 100 + i));
    const db = makeDbWithMessages(msgs);
    const chunks = [...iterChunksBy(db, 'g1', {
      chunkSize: 10,
      startCursor: { timestamp: 103, id: 3 },
    })];
    const ids = chunks.flat().map(m => m.id);
    expect(ids).toEqual([4, 5]);
  });
});

// ============================================================================
// Test 1: dry-run does not write candidates, progress, or lockfile
// ============================================================================

describe('bootstrap-corpus dry-run', () => {
  let tmpRoot: string;

  beforeEach(() => { tmpRoot = makeTmpRoot(); });
  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('dry-run does not write candidates, progress, or lockfile', async () => {
    const db = makeDbWithMessages([
      makeMessage(1, 100, 'u1', 'foo bar baz qux quux'),
      makeMessage(2, 200, 'u2', 'foo bar baz qux quux'),
    ]);
    // Set up jargon_candidates table so we can detect writes
    db.exec(`
      CREATE TABLE jargon_candidates (
        group_id TEXT NOT NULL, content TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        contexts TEXT NOT NULL DEFAULT '[]',
        last_inference_count INTEGER NOT NULL DEFAULT 0,
        meaning TEXT, is_jargon INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, content)
      );
    `);

    await runDryRun(db, 'g1', { dataRoot: tmpRoot, chunkSize: 100 });

    // No lockfile written
    const lockPath = path.join(groupDir(tmpRoot, 'g1'), '.lock');
    expect(fs.existsSync(lockPath)).toBe(false);
    // No progress file
    const progPath = path.join(groupDir(tmpRoot, 'g1'), 'progress.jsonl');
    expect(fs.existsSync(progPath)).toBe(false);
    // No jargon_candidates rows inserted
    const rows = db.prepare('SELECT COUNT(*) as n FROM jargon_candidates').get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

// ============================================================================
// Test 4 & 5: lockfile
// ============================================================================

describe('bootstrap-corpus lockfile', () => {
  let tmpRoot: string;

  beforeEach(() => { tmpRoot = makeTmpRoot(); });
  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('stale lockfile (<6hr, live pid) aborts with error; --force overrides', () => {
    fs.mkdirSync(groupDir(tmpRoot, 'g1'), { recursive: true });
    const lockPath = path.join(groupDir(tmpRoot, 'g1'), '.lock');
    // Write lock with current pid (live) and recent mtime
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      mtime: Date.now(),
    }));
    const now = Date.now();

    const res = acquireLock('g1', { dataRoot: tmpRoot, force: false, nowMs: now });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/lock|already/i);

    // With --force, it succeeds
    const resForce = acquireLock('g1', { dataRoot: tmpRoot, force: true, nowMs: now });
    expect(resForce.ok).toBe(true);
    if (resForce.ok) resForce.release();
  });

  it('stale lockfile (>6hr) is auto-cleaned and run proceeds', () => {
    fs.mkdirSync(groupDir(tmpRoot, 'g1'), { recursive: true });
    const lockPath = path.join(groupDir(tmpRoot, 'g1'), '.lock');
    const now = Date.now();
    // Write lock with mtime 7 hours ago
    const staleMtime = now - (STALE_LOCK_HOURS + 1) * 60 * 60 * 1000;
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 999999, mtime: staleMtime,
    }));

    const res = acquireLock('g1', { dataRoot: tmpRoot, force: false, nowMs: now });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Lock file now belongs to our pid
      const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number };
      expect(raw.pid).toBe(process.pid);
      res.release();
      expect(fs.existsSync(lockPath)).toBe(false);
    }
  });
});

// ============================================================================
// Test 2 & 8: progress file
// ============================================================================

describe('bootstrap-corpus progress.jsonl', () => {
  let tmpRoot: string;

  beforeEach(() => { tmpRoot = makeTmpRoot(); });
  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('progress.jsonl append-only: each step appends, never rewrites prior rows', () => {
    appendProgress('g1', { dataRoot: tmpRoot }, {
      step: 'jargon', cursor: null, finishedAt: 1000, chunksProcessed: 2,
    });
    appendProgress('g1', { dataRoot: tmpRoot }, {
      step: 'phrase', cursor: null, finishedAt: 2000, chunksProcessed: 1,
    });
    appendProgress('g1', { dataRoot: tmpRoot }, {
      step: 'jargon', cursor: null, finishedAt: 3000, chunksProcessed: 4,
    });

    const progPath = path.join(groupDir(tmpRoot, 'g1'), 'progress.jsonl');
    const contents = fs.readFileSync(progPath, 'utf8');
    const lines = contents.trim().split('\n');
    expect(lines.length).toBe(3);
    const rows = lines.map(l => JSON.parse(l) as { step: string; finishedAt: number });
    expect(rows[0]!.step).toBe('jargon');
    expect(rows[0]!.finishedAt).toBe(1000);
    expect(rows[1]!.step).toBe('phrase');
    expect(rows[2]!.step).toBe('jargon');
    expect(rows[2]!.finishedAt).toBe(3000);
  });

  it('cursor resumes at last finishedAt; does not reprocess', () => {
    // Seed progress: jargon step finished at cursor {timestamp:200,id:2}
    appendProgress('g1', { dataRoot: tmpRoot }, {
      step: 'jargon',
      cursor: { timestamp: 200, id: 2 },
      finishedAt: 1000,
      chunksProcessed: 1,
    });

    const prog = readProgress('g1', { dataRoot: tmpRoot });
    // latestByStep picks the most-recent jargon entry
    const jargonEntry = prog.latestByStep.get('jargon');
    expect(jargonEntry).toBeDefined();
    expect(jargonEntry!.cursor).toEqual({ timestamp: 200, id: 2 });
    expect(jargonEntry!.finishedAt).toBe(1000);

    // Insert 3 messages; only id>2 should be yielded when startCursor is resumed
    const db = makeDbWithMessages([
      makeMessage(1, 100),
      makeMessage(2, 200),
      makeMessage(3, 300),
    ]);
    const chunks = [...iterChunksBy(db, 'g1', {
      chunkSize: 10,
      startCursor: jargonEntry!.cursor,
    })];
    const ids = chunks.flat().map(m => m.id);
    expect(ids).toEqual([3]);
  });
});

// ============================================================================
// UR-N M1: SIGINT / SIGTERM release lockfile + DB before exit
// ============================================================================

describe('bootstrap-corpus registerShutdownHandlers (UR-N M1)', () => {
  it('SIGINT invokes onShutdown and exits 130', () => {
    const handlers: Record<string, () => void> = {};
    let exitCode: number | null = null;
    let shutdownCalled = 0;
    registerShutdownHandlers({
      onShutdown: () => { shutdownCalled++; },
      target: {
        on: (sig, listener) => { handlers[sig] = listener; },
        exit: (code) => { exitCode = code; },
      },
    });
    expect(handlers.SIGINT).toBeDefined();
    expect(handlers.SIGTERM).toBeDefined();

    handlers.SIGINT!();
    expect(shutdownCalled).toBe(1);
    expect(exitCode).toBe(130);
  });

  it('SIGTERM invokes onShutdown and exits 143', () => {
    const handlers: Record<string, () => void> = {};
    let exitCode: number | null = null;
    let shutdownCalled = 0;
    registerShutdownHandlers({
      onShutdown: () => { shutdownCalled++; },
      target: {
        on: (sig, listener) => { handlers[sig] = listener; },
        exit: (code) => { exitCode = code; },
      },
    });
    handlers.SIGTERM!();
    expect(shutdownCalled).toBe(1);
    expect(exitCode).toBe(143);
  });

  it('double signal fires onShutdown once (idempotent)', () => {
    const handlers: Record<string, () => void> = {};
    const exitCodes: number[] = [];
    let shutdownCalled = 0;
    registerShutdownHandlers({
      onShutdown: () => { shutdownCalled++; },
      target: {
        on: (sig, listener) => { handlers[sig] = listener; },
        exit: (code) => { exitCodes.push(code); },
      },
    });
    handlers.SIGINT!();
    handlers.SIGINT!();
    handlers.SIGTERM!();
    expect(shutdownCalled).toBe(1);
    // still only one exit call — once signaled, later signals no-op
    expect(exitCodes).toEqual([130]);
  });

  it('onShutdown throwing does not prevent exit', () => {
    const handlers: Record<string, () => void> = {};
    let exitCode: number | null = null;
    registerShutdownHandlers({
      onShutdown: () => { throw new Error('release failed'); },
      target: {
        on: (sig, listener) => { handlers[sig] = listener; },
        exit: (code) => { exitCode = code; },
      },
    });
    expect(() => handlers.SIGINT!()).not.toThrow();
    expect(exitCode).toBe(130);
  });
});
