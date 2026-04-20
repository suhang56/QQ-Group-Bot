import type { DatabaseSync } from 'node:sqlite';
import type { DbRow, KnownFactSource } from '../types.js';

/** R6.1a: cat2 is hard-capped at 50 even when perCategoryTarget is higher. */
export const CAT2_MAX = 50;

/** Escape !, %, _ for SQLite LIKE with ESCAPE '!'. */
function escapeLike(s: string): string {
  return s.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_');
}

/**
 * Collect all candidate term patterns from expanded recall sources.
 * Sources (R6.1a):
 *   1. learned_facts.topic
 *   2. learned_facts.canonical_form
 *   3. learned_facts.persona_form (if column exists)
 *   4. learned_facts.fact (the fact text itself)
 *   5. meme_graph.canonical + meme_graph.variants (if table exists)
 *   6. jargon_candidates.content (promoted: is_jargon=2 OR promoted=1)
 *   7. phrase_candidates.content (promoted: is_jargon=2 OR promoted=1)
 */
/** R6.1c: per-term source tag used by both queryCat2 (via collectTerms) and
 *  weak-label.findKnownFactSource (via collectTermsWithSource). */
export interface SourcedTerm {
  readonly term: string;
  readonly source: Exclude<KnownFactSource, null>;
}

/**
 * R6.1c priority order for duplicate-term resolution.
 * Lower rank = higher priority. Must match the documented priority in
 * types.ts KnownFactSource so weak-label output is deterministic when the
 * same string appears in multiple source tables.
 */
const SOURCE_PRIORITY: Record<Exclude<KnownFactSource, null>, number> = {
  topic: 0,
  canonical: 1,
  persona: 2,
  fact: 3,
  meme: 4,
  jargon: 5,
  phrase: 6,
};

/**
 * R6.1c: collect all recall terms from the 4 cat2 source tables, tagged with
 * the table/column they came from. When the same term appears under multiple
 * sources, the highest-priority source wins.
 *
 * Exported for use by scripts/eval/weak-label.ts — aligns weak-label's
 * knownFactSource with the exact row set queryCat2 samples from.
 */
export function collectTermsWithSource(db: DatabaseSync, groupId: string): SourcedTerm[] {
  const byTerm = new Map<string, Exclude<KnownFactSource, null>>();
  const put = (t: string | null | undefined, s: Exclude<KnownFactSource, null>) => {
    if (!t) return;
    const prev = byTerm.get(t);
    if (prev === undefined || SOURCE_PRIORITY[s] < SOURCE_PRIORITY[prev]) {
      byTerm.set(t, s);
    }
  };

  // learned_facts — topic / canonical / (persona) / fact
  let factsQuery = `
    SELECT topic, canonical_form, fact FROM learned_facts
    WHERE group_id = ? AND status = 'active'
    ORDER BY updated_at DESC LIMIT 500
  `;
  let hasPersonaForm = false;
  try {
    db.prepare(`SELECT persona_form FROM learned_facts LIMIT 0`).all();
    hasPersonaForm = true;
  } catch {
    // column not present
  }
  if (hasPersonaForm) {
    factsQuery = `
      SELECT topic, canonical_form, fact, persona_form FROM learned_facts
      WHERE group_id = ? AND status = 'active'
      ORDER BY updated_at DESC LIMIT 500
    `;
  }

  const factRows = db.prepare(factsQuery).all(groupId) as Array<{
    topic: string | null;
    canonical_form: string | null;
    fact: string | null;
    persona_form?: string | null;
  }>;

  for (const r of factRows) {
    put(r.topic, 'topic');
    put(r.canonical_form, 'canonical');
    if (hasPersonaForm) put(r.persona_form, 'persona');
    put(r.fact, 'fact');
  }

  // meme_graph — canonical + variants (if table exists)
  try {
    const memeRows = db.prepare(`
      SELECT canonical, variants FROM meme_graph
      WHERE group_id = ? AND status IN ('active', 'manual_edit')
      ORDER BY updated_at DESC LIMIT 300
    `).all(groupId) as Array<{ canonical: string; variants: string }>;

    for (const r of memeRows) {
      put(r.canonical, 'meme');
      try {
        const vs: unknown = JSON.parse(r.variants ?? '[]');
        if (Array.isArray(vs)) {
          for (const v of vs) {
            if (typeof v === 'string' && v) put(v, 'meme');
          }
        }
      } catch {
        // malformed variants JSON — skip
      }
    }
  } catch {
    // meme_graph table doesn't exist
  }

  // jargon_candidates promoted
  try {
    const jargonRows = db.prepare(`
      SELECT content FROM jargon_candidates
      WHERE group_id = ? AND (is_jargon = 2 OR promoted = 1)
      ORDER BY count DESC LIMIT 200
    `).all(groupId) as Array<{ content: string }>;
    for (const r of jargonRows) put(r.content, 'jargon');
  } catch {
    // table doesn't exist
  }

  // phrase_candidates promoted
  try {
    const phraseRows = db.prepare(`
      SELECT content FROM phrase_candidates
      WHERE group_id = ? AND (is_jargon = 2 OR promoted = 1)
      ORDER BY count DESC LIMIT 200
    `).all(groupId) as Array<{ content: string }>;
    for (const r of phraseRows) put(r.content, 'phrase');
  } catch {
    // table doesn't exist
  }

  return [...byTerm].map(([term, source]) => ({ term, source }));
}

/** R6.1c: thin wrapper kept for backward compat within queryCat2. */
export function collectTerms(db: DatabaseSync, groupId: string): string[] {
  return collectTermsWithSource(db, groupId).map(t => t.term);
}

/** SQLite expression tree depth limit — keep OR clauses well under 1000. */
const MAX_OR_CLAUSES_PER_CHUNK = 200;

export function queryCat2(db: DatabaseSync, groupId: string, limit: number): DbRow[] {
  // R6.1a: hard cap at CAT2_MAX regardless of caller's limit
  const effectiveLimit = Math.min(limit, CAT2_MAX);

  const termList = collectTerms(db, groupId);
  if (termList.length === 0) return [];

  // Filter long terms (sentence-length facts pollute LIKE matching)
  const validTerms = termList.filter(t => t.length <= 50);
  if (validTerms.length === 0) return [];

  // Chunk into groups to stay under SQLite's expression tree depth limit
  const seen = new Set<number>();
  const results: DbRow[] = [];

  for (let start = 0; start < validTerms.length && results.length < effectiveLimit; start += MAX_OR_CLAUSES_PER_CHUNK) {
    const chunk = validTerms.slice(start, start + MAX_OR_CLAUSES_PER_CHUNK);
    const patterns: string[] = [];
    const bindings: string[] = [];

    for (const term of chunk) {
      patterns.push("m.content LIKE ? ESCAPE '!'");
      bindings.push('%' + escapeLike(term) + '%');
    }

    const chunkLimit = effectiveLimit - results.length;
    const sql = `
      SELECT m.* FROM messages m
      WHERE m.group_id = ?
        AND m.deleted = 0
        AND (${patterns.join(' OR ')})
      ORDER BY m.id DESC
      LIMIT ?
    `;

    const rows = db.prepare(sql).all(groupId, ...bindings, chunkLimit * 3) as DbRow[];
    for (const row of rows) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        results.push(row);
        if (results.length >= effectiveLimit) break;
      }
    }
  }

  // Sort by id DESC to maintain recency ordering across chunks
  results.sort((a, b) => b.id - a.id);
  return results.slice(0, effectiveLimit);
}
