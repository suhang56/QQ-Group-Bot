import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../src/storage/db.js';
import type { LearnedFact } from '../src/storage/db.js';

function makeDb(): Database {
  return new Database(':memory:');
}

function countByStatusTopic(db: Database, groupId: string, status: string, topic: string | null): number {
  const sql = topic === null
    ? `SELECT COUNT(*) as n FROM learned_facts WHERE group_id=? AND status=? AND topic IS NULL`
    : `SELECT COUNT(*) as n FROM learned_facts WHERE group_id=? AND status=? AND topic=?`;
  const args: unknown[] = topic === null ? [groupId, status] : [groupId, status, topic];
  const row = (db as unknown as { rawDb: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } } })
    .rawDb.prepare(sql).get(...args) as { n: number };
  return row.n;
}

function insertRawActive(
  db: Database,
  groupId: string,
  topic: string | null,
  fact: string,
): number {
  return db.learnedFacts.insert({
    groupId,
    topic,
    fact,
    canonicalForm: fact,
    sourceUserId: null,
    sourceUserNickname: null,
    sourceMsgId: null,
    botReplyId: null,
    status: 'active',
  });
}

function findActiveByTopic(db: Database, groupId: string, topic: string): LearnedFact[] {
  return db.learnedFacts.listActive(groupId, 100).filter(f => f.topic === topic);
}

describe('insertOrSupersede — exact-topic semantics (cases 1-7 per DEV-READY)', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('case 1: topic=null → insert-only, supersededCount=0, no UPDATE issued', () => {
    const existing = insertRawActive(db, 'g1', null, 'some preexisting fact');
    const { newId, supersededCount } = db.learnedFacts.insertOrSupersede({
      groupId: 'g1',
      topic: null,
      fact: 'new fact',
      sourceUserId: null,
      sourceUserNickname: null,
      sourceMsgId: null,
      botReplyId: null,
      status: 'active',
    });
    expect(newId).toBeGreaterThan(0);
    expect(supersededCount).toBe(0);
    // Existing stays active
    const active = db.learnedFacts.listActive('g1', 100);
    expect(active.map(f => f.id).sort()).toEqual([existing, newId].sort());
  });

  it("case 2: bare '群内黑话' (no :term suffix) → insert-only, extractTerm returns null", () => {
    insertRawActive(db, 'g1', '群内黑话', 'legacy bare jargon');
    const { supersededCount } = db.learnedFacts.insertOrSupersede({
      groupId: 'g1',
      topic: '群内黑话',
      fact: 'new bare jargon',
      sourceUserId: null,
      sourceUserNickname: null,
      sourceMsgId: null,
      botReplyId: null,
      status: 'active',
    });
    expect(supersededCount).toBe(0);
    expect(countByStatusTopic(db, 'g1', 'active', '群内黑话')).toBe(2);
  });

  it("case 3: 'user-taught:ygfn' + existing 'user-taught:ygfn' active → supersede that one", () => {
    const oldId = insertRawActive(db, 'g1', 'user-taught:ygfn', 'ygfn=旧内容');
    const { newId, supersededCount } = db.learnedFacts.insertOrSupersede({
      groupId: 'g1',
      topic: 'user-taught:ygfn',
      fact: 'ygfn=新内容',
      canonicalForm: 'ygfn=新内容',
      sourceUserId: null,
      sourceUserNickname: null,
      sourceMsgId: null,
      botReplyId: null,
      status: 'active',
    });
    expect(supersededCount).toBe(1);
    expect(newId).not.toBe(oldId);
    const active = findActiveByTopic(db, 'g1', 'user-taught:ygfn');
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(newId);
    expect(active[0]!.fact).toBe('ygfn=新内容');
  });

  it("case 4: 'user-taught:ygfn' + existing 'opus-classified:fandom:ygfn' → both stay active", () => {
    const opusId = insertRawActive(db, 'g1', 'opus-classified:fandom:ygfn', 'opus guess for ygfn');
    const { newId, supersededCount } = db.learnedFacts.insertOrSupersede({
      groupId: 'g1',
      topic: 'user-taught:ygfn',
      fact: 'ygfn=羊宫妃那',
      canonicalForm: 'ygfn=羊宫妃那',
      sourceUserId: null,
      sourceUserNickname: null,
      sourceMsgId: null,
      botReplyId: null,
      status: 'active',
    });
    expect(supersededCount).toBe(0);
    const active = db.learnedFacts.findActiveByTopicTerm('g1', 'ygfn');
    const ids = active.map(f => f.id).sort();
    expect(ids).toEqual([opusId, newId].sort());
  });

  it("case 5: 'opus-classified:fandom:ygfn' + existing 'user-taught:ygfn' → both stay active", () => {
    const userId = insertRawActive(db, 'g1', 'user-taught:ygfn', 'ygfn=authoritative');
    const { newId, supersededCount } = db.learnedFacts.insertOrSupersede({
      groupId: 'g1',
      topic: 'opus-classified:fandom:ygfn',
      fact: 'opus guess',
      sourceUserId: null,
      sourceUserNickname: null,
      sourceMsgId: null,
      botReplyId: null,
      status: 'active',
    });
    expect(supersededCount).toBe(0);
    const active = db.learnedFacts.findActiveByTopicTerm('g1', 'ygfn');
    expect(active.map(f => f.id).sort()).toEqual([userId, newId].sort());
  });

  it("case 6: 'opus-classified:fandom:ygfn' + existing 'opus-classified:slang:ygfn' → both stay active", () => {
    const slangId = insertRawActive(db, 'g1', 'opus-classified:slang:ygfn', 'slang guess');
    const { newId, supersededCount } = db.learnedFacts.insertOrSupersede({
      groupId: 'g1',
      topic: 'opus-classified:fandom:ygfn',
      fact: 'fandom guess',
      sourceUserId: null,
      sourceUserNickname: null,
      sourceMsgId: null,
      botReplyId: null,
      status: 'active',
    });
    expect(supersededCount).toBe(0);
    const active = db.learnedFacts.findActiveByTopicTerm('g1', 'ygfn');
    expect(active.map(f => f.id).sort()).toEqual([slangId, newId].sort());
  });

  it('case 7: pathological — 6 active rows same topic → throws, DB unchanged (ROLLBACK)', () => {
    // Seed 6 active rows with identical topic. Healthy DB should never have
    // this, but the 5-row guard must stop a runaway supersede from happening.
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(insertRawActive(db, 'g1', 'user-taught:ygfn', `ygfn content ${i}`));
    }
    const activeBefore = countByStatusTopic(db, 'g1', 'active', 'user-taught:ygfn');
    const supersededBefore = countByStatusTopic(db, 'g1', 'superseded', 'user-taught:ygfn');
    expect(activeBefore).toBe(6);
    expect(supersededBefore).toBe(0);

    expect(() =>
      db.learnedFacts.insertOrSupersede({
        groupId: 'g1',
        topic: 'user-taught:ygfn',
        fact: 'attempted new ygfn',
        sourceUserId: null,
        sourceUserNickname: null,
        sourceMsgId: null,
        botReplyId: null,
        status: 'active',
      }),
    ).toThrow(/has 6 active rows/);

    // ROLLBACK — 6 active rows remain, still 0 superseded, no new row.
    expect(countByStatusTopic(db, 'g1', 'active', 'user-taught:ygfn')).toBe(6);
    expect(countByStatusTopic(db, 'g1', 'superseded', 'user-taught:ygfn')).toBe(0);
  });

  // R6 regression: normalizedRow must be INSERTED (trimmed topic), never raw row.
  it('R6: whitespace-padded topic is trimmed before INSERT (no orphan rows)', () => {
    const { newId } = db.learnedFacts.insertOrSupersede({
      groupId: 'g1',
      topic: '  user-taught:ygfn  ',
      fact: 'ygfn=羊宫妃那',
      canonicalForm: 'ygfn=羊宫妃那',
      sourceUserId: null,
      sourceUserNickname: null,
      sourceMsgId: null,
      botReplyId: null,
      status: 'active',
    });
    const stored = (db as unknown as { rawDb: { prepare: (sql: string) => { get: (id: number) => unknown } } })
      .rawDb.prepare('SELECT topic FROM learned_facts WHERE id=?')
      .get(newId) as { topic: string };
    expect(stored.topic).toBe('user-taught:ygfn');
    // Future lookup via trimmed topic hits the row.
    const active = db.learnedFacts.findActiveByTopicTerm('g1', 'ygfn');
    expect(active.map(f => f.id)).toContain(newId);
  });
});
