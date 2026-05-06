import { describe, it, expect, beforeEach } from 'vitest';
import { sanitizeFtsQuery } from '../src/utils/text-tokenize.js';
import { Database } from '../src/storage/db.js';

// ---------------------------------------------------------------------------
// In-memory fixture helpers (mirrors bm25-search.test.ts pattern)
// ---------------------------------------------------------------------------

function makeDb(): Database {
  return new Database(':memory:');
}

function insertFact(
  db: Database,
  groupId: string,
  fact: string,
  canonicalForm: string | null,
): number {
  return db.learnedFacts.insert({
    groupId,
    topic: null,
    fact,
    canonicalForm,
    personaForm: null,
    sourceUserId: null,
    sourceUserNickname: null,
    sourceMsgId: null,
    botReplyId: null,
    status: 'active',
  });
}

function searchVia(db: Database, groupId: string, raw: string, limit = 5) {
  const q = sanitizeFtsQuery(raw);
  if (!q) return [];
  return db.learnedFacts.searchByBM25(groupId, q, limit);
}

// ---------------------------------------------------------------------------
// §4 pure-function tests (DESIGN §4 rows 1-25 output equality)
// These test sanitizeFtsQuery return value without DB — fast and deterministic.
// ---------------------------------------------------------------------------

describe('sanitizeFtsQuery — pure-function output (DESIGN §4)', () => {
  // Row 1
  it('row 1: 高松灯是谁 -> "高松灯"', () => {
    expect(sanitizeFtsQuery('高松灯是谁')).toBe('"高松灯"');
  });

  // Row 2
  it('row 2: 高松灯 -> "高松灯" (regression hold)', () => {
    expect(sanitizeFtsQuery('高松灯')).toBe('"高松灯"');
  });

  // Row 3
  it('row 3: 高松灯是什么 -> "高松灯"', () => {
    expect(sanitizeFtsQuery('高松灯是什么')).toBe('"高松灯"');
  });

  // Row 4
  it('row 4: 高松灯是哪个 -> "高松灯"', () => {
    expect(sanitizeFtsQuery('高松灯是哪个')).toBe('"高松灯"');
  });

  // Row 5
  it('row 5: 高松灯谁啊 -> "高松灯"', () => {
    expect(sanitizeFtsQuery('高松灯谁啊')).toBe('"高松灯"');
  });

  // Row 6
  it('row 6: 高松灯是谁啊 -> "高松灯"', () => {
    expect(sanitizeFtsQuery('高松灯是谁啊')).toBe('"高松灯"');
  });

  // Row 7
  it('row 7: 高松灯是谁？ -> "高松灯"', () => {
    expect(sanitizeFtsQuery('高松灯是谁？')).toBe('"高松灯"');
  });

  // Row 8
  it('row 8: 高松灯是谁。 -> "高松灯"', () => {
    expect(sanitizeFtsQuery('高松灯是谁。')).toBe('"高松灯"');
  });

  // Row 9
  it('row 9: 这个高松灯是谁 -> "高松灯"', () => {
    expect(sanitizeFtsQuery('这个高松灯是谁')).toBe('"高松灯"');
  });

  // Row 10
  it('row 10: 那啥高松灯 -> "高松灯"', () => {
    expect(sanitizeFtsQuery('那啥高松灯')).toBe('"高松灯"');
  });

  // Row 11
  it('row 11: 那个高松灯是什么 -> "高松灯"', () => {
    expect(sanitizeFtsQuery('那个高松灯是什么')).toBe('"高松灯"');
  });

  // Row 12
  it('row 12: 偶像大师 -> "偶像大师" (non-question CJK preserved)', () => {
    expect(sanitizeFtsQuery('偶像大师')).toBe('"偶像大师"');
  });

  // Row 13
  it('row 13: 邦多利 -> "邦多利" (non-question CJK preserved)', () => {
    expect(sanitizeFtsQuery('邦多利')).toBe('"邦多利"');
  });

  // Row 14
  it('row 14: live ticket -> "live" "ticket" (Latin path untouched)', () => {
    expect(sanitizeFtsQuery('live ticket')).toBe('"live" "ticket"');
  });

  // Row 15
  it('row 15: foo-bar baz -> "foobar" "baz" (hyphen-strip preserved)', () => {
    expect(sanitizeFtsQuery('foo-bar baz')).toBe('"foobar" "baz"');
  });

  // Row 16
  it('row 16: live-2024 -> "live2024" (Latin operator-strip preserved)', () => {
    expect(sanitizeFtsQuery('live-2024')).toBe('"live2024"');
  });

  // Row 17
  it('row 17: live高松灯 -> "live高松灯" (C-2 territory unchanged)', () => {
    expect(sanitizeFtsQuery('live高松灯')).toBe('"live高松灯"');
  });

  // Row 18 — A5 degenerate: empty string
  it('row 18: "" -> ""', () => {
    expect(sanitizeFtsQuery('')).toBe('');
  });

  // Row 19 — A5 degenerate: whitespace only
  it('row 19: "  " -> ""', () => {
    expect(sanitizeFtsQuery('  ')).toBe('');
  });

  // Row 20 — A5: 是谁 alone -> ''
  it('row 20: 是谁 -> "" (degenerate tail-only)', () => {
    expect(sanitizeFtsQuery('是谁')).toBe('');
  });

  // Row 21 — A5: 谁啊 alone -> ''
  it('row 21: 谁啊 -> "" (degenerate tail-only)', () => {
    expect(sanitizeFtsQuery('谁啊')).toBe('');
  });

  // Row 22 — A5: 这个 alone -> ''
  it('row 22: 这个 -> "" (degenerate demonstrative-only)', () => {
    expect(sanitizeFtsQuery('这个')).toBe('');
  });

  // Row 23 — A5: star operator -> ''
  it('row 23: * -> ""', () => {
    expect(sanitizeFtsQuery('*')).toBe('');
  });

  // Row 24
  it('row 24: 高松灯是谁？！ -> "高松灯" (multi-punct tail)', () => {
    expect(sanitizeFtsQuery('高松灯是谁？！')).toBe('"高松灯"');
  });

  // Row 25
  it('row 25: 这个偶像大师是谁？ -> "偶像大师" (combined leading+tail+punct)', () => {
    expect(sanitizeFtsQuery('这个偶像大师是谁？')).toBe('"偶像大师"');
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases for full whitelist coverage (DESIGN §2 §3)
// ---------------------------------------------------------------------------

describe('sanitizeFtsQuery — whitelist coverage edge cases', () => {
  it('是啥意思 tail stripped', () => {
    expect(sanitizeFtsQuery('元宇宙是啥意思')).toBe('"元宇宙"');
  });

  it('是什么意思 tail stripped', () => {
    expect(sanitizeFtsQuery('元宇宙是什么意思')).toBe('"元宇宙"');
  });

  it('是哪一个 tail stripped (2+ char leftover)', () => {
    // '灯' is 1 char — guard prevents strip; use 2-char entity '高松' instead
    expect(sanitizeFtsQuery('高松是哪一个')).toBe('"高松"');
  });

  it('是哪一位 tail stripped', () => {
    expect(sanitizeFtsQuery('主唱是哪一位')).toBe('"主唱"');
  });

  it('是哪位 tail stripped', () => {
    expect(sanitizeFtsQuery('主唱是哪位')).toBe('"主唱"');
  });

  it('是谁呀 tail stripped', () => {
    expect(sanitizeFtsQuery('高松灯是谁呀')).toBe('"高松灯"');
  });

  it('是谁呢 tail stripped', () => {
    expect(sanitizeFtsQuery('高松灯是谁呢')).toBe('"高松灯"');
  });

  it('是啥 tail stripped', () => {
    expect(sanitizeFtsQuery('高松灯是啥')).toBe('"高松灯"');
  });

  it('是什么啊 tail stripped', () => {
    expect(sanitizeFtsQuery('mygo是什么啊')).toBe('"mygo"');
  });

  it('啥意思 tail stripped (no 是 prefix)', () => {
    expect(sanitizeFtsQuery('这梗啥意思')).toBe('"这梗"');
  });

  it('什么意思 tail stripped (no 是 prefix)', () => {
    expect(sanitizeFtsQuery('这梗什么意思')).toBe('"这梗"');
  });

  it('怎么回事 tail stripped (2+ char leftover)', () => {
    // '灯' is 1 char — guard prevents strip; use 2-char entity instead
    expect(sanitizeFtsQuery('高松怎么回事')).toBe('"高松"');
  });

  it('这位 leading demonstrative stripped', () => {
    expect(sanitizeFtsQuery('这位高松灯是谁')).toBe('"高松灯"');
  });

  it('那位 leading demonstrative stripped', () => {
    expect(sanitizeFtsQuery('那位高松灯是谁')).toBe('"高松灯"');
  });

  it('那个 leading demonstrative stripped', () => {
    expect(sanitizeFtsQuery('那个高松灯')).toBe('"高松灯"');
  });

  // ≥2-char leftover guard: leftover after strip must be ≥2 chars
  it('short leftover after tail strip reverts (灯是谁 -> stays 灯是谁 stripped to 灯)', () => {
    // '灯是谁': strip '是谁' -> '灯' (1 char) -> revert; but then '灯是谁' alone...
    // Actually '灯' is 1 char which is < 2, so strip is reverted
    // The whole input '灯是谁' then goes to whitelist-collapse check: '灯是谁' not in whitelist
    // So it wraps as '"灯是谁"' — single token, NOT stripped
    // This verifies the ≥2-char guard prevents over-stripping to single-char entities
    const result = sanitizeFtsQuery('灯是谁');
    // Revert path: '灯是谁' wraps as '"灯是谁"' (guard triggers, no strip)
    expect(result).toBe('"灯是谁"');
  });

  it('A5: 是什么 alone -> ""', () => {
    expect(sanitizeFtsQuery('是什么')).toBe('');
  });

  it('A5: 那个 alone -> ""', () => {
    expect(sanitizeFtsQuery('那个')).toBe('');
  });

  it('A5: 这位 alone -> ""', () => {
    expect(sanitizeFtsQuery('这位')).toBe('');
  });

  // Punctuation-only
  it('A5: 是谁？ alone -> ""', () => {
    expect(sanitizeFtsQuery('是谁？')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// A1 / A2 / A3: FTS5 fixture tests (in-memory DB, BM25 retrieval)
// ---------------------------------------------------------------------------

describe('sanitizeFtsQuery — BM25 fixture retrieval (A1/A2/A3)', () => {
  let db: Database;
  const GROUP = 'g1';

  beforeEach(() => {
    db = makeDb();
    // Minimum fact rows per DESIGN §7
    insertFact(db, GROUP, '高松灯是Bandori MyGO!!!!!的主唱', '高松灯是Bandori MyGO!!!!!的主唱');
    insertFact(db, GROUP, '千早爱音是MyGO!!!!!的吉他手', '千早爱音是MyGO!!!!!的吉他手');
    insertFact(db, GROUP, 'live指现场演出', 'live指现场演出');
    insertFact(db, GROUP, '户山香澄是Bandori的主唱', '户山香澄是Poppin\'Party的主唱');
  });

  // A1: prime case
  it('A1: 高松灯是谁 hits fixture row', () => {
    const hits = searchVia(db, GROUP, '高松灯是谁');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.canonicalForm).toContain('高松灯');
  });

  // A2: regression — exact term still hits
  it('A2: 高松灯 alone hits fixture row (regression)', () => {
    const hits = searchVia(db, GROUP, '高松灯');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.canonicalForm).toContain('高松灯');
  });

  // A3 edge case 1: 是什么 variant
  it('A3: 高松灯是什么 hits fixture (variant tail)', () => {
    const hits = searchVia(db, GROUP, '高松灯是什么');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.canonicalForm).toContain('高松灯');
  });

  // A3 edge case 1 paired regression
  it('A3 paired regression: 高松灯 still hits after 是什么 test', () => {
    const hits = searchVia(db, GROUP, '高松灯');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.canonicalForm).toContain('高松灯');
  });

  // A3 edge case 2: 是哪个
  it('A3: 高松灯是哪个 hits fixture (variant tail)', () => {
    const hits = searchVia(db, GROUP, '高松灯是哪个');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.canonicalForm).toContain('高松灯');
  });

  // A3 edge case 3: 谁啊 colloquial
  it('A3: 高松灯谁啊 hits fixture (colloquial tail)', () => {
    const hits = searchVia(db, GROUP, '高松灯谁啊');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.canonicalForm).toContain('高松灯');
  });

  // A3 edge case 4: combined tail+particle
  it('A3: 高松灯是谁啊 hits fixture (combined tail+particle)', () => {
    const hits = searchVia(db, GROUP, '高松灯是谁啊');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.canonicalForm).toContain('高松灯');
  });

  // A3 edge case 5: trailing CJK punctuation
  it('A3: 高松灯是谁？ hits fixture (trailing CJK punctuation)', () => {
    const hits = searchVia(db, GROUP, '高松灯是谁？');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.canonicalForm).toContain('高松灯');
  });

  // A3 edge case 6: leading demonstrative + tail
  it('A3: 这个高松灯是谁 hits fixture (leading demonstrative + tail)', () => {
    const hits = searchVia(db, GROUP, '这个高松灯是谁');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.canonicalForm).toContain('高松灯');
  });

  // A3 edge case 7: colloquial leading filler
  it('A3: 那啥高松灯 hits fixture (colloquial leading filler)', () => {
    const hits = searchVia(db, GROUP, '那啥高松灯');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.canonicalForm).toContain('高松灯');
  });

  // A3 paired regression for all 7 edge cases
  it('A3 paired regression: 高松灯 alone hits after all edge-case queries', () => {
    // Run all A3 edge queries first to ensure no state corruption
    searchVia(db, GROUP, '高松灯是什么');
    searchVia(db, GROUP, '高松灯是哪个');
    searchVia(db, GROUP, '高松灯谁啊');
    searchVia(db, GROUP, '高松灯是谁啊');
    searchVia(db, GROUP, '高松灯是谁？');
    searchVia(db, GROUP, '这个高松灯是谁');
    searchVia(db, GROUP, '那啥高松灯');
    // Now verify base term still hits
    const hits = searchVia(db, GROUP, '高松灯');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.canonicalForm).toContain('高松灯');
  });

  // A4: non-question queries not over-stripped
  it('A4: 偶像大师 not stripped (different entity)', () => {
    // Pure-function already tested in previous suite; verify no DB leakage
    const q = sanitizeFtsQuery('偶像大师');
    expect(q).toBe('"偶像大师"');
  });

  it('A4: 千早爱音是谁 strips tail and hits distractor row', () => {
    const hits = searchVia(db, GROUP, '千早爱音是谁');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    // Should hit 千早爱音 row, not 高松灯
    expect(hits[0]!.canonicalForm).toContain('千早爱音');
  });

  // A5: degenerate inputs return [] via empty sanitize
  it('A5: 是谁 alone returns [] (empty sanitize)', () => {
    const hits = searchVia(db, GROUP, '是谁');
    expect(hits).toEqual([]);
  });

  it('A5: 谁啊 alone returns [] (empty sanitize)', () => {
    const hits = searchVia(db, GROUP, '谁啊');
    expect(hits).toEqual([]);
  });

  it('A5: 这个 alone returns [] (empty sanitize)', () => {
    const hits = searchVia(db, GROUP, '这个');
    expect(hits).toEqual([]);
  });

  it('A5: "  " (whitespace) returns []', () => {
    const hits = searchVia(db, GROUP, '  ');
    expect(hits).toEqual([]);
  });

  it('A5: * returns []', () => {
    const hits = searchVia(db, GROUP, '*');
    expect(hits).toEqual([]);
  });
});
