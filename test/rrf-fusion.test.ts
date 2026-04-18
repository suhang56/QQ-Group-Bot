import { describe, it, expect } from 'vitest';
import { rrfFuse } from '../src/utils/rrf-fusion.js';

type Doc = { id: number; label?: string };

describe('rrfFuse', () => {
  it('empty lists returns empty', () => {
    expect(rrfFuse<Doc>([], {})).toEqual([]);
    expect(rrfFuse<Doc>([{ items: [] }, { items: [] }], {})).toEqual([]);
  });

  it('single list passthrough preserves rank order', () => {
    const items: Doc[] = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const fused = rrfFuse<Doc>([{ items }], {});
    expect(fused.map(f => f.item.id)).toEqual([1, 2, 3]);
    // Scores strictly descending (rank1 > rank2 > rank3 since all use k=60)
    expect(fused[0]!.score).toBeGreaterThan(fused[1]!.score);
    expect(fused[1]!.score).toBeGreaterThan(fused[2]!.score);
  });

  it('doc in both lists gets summed score higher than single-list doc', () => {
    // List A: [1, 2, 3], List B: [2, 4, 5] — doc 2 should outrank single-listers.
    const listA: Doc[] = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const listB: Doc[] = [{ id: 2 }, { id: 4 }, { id: 5 }];
    const fused = rrfFuse<Doc>([{ items: listA }, { items: listB }], {});
    const topIds = fused.map(f => f.item.id);
    // Doc 2 appears rank-2 in A + rank-1 in B, contributions add.
    // Doc 1 is rank-1 in A only; 1/(60+1) = 0.01639.
    // Doc 2 is rank-2 in A + rank-1 in B = 1/62 + 1/61 = 0.01613 + 0.01639 = 0.03252.
    // So doc 2 should beat doc 1.
    expect(topIds[0]).toBe(2);
    const doc2 = fused.find(f => f.item.id === 2)!;
    expect(doc2.contributions).toHaveLength(2);
    expect(doc2.contributions).toEqual(
      expect.arrayContaining([
        { listIndex: 0, rank: 2 },
        { listIndex: 1, rank: 1 },
      ]),
    );
  });

  it('tie broken by id ascending', () => {
    // Two docs in single list at same rank is impossible; but construct identical score
    // by putting each as rank-1 in its own single-item list.
    const fused = rrfFuse<Doc>(
      [
        { items: [{ id: 7 }] },
        { items: [{ id: 3 }] },
      ],
      {},
    );
    // Both score 1/(60+1) — tie → id ascending means 3 first.
    expect(fused[0]!.score).toBeCloseTo(fused[1]!.score, 10);
    expect(fused.map(f => f.item.id)).toEqual([3, 7]);
  });

  it('k parameter shifts score magnitude but not order', () => {
    const items: Doc[] = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const k60 = rrfFuse<Doc>([{ items }], { k: 60 });
    const k1 = rrfFuse<Doc>([{ items }], { k: 1 });
    // Order identical.
    expect(k60.map(f => f.item.id)).toEqual(k1.map(f => f.item.id));
    // k=1 gives larger scores (smaller denominator) than k=60.
    expect(k1[0]!.score).toBeGreaterThan(k60[0]!.score);
  });

  it('limit caps output', () => {
    const items: Doc[] = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));
    const fused = rrfFuse<Doc>([{ items }], { limit: 3 });
    expect(fused).toHaveLength(3);
    expect(fused.map(f => f.item.id)).toEqual([1, 2, 3]);
  });
});
