import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../../src/storage/db.js';
import { initLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

describe('MemeGraphRepository', () => {
  let db: Database;
  beforeEach(() => { db = new Database(':memory:'); });

  it('insert returns id and roundtrips via get', () => {
    const id = db.memeGraph.insert({
      groupId: 'g1', canonical: 'hyw', meaning: 'hello',
      variants: ['hyw', 'mmhyw'],
    });
    expect(id).toBeGreaterThan(0);
    const meme = db.memeGraph.get(id);
    expect(meme).not.toBeNull();
    expect(meme!.canonical).toBe('hyw');
    expect(meme!.meaning).toBe('hello');
    expect(meme!.variants).toEqual(['hyw', 'mmhyw']);
    expect(meme!.status).toBe('active');
    expect(meme!.confidence).toBe(0.5);
    expect(meme!.totalCount).toBe(0);
    expect(meme!.embedding).toBeNull();
    expect(meme!.createdAt).toBeGreaterThan(0);
  });

  it('get returns null for non-existent id', () => {
    expect(db.memeGraph.get(999)).toBeNull();
  });

  it('getByCanonical finds by group + canonical', () => {
    db.memeGraph.insert({ groupId: 'g1', canonical: 'test-meme', meaning: 'a meme' });
    db.memeGraph.insert({ groupId: 'g2', canonical: 'test-meme', meaning: 'different group' });

    const m1 = db.memeGraph.getByCanonical('g1', 'test-meme');
    expect(m1).not.toBeNull();
    expect(m1!.meaning).toBe('a meme');

    const m2 = db.memeGraph.getByCanonical('g2', 'test-meme');
    expect(m2).not.toBeNull();
    expect(m2!.meaning).toBe('different group');

    expect(db.memeGraph.getByCanonical('g1', 'nonexistent')).toBeNull();
  });

  it('insert enforces UNIQUE(group_id, canonical)', () => {
    db.memeGraph.insert({ groupId: 'g1', canonical: 'dup', meaning: 'first' });
    expect(() => {
      db.memeGraph.insert({ groupId: 'g1', canonical: 'dup', meaning: 'second' });
    }).toThrow();
  });

  it('updateVariants replaces variants array', () => {
    const id = db.memeGraph.insert({
      groupId: 'g1', canonical: 'hyw', meaning: 'test',
      variants: ['hyw'],
    });
    db.memeGraph.updateVariants(id, ['hyw', 'mmhyw', 'ohnmmhyw']);
    const meme = db.memeGraph.get(id)!;
    expect(meme.variants).toEqual(['hyw', 'mmhyw', 'ohnmmhyw']);
  });

  it('updateMeaningAndOrigin respects manual_edit status', () => {
    const id = db.memeGraph.insert({
      groupId: 'g1', canonical: 'protected', meaning: 'original',
    });
    // Set to manual_edit
    db.memeGraph.updateStatus(id, 'manual_edit');
    // Try to update meaning — should be blocked
    db.memeGraph.updateMeaningAndOrigin(id, 'overwritten', 'event', 'msg1', 'user1', 1000);
    const meme = db.memeGraph.get(id)!;
    expect(meme.meaning).toBe('original');
    expect(meme.originEvent).toBeNull();
  });

  it('updateMeaningAndOrigin works for active status', () => {
    const id = db.memeGraph.insert({
      groupId: 'g1', canonical: 'updatable', meaning: 'initial',
    });
    db.memeGraph.updateMeaningAndOrigin(id, 'updated meaning', 'some event', 'msg99', 'user5', 12345);
    const meme = db.memeGraph.get(id)!;
    expect(meme.meaning).toBe('updated meaning');
    expect(meme.originEvent).toBe('some event');
    expect(meme.originMsgId).toBe('msg99');
    expect(meme.originUserId).toBe('user5');
    expect(meme.originTs).toBe(12345);
  });

  it('updateEmbedding stores and retrieves Float32 BLOB', () => {
    const id = db.memeGraph.insert({
      groupId: 'g1', canonical: 'embed-test', meaning: 'test',
    });
    const vec = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    db.memeGraph.updateEmbedding(id, vec);
    const meme = db.memeGraph.get(id)!;
    expect(meme.embedding).not.toBeNull();
    expect(meme.embedding!.length).toBe(8);
    for (let i = 0; i < vec.length; i++) {
      expect(meme.embedding![i]).toBeCloseTo(vec[i]!, 5);
    }
  });

  it('findSimilarActive returns cosine-ranked results above threshold', () => {
    // Insert two memes with known embeddings
    const id1 = db.memeGraph.insert({ groupId: 'g1', canonical: 'meme-a', meaning: 'a' });
    const id2 = db.memeGraph.insert({ groupId: 'g1', canonical: 'meme-b', meaning: 'b' });
    const id3 = db.memeGraph.insert({ groupId: 'g1', canonical: 'meme-c', meaning: 'c' });

    // meme-a: [1,0,0,0], meme-b: [0.9,0.1,0,0], meme-c: [0,1,0,0]
    db.memeGraph.updateEmbedding(id1, [1, 0, 0, 0]);
    db.memeGraph.updateEmbedding(id2, [0.9, 0.1, 0, 0]);
    db.memeGraph.updateEmbedding(id3, [0, 1, 0, 0]);

    // Query with [1,0,0,0] — meme-a is exact match, meme-b is close, meme-c is orthogonal
    const results = db.memeGraph.findSimilarActive('g1', [1, 0, 0, 0], 0.5, 10);
    expect(results.length).toBe(2); // meme-a and meme-b above 0.5 threshold
    expect(results[0]!.canonical).toBe('meme-a'); // highest cosine first
    expect(results[1]!.canonical).toBe('meme-b');
  });

  it('findSimilarActive respects limit', () => {
    for (let i = 0; i < 5; i++) {
      const id = db.memeGraph.insert({ groupId: 'g1', canonical: `m${i}`, meaning: `m${i}` });
      db.memeGraph.updateEmbedding(id, [1, 0, 0, 0]); // all identical
    }
    const results = db.memeGraph.findSimilarActive('g1', [1, 0, 0, 0], 0.5, 2);
    expect(results.length).toBe(2);
  });

  it('findSimilarActive excludes demoted memes', () => {
    const id = db.memeGraph.insert({ groupId: 'g1', canonical: 'demoted', meaning: 'x' });
    db.memeGraph.updateEmbedding(id, [1, 0, 0, 0]);
    db.memeGraph.updateStatus(id, 'demoted');
    const results = db.memeGraph.findSimilarActive('g1', [1, 0, 0, 0], 0.5, 10);
    expect(results.length).toBe(0);
  });

  it('incrementTotalCount adds delta', () => {
    const id = db.memeGraph.insert({
      groupId: 'g1', canonical: 'counter', meaning: 'test', totalCount: 5,
    });
    db.memeGraph.incrementTotalCount(id, 3);
    expect(db.memeGraph.get(id)!.totalCount).toBe(8);
    db.memeGraph.incrementTotalCount(id, 1);
    expect(db.memeGraph.get(id)!.totalCount).toBe(9);
  });

  it('listActive returns active memes sorted by total_count', () => {
    db.memeGraph.insert({ groupId: 'g1', canonical: 'low', meaning: 'x', totalCount: 1 });
    db.memeGraph.insert({ groupId: 'g1', canonical: 'high', meaning: 'x', totalCount: 100 });
    db.memeGraph.insert({ groupId: 'g1', canonical: 'mid', meaning: 'x', totalCount: 50 });
    const id4 = db.memeGraph.insert({ groupId: 'g1', canonical: 'demoted', meaning: 'x', totalCount: 999 });
    db.memeGraph.updateStatus(id4, 'demoted');

    const list = db.memeGraph.listActive('g1', 10);
    expect(list.length).toBe(3);
    expect(list[0]!.canonical).toBe('high');
    expect(list[1]!.canonical).toBe('mid');
    expect(list[2]!.canonical).toBe('low');
  });

  it('listNullEmbedding returns active memes without embeddings', () => {
    const id1 = db.memeGraph.insert({ groupId: 'g1', canonical: 'no-emb', meaning: 'x' });
    const id2 = db.memeGraph.insert({ groupId: 'g1', canonical: 'has-emb', meaning: 'x' });
    db.memeGraph.updateEmbedding(id2, [1, 0, 0, 0]);
    const id3 = db.memeGraph.insert({ groupId: 'g1', canonical: 'demoted-no-emb', meaning: 'x' });
    db.memeGraph.updateStatus(id3, 'demoted');

    const list = db.memeGraph.listNullEmbedding('g1', 10);
    expect(list.length).toBe(1);
    expect(list[0]!.id).toBe(id1);
  });

  it('listActiveWithEmbeddings returns only embedded active memes', () => {
    const id1 = db.memeGraph.insert({ groupId: 'g1', canonical: 'a', meaning: 'x' });
    db.memeGraph.updateEmbedding(id1, [1, 0, 0, 0]);
    db.memeGraph.insert({ groupId: 'g1', canonical: 'b', meaning: 'x' }); // no embedding

    const list = db.memeGraph.listActiveWithEmbeddings('g1');
    expect(list.length).toBe(1);
    expect(list[0]!.canonical).toBe('a');
    expect(list[0]!.embedding).not.toBeNull();
  });

  it('findByVariant matches canonical substring', () => {
    db.memeGraph.insert({ groupId: 'g1', canonical: 'mmhyw', meaning: 'test', variants: ['mmhyw', 'hyw'] });
    db.memeGraph.insert({ groupId: 'g1', canonical: 'unrelated', meaning: 'other' });

    const results = db.memeGraph.findByVariant('g1', 'hyw');
    expect(results.length).toBe(1);
    expect(results[0]!.canonical).toBe('mmhyw');
  });

  it('findByVariant matches inside variants JSON', () => {
    db.memeGraph.insert({ groupId: 'g1', canonical: 'main-form', meaning: 'test', variants: ['alt1', 'ohnmmhyw'] });
    const results = db.memeGraph.findByVariant('g1', 'ohnmmhyw');
    expect(results.length).toBe(1);
  });

  it('findByVariant returns empty for no match', () => {
    db.memeGraph.insert({ groupId: 'g1', canonical: 'something', meaning: 'x' });
    expect(db.memeGraph.findByVariant('g1', 'nonexistent')).toEqual([]);
  });

  it('fromRow deserializes JSON variants correctly for empty array', () => {
    const id = db.memeGraph.insert({ groupId: 'g1', canonical: 'empty-var', meaning: 'x' });
    const meme = db.memeGraph.get(id)!;
    expect(meme.variants).toEqual([]);
  });

  it('insert with custom confidence and totalCount', () => {
    const id = db.memeGraph.insert({
      groupId: 'g1', canonical: 'custom', meaning: 'x',
      confidence: 0.85, totalCount: 42, firstSeenCount: 10,
    });
    const meme = db.memeGraph.get(id)!;
    expect(meme.confidence).toBe(0.85);
    expect(meme.totalCount).toBe(42);
    expect(meme.firstSeenCount).toBe(10);
  });
});
