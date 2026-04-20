import type {
  SampledRow,
  WeakLabeledRow,
  SummaryJson,
  CategorySummary,
  CategoryOverlapMatrix,
} from './types.js';
import { CATEGORY_LABELS } from './types.js';
import { CAT2_MAX } from './categories/cat2-known-fact-term.js';

/** Regex to detect media-only CQ codes that make content appear empty.
 *  R6.1b: kept in sync with weak-label.isEmptyBecauseMediaOnly — `face` included. */
const MEDIA_CQ_RE = /\[CQ:(?:image|mface|face|video|record)[^\]]*\]/;

export function buildSummary(
  rawRows: SampledRow[],
  labeledRows: WeakLabeledRow[],
  seed: number,
  perCategoryTarget: number,
  categoryOverlap: CategoryOverlapMatrix = {},
): SummaryJson {
  const countByCat = new Map<number, number>();
  for (const row of rawRows) {
    countByCat.set(row.category, (countByCat.get(row.category) ?? 0) + 1);
  }

  const categories: CategorySummary[] = CATEGORY_LABELS.map((label, i) => {
    const cat = i + 1;
    const target = cat === 2 ? Math.min(perCategoryTarget, CAT2_MAX) : perCategoryTarget;
    const sampled = countByCat.get(cat) ?? 0;
    const entry: CategorySummary = { category: cat, label, sampled, target, gap: target - sampled };

    // R6.1a: cat2 organic fact shortfall
    if (cat === 2) {
      entry.organicFactShortfall = {
        expected: target,
        actual: sampled,
        gap: target - sampled,
      };
    }

    return entry;
  });

  // R6.1a: sameMessageId — after hard dedupe this must be 0 (sanity check)
  const messageIds = rawRows.map(r => r.messageId);
  const uniqueMessageIds = new Set(messageIds);
  const sameMessageIdCount = messageIds.length - uniqueMessageIds.size;

  // R6.1a: sameContentHash — content-level duplicate rate
  const contentHashCount = new Map<string, number>();
  for (const row of rawRows) {
    contentHashCount.set(row.contentHash, (contentHashCount.get(row.contentHash) ?? 0) + 1);
  }
  let sameContentHashCount = 0;
  for (const count of contentHashCount.values()) {
    if (count > 1) sameContentHashCount += count;
  }

  // R6.1a: sameContextHash — trigger+context hash duplicate rate (real pollution signal)
  const contextHashCount = new Map<string, number>();
  for (const row of rawRows) {
    contextHashCount.set(row.contextHash, (contextHashCount.get(row.contextHash) ?? 0) + 1);
  }
  let sameContextHashCount = 0;
  for (const count of contextHashCount.values()) {
    if (count > 1) sameContextHashCount += count;
  }

  const total = rawRows.length;

  // R6.1a: empty split
  let emptyBecauseMediaOnly = 0;
  let emptyWithoutMedia = 0;
  for (const row of rawRows) {
    const content = row.content ?? '';
    if (content.trim() === '') {
      const raw = row.rawContent ?? '';
      if (MEDIA_CQ_RE.test(raw)) {
        emptyBecauseMediaOnly++;
      } else {
        emptyWithoutMedia++;
      }
    }
  }

  return {
    generatedAt: Math.floor(Date.now() / 1000),
    seed,
    perCategoryTarget,
    totalSampled: total,
    totalLabeled: labeledRows.length,
    categories,
    duplicates: {
      sameMessageId: {
        count: sameMessageIdCount,
        rate: total > 0 ? sameMessageIdCount / total : 0,
      },
      sameContentHash: {
        count: sameContentHashCount,
        rate: total > 0 ? sameContentHashCount / total : 0,
      },
      sameContextHash: {
        count: sameContextHashCount,
        rate: total > 0 ? sameContextHashCount / total : 0,
      },
    },
    empty: {
      emptyBecauseMediaOnly,
      emptyWithoutMedia,
    },
    malformedCount: 0,
    categoryOverlap,
  };
}
