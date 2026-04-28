import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from '../../src/storage/db.js';
import type { LaterReaction } from '../../src/storage/db.js';
import { initLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

describe('StickerUsageSampleRepository', () => {
  let db: Database;
  beforeEach(() => { db = new Database(':memory:'); });

  it('insert returns numeric id and roundtrips fields via findRecentForUpdate', () => {
    const id = db.stickerUsageSamples.insert({
      groupId: 'g1', stickerKey: 'mface:p1:e1', senderUserId: 'u1',
      prevMsgs: [{ userId: 'u9', content: 'hi', timestamp: 100 }],
      triggerText: 'hi', replyToTarget: null, createdAt: 200,
    });
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);

    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.id).toBe(id);
    expect(r.stickerKey).toBe('mface:p1:e1');
    expect(r.senderUserId).toBe('u1');
    expect(r.prevMsgs).toEqual([{ userId: 'u9', content: 'hi', timestamp: 100 }]);
    expect(r.triggerText).toBe('hi');
    expect(r.replyToTarget).toBeNull();
    expect(r.actLabel).toBeNull();
    expect(r.contextEmbedding).toBeNull();
    expect(r.laterReactions).toEqual([]);
    expect(r.createdAt).toBe(200);
  });

  it('setEmbedding round-trips a Float32 vector', () => {
    const id = db.stickerUsageSamples.insert({
      groupId: 'g1', stickerKey: 'k', senderUserId: 'u',
      prevMsgs: [], triggerText: '', replyToTarget: null, createdAt: 1,
    });
    const vec = [1.5, -2.25, 0, 0.125, 999.5, -0.001];
    db.stickerUsageSamples.setEmbedding(id, vec);
    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    expect(rows[0]!.contextEmbedding).not.toBeNull();
    const out = rows[0]!.contextEmbedding!;
    expect(out).toHaveLength(vec.length);
    for (let i = 0; i < vec.length; i++) {
      expect(out[i]).toBeCloseTo(vec[i]!, 3);
    }
  });

  it('setActLabel updates a single row', () => {
    const id = db.stickerUsageSamples.insert({
      groupId: 'g1', stickerKey: 'k', senderUserId: 'u',
      prevMsgs: [], triggerText: '', replyToTarget: null, createdAt: 1,
    });
    db.stickerUsageSamples.setActLabel(id, 'laugh');
    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    expect(rows[0]!.actLabel).toBe('laugh');
    db.stickerUsageSamples.setActLabel(id, 'mock');
    const rows2 = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    expect(rows2[0]!.actLabel).toBe('mock');
  });

  it('findRecentForUpdate excludes rows older than sinceSec, includes boundary', () => {
    db.stickerUsageSamples.insert({
      groupId: 'g1', stickerKey: 'k', senderUserId: 'u',
      prevMsgs: [], triggerText: '', replyToTarget: null, createdAt: 50,
    });
    db.stickerUsageSamples.insert({
      groupId: 'g1', stickerKey: 'k', senderUserId: 'u',
      prevMsgs: [], triggerText: '', replyToTarget: null, createdAt: 100,
    });
    db.stickerUsageSamples.insert({
      groupId: 'g1', stickerKey: 'k', senderUserId: 'u',
      prevMsgs: [], triggerText: '', replyToTarget: null, createdAt: 200,
    });
    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 100);
    expect(rows.map(r => r.createdAt)).toEqual([100, 200]);
  });

  it('findRecentForUpdate is group-scoped', () => {
    db.stickerUsageSamples.insert({
      groupId: 'g1', stickerKey: 'k', senderUserId: 'u',
      prevMsgs: [], triggerText: '', replyToTarget: null, createdAt: 100,
    });
    db.stickerUsageSamples.insert({
      groupId: 'g2', stickerKey: 'k', senderUserId: 'u',
      prevMsgs: [], triggerText: '', replyToTarget: null, createdAt: 100,
    });
    expect(db.stickerUsageSamples.findRecentForUpdate('g1', 0)).toHaveLength(1);
    expect(db.stickerUsageSamples.findRecentForUpdate('g2', 0)).toHaveLength(1);
  });

  it('updateLaterReactions JSON round-trips', () => {
    const id = db.stickerUsageSamples.insert({
      groupId: 'g1', stickerKey: 'k', senderUserId: 'u',
      prevMsgs: [], triggerText: '', replyToTarget: null, createdAt: 1,
    });
    const reactions: LaterReaction[] = [
      { type: 'echo', count: 2, sampleMsg: 'haha' },
      { type: 'meme-react', count: 1, sampleMsg: '草' },
    ];
    db.stickerUsageSamples.updateLaterReactions(id, reactions);
    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    expect(rows[0]!.laterReactions).toEqual(reactions);
  });

  it('count is group-scoped', () => {
    db.stickerUsageSamples.insert({
      groupId: 'g1', stickerKey: 'k', senderUserId: 'u',
      prevMsgs: [], triggerText: '', replyToTarget: null, createdAt: 1,
    });
    db.stickerUsageSamples.insert({
      groupId: 'g1', stickerKey: 'k', senderUserId: 'u',
      prevMsgs: [], triggerText: '', replyToTarget: null, createdAt: 2,
    });
    db.stickerUsageSamples.insert({
      groupId: 'g2', stickerKey: 'k', senderUserId: 'u',
      prevMsgs: [], triggerText: '', replyToTarget: null, createdAt: 1,
    });
    expect(db.stickerUsageSamples.count('g1')).toBe(2);
    expect(db.stickerUsageSamples.count('g2')).toBe(1);
    expect(db.stickerUsageSamples.count('g3')).toBe(0);
  });

  it('reply_to_target NULL persists as null, non-null persists as-is', () => {
    db.stickerUsageSamples.insert({
      groupId: 'g1', stickerKey: 'k', senderUserId: 'u',
      prevMsgs: [], triggerText: '', replyToTarget: null, createdAt: 1,
    });
    db.stickerUsageSamples.insert({
      groupId: 'g1', stickerKey: 'k', senderUserId: 'u',
      prevMsgs: [], triggerText: '', replyToTarget: 'u9: hello', createdAt: 2,
    });
    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    expect(rows[0]!.replyToTarget).toBeNull();
    expect(rows[1]!.replyToTarget).toBe('u9: hello');
  });

  it('migration is idempotent — open same DB file twice', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'sus-mig-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const db1 = new Database(dbPath);
    db1.stickerUsageSamples.insert({
      groupId: 'g1', stickerKey: 'k', senderUserId: 'u',
      prevMsgs: [], triggerText: '', replyToTarget: null, createdAt: 1,
    });
    expect(db1.stickerUsageSamples.count('g1')).toBe(1);
    db1.close();
    // Reopen — schema + migrations re-run; row preserved.
    const db2 = new Database(dbPath);
    expect(db2.stickerUsageSamples.count('g1')).toBe(1);
    db2.close();
  });
});
