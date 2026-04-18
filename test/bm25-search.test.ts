import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../src/storage/db.js';

function makeDb(): Database {
  return new Database(':memory:');
}

describe('LearnedFactsRepository.searchByBM25', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  function insert(
    groupId: string,
    fact: string,
    canonicalForm: string | null,
    status: 'active' | 'pending' = 'active',
  ): number {
    return db.learnedFacts.insert({
      groupId, topic: null, fact,
      canonicalForm,
      personaForm: null,
      sourceUserId: null, sourceUserNickname: null,
      sourceMsgId: null, botReplyId: null,
      status,
    });
  }

  it('Chinese-only query matches Chinese canonical_form', () => {
    // Production shape: contiguous CJK (no artificial whitespace). trigram
    // tokenizer handles substring matches regardless of whitespace.
    insert('g1', 'fallback', '偶像大师是Bandori外的另一手游');
    insert('g1', '别的事实', '某个和别的游戏无关的内容');

    const hits = db.learnedFacts.searchByBM25('g1', '偶像大师', 10);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    // Top hit is the one whose canonical_form contains the query.
    expect(hits[0]!.canonicalForm).toContain('偶像大师');
  });

  it('retrieves contiguous CJK canonical_form without artificial whitespace', () => {
    // Regression: unicode61 tokenizer collapsed a contiguous CJK run into a
    // single token, so MATCH '"凑友希那"' against INSERT '羊宫妃那给凑友希那配音'
    // returned 0 rows. trigram tokenizer matches any 3-char substring.
    insert('g1', '羊宫妃那给凑友希那配音', '羊宫妃那给凑友希那配音');
    insert('g1', '其他无关事实', '其他无关的内容放在这里');

    const hits = db.learnedFacts.searchByBM25('g1', '凑友希那', 10);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.canonicalForm).toContain('凑友希那');
  });

  it('hyphen in query sanitized, does not throw', () => {
    insert('g1', 'hi', 'foo bar baz content here');
    // Raw hyphen would otherwise trigger FTS5 NOT-operator parse error.
    expect(() => db.learnedFacts.searchByBM25('g1', 'foo-bar baz', 10)).not.toThrow();
    const hits = db.learnedFacts.searchByBM25('g1', 'foo-bar baz', 10);
    // Sanitizer strips '-' so tokens become "foobar" + "baz"; expect at least to run.
    expect(Array.isArray(hits)).toBe(true);
  });

  it('FTS5 operator chars sanitized (star, quotes, parens)', () => {
    insert('g1', 'x', 'anything with bar in it');
    expect(() => db.learnedFacts.searchByBM25('g1', 'foo* "bar" (baz)', 10)).not.toThrow();
    // Empty-after-strip returns [] (tested via only operators)
    expect(db.learnedFacts.searchByBM25('g1', '*()""', 10)).toEqual([]);
  });

  it('canonical_form NULL falls back to fact column for FTS indexing', () => {
    // Legacy-shape row: canonical_form null, fact carries the text. FTS5 indexes
    // both columns so a token in `fact` alone still matches. Query is 3+ chars
    // because trigram tokenizer needs a 3-char window to produce any token.
    insert('g1', '群梗意思在这里的内容', null);
    const hits = db.learnedFacts.searchByBM25('g1', '群梗意思', 10);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.fact).toContain('群梗意思');
    expect(hits[0]!.canonicalForm).toBeNull();
  });

  it('embedding_vec update does not corrupt FTS index (trigger cascade idempotent)', () => {
    const id = insert('g1', 'fact-a', '偶像大师是Bandori外手游');
    // Simulate embedding backfill — fires learned_facts_au trigger which
    // re-inserts into FTS. Idempotent: row count unchanged, query still hits.
    db.learnedFacts.updateEmbedding(id, [0.1, 0.2, 0.3]);
    const hits = db.learnedFacts.searchByBM25('g1', '偶像大师', 10);
    expect(hits.length).toBe(1);
    expect(hits[0]!.id).toBe(id);
  });

  it('different group_id does not leak into query', () => {
    insert('g1', 'g1 fact', '偶像大师属于g1的内容');
    insert('g2', 'g2 fact', '偶像大师属于g2的内容');

    const hitsG1 = db.learnedFacts.searchByBM25('g1', '偶像大师', 10);
    expect(hitsG1).toHaveLength(1);
    expect(hitsG1[0]!.groupId).toBe('g1');

    const hitsG2 = db.learnedFacts.searchByBM25('g2', '偶像大师', 10);
    expect(hitsG2).toHaveLength(1);
    expect(hitsG2[0]!.groupId).toBe('g2');
  });
});
