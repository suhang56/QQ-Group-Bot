import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../../src/storage/db.js';
import { initLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

describe('LearnedFactsRepository — pending queue (Feature B)', () => {
  let db: Database;
  beforeEach(() => { db = new Database(':memory:'); });

  function insert(groupId: string, fact: string, status: 'active' | 'pending' = 'active'): number {
    return db.learnedFacts.insert({
      groupId, topic: null, fact,
      sourceUserId: null, sourceUserNickname: null,
      sourceMsgId: null, botReplyId: null,
      status,
    });
  }

  it('insert() with status="pending" stores pending row', () => {
    const id = insert('g1', 'A', 'pending');
    expect(id).toBeGreaterThan(0);
    expect(db.learnedFacts.countPending('g1')).toBe(1);
    expect(db.learnedFacts.countActive('g1')).toBe(0);
  });

  it('insert() default status is still active (backward compatible)', () => {
    insert('g1', 'A');
    expect(db.learnedFacts.countActive('g1')).toBe(1);
    expect(db.learnedFacts.countPending('g1')).toBe(0);
  });

  it('listActive excludes pending rows', () => {
    insert('g1', 'act', 'active');
    insert('g1', 'pend', 'pending');
    const active = db.learnedFacts.listActive('g1', 10);
    expect(active).toHaveLength(1);
    expect(active[0]!.fact).toBe('act');
  });

  it('listActiveWithEmbeddings excludes pending rows', () => {
    const a = insert('g1', 'act', 'active');
    const p = insert('g1', 'pend', 'pending');
    db.learnedFacts.updateEmbedding(a, [1, 0, 0, 0, 0, 0, 0, 0]);
    db.learnedFacts.updateEmbedding(p, [1, 0, 0, 0, 0, 0, 0, 0]);
    const out = db.learnedFacts.listActiveWithEmbeddings('g1');
    expect(out).toHaveLength(1);
    expect(out[0]!.fact).toBe('act');
  });

  it('listPending orders by id DESC with limit and offset', () => {
    const ids = [1, 2, 3, 4, 5].map(n => insert('g1', `p${n}`, 'pending'));
    const page1 = db.learnedFacts.listPending('g1', 2, 0);
    expect(page1.map(f => f.id)).toEqual([ids[4], ids[3]]);
    const page2 = db.learnedFacts.listPending('g1', 2, 2);
    expect(page2.map(f => f.id)).toEqual([ids[2], ids[1]]);
    const page3 = db.learnedFacts.listPending('g1', 2, 4);
    expect(page3.map(f => f.id)).toEqual([ids[0]]);
  });

  it('listPending is scoped to groupId', () => {
    insert('g1', 'p', 'pending');
    insert('g2', 'p', 'pending');
    expect(db.learnedFacts.listPending('g1', 10, 0)).toHaveLength(1);
    expect(db.learnedFacts.listPending('g2', 10, 0)).toHaveLength(1);
    expect(db.learnedFacts.listPending('g3', 10, 0)).toHaveLength(0);
  });

  it('countPending is scoped to groupId', () => {
    insert('g1', 'a', 'pending');
    insert('g1', 'b', 'pending');
    insert('g2', 'c', 'pending');
    insert('g1', 'd', 'active');
    expect(db.learnedFacts.countPending('g1')).toBe(2);
    expect(db.learnedFacts.countPending('g2')).toBe(1);
    expect(db.learnedFacts.countPending('empty')).toBe(0);
  });

  it('markStatus pending → active promotes row', () => {
    const id = insert('g1', 'p', 'pending');
    db.learnedFacts.markStatus(id, 'active');
    expect(db.learnedFacts.countPending('g1')).toBe(0);
    expect(db.learnedFacts.countActive('g1')).toBe(1);
  });

  it('markStatus pending → rejected removes from both counts', () => {
    const id = insert('g1', 'p', 'pending');
    db.learnedFacts.markStatus(id, 'rejected');
    expect(db.learnedFacts.countPending('g1')).toBe(0);
    expect(db.learnedFacts.countActive('g1')).toBe(0);
  });

  it('empty pending list returns []', () => {
    expect(db.learnedFacts.listPending('g1', 10, 0)).toEqual([]);
  });

  it('listPending limit 0 returns empty', () => {
    insert('g1', 'p', 'pending');
    expect(db.learnedFacts.listPending('g1', 0, 0)).toHaveLength(0);
  });
});

describe('LearnedFactsRepository — listAliasFactsForMap (M6.2c)', () => {
  let db: Database;
  beforeEach(() => { db = new Database(':memory:'); });

  function insertFact(groupId: string, topic: string | null, fact: string, status: 'active' | 'pending' = 'active'): number {
    return db.learnedFacts.insert({
      groupId, topic, fact,
      sourceUserId: null, sourceUserNickname: null,
      sourceMsgId: null, botReplyId: null,
      status,
    });
  }

  it('returns active alias facts', () => {
    insertFact('g1', '群友别名 小明', 'small ming fact', 'active');
    const rows = db.learnedFacts.listAliasFactsForMap('g1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fact).toBe('small ming fact');
  });

  it('returns pending alias facts (critical: miner rows are pending)', () => {
    insertFact('g1', '群友别名 拉神', 'laa shen = User5', 'pending');
    const rows = db.learnedFacts.listAliasFactsForMap('g1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
  });

  it('returns both active and pending alias facts mixed', () => {
    insertFact('g1', '群友别名 A', 'active fact', 'active');
    insertFact('g1', '群友别名 B', 'pending fact', 'pending');
    const rows = db.learnedFacts.listAliasFactsForMap('g1');
    expect(rows).toHaveLength(2);
    const statuses = rows.map(r => r.status).sort();
    expect(statuses).toEqual(['active', 'pending']);
  });

  it('excludes non-alias-topic rows (topic must LIKE %别名%)', () => {
    insertFact('g1', '群友别名 A', 'alias fact', 'active');
    insertFact('g1', '小明的爱好', 'hobby fact', 'active');
    insertFact('g1', null, 'no-topic fact', 'active');
    const rows = db.learnedFacts.listAliasFactsForMap('g1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fact).toBe('alias fact');
  });

  it('scopes by group id', () => {
    insertFact('g1', '群友别名 A', 'g1 alias', 'active');
    insertFact('g2', '群友别名 B', 'g2 alias', 'active');
    const g1Rows = db.learnedFacts.listAliasFactsForMap('g1');
    expect(g1Rows).toHaveLength(1);
    expect(g1Rows[0]!.fact).toBe('g1 alias');
  });

  it('returns results respecting LIMIT 200 cap', () => {
    for (let i = 0; i < 5; i++) {
      insertFact('g1', `群友别名 k${i}`, `fact ${i}`, i % 2 === 0 ? 'active' : 'pending');
    }
    const rows = db.learnedFacts.listAliasFactsForMap('g1');
    expect(rows).toHaveLength(5);
    expect(rows.every(r => r.topic?.includes('别名'))).toBe(true);
  });

  it('regression: listActiveAliasFacts still returns ONLY active alias rows', () => {
    insertFact('g1', '群友别名 A', 'active fact', 'active');
    insertFact('g1', '群友别名 B', 'pending fact', 'pending');
    const rows = db.learnedFacts.listActiveAliasFacts('g1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('active');
  });

  it('regression: listPending still returns ALL pending rows (alias + non-alias)', () => {
    insertFact('g1', '群友别名 A', 'alias pending', 'pending');
    insertFact('g1', '小明的爱好', 'hobby pending', 'pending');
    const rows = db.learnedFacts.listPending('g1', 100, 0);
    expect(rows).toHaveLength(2);
    const facts = rows.map(r => r.fact).sort();
    expect(facts).toEqual(['alias pending', 'hobby pending']);
  });

  it('empty group returns empty array', () => {
    expect(db.learnedFacts.listAliasFactsForMap('empty-group')).toEqual([]);
  });
});
