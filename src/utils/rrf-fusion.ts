/**
 * Reciprocal Rank Fusion — merges N ranked lists into a single score per doc.
 *
 * score(doc) = Σ 1 / (k + rank_i(doc))   (1-based rank, k=60 default)
 *
 * Higher score = better. Ties broken by id ascending for determinism across runs.
 * Pure — no DB, no side effects.
 */
export interface Ranked<T extends { id: number }> {
  items: T[]; // already sorted best-first; rank is index + 1
}

export interface RrfContribution {
  listIndex: number;
  rank: number;
}

export interface RrfResult<T extends { id: number }> {
  item: T;
  score: number;
  contributions: RrfContribution[];
}

export function rrfFuse<T extends { id: number }>(
  lists: Ranked<T>[],
  opts: { k?: number; limit?: number } = {},
): RrfResult<T>[] {
  const k = opts.k ?? 60;
  const limit = opts.limit ?? 20;
  const agg = new Map<number, RrfResult<T>>();

  lists.forEach((list, listIndex) => {
    list.items.forEach((item, rank0) => {
      const rank = rank0 + 1;
      const contrib = 1 / (k + rank);
      const cur = agg.get(item.id);
      if (cur) {
        cur.score += contrib;
        cur.contributions.push({ listIndex, rank });
      } else {
        agg.set(item.id, {
          item,
          score: contrib,
          contributions: [{ listIndex, rank }],
        });
      }
    });
  });

  return Array.from(agg.values())
    .sort((a, b) => b.score - a.score || a.item.id - b.item.id)
    .slice(0, limit);
}
