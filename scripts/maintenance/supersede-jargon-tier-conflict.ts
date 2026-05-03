#!/usr/bin/env tsx
/**
 * One-shot maintenance — find and (optionally) supersede active learned_facts
 * rows where a lower-trust prefix coexists with a higher-trust active row for
 * the same term in the same group.
 *
 * Default: dry-run (prints affected rows, makes no DB writes).
 * --apply: UPDATE the lower-trust rows to status='superseded' (no DELETE).
 *
 * Reuses the canonical `extractTermFromTopic` + `trustTierFromTopic` from
 * `src/modules/fact-topic-prefixes.ts` so tier semantics stay in one place.
 *
 * SAFETY:
 *   - Default dry-run; --apply is required for any UPDATE.
 *   - UPDATE only; never DELETE (per audit policy).
 *   - Belt-and-suspenders WHERE status='active' so the script is idempotent
 *     even on rows already superseded between dry-run and apply.
 *   - Dry-run + apply share the same conflict-detection pass so what you
 *     saw is what gets superseded.
 *
 * Usage:
 *   supersede-jargon-tier-conflict.ts --db-path <path> [--apply]
 *
 * Exit codes:
 *   0 — success (dry-run or apply, including 0 conflicts)
 *   1 — runtime error
 *   2 — bad args
 */
import { DatabaseSync } from 'node:sqlite';
import {
  extractTermFromTopic,
  trustTierFromTopic,
} from '../../src/modules/fact-topic-prefixes.js';

interface Args {
  dbPath: string;
  apply: boolean;
}

export function parseArgs(argv: ReadonlyArray<string>): Args | null {
  const args = [...argv];
  const dbPathIdx = args.indexOf('--db-path');
  if (dbPathIdx === -1 || !args[dbPathIdx + 1]) return null;
  return {
    dbPath: args[dbPathIdx + 1]!,
    apply: args.includes('--apply'),
  };
}

interface ConflictPair {
  loId: number;
  loTopic: string;
  loFact: string;
  loTier: number;
  hiId: number;
  hiTopic: string;
  hiTier: number;
  groupId: string;
}

// SQL self-join: every (lo, hi) active pair in the same group with distinct
// topics. The `lo.id < hi.id` clause halves the cross-product (per Architect
// SQL note); we then post-filter in TS so canonical extractTermFromTopic +
// trustTierFromTopic decide tier ranking instead of duplicating logic in SQL.
const SELECT_CONFLICTS_SQL = `
  SELECT lo.id        AS lo_id,
         lo.topic     AS lo_topic,
         lo.fact      AS lo_fact,
         hi.id        AS hi_id,
         hi.topic     AS hi_topic,
         lo.group_id  AS group_id
    FROM learned_facts lo
    JOIN learned_facts hi
      ON hi.group_id = lo.group_id
     AND hi.status = 'active'
     AND lo.id < hi.id
   WHERE lo.status = 'active'
     AND lo.topic != hi.topic
`;

const UPDATE_SQL = `
  UPDATE learned_facts
     SET status = 'superseded', updated_at = ?
   WHERE id = ?
     AND status = 'active'
`;

interface RawConflictRow {
  lo_id: number | bigint;
  lo_topic: string | null;
  lo_fact: string | null;
  hi_id: number | bigint;
  hi_topic: string | null;
  group_id: string;
}

function toNum(v: number | bigint): number {
  return typeof v === 'bigint' ? Number(v) : v;
}

/**
 * Find all (loser, winner) conflict pairs where:
 *   - same group_id
 *   - both status='active'
 *   - extractTermFromTopic(lo) === extractTermFromTopic(hi) (same term)
 *   - trustTierFromTopic(hi) < trustTierFromTopic(lo) (hi strictly higher trust)
 *
 * The losers are de-duplicated by id — a single lo row beaten by multiple
 * higher-trust rows still gets superseded once.
 */
export function findConflicts(db: DatabaseSync): ConflictPair[] {
  const rawPairs = db.prepare(SELECT_CONFLICTS_SQL).all() as unknown as ReadonlyArray<RawConflictRow>;
  const pairs: ConflictPair[] = [];
  for (const row of rawPairs) {
    const loTopic = row.lo_topic ?? '';
    const hiTopic = row.hi_topic ?? '';
    const loTerm = extractTermFromTopic(loTopic);
    const hiTerm = extractTermFromTopic(hiTopic);
    if (loTerm === null || hiTerm === null) continue;
    if (loTerm !== hiTerm) continue;
    const loTier = trustTierFromTopic(loTopic);
    const hiTier = trustTierFromTopic(hiTopic);
    // Because lo.id < hi.id in SQL, the "lo" (lower id) might actually be the
    // higher-trust one. Determine the loser by tier, not by id.
    if (loTier === hiTier) continue;
    if (hiTier < loTier) {
      pairs.push({
        loId: toNum(row.lo_id),
        loTopic,
        loFact: row.lo_fact ?? '',
        loTier,
        hiId: toNum(row.hi_id),
        hiTopic,
        hiTier,
        groupId: row.group_id,
      });
    } else {
      // hi.id is larger but its tier is worse (= less trust). Swap so the
      // loser (= the one that gets superseded) is recorded as `lo`.
      pairs.push({
        loId: toNum(row.hi_id),
        loTopic: hiTopic,
        // The fact text of the higher-id row is not in our SELECT; fetch it.
        loFact: '',
        loTier: hiTier,
        hiId: toNum(row.lo_id),
        hiTopic: loTopic,
        hiTier: loTier,
        groupId: row.group_id,
      });
    }
  }
  // Hydrate any blank loFact entries (the swap branch did not have it).
  const missingFactIds = pairs.filter((p) => p.loFact === '').map((p) => p.loId);
  if (missingFactIds.length > 0) {
    const placeholders = missingFactIds.map(() => '?').join(',');
    const factRows = db.prepare(
      `SELECT id, fact FROM learned_facts WHERE id IN (${placeholders})`,
    ).all(...missingFactIds) as unknown as ReadonlyArray<{ id: number | bigint; fact: string | null }>;
    const idToFact = new Map<number, string>();
    for (const fr of factRows) idToFact.set(toNum(fr.id), fr.fact ?? '');
    for (const p of pairs) {
      if (p.loFact === '') p.loFact = idToFact.get(p.loId) ?? '';
    }
  }
  // De-dupe loser ids (one losing row may be beaten by multiple winners).
  const seen = new Set<number>();
  const deduped: ConflictPair[] = [];
  for (const p of pairs) {
    if (seen.has(p.loId)) continue;
    seen.add(p.loId);
    deduped.push(p);
  }
  return deduped;
}

export interface RunResult {
  found: number;
  applied: number;
  conflicts: ReadonlyArray<ConflictPair>;
}

export function runScript(opts: {
  db: DatabaseSync;
  apply: boolean;
  log?: (line: string) => void;
  now?: () => number;
}): RunResult {
  const log = opts.log ?? ((line: string) => console.log(line));
  const nowSec = Math.floor((opts.now?.() ?? Date.now()) / 1000);

  const conflicts = findConflicts(opts.db);

  for (const c of conflicts) {
    const factPreview = c.loFact.slice(0, 80).replace(/\s+/g, ' ');
    const reason = `lower-trust-vs-${c.hiTopic} (tier ${c.loTier} > tier ${c.hiTier})`;
    log(
      `would supersede id=${c.loId} topic=${c.loTopic} group=${c.groupId} ` +
      `reason=${reason} fact='${factPreview}'`,
    );
  }

  if (!opts.apply) {
    log(`[DRY RUN] ${conflicts.length} conflict row(s) found; pass --apply to UPDATE.`);
    return { found: conflicts.length, applied: 0, conflicts };
  }

  if (conflicts.length === 0) {
    log('Apply mode -- 0 conflicts found; nothing to do.');
    return { found: 0, applied: 0, conflicts };
  }

  const upd = opts.db.prepare(UPDATE_SQL);
  opts.db.exec('BEGIN');
  let applied = 0;
  try {
    for (const c of conflicts) {
      const info = upd.run(nowSec, c.loId);
      const changes = typeof info.changes === 'bigint' ? Number(info.changes) : info.changes;
      if (changes === 1) {
        applied += 1;
        log(`SUPERSEDED id=${c.loId} topic=${c.loTopic} group=${c.groupId}`);
      } else {
        // Row already moved off 'active' since the SELECT — skip without
        // failing the whole batch (idempotent re-run case).
        log(`SKIPPED id=${c.loId} topic=${c.loTopic} (no longer active, changes=${changes})`);
      }
    }
    opts.db.exec('COMMIT');
  } catch (err) {
    opts.db.exec('ROLLBACK');
    throw err;
  }
  log(`Apply mode -- ${applied} row(s) superseded of ${conflicts.length} found.`);
  return { found: conflicts.length, applied, conflicts };
}

function main(argv: ReadonlyArray<string>): number {
  const parsed = parseArgs(argv);
  if (!parsed) {
    console.error('Usage: supersede-jargon-tier-conflict.ts --db-path <path> [--apply]');
    return 2;
  }
  const db = new DatabaseSync(parsed.dbPath);
  try {
    runScript({ db, apply: parsed.apply });
    return 0;
  } catch (err) {
    console.error('Runtime error:', err);
    return 1;
  } finally {
    db.close();
  }
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const url = new URL(`file://${entry.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}`).href;
    return url === import.meta.url;
  } catch { return false; }
})();

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
