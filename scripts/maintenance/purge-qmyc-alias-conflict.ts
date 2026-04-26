#!/usr/bin/env tsx
/**
 * R2.5.1-annex — purge qmyc alias-conflict learned_facts (id 531, 637).
 *
 * Two alias-miner rows in `learned_facts` for group 958751334 falsely link
 * "qmyc" to 西瓜's QQ number, contradicting the curated id=2081 row that
 * correctly identifies qmyc as 青木阳菜. RAG surfaces both → bot bails on
 * "qmyc是谁" with a confused "谁啊". This script flips id=531 and id=637 to
 * `status='rejected'` via UPDATE (no DELETE — `learned_facts_au` keeps FTS5
 * mirror in sync).
 *
 * SAFETY RAILS — SELECT requires ALL FOUR conditions to match:
 *   1. id IN (531, 637)            — exact id-set guard
 *   2. status = 'active'           — leave pending/rejected/superseded alone
 *   3. group_id = '958751334'      — scope to the affected group only
 *   4. fact LIKE '%qmyc%'          — sanity belt-and-suspenders check
 *
 * The id=2081 row (`nga:声优` topic, 青木阳菜 (qmyc) 是…) is NOT in the id-set
 * and is structurally protected even if its other fields drift.
 *
 * Usage:
 *   purge-qmyc-alias-conflict.ts --db-path <path> [--apply] [--verbose]
 * Default is DRY RUN (reports only). Pass --apply to persist.
 *
 * Exit codes:
 *   0 — success (dry run or apply)
 *   1 — runtime error
 *   2 — bad args
 */
import { DatabaseSync } from 'node:sqlite';

interface Args {
  dbPath: string;
  apply: boolean;
  verbose: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): Args | null {
  const args = [...argv];
  const dbPathIdx = args.indexOf('--db-path');
  if (dbPathIdx === -1 || !args[dbPathIdx + 1]) return null;
  return {
    dbPath: args[dbPathIdx + 1]!,
    apply: args.includes('--apply'),
    verbose: args.includes('--verbose'),
  };
}

interface Row {
  id: number;
  topic: string;
  fact: string;
  status: string;
}

/**
 * Four-condition safety rail. id-set is primary; status/group_id/fact LIKE are
 * defense-in-depth so a wrong-DB run, schema drift, or already-fixed row
 * cannot cause a stray UPDATE.
 */
const SELECT_SQL = `
  SELECT id, topic, fact, status
    FROM learned_facts
   WHERE id IN (531, 637)
     AND status = 'active'
     AND group_id = '958751334'
     AND fact LIKE '%qmyc%'
`;

function findCandidateRows(db: DatabaseSync): Row[] {
  return db.prepare(SELECT_SQL).all() as unknown as Row[];
}

function applyReject(db: DatabaseSync, ids: ReadonlyArray<number>, nowSec: number): number {
  if (ids.length === 0) return 0;
  const upd = db.prepare(
    "UPDATE learned_facts SET status = 'rejected', updated_at = ? WHERE id = ?",
  );
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
  found: number;
  updated: number;
  matched: ReadonlyArray<Row>;
}

/**
 * Runs the purge. Pure w.r.t. stdout when `log` is supplied. Caller owns
 * opening / closing the DatabaseSync handle.
 */
export function runPurge(opts: {
  db: DatabaseSync;
  apply: boolean;
  verbose: boolean;
  log?: (line: string) => void;
  now?: () => number;
}): PurgeResult {
  const log = opts.log ?? ((line: string) => console.log(line));
  const nowSec = Math.floor((opts.now?.() ?? Date.now()) / 1000);

  const matched = findCandidateRows(opts.db);

  const ids = matched.map(r => r.id);
  const updated = opts.apply ? applyReject(opts.db, ids, nowSec) : 0;
  const action = opts.apply ? 'updated' : 'would update';
  const heading = opts.apply ? 'Rows updated:' : '[DRY RUN] Rows that would be updated:';

  log(heading);
  log(`  learned_facts alias-conflict rows: ${matched.length} found, ${opts.apply ? updated : 0} ${action}`);
  log(`  skipped (non-matching): 0`);
  log(`TOTAL: ${matched.length} found, ${opts.apply ? updated : 0} ${action}`);

  if (opts.verbose) {
    for (const r of matched) {
      log(`  [id=${r.id}] topic=${r.topic} status=${r.status} fact=${r.fact.slice(0, 80)}`);
    }
  }

  return {
    found: matched.length,
    updated: opts.apply ? updated : 0,
    matched,
  };
}

function main(argv: ReadonlyArray<string>): number {
  const parsed = parseArgs(argv);
  if (!parsed) {
    console.error('Usage: purge-qmyc-alias-conflict.ts --db-path <path> [--apply] [--verbose]');
    return 2;
  }
  const db = new DatabaseSync(parsed.dbPath);
  try {
    runPurge({ db, apply: parsed.apply, verbose: parsed.verbose });
    return 0;
  } catch (err) {
    console.error('Runtime error:', err);
    return 1;
  } finally {
    db.close();
  }
}

// Only auto-run when executed directly. Mirrors purge-vulgar-phrase-facts.ts.
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
