#!/usr/bin/env tsx
/**
 * PR3 purge: flip `learned_facts` rows where `source_user_id` matches the bot's
 * own QQ id to `status='rejected'`. Conservative — only touches `learned_facts`
 * (sole table with a precise scalar bot-source field). Never executes `DELETE`;
 * the `learned_facts_au` trigger auto-syncs the paired FTS5 virtual table.
 *
 * Tables lacking a precise bot-source field (jargon_candidates, phrase_candidates,
 * meme_graph, groupmate_expression_samples) are logged as skipped — not guessed.
 *
 * Usage:
 *   purge-bot-output-phrases.ts --db-path <path> [--bot-user-id <id>] [--apply] [--verbose]
 *
 * Env fallback: BOT_QQ_ID. Exits with code 2 if neither arg nor env is set
 * (fail-closed — without a bot id we can't distinguish bot rows from user rows).
 */
import { DatabaseSync } from 'node:sqlite';

interface Args {
  dbPath: string;
  botUserId: string;
  apply: boolean;
  verbose: boolean;
}

const SKIPPED_TABLES: ReadonlyArray<string> = [
  'jargon_candidates (contexts JSON only — no scalar bot-source field)',
  'phrase_candidates (no user_id column)',
  'meme_graph (origin_user_id is incidental, not bot-only provenance)',
  'groupmate_expression_samples (speaker_user_ids is JSON array, no per-row bot-only flag)',
];

function parseArgs(argv: ReadonlyArray<string>): Args | null {
  const args = [...argv];
  const dbPathIdx = args.indexOf('--db-path');
  const botIdIdx = args.indexOf('--bot-user-id');
  const apply = args.includes('--apply');
  const verbose = args.includes('--verbose');

  if (dbPathIdx === -1 || !args[dbPathIdx + 1]) return null;
  const dbPath = args[dbPathIdx + 1]!;

  let botUserId: string | undefined;
  if (botIdIdx !== -1 && args[botIdIdx + 1]) {
    botUserId = args[botIdIdx + 1]!;
  } else if (process.env['BOT_QQ_ID']) {
    botUserId = process.env['BOT_QQ_ID'];
  }
  if (!botUserId) return null;

  return { dbPath, botUserId, apply, verbose };
}

interface Row { id: number; topic: string | null; fact: string; status: string }

function findBotRows(db: DatabaseSync, botUserId: string): Row[] {
  return db.prepare(
    "SELECT id, topic, fact, status FROM learned_facts WHERE source_user_id = ? AND status != 'rejected'",
  ).all(botUserId) as unknown as Row[];
}

function applyReject(db: DatabaseSync, ids: ReadonlyArray<number>, nowSec: number): number {
  if (ids.length === 0) return 0;
  const upd = db.prepare("UPDATE learned_facts SET status = 'rejected', updated_at = ? WHERE id = ?");
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

export function runPurge(opts: {
  db: DatabaseSync;
  botUserId: string;
  apply: boolean;
  verbose: boolean;
  log?: (line: string) => void;
  now?: () => number;
}): { found: number; updated: number; rows: Row[] } {
  const log = opts.log ?? ((line: string) => console.log(line));
  const nowSec = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const rows = findBotRows(opts.db, opts.botUserId);
  const found = rows.length;
  const updated = opts.apply ? applyReject(opts.db, rows.map(r => r.id), nowSec) : 0;
  const action = opts.apply ? 'updated' : 'would update';
  const heading = opts.apply ? 'Rows updated:' : '[DRY RUN] Rows that would be updated:';

  log(heading);
  log(`  learned_facts (source_user_id = '${opts.botUserId}'): ${found} found, ${opts.apply ? updated : 0} ${action}`);
  log('Skipped tables:');
  for (const t of SKIPPED_TABLES) {
    log(`  skipped: ${t}`);
  }
  log(`TOTAL: ${found} found, ${opts.apply ? updated : 0} ${action}`);

  if (opts.verbose) {
    for (const r of rows) {
      log(`  [id=${r.id}] topic=${r.topic ?? '(null)'} status=${r.status} fact=${r.fact.slice(0, 80)}`);
    }
  }

  return { found, updated, rows };
}

function main(argv: ReadonlyArray<string>): number {
  const parsed = parseArgs(argv);
  if (!parsed) {
    console.error(
      'Usage: purge-bot-output-phrases.ts --db-path <path> --bot-user-id <id> [--apply] [--verbose]',
    );
    console.error('(bot id may also be provided via BOT_QQ_ID env; exits 2 if neither set)');
    return 2;
  }
  const db = new DatabaseSync(parsed.dbPath);
  try {
    runPurge({
      db,
      botUserId: parsed.botUserId,
      apply: parsed.apply,
      verbose: parsed.verbose,
    });
    return 0;
  } catch (err) {
    console.error('Runtime error:', err);
    return 1;
  } finally {
    db.close();
  }
}

// Only auto-run when executed directly (not when imported by tests).
// Compare via URL to avoid Windows path / escape issues.
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
