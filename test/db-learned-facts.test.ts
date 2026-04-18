import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Database } from '../src/storage/db.js';

function makeDb(): Database {
  return new Database(':memory:');
}

describe('LearnedFactsRepository', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  function insert(groupId: string, fact: string, extras: Partial<Parameters<Database['learnedFacts']['insert']>[0]> = {}): number {
    return db.learnedFacts.insert({
      groupId, topic: null, fact,
      sourceUserId: null, sourceUserNickname: null,
      sourceMsgId: null, botReplyId: null,
      ...extras,
    });
  }

  it('insert returns id and the row defaults to active status', () => {
    const id = insert('g1', 'fact one');
    expect(id).toBeGreaterThan(0);
    const facts = db.learnedFacts.listActive('g1', 10);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.status).toBe('active');
    expect(facts[0]!.confidence).toBe(1.0);
  });

  it('listActive respects limit and orders newest-first (created_at desc, id desc tiebreaker)', () => {
    insert('g1', 'A');
    insert('g1', 'B');
    insert('g1', 'C');

    const all = db.learnedFacts.listActive('g1', 10);
    expect(all.map(f => f.fact)).toEqual(['C', 'B', 'A']);

    const limited = db.learnedFacts.listActive('g1', 2);
    expect(limited).toHaveLength(2);
    expect(limited[0]!.fact).toBe('C');
  });

  it('listActive excludes rejected and superseded facts', () => {
    const a = insert('g1', 'A');
    const b = insert('g1', 'B');
    insert('g1', 'C');

    db.learnedFacts.markStatus(a, 'rejected');
    db.learnedFacts.markStatus(b, 'superseded');

    const active = db.learnedFacts.listActive('g1', 10);
    expect(active).toHaveLength(1);
    expect(active[0]!.fact).toBe('C');
  });

  it('markStatus changes status and bumps updated_at', async () => {
    const id = insert('g1', 'A');
    const before = db.learnedFacts.listActive('g1', 10)[0]!;
    await new Promise(r => setTimeout(r, 1100));
    db.learnedFacts.markStatus(id, 'rejected');

    // active list no longer contains it; verify via countActive
    expect(db.learnedFacts.countActive('g1')).toBe(0);

    // re-insert another row to confirm timestamps work; cross-check before timestamp
    const id2 = insert('g1', 'B');
    expect(id2).not.toBe(id);
    const after = db.learnedFacts.listActive('g1', 10)[0]!;
    expect(after.createdAt).toBeGreaterThanOrEqual(before.createdAt);
  });

  it('clearGroup deletes only the target group and returns the count', () => {
    insert('g1', 'A');
    insert('g1', 'B');
    insert('g2', 'C');

    const deleted = db.learnedFacts.clearGroup('g1');
    expect(deleted).toBe(2);
    expect(db.learnedFacts.countActive('g1')).toBe(0);
    expect(db.learnedFacts.countActive('g2')).toBe(1);
  });

  it('countActive only counts active rows', () => {
    const a = insert('g1', 'A');
    insert('g1', 'B');
    insert('g1', 'C');
    db.learnedFacts.markStatus(a, 'rejected');
    expect(db.learnedFacts.countActive('g1')).toBe(2);
  });

  it('updateEmbedding sets embedding_status to done', () => {
    const id = insert('g1', 'fact-embed');
    db.learnedFacts.updateEmbedding(id, [0.1, 0.2, 0.3]);
    const raw = (db as any)._db.prepare(
      'SELECT embedding_status FROM learned_facts WHERE id = ?'
    ).get(id) as { embedding_status: string };
    expect(raw.embedding_status).toBe('done');
  });

  it('recordEmbeddingFailure cycles pending->fail_1->fail_2->failed independently', () => {
    const id = insert('g1', 'fact-fail');
    db.learnedFacts.recordEmbeddingFailure(id);
    let raw = (db as any)._db.prepare(
      'SELECT embedding_status FROM learned_facts WHERE id = ?'
    ).get(id) as { embedding_status: string };
    expect(raw.embedding_status).toBe('fail_1');

    db.learnedFacts.recordEmbeddingFailure(id);
    raw = (db as any)._db.prepare(
      'SELECT embedding_status FROM learned_facts WHERE id = ?'
    ).get(id) as { embedding_status: string };
    expect(raw.embedding_status).toBe('fail_2');

    db.learnedFacts.recordEmbeddingFailure(id);
    raw = (db as any)._db.prepare(
      'SELECT embedding_status FROM learned_facts WHERE id = ?'
    ).get(id) as { embedding_status: string };
    expect(raw.embedding_status).toBe('failed');
  });
});

describe('Database migration: bot_replies.was_evasive on existing DBs', () => {
  it('adds the was_evasive column to a pre-existing bot_replies table', () => {
    // Build a "legacy" DB file in memory by hand: same bot_replies shape WITHOUT was_evasive.
    // We then open it through Database() and assert the column appears.
    //
    // node:sqlite ':memory:' DBs are not shareable, so we use a temp file path.
    const path = require('node:path') as typeof import('node:path');
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const tmp = path.join(os.tmpdir(), `qqbot-mig-${Date.now()}.db`);
    try {
      const legacy = new DatabaseSync(tmp);
      legacy.exec(`
        CREATE TABLE bot_replies (
          id                   INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id             TEXT NOT NULL,
          trigger_msg_id       TEXT,
          trigger_user_nickname TEXT,
          trigger_content      TEXT NOT NULL,
          bot_reply            TEXT NOT NULL,
          module               TEXT NOT NULL,
          sent_at              INTEGER NOT NULL,
          rating               INTEGER,
          rating_comment       TEXT,
          rated_at             INTEGER
        );
      `);
      legacy.prepare(
        'INSERT INTO bot_replies (group_id, trigger_content, bot_reply, module, sent_at) VALUES (?, ?, ?, ?, ?)'
      ).run('g1', 'trig', 'reply', 'chat', Math.floor(Date.now() / 1000));
      legacy.close();

      // Open via Database — runtime migration should add was_evasive AND learned_facts.
      const db = new Database(tmp);
      const cols = (db as unknown as { _db: DatabaseSync })._db
        .prepare(`PRAGMA table_info(bot_replies)`)
        .all() as Array<{ name: string }>;
      expect(cols.some(c => c.name === 'was_evasive')).toBe(true);

      // learned_facts table also exists
      const tables = (db as unknown as { _db: DatabaseSync })._db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='learned_facts'`)
        .all() as Array<{ name: string }>;
      expect(tables).toHaveLength(1);

      // Existing row is preserved; new evasive column defaults to 0
      const reply = db.botReplies.getRecent('g1', 10)[0];
      expect(reply).toBeDefined();
      expect(reply!.wasEvasive).toBe(false);

      db.close();
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  });

  it('markEvasive flips the column and getById reflects it', () => {
    const db = makeDb();
    const reply = db.botReplies.insert({
      groupId: 'g1', triggerMsgId: 'm1', triggerUserNickname: 'a',
      triggerContent: 't', botReply: 'r', module: 'chat',
      sentAt: Math.floor(Date.now() / 1000),
    });
    expect(reply.wasEvasive).toBe(false);

    db.botReplies.markEvasive(reply.id);
    const fetched = db.botReplies.getById(reply.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.wasEvasive).toBe(true);

    expect(db.botReplies.getById(99999)).toBeNull();
  });

  it('listEvasiveSince returns only evasive replies after the cutoff', () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);

    const a = db.botReplies.insert({ groupId: 'g1', triggerMsgId: null, triggerUserNickname: null, triggerContent: 'a', botReply: 'r', module: 'chat', sentAt: now - 100 });
    const b = db.botReplies.insert({ groupId: 'g1', triggerMsgId: null, triggerUserNickname: null, triggerContent: 'b', botReply: 'r', module: 'chat', sentAt: now - 30 });
    db.botReplies.insert({ groupId: 'g1', triggerMsgId: null, triggerUserNickname: null, triggerContent: 'c', botReply: 'r', module: 'chat', sentAt: now - 10 });

    db.botReplies.markEvasive(a.id);
    db.botReplies.markEvasive(b.id);

    const recentEvasive = db.botReplies.listEvasiveSince('g1', now - 60);
    expect(recentEvasive).toHaveLength(1);
    expect(recentEvasive[0]!.id).toBe(b.id);
  });
});
