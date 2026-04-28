#!/usr/bin/env tsx
/**
 * R6 maintenance: purge bot-self historical corpus contamination.
 *
 * Tables audited:
 *   - groupmate_expression_samples — LENIENT: rejected=1 only when bot is SOLE speaker
 *   - meme_graph — status='demoted' when origin_user_id == botUserId
 *   - jargon_candidates — rejected=1 when all rich contexts have user_id == botUserId
 *   - phrase_candidates — DEFERRED to Phase 2 (contexts shape unreliable)
 *
 * **STOP THE BOT BEFORE --apply** — per feedback_db_writer_lock_with_live_bot.md
 * SQLite write contention against a live bot causes disk I/O lock failures
 * that pm2 does not detect (process stays "online" but unresponsive).
 *
 * Usage:
 *   npx tsx scripts/maintenance/purge-bot-self-corpus.ts \
 *     --db-path data/bot.db --bot-qq 1705075399 [--group-id 958751334] [--apply]
 *
 * Default is dry-run. --apply opens DB read-write inside a transaction.
 * Exits: 0 success, 1 runtime, 2 missing required arg.
 */
import { DatabaseSync } from 'node:sqlite';

interface Args {
  dbPath: string;
  botQq: string;
  apply: boolean;
  groupId: string | null;
}

interface AuditResult {
  table: string;
  found: number;
  updated: number;
  skipped?: string;
}

function parseArgs(argv: ReadonlyArray<string>): Args | null {
  const args = [...argv];
  const get = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1]! : null;
  };
  const dbPath = get('--db-path');
  const botQq = get('--bot-qq') ?? process.env['BOT_QQ_ID'] ?? null;
  const groupId = get('--group-id');
  const apply = args.includes('--apply');
  if (!dbPath || !botQq) return null;
  return { dbPath, botQq, apply, groupId };
}

function printBotStopWarning(apply: boolean): void {
  if (!apply) return;
  console.log('==================================================================');
  console.log(' WARNING: --apply mode writes to bot.db. Stop the live bot first:');
  console.log('   pm2 stop qq-bot');
  console.log(' Concurrent writes cause SQLite I/O lock; pm2 will NOT detect the');
  console.log(' resulting bot hang. See feedback_db_writer_lock_with_live_bot.md.');
  console.log('==================================================================');
}

// LENIENT: sole-speaker check requires JSON parsing — LIKE '%"<bot>"%' would
// match mixed rows too. Iterate rejected=0 rows in JS.
function isSoleBotSpeaker(rawSpeakers: string, botQq: string): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(rawSpeakers); } catch { return false; }
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  for (const id of parsed) {
    if (id !== botQq) return false;
  }
  return true; // every speaker is the bot (typically length=1, but tolerate dupes like [bot, bot])
}

function auditGroupmateExpressions(
  db: DatabaseSync, botQq: string, groupId: string | null, apply: boolean,
): AuditResult {
  const groupClause = groupId ? 'AND group_id = ?' : '';
  const params: unknown[] = [];
  if (groupId) params.push(groupId);
  const rows = db.prepare(
    `SELECT id, speaker_user_ids FROM groupmate_expression_samples
     WHERE rejected = 0 ${groupClause}`,
  ).all(...params) as { id: number; speaker_user_ids: string }[];

  const targets = rows.filter(r => isSoleBotSpeaker(r.speaker_user_ids, botQq));
  const found = targets.length;
  let updated = 0;
  if (apply && found > 0) {
    const upd = db.prepare(
      `UPDATE groupmate_expression_samples
       SET rejected = 1, modified_by = 'bot-self-purge'
       WHERE id = ? AND rejected = 0`,
    );
    db.exec('BEGIN');
    try {
      for (const r of targets) {
        const info = upd.run(r.id) as { changes: number };
        updated += info.changes;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return { table: 'groupmate_expression_samples', found, updated };
}

function auditMemeGraph(
  db: DatabaseSync, botQq: string, groupId: string | null, apply: boolean,
): AuditResult {
  const groupClause = groupId ? 'AND group_id = ?' : '';
  const params: unknown[] = [botQq];
  if (groupId) params.push(groupId);
  const found = (db.prepare(
    `SELECT COUNT(*) AS c FROM meme_graph
     WHERE status IN ('active','manual_edit') AND origin_user_id = ? ${groupClause}`,
  ).get(...params) as { c: number }).c;

  let updated = 0;
  if (apply && found > 0) {
    const nowSec = Math.floor(Date.now() / 1000);
    const updParams = [nowSec, ...params];
    const r = db.prepare(
      `UPDATE meme_graph
       SET status = 'demoted', updated_at = ?
       WHERE status IN ('active','manual_edit') AND origin_user_id = ? ${groupClause}`,
    ).run(...updParams) as { changes: number };
    updated = r.changes;
  }
  return { table: 'meme_graph', found, updated };
}

interface JargonContext { user_id?: unknown; content?: unknown }

function rowIsAllBotJargon(rawContexts: string, botQq: string): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(rawContexts); } catch { return false; }
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  // STRICT: every context must be a rich object with user_id === botQq.
  // Legacy string-only contexts (no user_id) cannot be confirmed bot-source → skip.
  for (const c of parsed) {
    if (typeof c !== 'object' || c === null) return false;
    const ctx = c as JargonContext;
    if (!('user_id' in ctx) || ctx.user_id !== botQq) return false;
  }
  return true;
}

function auditJargonCandidates(
  db: DatabaseSync, botQq: string, groupId: string | null, apply: boolean,
): AuditResult {
  const groupClause = groupId ? 'AND group_id = ?' : '';
  const params: unknown[] = [];
  if (groupId) params.push(groupId);
  const rows = db.prepare(
    `SELECT group_id, content, contexts FROM jargon_candidates
     WHERE rejected = 0 ${groupClause}`,
  ).all(...params) as { group_id: string; content: string; contexts: string }[];

  const targets = rows.filter(r => rowIsAllBotJargon(r.contexts, botQq));
  const found = targets.length;
  let updated = 0;
  if (apply && found > 0) {
    const upd = db.prepare(
      `UPDATE jargon_candidates SET rejected = 1, updated_at = ?
       WHERE group_id = ? AND content = ? AND rejected = 0`,
    );
    const nowSec = Math.floor(Date.now() / 1000);
    db.exec('BEGIN');
    try {
      for (const r of targets) {
        const info = upd.run(nowSec, r.group_id, r.content) as { changes: number };
        updated += info.changes;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return { table: 'jargon_candidates', found, updated };
}

function auditPhraseCandidatesDeferred(): AuditResult {
  return {
    table: 'phrase_candidates',
    found: 0,
    updated: 0,
    skipped: 'DEFERRED Phase 2 — contexts is string[] without user_id; reliable bot-source detection requires walk-back via messages content LIKE-match (fragile). Infrastructure (rejected col + read-path filter) is in place.',
  };
}

export function runPurge(
  db: DatabaseSync, botQq: string, groupId: string | null, apply: boolean,
): AuditResult[] {
  return [
    auditGroupmateExpressions(db, botQq, groupId, apply),
    auditMemeGraph(db, botQq, groupId, apply),
    auditJargonCandidates(db, botQq, groupId, apply),
    auditPhraseCandidatesDeferred(),
  ];
}

function main(argv: ReadonlyArray<string>): number {
  const parsed = parseArgs(argv);
  if (!parsed) {
    console.error('Usage: purge-bot-self-corpus.ts --db-path <path> --bot-qq <id> [--group-id <id>] [--apply]');
    return 2;
  }
  printBotStopWarning(parsed.apply);
  const db = new DatabaseSync(parsed.dbPath);
  try {
    const results = runPurge(db, parsed.botQq, parsed.groupId, parsed.apply);
    const action = parsed.apply ? 'updated' : 'would update';
    const heading = parsed.apply ? 'APPLIED' : 'DRY RUN';
    console.log(`\n[${heading}] bot-self corpus purge — bot_qq=${parsed.botQq}${parsed.groupId ? ` group=${parsed.groupId}` : ''}`);
    for (const r of results) {
      if (r.skipped) {
        console.log(`  ${r.table}: SKIPPED — ${r.skipped}`);
      } else {
        console.log(`  ${r.table}: ${r.found} found, ${r.updated} ${action}`);
      }
    }
    console.log('  expression_patterns: SKIPPED (no source attribution)');
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

if (invokedDirectly) process.exit(main(process.argv.slice(2)));
