#!/usr/bin/env tsx
/**
 * R2.5.1 Item 5 — purge social-phrase learned_facts.
 *
 * Flips rows in `learned_facts` whose `topic` is one of the slang-classifier
 * prefixes (`opus-classified:slang:%` / `opus-rest-classified:slang:%`) AND
 * whose `canonical` is an exact social-phrase (see `isSocialPhrase`) to
 * `status='rejected'`. No DELETE — the `learned_facts_au` trigger keeps the
 * paired FTS5 mirror in sync. Lore-topic rows (topic contains `lore:`) are
 * exempt — they are fandom-curated (e.g. 宝宝 in 958751334 lore).
 *
 * Usage:
 *   purge-social-phrase-facts.ts --db-path <path> [--apply] [--verbose]
 * Default is DRY RUN (reports only). Pass --apply to persist.
 *
 * Exit codes:
 *   0 — success (dry run or apply)
 *   1 — runtime error
 *   2 — bad args
 */
import { DatabaseSync } from 'node:sqlite';
import { isSocialPhrase } from '../../src/utils/social-phrase.js';
import { extractTermFromTopic } from '../../src/modules/fact-topic-prefixes.js';

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
 * Slang-classifier prefixes ONLY. Lore-topic rows filtered out via NOT LIKE.
 * The social-phrase canonical lives in the topic suffix (e.g.
 * `opus-classified:slang:贴贴`) — `learned_facts` has no dedicated canonical
 * column. `extractTermFromTopic` is the canonical reader used at every
 * read/write boundary.
 */
const SELECT_SQL = `
  SELECT id, topic, fact, status
    FROM learned_facts
   WHERE status != 'rejected'
     AND (topic LIKE 'opus-classified:slang:%' ESCAPE '!'
       OR topic LIKE 'opus-rest-classified:slang:%' ESCAPE '!')
     AND topic NOT LIKE '%lore:%' ESCAPE '!'
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
  skippedLoreCount: number;
  skippedNonSocialCount: number;
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

  const candidates = findCandidateRows(opts.db);

  const matched: Row[] = [];
  let skippedNonSocial = 0;
  for (const r of candidates) {
    const term = extractTermFromTopic(r.topic);
    if (term !== null && isSocialPhrase(term)) {
      matched.push(r);
    } else {
      skippedNonSocial++;
    }
  }

  // Separately count lore-exempt rows for reporting (SELECT already filtered
  // them, but we re-count via a wider SELECT so the operator sees what the
  // filter skipped). Cheap — single COUNT(*) roundtrip.
  const loreSkipped = (
    opts.db.prepare(
      `SELECT COUNT(*) AS n FROM learned_facts
        WHERE status != 'rejected'
          AND (topic LIKE 'opus-classified:slang:%' ESCAPE '!'
            OR topic LIKE 'opus-rest-classified:slang:%' ESCAPE '!')
          AND topic LIKE '%lore:%' ESCAPE '!'`,
    ).get() as { n: number }
  ).n;

  const ids = matched.map(r => r.id);
  const updated = opts.apply ? applyReject(opts.db, ids, nowSec) : 0;
  const action = opts.apply ? 'updated' : 'would update';
  const heading = opts.apply ? 'Rows updated:' : '[DRY RUN] Rows that would be updated:';

  log(heading);
  log(`  learned_facts social-phrase slang rows: ${matched.length} found, ${opts.apply ? updated : 0} ${action}`);
  log(`  skipped (lore-topic exempt): ${loreSkipped}`);
  log(`  skipped (non-social canonical): ${skippedNonSocial}`);
  log(`TOTAL: ${matched.length} found, ${opts.apply ? updated : 0} ${action}`);

  if (opts.verbose) {
    for (const r of matched) {
      log(`  [id=${r.id}] topic=${r.topic} term=${extractTermFromTopic(r.topic) ?? '(null)'} status=${r.status} fact=${r.fact.slice(0, 80)}`);
    }
  }

  return {
    found: matched.length,
    updated: opts.apply ? updated : 0,
    skippedLoreCount: loreSkipped,
    skippedNonSocialCount: skippedNonSocial,
    matched,
  };
}

function main(argv: ReadonlyArray<string>): number {
  const parsed = parseArgs(argv);
  if (!parsed) {
    console.error('Usage: purge-social-phrase-facts.ts --db-path <path> [--apply] [--verbose]');
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

// Only auto-run when executed directly. Mirrors purge-bot-output-phrases.ts.
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
