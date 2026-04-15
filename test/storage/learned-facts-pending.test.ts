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
