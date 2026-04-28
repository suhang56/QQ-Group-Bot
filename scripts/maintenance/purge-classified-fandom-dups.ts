#!/usr/bin/env tsx
/**
 * One-shot maintenance — purge duplicate active rows produced by the
 * 2026-04-18 09:37:30 `opus-classifier-rest` batch run that double-inserted
 * `(topic, canonical_form)` pairs into `learned_facts` under exactly two
 * topic prefixes:
 *
 *   - opus-rest-classified:fandom:%
 *   - opus-rest-classified:slang:%
 *
 * Action: for each `(topic, canonical_form)` group with COUNT(*) > 1 (status
 * 'active', canonical_form NOT NULL), keep `MIN(id)` and flip every other
 * row to `status = 'superseded'` via UPDATE. No DELETE — `learned_facts_au`
 * keeps the FTS5 mirror in sync, and superseded rows remain auditable.
 *
 * SAFETY RAILS (every condition required in SELECT):
 *   1. status = 'active'                    — leave pending/rejected/superseded alone
 *   2. canonical_form IS NOT NULL           — null-canonical rows untouched
 *   3. topic LIKE 'opus-rest-classified:fandom:%' OR
 *      topic LIKE 'opus-rest-classified:slang:%' — exact two prefixes, no widening
 *   4. GROUP BY topic, canonical_form / HAVING COUNT(*) > 1 — only true duplicates
 *   5. MIN(id) is the survivor (kept active); others go superseded
 *
 * Per-row UPDATE additionally requires `AND status = 'active'`
 * (belt-and-suspenders against concurrent writes).
 *
 * Usage:
 *   purge-classified-fandom-dups.ts --db-path <path> [--apply] [--limit N] [--verbose]
 *
 * Default is DRY RUN. Pass --apply to persist. --limit defaults to 1000;
 * if found > limit the script throws (caught -> exit 1).
 *
 * Exit codes:
 *   0 — success (dry run or apply)
 *   1 — runtime error / limit exceeded
 *   2 — bad args
 */
import { DatabaseSync } from 'node:sqlite';

interface Args {
  dbPath: string;
  apply: boolean;
  verbose: boolean;
  limit: number;
}

function parseArgs(argv: ReadonlyArray<string>): Args | null {
  const args = [...argv];
  const dbPathIdx = args.indexOf('--db-path');
  if (dbPathIdx === -1 || !args[dbPathIdx + 1]) return null;

  let limit = 1000;
  const limitIdx = args.indexOf('--limit');
  if (limitIdx !== -1) {
    const raw = args[limitIdx + 1];
    if (!raw) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    limit = Math.floor(parsed);
  }

  return {
    dbPath: args[dbPathIdx + 1]!,
    apply: args.includes('--apply'),
    verbose: args.includes('--verbose'),
    limit,
  };
}

interface DupGroupRow {
  topic: string;
  canonical_form: string;
  keep_id: number;
  cnt: number;
  all_ids: string;
}

export interface DupGroup {
  topic: string;
  canonicalForm: string;
  keepId: number;
  supersededIds: ReadonlyArray<number>;
  count: number;
}

const SELECT_SQL = `
  SELECT
      topic,
      canonical_form,
      MIN(id)            AS keep_id,
      COUNT(*)           AS cnt,
      GROUP_CONCAT(id)   AS all_ids
    FROM learned_facts
   WHERE status = 'active'
     AND canonical_form IS NOT NULL
     AND (
            topic LIKE 'opus-rest-classified:fandom:%'
         OR topic LIKE 'opus-rest-classified:slang:%'
         )
   GROUP BY topic, canonical_form
  HAVING COUNT(*) > 1
   ORDER BY topic ASC, canonical_form ASC;
`;

const UPDATE_SQL = `
  UPDATE learned_facts
     SET status = 'superseded', updated_at = ?
   WHERE id = ?
     AND status = 'active'
`;

function findDupGroups(db: DatabaseSync): DupGroup[] {
  const rows = db.prepare(SELECT_SQL).all() as unknown as DupGroupRow[];
  return rows.map((row): DupGroup => {
    const keepId = typeof row.keep_id === 'bigint' ? Number(row.keep_id) : row.keep_id;
    const cnt = typeof row.cnt === 'bigint' ? Number(row.cnt) : row.cnt;
    const parsedIds = String(row.all_ids)
      .split(',')
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n));
    const supersededIds = parsedIds
      .filter((id) => id !== keepId)
      .sort((a, b) => a - b);
    return {
      topic: row.topic,
      canonicalForm: row.canonical_form,
      keepId,
      supersededIds,
      count: cnt,
    };
  });
}

function applySupersede(
  db: DatabaseSync,
  ids: ReadonlyArray<number>,
  nowSec: number,
): number {
  if (ids.length === 0) return 0;
  const upd = db.prepare(UPDATE_SQL);
  db.exec('BEGIN');
  try {
    let updated = 0;
    for (const id of ids) {
      const info = upd.run(nowSec, id);
      if (typeof info.changes === 'bigint' ? info.changes > 0n : info.changes > 0) {
        updated += 1;
      }
    }
    db.exec('COMMIT');
    return updated;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export interface PurgeResult {
  groupCount: number;
  found: number;
  updated: number;
  groups: ReadonlyArray<DupGroup>;
}

function truncateCanonical(s: string): string {
  return s.length > 40 ? s.slice(0, 40) + '...' : s;
}

/**
 * Runs the purge. Pure w.r.t. stdout when `log` is supplied. Caller owns
 * opening / closing the DatabaseSync handle.
 */
export function runPurge(opts: {
  db: DatabaseSync;
  apply: boolean;
  verbose: boolean;
  limit?: number;
  log?: (line: string) => void;
  now?: () => number;
}): PurgeResult {
  const log = opts.log ?? ((line: string) => console.log(line));
  const nowSec = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const limit = opts.limit ?? 1000;

  const groups = findDupGroups(opts.db);
  const found = groups.reduce((sum, g) => sum + g.supersededIds.length, 0);

  if (found > limit) {
    throw new Error(
      `Refusing to supersede ${found} rows - exceeds --limit ${limit}`,
    );
  }

  const supersededIds = groups.flatMap((g) => g.supersededIds);
  const updated = opts.apply ? applySupersede(opts.db, supersededIds, nowSec) : 0;

  if (opts.apply) {
    log(`Dup groups found: ${groups.length}`);
    for (const g of groups) {
      log(
        `  ${g.topic} | kept=${g.keepId} | superseded=[${g.supersededIds.join(',')}] | ${truncateCanonical(g.canonicalForm)}`,
      );
      if (opts.verbose) {
        const allIds = [g.keepId, ...g.supersededIds].sort((a, b) => a - b);
        log(`  [verbose] all_ids=[${allIds.join(',')}]`);
      }
    }
    log(`TOTAL: ${groups.length} groups / ${updated} rows superseded`);
    log(`Skipped: 0 null-canonical (excluded by SQL filter)`);
  } else {
    log(`[DRY RUN] Dup groups found: ${groups.length}`);
    log(`  topic | kept_id | superseded_ids | canonical`);
    for (const g of groups) {
      log(
        `  ${g.topic} | ${g.keepId} | [${g.supersededIds.join(',')}] | ${truncateCanonical(g.canonicalForm)}`,
      );
      if (opts.verbose) {
        const allIds = [g.keepId, ...g.supersededIds].sort((a, b) => a - b);
        log(`  [verbose] all_ids=[${allIds.join(',')}]`);
      }
    }
    log(`TOTAL: ${groups.length} groups / ${found} rows would be superseded`);
    log(`Skipped: 0 null-canonical (excluded by SQL filter)`);
  }

  return {
    groupCount: groups.length,
    found,
    updated: opts.apply ? updated : 0,
    groups,
  };
}

function main(argv: ReadonlyArray<string>): number {
  const parsed = parseArgs(argv);
  if (!parsed) {
    console.error(
      'Usage: purge-classified-fandom-dups.ts --db-path <path> [--apply] [--limit N] [--verbose]',
    );
    return 2;
  }
  const db = new DatabaseSync(parsed.dbPath);
  try {
    runPurge({
      db,
      apply: parsed.apply,
      verbose: parsed.verbose,
      limit: parsed.limit,
    });
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
