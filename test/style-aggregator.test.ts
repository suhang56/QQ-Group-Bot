import { describe, it, expect } from 'vitest';
import { computeGroupAggregate } from '../src/modules/style-aggregator.js';
import type { StyleJsonData } from '../src/storage/db.js';

function mkStyle(overrides: Partial<StyleJsonData> = {}): StyleJsonData {
  return {
    catchphrases: [],
    punctuationStyle: '',
    sentencePattern: '',
    emotionalSignatures: {},
    topicAffinity: [],
    ...overrides,
  };
}

describe('computeGroupAggregate', () => {
  it('returns null for empty input', () => {
    expect(computeGroupAggregate([])).toBeNull();
  });

  it('returns null when fewer than 3 users supplied', () => {
    const two = [
      { userId: 'u1', style: mkStyle({ catchphrases: ['草'] }) },
      { userId: 'u2', style: mkStyle({ catchphrases: ['草'] }) },
    ];
    expect(computeGroupAggregate(two)).toBeNull();
  });

  it('empty topCatchphrases when 3 users all have distinct phrases', () => {
    const users = [
      { userId: 'u1', style: mkStyle({ catchphrases: ['啊这'] }) },
      { userId: 'u2', style: mkStyle({ catchphrases: ['确实'] }) },
      { userId: 'u3', style: mkStyle({ catchphrases: ['离谱'] }) },
    ];
    const agg = computeGroupAggregate(users);
    expect(agg).not.toBeNull();
    expect(agg!.topCatchphrases).toEqual([]);
    expect(agg!.userCount).toBe(3);
  });

  it('includes a phrase shared by all 3 users with userCount=3', () => {
    const users = [
      { userId: 'u1', style: mkStyle({ catchphrases: ['草', '哈哈'] }) },
      { userId: 'u2', style: mkStyle({ catchphrases: ['草', '对'] }) },
      { userId: 'u3', style: mkStyle({ catchphrases: ['草', '牛'] }) },
    ];
    const agg = computeGroupAggregate(users)!;
    expect(agg.topCatchphrases).toEqual([{ phrase: '草', userCount: 3 }]);
  });

  it('does not double-count the same phrase appearing twice in one user', () => {
    const users = [
      { userId: 'u1', style: mkStyle({ catchphrases: ['草', '草', '草'] }) },
      { userId: 'u2', style: mkStyle({ catchphrases: ['哈'] }) },
      { userId: 'u3', style: mkStyle({ catchphrases: ['啊'] }) },
    ];
    const agg = computeGroupAggregate(users)!;
    // "草" only has 1 user → below PHRASE_MIN_USERS=2 → filtered out
    expect(agg.topCatchphrases).toEqual([]);
  });

  it('majority-votes punctuationDensity → minimal when all users say "不用标点"', () => {
    const users = Array.from({ length: 3 }, (_, i) => ({
      userId: `u${i}`,
      style: mkStyle({ punctuationStyle: '不用标点' }),
    }));
    const agg = computeGroupAggregate(users)!;
    expect(agg.punctuationDensity).toBe('minimal');
  });

  it('majority-votes punctuationDensity → heavy when users use "频繁"', () => {
    const users = Array.from({ length: 3 }, (_, i) => ({
      userId: `u${i}`,
      style: mkStyle({ punctuationStyle: '频繁使用！！！' }),
    }));
    const agg = computeGroupAggregate(users)!;
    expect(agg.punctuationDensity).toBe('heavy');
  });

  it('emojiProneness = frequent when >=50% users mention emoji/表情', () => {
    const users = [
      { userId: 'u1', style: mkStyle({ punctuationStyle: '常用 emoji' }) },
      { userId: 'u2', style: mkStyle({ sentencePattern: '颜文字多' }) },
      { userId: 'u3', style: mkStyle({ punctuationStyle: '普通' }) },
    ];
    const agg = computeGroupAggregate(users)!;
    expect(agg.emojiProneness).toBe('frequent');
  });

  it('emojiProneness = occasional at 20-50% match', () => {
    const users = [
      { userId: 'u1', style: mkStyle({ punctuationStyle: '偶尔 emoji' }) },
      { userId: 'u2', style: mkStyle({ punctuationStyle: '普通' }) },
      { userId: 'u3', style: mkStyle({ punctuationStyle: '普通' }) },
      { userId: 'u4', style: mkStyle({ punctuationStyle: '普通' }) },
    ];
    const agg = computeGroupAggregate(users)!;
    expect(agg.emojiProneness).toBe('occasional');
  });

  it('emojiProneness = rare when no users match', () => {
    const users = Array.from({ length: 3 }, (_, i) => ({
      userId: `u${i}`,
      style: mkStyle({ punctuationStyle: '普通' }),
    }));
    const agg = computeGroupAggregate(users)!;
    expect(agg.emojiProneness).toBe('rare');
  });

  it('topTopics filters by >=2 user occurrences', () => {
    const users = [
      { userId: 'u1', style: mkStyle({ topicAffinity: ['BanG Dream', '游戏'] }) },
      { userId: 'u2', style: mkStyle({ topicAffinity: ['BanG Dream', '动画'] }) },
      { userId: 'u3', style: mkStyle({ topicAffinity: ['cos', '游戏'] }) },
    ];
    const agg = computeGroupAggregate(users)!;
    expect(agg.topTopics).toContainEqual({ topic: 'BanG Dream', userCount: 2 });
    expect(agg.topTopics).toContainEqual({ topic: '游戏', userCount: 2 });
    expect(agg.topTopics.some(t => t.topic === '动画')).toBe(false);
    expect(agg.topTopics.some(t => t.topic === 'cos')).toBe(false);
  });

  it('lexicographic tiebreaker for equal userCount (stable ordering)', () => {
    const users = [
      { userId: 'u1', style: mkStyle({ catchphrases: ['zzz', 'aaa'] }) },
      { userId: 'u2', style: mkStyle({ catchphrases: ['zzz', 'aaa'] }) },
      { userId: 'u3', style: mkStyle({ catchphrases: ['mmm', 'bbb'] }) },
    ];
    const agg = computeGroupAggregate(users)!;
    // aaa & zzz both have userCount=2, tied → lex ascending: aaa before zzz
    const ids = agg.topCatchphrases.map(c => c.phrase);
    expect(ids).toEqual(['aaa', 'zzz']);
  });

  it('caps topCatchphrases at 5 entries', () => {
    // 3 users, 6 distinct phrases all shared by all 3 users
    const shared = ['a', 'b', 'c', 'd', 'e', 'f'];
    const users = Array.from({ length: 3 }, (_, i) => ({
      userId: `u${i}`,
      style: mkStyle({ catchphrases: [...shared] }),
    }));
    const agg = computeGroupAggregate(users)!;
    expect(agg.topCatchphrases.length).toBe(5);
  });

  it('extracts commonSentenceTraits substrings across users', () => {
    const users = [
      { userId: 'u1', style: mkStyle({ sentencePattern: '中日混用' }) },
      { userId: 'u2', style: mkStyle({ sentencePattern: '中日混用' }) },
      { userId: 'u3', style: mkStyle({ sentencePattern: '中日英混用' }) },
    ];
    const agg = computeGroupAggregate(users)!;
    // "中日" substring appears in all 3, "混用" appears in all 3.
    expect(agg.commonSentenceTraits.length).toBeGreaterThan(0);
    expect(agg.commonSentenceTraits.some(t => t === '混用')).toBe(true);
  });

  it('userCount reflects input size', () => {
    const users = Array.from({ length: 7 }, (_, i) => ({
      userId: `u${i}`,
      style: mkStyle({ catchphrases: ['x'] }),
    }));
    const agg = computeGroupAggregate(users)!;
    expect(agg.userCount).toBe(7);
  });

  it('ignores empty / whitespace-only phrases', () => {
    const users = [
      { userId: 'u1', style: mkStyle({ catchphrases: ['', '   ', 'valid'] }) },
      { userId: 'u2', style: mkStyle({ catchphrases: ['valid', ''] }) },
      { userId: 'u3', style: mkStyle({ catchphrases: ['valid'] }) },
    ];
    const agg = computeGroupAggregate(users)!;
    expect(agg.topCatchphrases).toEqual([{ phrase: 'valid', userCount: 3 }]);
  });

  it('tolerates missing catchphrases/topicAffinity fields', () => {
    const users = [
      { userId: 'u1', style: { punctuationStyle: '', sentencePattern: '', emotionalSignatures: {} } as unknown as StyleJsonData },
      { userId: 'u2', style: mkStyle() },
      { userId: 'u3', style: mkStyle() },
    ];
    const agg = computeGroupAggregate(users);
    expect(agg).not.toBeNull();
    expect(agg!.topCatchphrases).toEqual([]);
    expect(agg!.topTopics).toEqual([]);
  });
});
