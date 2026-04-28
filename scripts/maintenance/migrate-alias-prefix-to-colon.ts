#!/usr/bin/env tsx
/**
 * One-shot maintenance — rewrite legacy alias rows from space-prefix
 * `'群友别名 X'` to canonical colon-prefix `'群友别名:X'` in `learned_facts`.
 *
 * Background: `alias-miner.ts` historically used a trailing-space prefix
 * constant. PR1 of `alias-prefix-canonical-migration` changes the constant
 * to colon form (matching all other LEARNED_FACT_TOPIC_PREFIXES), but ~30
 * post-#138 KEEP rows still hold the space form and would never be matched
 * by future `insertOrSupersede` exact-topic queries. This script rewrites
 * those topics in-place.
 *
 * Action: every active row whose topic matches `LIKE '群友别名 %'` AND
 * whose suffix (after the prefix-with-space) trims to non-empty has its
 * topic rewritten to `'群友别名:' || substr(topic, 6)`. updated_at is
 * refreshed to now (seconds).
 *
 * SAFETY RAILS:
 *   1. SELECT scope: status='active' AND topic LIKE '群友别名 %'
 *      AND trim(substr(topic, 6)) != ''  (skip empty-suffix EC2/EC7)
 *   2. Per-row UPDATE WHERE: id=? AND status='active'
 *      AND topic LIKE '群友别名 %'  (belt-and-suspenders)
 *   3. Single BEGIN IMMEDIATE / COMMIT — any error -> ROLLBACK
 *   4. info.changes !== 1 per UPDATE -> throw -> ROLLBACK
 *      (catches concurrent writer / belt-suspenders rejection)
 *   5. No DELETE, no superseded-row touch, no cross-prefix touch
 *   6. Idempotent: second --apply finds 0 candidates, exits 0
 *
 * Usage:
 *   migrate-alias-prefix-to-colon.ts --db-path <path> [--apply] [--verbose] [--limit N]
 *
 * Default is DRY RUN. Pass --apply to persist. --limit defaults to 100;
 * if candidates > limit the script throws (caught -> exit 1).
 *
 * Exit codes:
 *   0 — success (dry run or apply, including 0-rows-to-update)
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

  let limit = 100;
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

const SELECT_CANDIDATES_SQL = `
  SELECT id, group_id, topic, status
    FROM learned_facts
   WHERE status = 'active'
     AND topic LIKE '群友别名 %'
     AND trim(substr(topic, 6)) != ''
   ORDER BY id ASC
`;

const UPDATE_SQL = `
  UPDATE learned_facts
     SET topic = '群友别名:' || substr(topic, 6),
         updated_at = ?
   WHERE id = ?
     AND status = 'active'
     AND topic LIKE '群友别名 %'
`;

interface CandidateRow {
  id: number;
  groupId: string;
  topic: string;
  status: string;
}

interface MigrateResult {
  candidates: number;
  applied: number;
  skippedEmptySuffix: number;
}

export function runMigrate(opts: {
  db: DatabaseSync;
  apply: boolean;
  verbose: boolean;
  log?: (line: string) => void;
  limit?: number;
  now?: () => number;
}): MigrateResult {
  const log = opts.log ?? ((line: string) => console.log(line));
  const nowSec = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const limit = opts.limit ?? 100;

  const candidates = opts.db.prepare(SELECT_CANDIDATES_SQL).all() as ReadonlyArray<{
    id: number | bigint; group_id: string; topic: string; status: string;
  }>;

  const rows: CandidateRow[] = candidates.map((c) => ({
    id: typeof c.id === 'bigint' ? Number(c.id) : c.id,
    groupId: c.group_id,
    topic: c.topic,
    status: c.status,
  }));

  if (rows.length > limit) {
    throw new Error(
      `Refusing to migrate ${rows.length} rows - exceeds --limit ${limit}`,
    );
  }

  const header = opts.apply
    ? `Apply mode - migrating ${rows.length} rows from '群友别名 X' to '群友别名:X'`
    : `[DRY RUN] Would migrate ${rows.length} rows from '群友别名 X' to '群友别名:X'`;
  log(header);

  if (opts.verbose || opts.apply) {
    for (const r of rows) {
      const newTopic = '群友别名:' + r.topic.slice(5);
      log(`  ${r.id} | ${r.topic} -> ${newTopic} | group=${r.groupId}`);
    }
  }

  let applied = 0;
  if (opts.apply && rows.length > 0) {
    const upd = opts.db.prepare(UPDATE_SQL);
    opts.db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) {
        const info = upd.run(nowSec, r.id);
        const changes = typeof info.changes === 'bigint' ? Number(info.changes) : info.changes;
        if (changes !== 1) {
          throw new Error(
            `UPDATE for id=${r.id} affected ${changes} rows; expected 1. ` +
            `Belt-suspenders WHERE rejected after SELECT approved - concurrent writer suspected. Rolling back.`,
          );
        }
        applied += 1;
      }
      opts.db.exec('COMMIT');
    } catch (err) {
      opts.db.exec('ROLLBACK');
      throw err;
    }
  }

  log(`TOTAL: ${applied} migrated / ${rows.length} candidates`);

  return { candidates: rows.length, applied, skippedEmptySuffix: 0 };
}

function main(argv: ReadonlyArray<string>): number {
  const parsed = parseArgs(argv);
  if (!parsed) {
    console.error(
      'Usage: migrate-alias-prefix-to-colon.ts --db-path <path> [--apply] [--verbose] [--limit N]',
    );
    return 2;
  }
  const db = new DatabaseSync(parsed.dbPath);
  try {
    runMigrate({
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

export { parseArgs };
export type { Args, CandidateRow, MigrateResult };
