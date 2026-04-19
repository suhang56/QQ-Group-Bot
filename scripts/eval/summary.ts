import type { SampledRow, WeakLabeledRow, SummaryJson, CategorySummary } from './types.js';
import { CATEGORY_LABELS } from './types.js';

export function buildSummary(
  rawRows: SampledRow[],
  _labeledRows: WeakLabeledRow[],
  seed: number,
  perCategoryTarget: number,
): SummaryJson {
  const countByCat = new Map<number, number>();
  for (const row of rawRows) {
    countByCat.set(row.category, (countByCat.get(row.category) ?? 0) + 1);
  }

  const categories: CategorySummary[] = CATEGORY_LABELS.map((label, i) => {
    const cat = i + 1;
    const sampled = countByCat.get(cat) ?? 0;
    return { category: cat, label, sampled, target: perCategoryTarget, gap: perCategoryTarget - sampled };
  });

  const hashCount = new Map<string, number>();
  for (const row of rawRows) {
    hashCount.set(row.contentHash, (hashCount.get(row.contentHash) ?? 0) + 1);
  }
  let duplicateCount = 0;
  for (const count of hashCount.values()) {
    if (count > 1) duplicateCount += count;
  }

  const emptyContentCount = rawRows.filter(r => !r.content || r.content.trim() === '').length;

  return {
    generatedAt: Math.floor(Date.now() / 1000),
    seed,
    perCategoryTarget,
    totalSampled: rawRows.length,
    categories,
    duplicateCount,
    duplicateRate: rawRows.length > 0 ? duplicateCount / rawRows.length : 0,
    emptyContentCount,
    malformedCount: 0,
  };
}
