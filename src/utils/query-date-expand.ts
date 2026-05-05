// Pre-BM25 query rewriter: detects compact date tokens (618, 6/18, 6-18) and
// emits canonical Chinese alternates (6月18号 / 6月18日 / 6月) as a separate
// array. Caller runs one BM25 call per alternate and unions results — needed
// because sanitizeFtsQuery joins phrase-literals with implicit AND, so simply
// concatenating expansions into the same query string would intersect not
// union and never recover the BM25 miss this PR exists to fix.
//
// Pure function, no I/O, no logger dependency — caller logs if it cares.

const MMDD_RE = /\b(\d{1,2})(\d{2})\b/g;
const SLASH_RE = /\b(\d{1,2})[\/\-](\d{1,2})\b/g;
const CANONICAL_MD_RE = /(\d{1,2})月(\d{1,2})[号日]/g;

const MAX_DATES = 4;

interface DateMatch { month: number; day: number; }

export interface ExpandedQuery {
  /** Original input, unchanged — preserves existing BM25 hit shape. */
  baseQuery: string;
  /** Flat list of canonical alternates to OR via separate BM25 calls. */
  alternates: string[];
}

function isValidMonthDay(m: number, d: number): boolean {
  return m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

function dateKey(m: number, d: number): string {
  return `${m}-${d}`;
}

function parseExistingCanonicals(query: string): Set<string> {
  const found = new Set<string>();
  for (const m of query.matchAll(CANONICAL_MD_RE)) {
    const month = parseInt(m[1]!, 10);
    const day = parseInt(m[2]!, 10);
    if (isValidMonthDay(month, day)) found.add(dateKey(month, day));
  }
  return found;
}

function parseDateTokens(query: string): DateMatch[] {
  const found: DateMatch[] = [];
  const seen = new Set<string>();

  for (const match of query.matchAll(MMDD_RE)) {
    const m = parseInt(match[1]!, 10);
    const d = parseInt(match[2]!, 10);
    if (!isValidMonthDay(m, d)) continue;
    const k = dateKey(m, d);
    if (seen.has(k)) continue;
    seen.add(k);
    found.push({ month: m, day: d });
  }
  for (const match of query.matchAll(SLASH_RE)) {
    const m = parseInt(match[1]!, 10);
    const d = parseInt(match[2]!, 10);
    if (!isValidMonthDay(m, d)) continue;
    const k = dateKey(m, d);
    if (seen.has(k)) continue;
    seen.add(k);
    found.push({ month: m, day: d });
  }
  return found;
}

/**
 * Detect date tokens in `query` and return the original alongside canonical
 * alternates. `alternates` is empty when no compact dates detected or when
 * every detected date is already canonical in the query (idempotent).
 * Caps at MAX_DATES=4 distinct dates to bound total alternates at 12 strings.
 */
export function expandDateTokens(query: string): ExpandedQuery {
  if (typeof query !== 'string' || query.length === 0) {
    return { baseQuery: query, alternates: [] };
  }

  const dates = parseDateTokens(query);
  if (dates.length === 0) return { baseQuery: query, alternates: [] };

  const existing = parseExistingCanonicals(query);
  const alternates: string[] = [];

  const capped = dates.slice(0, MAX_DATES);
  for (const { month, day } of capped) {
    if (existing.has(dateKey(month, day))) continue;
    alternates.push(`${month}月${day}号`);
    alternates.push(`${month}月${day}日`);
    alternates.push(`${month}月`);
  }

  return { baseQuery: query, alternates };
}
