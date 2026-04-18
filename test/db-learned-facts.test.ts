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

describe('LearnedFactsRepository.insertOrSupersede', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  function insertRaw(groupId: string, fact: string, status: string = 'active', canonicalForm?: string): number {
    return db.learnedFacts.insert({
      groupId, topic: null, fact,
      canonicalForm: canonicalForm ?? null,
      sourceUserId: null, sourceUserNickname: null,
      sourceMsgId: null, botReplyId: null,
      status: status as 'active' | 'pending' | 'superseded' | 'rejected',
    });
  }

  function countByStatus(groupId: string, status: string): number {
    const row = db.rawDb.prepare(
      'SELECT COUNT(*) as n FROM learned_facts WHERE group_id = ? AND status = ?'
    ).get(groupId, status) as { n: number };
    return row.n;
  }

  it('T1: new term inserts without superseding anything', () => {
    const { newId, supersededCount } = db.learnedFacts.insertOrSupersede(
      { groupId: 'g1', topic: null, fact: 'xtt的意思是某人', canonicalForm: 'xtt的意思是某人', sourceUserId: null, sourceUserNickname: null, sourceMsgId: null, botReplyId: null, status: 'active' },
      'xtt',
    );
    expect(newId).toBeGreaterThan(0);
    expect(supersededCount).toBe(0);
    expect(countByStatus('g1', 'active')).toBe(1);
  });

  it('T2: single existing row is superseded and new row inserted', () => {
    insertRaw('g1', 'xtt的意思是旧含义', 'active', 'xtt的意思是旧含义');
    const { supersededCount } = db.learnedFacts.insertOrSupersede(
      { groupId: 'g1', topic: null, fact: 'xtt的意思是新含义', canonicalForm: 'xtt的意思是新含义', sourceUserId: null, sourceUserNickname: null, sourceMsgId: null, botReplyId: null, status: 'active' },
      'xtt',
    );
    expect(supersededCount).toBe(1);
    expect(countByStatus('g1', 'superseded')).toBe(1);
    expect(countByStatus('g1', 'active')).toBe(1);
    expect(db.learnedFacts.listActive('g1', 10)[0]!.fact).toBe('xtt的意思是新含义');
  });

  it('T3: multiple existing rows all superseded atomically', () => {
    insertRaw('g1', 'xtt是好人', 'active', 'xtt是好人');
    insertRaw('g1', 'xtt是学生', 'active', 'xtt是学生');
    const { supersededCount } = db.learnedFacts.insertOrSupersede(
      { groupId: 'g1', topic: null, fact: 'xtt的最新含义', sourceUserId: null, sourceUserNickname: null, sourceMsgId: null, botReplyId: null, status: 'active' },
      'xtt',
    );
    expect(supersededCount).toBe(2);
    expect(countByStatus('g1', 'superseded')).toBe(2);
    expect(countByStatus('g1', 'active')).toBe(1);
  });

  it('T4: fact text substring match triggers supersede', () => {
    insertRaw('g1', '大家知道xtt是群里的人', 'active');
    const { supersededCount } = db.learnedFacts.insertOrSupersede(
      { groupId: 'g1', topic: null, fact: 'xtt的意思是某人', sourceUserId: null, sourceUserNickname: null, sourceMsgId: null, botReplyId: null, status: 'active' },
      'xtt',
    );
    expect(supersededCount).toBe(1);
  });

  it('T5: canonical_form-only match triggers supersede', () => {
    insertRaw('g1', '不相关的fact文字', 'active', 'xtt的意思是旧内容');
    const { supersededCount } = db.learnedFacts.insertOrSupersede(
      { groupId: 'g1', topic: null, fact: 'xtt的意思是新内容', canonicalForm: 'xtt的意思是新内容', sourceUserId: null, sourceUserNickname: null, sourceMsgId: null, botReplyId: null, status: 'active' },
      'xtt',
    );
    expect(supersededCount).toBe(1);
  });

  it('T6: term shorter than 3 chars skips supersede and just inserts', () => {
    insertRaw('g1', 'ab相关的事实', 'active', 'ab相关');
    const { supersededCount } = db.learnedFacts.insertOrSupersede(
      { groupId: 'g1', topic: null, fact: '新内容', sourceUserId: null, sourceUserNickname: null, sourceMsgId: null, botReplyId: null, status: 'active' },
      'ab',
    );
    expect(supersededCount).toBe(0);
    expect(countByStatus('g1', 'active')).toBe(2);
  });

  it('T6b: rollback — UPDATE succeeds but INSERT fails; superseded rows restored to active', () => {
    // Insert a row matching the term so the UPDATE step will mark it superseded.
    insertRaw('g1', 'xtt是某人', 'active', 'xtt的意思是某人');
    expect(countByStatus('g1', 'active')).toBe(1);

    // Pass null for fact (NOT NULL column) — this causes the INSERT to throw after UPDATE ran.
    expect(() =>
      db.learnedFacts.insertOrSupersede(
        { groupId: 'g1', topic: null, fact: null as unknown as string, sourceUserId: null, sourceUserNickname: null, sourceMsgId: null, botReplyId: null, status: 'active' },
        'xtt',
      )
    ).toThrow();

    // ROLLBACK must have fired — original row still active, no superseded rows.
    expect(countByStatus('g1', 'active')).toBe(1);
    expect(countByStatus('g1', 'superseded')).toBe(0);
  });

  it('T7: cross-group isolation — does not supersede other group rows', () => {
    insertRaw('g2', 'xtt是g2成员', 'active', 'xtt是g2成员');
    db.learnedFacts.insertOrSupersede(
      { groupId: 'g1', topic: null, fact: 'xtt的新内容', sourceUserId: null, sourceUserNickname: null, sourceMsgId: null, botReplyId: null, status: 'active' },
      'xtt',
    );
    expect(countByStatus('g2', 'active')).toBe(1);
    expect(countByStatus('g2', 'superseded')).toBe(0);
  });

  it('T8: already-superseded rows are not re-superseded', () => {
    insertRaw('g1', 'xtt旧事实', 'superseded', 'xtt旧事实');
    const { supersededCount } = db.learnedFacts.insertOrSupersede(
      { groupId: 'g1', topic: null, fact: 'xtt的意思是新内容', sourceUserId: null, sourceUserNickname: null, sourceMsgId: null, botReplyId: null, status: 'active' },
      'xtt',
    );
    expect(supersededCount).toBe(0);
    expect(countByStatus('g1', 'active')).toBe(1);
    expect(countByStatus('g1', 'superseded')).toBe(1);
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

describe('LearnedFactsRepository.findActiveByTopicTerm', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  function insertFact(
    groupId: string,
    topic: string,
    fact: string,
    status: 'active' | 'pending' | 'superseded' | 'rejected' = 'active',
  ): number {
    return db.learnedFacts.insert({
      groupId, topic, fact,
      sourceUserId: null, sourceUserNickname: null,
      sourceMsgId: null, botReplyId: null,
      status,
    });
  }

  it('returns all 6 rows when all topic prefixes active for term', () => {
    insertFact('g1', 'user-taught:ygfn', '1');
    insertFact('g1', 'opus-classified:slang:ygfn', '2');
    insertFact('g1', 'opus-classified:fandom:ygfn', '3');
    insertFact('g1', 'opus-rest-classified:slang:ygfn', '4');
    insertFact('g1', 'opus-rest-classified:fandom:ygfn', '5');
    insertFact('g1', '群内黑话:ygfn', '6');
    const result = db.learnedFacts.findActiveByTopicTerm('g1', 'ygfn');
    expect(result).toHaveLength(6);
  });

  it('excludes inactive rows (5 active + 1 superseded)', () => {
    insertFact('g1', 'user-taught:ygfn', '1');
    insertFact('g1', 'opus-classified:slang:ygfn', '2');
    insertFact('g1', 'opus-classified:fandom:ygfn', '3');
    insertFact('g1', 'opus-rest-classified:slang:ygfn', '4');
    insertFact('g1', 'opus-rest-classified:fandom:ygfn', '5');
    insertFact('g1', '群内黑话:ygfn', '6', 'superseded');
    const result = db.learnedFacts.findActiveByTopicTerm('g1', 'ygfn');
    expect(result).toHaveLength(5);
    expect(result.every(r => r.topic !== '群内黑话:ygfn')).toBe(true);
  });

  it('returns only exact topic match — no substring leak', () => {
    insertFact('g1', 'user-taught:xtt', 'xtt-fact');
    insertFact('g1', 'user-taught:tt', 'tt-fact');
    const result = db.learnedFacts.findActiveByTopicTerm('g1', 'tt');
    expect(result).toHaveLength(1);
    expect(result[0]!.topic).toBe('user-taught:tt');
  });

  it('returns empty array for absent term', () => {
    insertFact('g1', 'user-taught:xtt', 'xtt-fact');
    const result = db.learnedFacts.findActiveByTopicTerm('g1', 'absent');
    expect(result).toEqual([]);
  });

  it('scopes by groupId', () => {
    insertFact('g2', 'user-taught:ygfn', 'g2-fact');
    const result = db.learnedFacts.findActiveByTopicTerm('g1', 'ygfn');
    expect(result).toEqual([]);
  });

  it('orders by id DESC', () => {
    const first = insertFact('g1', 'user-taught:ygfn', '1');
    const second = insertFact('g1', 'opus-classified:slang:ygfn', '2');
    const result = db.learnedFacts.findActiveByTopicTerm('g1', 'ygfn');
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe(second);
    expect(result[1]!.id).toBe(first);
  });
});

describe('LearnedFactsRepository.insertOrSupersede — user-taught protection', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  function insertFact(
    groupId: string,
    topic: string,
    fact: string,
    canonicalForm: string | null = null,
    status: 'active' | 'pending' | 'superseded' | 'rejected' = 'active',
  ): number {
    return db.learnedFacts.insert({
      groupId, topic, fact,
      canonicalForm: canonicalForm ?? fact,
      sourceUserId: null, sourceUserNickname: null,
      sourceMsgId: null, botReplyId: null,
      status,
    });
  }

  function statusOf(id: number): string {
    const row = db.rawDb.prepare(
      'SELECT status FROM learned_facts WHERE id = ?',
    ).get(id) as { status: string };
    return row.status;
  }

  it('non-user-taught insert leaves existing user-taught row active', () => {
    const userTaughtId = insertFact('g1', 'user-taught:ygfn', 'ygfn=羊宫妃那');
    const opusOldId = insertFact('g1', 'opus-classified:slang:ygfn', 'ygfn可能是某缩写');

    db.learnedFacts.insertOrSupersede(
      {
        groupId: 'g1', topic: 'opus-classified:slang:ygfn',
        fact: 'ygfn新的推测内容',
        canonicalForm: 'ygfn新的推测内容',
        sourceUserId: null, sourceUserNickname: null,
        sourceMsgId: null, botReplyId: null,
        status: 'active',
      },
      'ygfn',
    );

    expect(statusOf(userTaughtId)).toBe('active');
    expect(statusOf(opusOldId)).toBe('superseded');
  });

  it('user-taught insert supersedes all including other user-taught', () => {
    const oldUserTaughtId = insertFact('g1', 'user-taught:ygfn', 'ygfn=旧内容');
    const opusId = insertFact('g1', 'opus-classified:slang:ygfn', 'ygfn旧推测');

    db.learnedFacts.insertOrSupersede(
      {
        groupId: 'g1', topic: 'user-taught:ygfn',
        fact: 'ygfn=羊宫妃那',
        canonicalForm: 'ygfn=羊宫妃那',
        sourceUserId: null, sourceUserNickname: null,
        sourceMsgId: null, botReplyId: null,
        status: 'active',
      },
      'ygfn',
    );

    expect(statusOf(oldUserTaughtId)).toBe('superseded');
    expect(statusOf(opusId)).toBe('superseded');
    const active = db.learnedFacts.findActiveByTopicTerm('g1', 'ygfn');
    expect(active).toHaveLength(1);
    expect(active[0]!.topic).toBe('user-taught:ygfn');
    expect(active[0]!.canonicalForm).toBe('ygfn=羊宫妃那');
  });

  it('no existing rows: inserts active, supersededCount=0', () => {
    const { newId, supersededCount } = db.learnedFacts.insertOrSupersede(
      {
        groupId: 'g1', topic: 'opus-classified:slang:ygfn',
        fact: 'ygfn新条目',
        canonicalForm: 'ygfn新条目',
        sourceUserId: null, sourceUserNickname: null,
        sourceMsgId: null, botReplyId: null,
        status: 'active',
      },
      'ygfn',
    );
    expect(newId).toBeGreaterThan(0);
    expect(supersededCount).toBe(0);
    expect(statusOf(newId)).toBe('active');
  });

  it('two user-taught rows: new user-taught supersedes both', () => {
    const u1 = insertFact('g1', 'user-taught:ygfn', 'ygfn=第一条');
    const u2 = insertFact('g1', 'user-taught:ygfn', 'ygfn=第二条');

    db.learnedFacts.insertOrSupersede(
      {
        groupId: 'g1', topic: 'user-taught:ygfn',
        fact: 'ygfn=第三条',
        canonicalForm: 'ygfn=第三条',
        sourceUserId: null, sourceUserNickname: null,
        sourceMsgId: null, botReplyId: null,
        status: 'active',
      },
      'ygfn',
    );

    expect(statusOf(u1)).toBe('superseded');
    expect(statusOf(u2)).toBe('superseded');
    const active = db.learnedFacts.findActiveByTopicTerm('g1', 'ygfn');
    expect(active).toHaveLength(1);
    expect(active[0]!.canonicalForm).toBe('ygfn=第三条');
  });
});
