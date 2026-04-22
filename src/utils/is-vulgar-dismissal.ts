/**
 * R2.5.1-annex — Vulgar-dismissal predicate for `_buildOnDemandBlock` candidate
 * chain. Separate family from `isEmotivePhrase` (emotive = 烦/累/崩; vulgar =
 * 轻挑衅回怼 like `你懂个毛 / 去你的 / 管你屁事`). Purely code-local — pairs with
 * `scripts/maintenance/purge-vulgar-phrase-facts.ts` for historical-row cleanup.
 *
 * Exact-match on extracted term only (`^...$`). Called after
 * `isValidStructuredTerm` + `isEmotivePhrase` in the filter chain, so the
 * candidates it sees are already structured terms extracted from user input —
 * free-text sentences never reach this predicate.
 */

const VULGAR_DISMISSAL_RE =
  /^(?:你?懂个(?:毛|屁|锤子|鬼|啥|蛋)|你(?:个|才)(?:屁|毛|傻|二|蠢)|去你的|滚你的|管你屁事)$/u;

export const VULGAR_DISMISSAL_PATTERNS: readonly RegExp[] = [VULGAR_DISMISSAL_RE];

// Kept empty for parity with is-emotive-phrase.ts shape; lore grep (Designer Q3)
// found zero exact matches, so no allowlist entry is required today.
export const VULGAR_DISMISSAL_ALLOWLIST: ReadonlySet<string> = new Set<string>();

export function isVulgarDismissal(term: unknown): boolean {
  if (typeof term !== 'string') return false;
  if (term.length === 0 || term.trim().length === 0) return false;
  if (VULGAR_DISMISSAL_ALLOWLIST.has(term)) return false;
  return VULGAR_DISMISSAL_RE.test(term);
}
