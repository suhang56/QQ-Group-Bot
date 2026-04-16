import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../../src/storage/db.js';
import { initLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

describe('PhraseCandidatesRepository', () => {
  let db: Database;
  beforeEach(() => { db = new Database(':memory:'); });

  it('upsert inserts new phrase with context and gram_len', () => {
    db.phraseCandidates.upsert('g1', 'hello world', 2, 'someone said hello world');
    const list = db.phraseCandidates.list('g1', 1, 10);
    expect(list.length).toBe(1);
    expect(list[0]!.content).toBe('hello world');
    expect(list[0]!.gramLen).toBe(2);
    expect(list[0]!.count).toBe(1);
    expect(list[0]!.contexts).toEqual(['someone said hello world']);
    expect(list[0]!.isJargon).toBe(false);
    expect(list[0]!.meaning).toBeNull();
  });

  it('upsert increments count on duplicate', () => {
    db.phraseCandidates.upsert('g1', 'repeat phrase', 2, 'ctx1');
    db.phraseCandidates.upsert('g1', 'repeat phrase', 2, 'ctx2');
    db.phraseCandidates.upsert('g1', 'repeat phrase', 2, 'ctx3');
    const list = db.phraseCandidates.list('g1', 1, 10);
    expect(list.length).toBe(1);
    expect(list[0]!.count).toBe(3);
    expect(list[0]!.contexts).toEqual(['ctx1', 'ctx2', 'ctx3']);
  });

  it('upsert caps contexts at 10', () => {
    for (let i = 0; i < 15; i++) {
      db.phraseCandidates.upsert('g1', 'many contexts', 3, `ctx${i}`);
    }
    const list = db.phraseCandidates.list('g1', 1, 10);
    expect(list[0]!.contexts.length).toBe(10);
    expect(list[0]!.count).toBe(15);
  });

  it('upsert with null context does not add to contexts array', () => {
    db.phraseCandidates.upsert('g1', 'no-ctx', 2, null);
    const list = db.phraseCandidates.list('g1', 1, 10);
    expect(list[0]!.contexts).toEqual([]);
  });

  it('list respects minCount filter', () => {
    db.phraseCandidates.upsert('g1', 'rare', 2, null);
    for (let i = 0; i < 5; i++) {
      db.phraseCandidates.upsert('g1', 'common', 2, null);
    }
    const listAll = db.phraseCandidates.list('g1', 1, 10);
    expect(listAll.length).toBe(2);
    const listFiltered = db.phraseCandidates.list('g1', 3, 10);
    expect(listFiltered.length).toBe(1);
    expect(listFiltered[0]!.content).toBe('common');
  });

  it('listUnprocessed returns only candidates with count > lastInferenceCount', () => {
    // Insert and mark one as inferred
    for (let i = 0; i < 3; i++) db.phraseCandidates.upsert('g1', 'inferred', 2, null);
    for (let i = 0; i < 3; i++) db.phraseCandidates.upsert('g1', 'pending', 2, null);
    db.phraseCandidates.markInferred('g1', 'inferred', 'some meaning', true);

    const unprocessed = db.phraseCandidates.listUnprocessed('g1', 3, 10);
    expect(unprocessed.length).toBe(1);
    expect(unprocessed[0]!.content).toBe('pending');

    // Now add more occurrences to 'inferred' so it becomes unprocessed again
    for (let i = 0; i < 2; i++) db.phraseCandidates.upsert('g1', 'inferred', 2, null);
    const unprocessed2 = db.phraseCandidates.listUnprocessed('g1', 3, 10);
    expect(unprocessed2.length).toBe(2);
  });

  it('markInferred updates meaning and is_jargon', () => {
    for (let i = 0; i < 3; i++) db.phraseCandidates.upsert('g1', 'test phrase', 2, null);
    db.phraseCandidates.markInferred('g1', 'test phrase', 'it means hello', true);
    const list = db.phraseCandidates.list('g1', 1, 10);
    expect(list[0]!.meaning).toBe('it means hello');
    expect(list[0]!.isJargon).toBe(true);
    expect(list[0]!.lastInferenceCount).toBe(3);
  });

  it('markPromoted sets is_jargon to 2', () => {
    db.phraseCandidates.upsert('g1', 'promoted', 3, null);
    db.phraseCandidates.markPromoted('g1', 'promoted');
    // is_jargon=2 means promoted; list still returns it but the value is 2 (truthy)
    const row = db.rawDb.prepare(
      'SELECT is_jargon FROM phrase_candidates WHERE group_id = ? AND content = ?'
    ).get('g1', 'promoted') as { is_jargon: number };
    expect(row.is_jargon).toBe(2);
  });

  it('different groups are isolated', () => {
    db.phraseCandidates.upsert('g1', 'shared phrase', 2, null);
    db.phraseCandidates.upsert('g2', 'shared phrase', 2, null);
    const g1 = db.phraseCandidates.list('g1', 1, 10);
    const g2 = db.phraseCandidates.list('g2', 1, 10);
    expect(g1.length).toBe(1);
    expect(g2.length).toBe(1);
    expect(g1[0]!.groupId).toBe('g1');
    expect(g2[0]!.groupId).toBe('g2');
  });
});
