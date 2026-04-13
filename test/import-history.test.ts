import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Database } from '../src/storage/db.js';
import {
  shouldKeep,
  importLines,
  makeStats,
  type JsonlRecord,
  type ImportDeps,
} from '../scripts/import-history.js';

// ---- Helpers ----

function makeRecord(overrides: Partial<JsonlRecord> = {}): JsonlRecord {
  return {
    id: 'msg-001',
    timestamp: 1772964111000,
    sender: { uin: '1279051865', name: '高木梦以', groupCard: '高木梦以' },
    type: 'text',
    content: { text: '草你的' },
    recalled: false,
    system: false,
    ...overrides,
  };
}

async function* asyncLines(lines: string[]): AsyncIterable<string> {
  for (const line of lines) yield line;
}

function makeDb(): Database {
  return new Database(':memory:');
}

// ---- shouldKeep tests ----

describe('shouldKeep', () => {
  it('keeps text messages', () => {
    expect(shouldKeep(makeRecord({ type: 'text' }))).toBe(true);
  });

  it('keeps reply messages', () => {
    expect(shouldKeep(makeRecord({ type: 'reply' }))).toBe(true);
  });

  it('skips recalled messages', () => {
    expect(shouldKeep(makeRecord({ recalled: true }))).toBe(false);
  });

  it('skips system flag', () => {
    expect(shouldKeep(makeRecord({ system: true }))).toBe(false);
  });

  it('skips system type', () => {
    expect(shouldKeep(makeRecord({ type: 'system' }))).toBe(false);
  });

  it('skips video type', () => {
    expect(shouldKeep(makeRecord({ type: 'video' }))).toBe(false);
  });

  it('skips audio type', () => {
    expect(shouldKeep(makeRecord({ type: 'audio' }))).toBe(false);
  });

  it('skips forward type', () => {
    expect(shouldKeep(makeRecord({ type: 'forward' }))).toBe(false);
  });

  it('skips type_17', () => {
    expect(shouldKeep(makeRecord({ type: 'type_17' }))).toBe(false);
  });

  it('skips missing sender.uin', () => {
    expect(shouldKeep(makeRecord({ sender: { name: 'Alice' } }))).toBe(false);
  });

  it('skips whitespace-only content.text', () => {
    expect(shouldKeep(makeRecord({ content: { text: '   ' } }))).toBe(false);
  });

  it('skips missing content.text', () => {
    expect(shouldKeep(makeRecord({ content: {} }))).toBe(false);
  });
});

// ---- importLines tests ----

describe('importLines', () => {
  let db: Database;
  let deps: ImportDeps;

  beforeEach(() => {
    db = makeDb();
    deps = { db, dryRun: false, targetGroup: 'g-test' };
  });

  it('inserts kept rows and counts filtered rows', async () => {
    const lines = [
      JSON.stringify(makeRecord({ id: 'msg-1', type: 'text', content: { text: 'hello' } })),
      JSON.stringify(makeRecord({ id: 'msg-2', type: 'video' })),
      JSON.stringify(makeRecord({ id: 'msg-3', type: 'reply', content: { text: 'ok' } })),
    ];
    const stats = makeStats();
    await importLines(asyncLines(lines), deps, stats);

    expect(stats.linesRead).toBe(3);
    expect(stats.linesKept).toBe(2);
    expect(stats.inserted).toBe(2);
    expect(stats.skippedFilter).toBe(1);
    expect(stats.skippedDuplicate).toBe(0);
    expect(stats.errors).toBe(0);
  });

  it('skips recalled and system messages', async () => {
    const lines = [
      JSON.stringify(makeRecord({ id: 'r1', recalled: true, content: { text: 'recalled' } })),
      JSON.stringify(makeRecord({ id: 's1', system: true, content: { text: 'system' } })),
      JSON.stringify(makeRecord({ id: 'ok', content: { text: 'good' } })),
    ];
    const stats = makeStats();
    await importLines(asyncLines(lines), deps, stats);
    expect(stats.inserted).toBe(1);
    expect(stats.skippedFilter).toBe(2);
  });

  it('handles malformed JSON line — logs warn, continues', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lines = [
      '{ this is not json }',
      JSON.stringify(makeRecord({ id: 'ok', content: { text: 'fine' } })),
    ];
    const stats = makeStats();
    await importLines(asyncLines(lines), deps, stats);
    expect(stats.errors).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('dry-run: counts kept rows but inserts nothing into db', async () => {
    const dryDeps = { ...deps, dryRun: true };
    const lines = [
      JSON.stringify(makeRecord({ id: 'm1', content: { text: 'hi' } })),
      JSON.stringify(makeRecord({ id: 'm2', content: { text: 'hey' } })),
    ];
    const stats = makeStats();
    await importLines(asyncLines(lines), dryDeps, stats);
    expect(stats.linesKept).toBe(2);
    expect(stats.inserted).toBe(0);
    expect(db.messages.getRecent('g-test', 10)).toHaveLength(0);
  });

  it('idempotent: import twice → same row count in db', async () => {
    const lines = [
      JSON.stringify(makeRecord({ id: 'dup-1', content: { text: 'once' } })),
      JSON.stringify(makeRecord({ id: 'dup-2', content: { text: 'twice' } })),
    ];

    const stats1 = makeStats();
    await importLines(asyncLines(lines), deps, stats1);
    expect(stats1.inserted).toBe(2);
    const countAfterFirst = db.messages.getRecent('g-test', 100).length;

    const stats2 = makeStats();
    await importLines(asyncLines(lines), deps, stats2);
    expect(stats2.inserted).toBe(0);
    expect(stats2.skippedDuplicate).toBe(2);
    expect(db.messages.getRecent('g-test', 100).length).toBe(countAfterFirst);
  });

  it('second run reports all rows as skipped-duplicate', async () => {
    const lines = Array.from({ length: 4 }, (_, i) =>
      JSON.stringify(makeRecord({ id: `sid-${i}`, content: { text: `msg ${i}` } }))
    );

    const stats1 = makeStats();
    await importLines(asyncLines(lines), deps, stats1);
    expect(stats1.inserted).toBe(4);
    expect(stats1.skippedDuplicate).toBe(0);

    const stats2 = makeStats();
    await importLines(asyncLines(lines), deps, stats2);
    expect(stats2.inserted).toBe(0);
    expect(stats2.skippedDuplicate).toBe(4);
    expect(stats2.linesKept).toBe(4);
  });

  it('upserts users for inserted rows', async () => {
    const lines = [
      JSON.stringify(makeRecord({ id: 'u1-msg', sender: { uin: 'u111', name: 'Alice', groupCard: 'Alice' } })),
    ];
    const stats = makeStats();
    await importLines(asyncLines(lines), deps, stats);

    const user = db.users.findById('u111', 'g-test');
    expect(user).not.toBeNull();
    expect(user!.nickname).toBe('Alice');
    expect(user!.groupId).toBe('g-test');
  });

  it('uses groupCard over name for nickname', async () => {
    const lines = [
      JSON.stringify(makeRecord({ id: 'nc1', sender: { uin: 'u999', name: 'RealName', groupCard: 'CardName' } })),
    ];
    const stats = makeStats();
    await importLines(asyncLines(lines), deps, stats);
    const user = db.users.findById('u999', 'g-test');
    expect(user!.nickname).toBe('CardName');
  });

  it('converts ms timestamp to seconds in db', async () => {
    const tsMs = 1772964111000;
    const lines = [JSON.stringify(makeRecord({ id: 'ts-1', timestamp: tsMs, content: { text: 'time check' } }))];
    const stats = makeStats();
    await importLines(asyncLines(lines), deps, stats);
    const msgs = db.messages.getRecent('g-test', 1);
    expect(msgs[0]!.timestamp).toBe(Math.floor(tsMs / 1000));
  });

  it('skips rows with missing sender.uin', async () => {
    const lines = [
      JSON.stringify(makeRecord({ id: 'nouin', sender: { name: 'Ghost' } })),
    ];
    const stats = makeStats();
    await importLines(asyncLines(lines), deps, stats);
    expect(stats.skippedFilter).toBe(1);
    expect(stats.inserted).toBe(0);
  });

  it('skips blank lines without counting them', async () => {
    const lines = ['', '   ', JSON.stringify(makeRecord({ id: 'real', content: { text: 'hi' } }))];
    const stats = makeStats();
    await importLines(asyncLines(lines), deps, stats);
    expect(stats.linesRead).toBe(1);
    expect(stats.inserted).toBe(1);
  });

  it('fires onProgress callback at configured interval', async () => {
    const progressCb = vi.fn();
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify(makeRecord({ id: `p${i}`, content: { text: `msg ${i}` } }))
    );
    const stats = makeStats();
    await importLines(asyncLines(lines), { ...deps, onProgress: progressCb, progressInterval: 3 }, stats);
    expect(progressCb).toHaveBeenCalledOnce();
  });
});
