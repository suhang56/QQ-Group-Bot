import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../src/storage/db.js';

describe('UserStyleAggregateRepository', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('returns null for an unknown group', () => {
    expect(db.userStylesAggregate.get('g-nope')).toBeNull();
  });

  it('upsert + get roundtrip preserves payload', () => {
    const agg = {
      topCatchphrases: [{ phrase: '草', userCount: 3 }],
      punctuationDensity: 'minimal' as const,
      emojiProneness: 'frequent' as const,
      commonSentenceTraits: ['混用'],
      topTopics: [{ topic: 'BanG Dream', userCount: 2 }],
      userCount: 3,
    };
    db.userStylesAggregate.upsert('g1', agg);
    const got = db.userStylesAggregate.get('g1');
    expect(got).not.toBeNull();
    expect(got!.topCatchphrases).toEqual(agg.topCatchphrases);
    expect(got!.punctuationDensity).toBe('minimal');
    expect(got!.emojiProneness).toBe('frequent');
    expect(got!.commonSentenceTraits).toEqual(['混用']);
    expect(got!.topTopics).toEqual(agg.topTopics);
    expect(got!.userCount).toBe(3);
    expect(got!.updatedAt).toBeGreaterThan(0);
  });

  it('upsert overwrites prior row with new payload', () => {
    db.userStylesAggregate.upsert('g1', {
      topCatchphrases: [{ phrase: 'a', userCount: 3 }],
      punctuationDensity: 'light',
      emojiProneness: 'rare',
      commonSentenceTraits: [],
      topTopics: [],
      userCount: 3,
    });
    db.userStylesAggregate.upsert('g1', {
      topCatchphrases: [{ phrase: 'b', userCount: 4 }],
      punctuationDensity: 'heavy',
      emojiProneness: 'frequent',
      commonSentenceTraits: ['x'],
      topTopics: [{ topic: 't', userCount: 4 }],
      userCount: 4,
    });
    const got = db.userStylesAggregate.get('g1')!;
    expect(got.topCatchphrases).toEqual([{ phrase: 'b', userCount: 4 }]);
    expect(got.userCount).toBe(4);
    expect(got.punctuationDensity).toBe('heavy');
  });

  it('per-group isolation — group A value never leaks into group B', () => {
    db.userStylesAggregate.upsert('gA', {
      topCatchphrases: [{ phrase: 'onlyA', userCount: 3 }],
      punctuationDensity: 'light', emojiProneness: 'rare',
      commonSentenceTraits: [], topTopics: [], userCount: 3,
    });
    db.userStylesAggregate.upsert('gB', {
      topCatchphrases: [{ phrase: 'onlyB', userCount: 3 }],
      punctuationDensity: 'heavy', emojiProneness: 'frequent',
      commonSentenceTraits: [], topTopics: [], userCount: 3,
    });
    expect(db.userStylesAggregate.get('gA')!.topCatchphrases[0]!.phrase).toBe('onlyA');
    expect(db.userStylesAggregate.get('gB')!.topCatchphrases[0]!.phrase).toBe('onlyB');
  });

  it('tolerates upsert with empty arrays', () => {
    db.userStylesAggregate.upsert('g1', {
      topCatchphrases: [], punctuationDensity: 'light', emojiProneness: 'rare',
      commonSentenceTraits: [], topTopics: [], userCount: 3,
    });
    const got = db.userStylesAggregate.get('g1')!;
    expect(got.topCatchphrases).toEqual([]);
    expect(got.topTopics).toEqual([]);
    expect(got.commonSentenceTraits).toEqual([]);
  });
});
