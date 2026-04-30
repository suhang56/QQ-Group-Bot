import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../src/storage/db.js';
import {
  isValidStructuredTerm,
  extractTermFromTopic,
  topicStringsForTerm,
  trustTierFromTopic,
  compareFactsByTrust,
  LEARNED_FACT_TOPIC_PREFIXES,
} from '../src/modules/fact-topic-prefixes.js';

describe('trustTierFromTopic (case 8 — exhaustive)', () => {
  it('assigns correct tier for every prefix with a valid term', () => {
    expect(trustTierFromTopic('user-taught:ygfn')).toBe(0);
    expect(trustTierFromTopic('opus-classified:slang:ygfn')).toBe(1);
    expect(trustTierFromTopic('opus-classified:fandom:ygfn')).toBe(1);
    expect(trustTierFromTopic('opus-rest-classified:slang:ygfn')).toBe(2);
    expect(trustTierFromTopic('opus-rest-classified:fandom:ygfn')).toBe(2);
    expect(trustTierFromTopic('passive:ygfn')).toBe(3);
    expect(trustTierFromTopic('online-research:ygfn')).toBe(3);
    expect(trustTierFromTopic('moegirl:Roselia')).toBe(3);
    expect(trustTierFromTopic('nga:声优')).toBe(3);
    expect(trustTierFromTopic('群内黑话:ygfn')).toBe(4);
    expect(trustTierFromTopic('ondemand-lookup:ygfn')).toBe(5);
  });

  it('returns 10 for null, unknown-prefix, or dirty suffix', () => {
    expect(trustTierFromTopic(null)).toBe(10);
    expect(trustTierFromTopic('unknown-prefix:ygfn')).toBe(10);
    expect(trustTierFromTopic('user-taught:ygfn是谁啊')).toBe(10);
    expect(trustTierFromTopic('user-taught')).toBe(10);
  });
});

describe('extractTermFromTopic (case 9)', () => {
  it('extracts valid suffix', () => {
    expect(extractTermFromTopic('user-taught:ygfn')).toBe('ygfn');
  });
  it('rejects unknown prefix', () => {
    expect(extractTermFromTopic('unknown-prefix:ygfn')).toBeNull();
  });
  it('rejects prefix-only (no colon)', () => {
    expect(extractTermFromTopic('user-taught')).toBeNull();
  });
  it('handles null', () => {
    expect(extractTermFromTopic(null)).toBeNull();
  });
  it('rejects dirty Han suffix', () => {
    expect(extractTermFromTopic('user-taught:ygfn是谁啊')).toBeNull();
  });
  it('rejects too-short suffix', () => {
    expect(extractTermFromTopic('user-taught:X')).toBeNull();
  });
  it('extracts moegirl ASCII term', () => {
    expect(extractTermFromTopic('moegirl:Roselia')).toBe('Roselia');
  });
  it('extracts nga Han 2-char term', () => {
    expect(extractTermFromTopic('nga:声优')).toBe('声优');
  });
  it('extracts moegirl Han 3-char term', () => {
    expect(extractTermFromTopic('moegirl:高松灯')).toBe('高松灯');
  });
  it('extracts nga Han 4-char term', () => {
    expect(extractTermFromTopic('nga:翻唱歌曲')).toBe('翻唱歌曲');
  });
  it('rejects moegirl paren term (fails isValidStructuredTerm)', () => {
    expect(extractTermFromTopic('moegirl:Afterglow(BanG Dream!)')).toBeNull();
  });
});

describe('moegirl + nga prefix edge cases', () => {
  it('moegirl:高松灯 — pure-Han 3-char term passes', () => {
    expect(extractTermFromTopic('moegirl:高松灯')).toBe('高松灯');
  });
  it('nga:翻唱歌曲 — pure-Han 4-char term passes', () => {
    expect(extractTermFromTopic('nga:翻唱歌曲')).toBe('翻唱歌曲');
  });
  it('moegirl:Afterglow(BanG Dream!) — mixed/paren term rejects', () => {
    expect(extractTermFromTopic('moegirl:Afterglow(BanG Dream!)')).toBeNull();
  });
  it('moegirl:Roselia — ASCII-leading band name passes', () => {
    expect(extractTermFromTopic('moegirl:Roselia')).toBe('Roselia');
  });
  it('nga:声优 — tier 3', () => {
    expect(trustTierFromTopic('nga:声优')).toBe(3);
  });
  it('moegirl:Roselia — tier 3', () => {
    expect(trustTierFromTopic('moegirl:Roselia')).toBe(3);
  });
  it('dirty suffix on moegirl falls to tier 10', () => {
    expect(trustTierFromTopic('moegirl:ygfn是谁啊')).toBe(10);
  });
  it('topicStringsForTerm Roselia includes moegirl and nga entries', () => {
    const list = topicStringsForTerm('Roselia');
    expect(list).toContain('moegirl:Roselia');
    expect(list).toContain('nga:Roselia');
    expect(list).toHaveLength(LEARNED_FACT_TOPIC_PREFIXES.length);
  });
});

describe('isValidStructuredTerm (case 16)', () => {
  it.each([
    ['ygfn'],
    ['xtt'],
    ['lsycx'],
    ['120w'],
    ['羊宫妃那'],
    ['小团体'],
    ['鸡狗'],
    ['乐队'],
    ['7_11'],
    ['A_b'],
  ])('accepts clean term: %s', (term) => {
    expect(isValidStructuredTerm(term)).toBe(true);
  });

  it.each([
    ['ygfn是谁啊'],
    ['ygfn牛逼'],
    ['一整句很长的东西'],
    ['那个xtt'],
    ['xtt是啥'],
    ['25时'],
    ['X'],
    [''],
    ['   '],
    ['长达二十一个字符的超长字符串'],
    ['是谁'],
    ['这个梗'],
    ['的意思'],
    ['怎么回事吗'],
    ['在家里'],
  ])('rejects dirty term: %s', (term) => {
    expect(isValidStructuredTerm(term)).toBe(false);
  });
});

describe('compareFactsByTrust determinism (case 17)', () => {
  it('tier wins over confidence (tier 0 conf 0.1 beats tier 1 conf 0.9)', () => {
    const a = { id: 1, topic: 'user-taught:ygfn', confidence: 0.1 };
    const b = { id: 2, topic: 'opus-classified:slang:ygfn', confidence: 0.9 };
    expect(compareFactsByTrust(a, b)).toBeLessThan(0);
  });

  it('confidence wins over id within same tier (conf 0.9 id 1 beats conf 0.5 id 100)', () => {
    const a = { id: 1, topic: 'opus-classified:slang:ygfn', confidence: 0.9 };
    const b = { id: 100, topic: 'opus-classified:fandom:ygfn', confidence: 0.5 };
    expect(compareFactsByTrust(a, b)).toBeLessThan(0);
  });

  it('id desc wins on tier+conf tie', () => {
    const a = { id: 100, topic: 'user-taught:ygfn', confidence: 0.7 };
    const b = { id: 1, topic: 'user-taught:ygfn', confidence: 0.7 };
    expect(compareFactsByTrust(a, b)).toBeLessThan(0);
  });
});

describe('topicStringsForTerm (case 18)', () => {
  it("returns one entry per LEARNED_FACT_TOPIC_PREFIXES for valid 'ygfn'", () => {
    const list = topicStringsForTerm('ygfn');
    expect(list).toHaveLength(LEARNED_FACT_TOPIC_PREFIXES.length);
    expect(list).toEqual(expect.arrayContaining(LEARNED_FACT_TOPIC_PREFIXES.map(p => `${p}:ygfn`)));
  });

  it("returns [] for dirty 'ygfn是谁啊'", () => {
    expect(topicStringsForTerm('ygfn是谁啊')).toEqual([]);
  });

  it('returns [] for whitespace-only term', () => {
    expect(topicStringsForTerm('   ')).toEqual([]);
  });
});

describe('findActiveByTopicTerm dynamic-placeholder sanity (case 19)', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  function insertFact(groupId: string, topic: string, fact: string): number {
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

  it('returns one row per prefix for a term with every prefix populated, plus no decoys', () => {
    for (const p of LEARNED_FACT_TOPIC_PREFIXES) {
      insertFact('g1', `${p}:ygfn`, `fact under ${p}`);
    }
    // Decoys: different term + unknown prefix
    insertFact('g1', 'user-taught:xxx', 'unrelated');
    insertFact('g1', 'unknown-prefix:ygfn', 'unknown prefix');

    const result = db.learnedFacts.findActiveByTopicTerm('g1', 'ygfn');
    expect(result).toHaveLength(LEARNED_FACT_TOPIC_PREFIXES.length);
    const topics = new Set(result.map(r => r.topic));
    for (const p of LEARNED_FACT_TOPIC_PREFIXES) {
      expect(topics).toContain(`${p}:ygfn`);
    }
    // Ordered by id DESC
    const ids = result.map(r => r.id);
    const sorted = [...ids].sort((a, b) => b - a);
    expect(ids).toEqual(sorted);
  });
});
