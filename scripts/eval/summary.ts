import { createHash } from 'node:crypto';
import type {
  BenchmarkRow,
  LabeledBenchmarkRow,
  SamplingCategory,
  SummaryJson,
  CategoryStats,
} from './types.js';
import { ALL_CATEGORIES } from './types.js';

export function buildSummary(
  rawRows: BenchmarkRow[],
  labeledRows: LabeledBenchmarkRow[],
  seed: string,
  sourceDb: string,
  perCategoryTarget: number,
): SummaryJson {
  const perCategory = {} as Record<SamplingCategory, CategoryStats>;
  for (const cat of ALL_CATEGORIES) {
    const sampled = rawRows.filter(r => r.category === cat).length;
    const labeled = labeledRows.filter(r => r.category === cat).length;
    perCategory[cat] = { sampled, labeled, target: perCategoryTarget };
  }

  // Duplicate detection by content hash
  const hashCount = new Map<string, number>();
  for (const row of rawRows) {
    const h = createHash('sha256').update(row.content).digest('hex');
    hashCount.set(h, (hashCount.get(h) ?? 0) + 1);
  }
  let duplicateCount = 0;
  for (const count of hashCount.values()) {
    if (count > 1) duplicateCount += count;
  }
  const byContentHash = rawRows.length > 0 ? duplicateCount / rawRows.length : 0;

  // Data quality
  let emptyContent = 0;
  let missingContext = 0;
  let missingContextAfter = 0;
  for (const row of rawRows) {
    if (!row.content || row.content.trim() === '') emptyContent++;
    if (row.triggerContext.length < 5) missingContext++;
    if (row.triggerContextAfter.length < 3) missingContextAfter++;
  }

  // Gaps
  const undersampled = ALL_CATEGORIES
    .map(cat => {
      const stats = perCategory[cat];
      const shortfall = stats.target - stats.sampled;
      return { category: cat, sampled: stats.sampled, target: stats.target, shortfall };
    })
    .filter(g => g.sampled < g.target * 0.8);

  return {
    generatedAt: new Date().toISOString(),
    samplingSeed: seed,
    sourceDb,
    totalSampled: rawRows.length,
    totalLabeled: labeledRows.length,
    perCategory,
    duplicateRate: { byContentHash, duplicateCount },
    dataQuality: {
      emptyContent,
      malformedRows: 0,
      missingContext,
      missingContextAfter,
    },
    gaps: { undersampled },
  };
}
