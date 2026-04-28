#!/usr/bin/env tsx
/**
 * One-shot maintenance — supersede 45 misclassified `群友别名` rows in
 * `learned_facts`, hand-curated by user audit on 2026-04-28.
 *
 * The LLM-driven alias classifier conflated five pattern families with
 * genuine per-member QQ nicknames:
 *   1. 声优 / Vocaloid / 角色名 (e.g. 洛天依, 钉宫, 山新)
 *   2. Internet meme / phonetic shorthand (e.g. 艾斯比, hyw, nsy, ylg)
 *   3. Domain jargon (e.g. a380, 龙矛, 太极村正)
 *   4. Same-alias multi-row noise (keep canonical MIN(id), retire rest)
 *   5. Fact text self-declares "not an alias"
 *
 * Action: each id in SUPERSEDE_IDS that is currently
 *   status='active' AND topic LIKE '群友别名%'
 * is flipped to status='superseded' with updated_at = now() seconds.
 *
 * SAFETY RAILS:
 *   1. SUPERSEDE_IDS is a frozen 45-item ReadonlyArray<number> — no SQL widens scope
 *   2. Per-row defensive SELECT classifies each id before UPDATE for skip-log
 *   3. UPDATE WHERE carries belt-and-suspenders guards
 *      (AND status = 'active' AND topic LIKE '群友别名%')
 *   4. Single BEGIN/COMMIT — partial commits prohibited; any error -> ROLLBACK
 *   5. No DELETE — superseded rows remain auditable; learned_facts_au mirror in sync
 *
 * Usage:
 *   purge-alias-misclassifications.ts --db-path <path> [--apply] [--verbose] [--limit N]
 *
 * Default is DRY RUN. Pass --apply to persist. --limit defaults to 100
 * (45-item list); if candidates > limit the script throws (caught -> exit 1).
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

// Curated by user audit 2026-04-28 — 45 rows confirmed misclassified.
// Order within each bin preserves the user's audit walk-order from the planner
// spec § Hardcoded SUPERSEDE_IDS. Term annotations are best-effort hints from
// planner § Why; ids whose precise term is not enumerated by the planner are
// grouped under "Other / mixed" rather than guessed.
const SUPERSEDE_IDS: ReadonlyArray<number> = [
  // --- 声优 / Vocaloid / 角色名 misread as QQ alias ---
  46,    // 洛天依 (Vocaloid character)
  530,   // 钉宫 (voice actress 钉宫理恵)
  544,   // 山新 (voice actor)

  // --- Internet meme / phonetic shorthand ---
  66,    // 艾斯比 (SB euphemism)

  // --- Domain jargon / specialized terms ---
  159,   // a380 (aircraft model)

  // --- Other / mixed (audit-confirmed but term not enumerated by planner spec) ---
  872,
  158,
  418,
  529,
  543,
  472,
  729,
  789,
  473,
  675,
  44,
  674,
  295,
  419,
  654,
  670,
  639,
  656,
  676,
  45,
  53,
  673,
  655,
  560,
  671,
  672,
  733,
  788,
  790,
  559,
  67,
  68,
  732,
  532,
  638,
  730,
  731,
  734,
  735,
  791,
] as const;

if (SUPERSEDE_IDS.length !== 45) {
  throw new Error(`SUPERSEDE_IDS must have exactly 45 ids, got ${SUPERSEDE_IDS.length}`);
}
if (new Set(SUPERSEDE_IDS).size !== 45) {
  throw new Error('SUPERSEDE_IDS contains duplicates');
}

const TOPIC_PREFIX = '群友别名';

interface CandidateRow {
  id: number;
  topic: string | null;
  status: string;
  fact: string;
}

const SELECT_ONE_SQL = `
  SELECT id, topic, status, fact
    FROM learned_facts
   WHERE id = ?
`;

const UPDATE_SQL = `
  UPDATE learned_facts
     SET status = 'superseded', updated_at = ?
   WHERE id = ?
     AND status = 'active'
     AND topic LIKE '群友别名%'
`;

type Action =
  | 'superseded'
  | 'skipped-already-superseded'
  | 'skipped-wrong-topic'
  | 'skipped-nonexistent';

interface RowDecision {
  id: number;
  topic: string | null;
  factPreview: string;
  action: Action;
}

function classifyRow(db: DatabaseSync, id: number): RowDecision {
  const row = db.prepare(SELECT_ONE_SQL).get(id) as
    | { id: number | bigint; topic: string | null; status: string; fact: string }
    | undefined;

  if (!row) {
    return { id, topic: null, factPreview: '', action: 'skipped-nonexistent' };
  }

  const topic = row.topic;
  const factPreview = (row.fact ?? '').slice(0, 60);

  if (row.status === 'superseded') {
    return { id, topic, factPreview, action: 'skipped-already-superseded' };
  }
  if (!topic || !topic.startsWith(TOPIC_PREFIX)) {
    return { id, topic, factPreview, action: 'skipped-wrong-topic' };
  }
  return { id, topic, factPreview, action: 'superseded' };
}

function applySupersede(
  db: DatabaseSync,
  eligibleIds: ReadonlyArray<number>,
  nowSec: number,
): number {
  if (eligibleIds.length === 0) return 0;
  const upd = db.prepare(UPDATE_SQL);
  db.exec('BEGIN');
  try {
    let updated = 0;
    for (const id of eligibleIds) {
      const info = upd.run(nowSec, id);
      const changes = typeof info.changes === 'bigint' ? Number(info.changes) : info.changes;
      if (changes === 1) {
        updated += 1;
      } else {
        throw new Error(
          `UPDATE for id=${id} affected ${changes} rows; expected 1. ` +
          `Belt-and-suspenders WHERE rejected the row after classifyRow approved it — ` +
          `concurrent writer suspected. Rolling back.`,
        );
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
  totalPlanned: number;
  eligible: number;
  applied: number;
  skippedAlreadySuperseded: number;
  skippedWrongTopic: number;
  skippedNonexistent: number;
  decisions: ReadonlyArray<RowDecision>;
}

export function runPurge(opts: {
  db: DatabaseSync;
  apply: boolean;
  verbose: boolean;
  log?: (line: string) => void;
  limit?: number;
  now?: () => number;
}): PurgeResult {
  const log = opts.log ?? ((line: string) => console.log(line));
  const nowSec = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const limit = opts.limit ?? 100;

  const decisions: RowDecision[] = SUPERSEDE_IDS.map((id) => classifyRow(opts.db, id));

  const eligibleIds = decisions
    .filter((d) => d.action === 'superseded')
    .map((d) => d.id);
  const skippedAlreadySuperseded = decisions.filter((d) => d.action === 'skipped-already-superseded').length;
  const skippedWrongTopic = decisions.filter((d) => d.action === 'skipped-wrong-topic').length;
  const skippedNonexistent = decisions.filter((d) => d.action === 'skipped-nonexistent').length;

  if (eligibleIds.length > limit) {
    throw new Error(
      `Refusing to supersede ${eligibleIds.length} rows - exceeds --limit ${limit}`,
    );
  }

  const shouldLogRows = opts.verbose || opts.apply;
  const header = opts.apply
    ? `Apply mode — superseding ${eligibleIds.length} of ${SUPERSEDE_IDS.length} candidates`
    : `[DRY RUN] Would supersede ${eligibleIds.length} of ${SUPERSEDE_IDS.length} candidates`;
  log(header);

  if (shouldLogRows) {
    for (const d of decisions) {
      log(`  ${d.id} | ${d.topic ?? '<null>'} | ${d.factPreview} | ${d.action}`);
    }
  }

  const applied = opts.apply ? applySupersede(opts.db, eligibleIds, nowSec) : 0;

  log(
    `TOTAL: ${applied} superseded / ` +
    `${skippedAlreadySuperseded} already-superseded / ` +
    `${skippedWrongTopic} wrong-topic / ` +
    `${skippedNonexistent} nonexistent ` +
    `(planned=${SUPERSEDE_IDS.length}, eligible=${eligibleIds.length})`,
  );

  return {
    totalPlanned: SUPERSEDE_IDS.length,
    eligible: eligibleIds.length,
    applied,
    skippedAlreadySuperseded,
    skippedWrongTopic,
    skippedNonexistent,
    decisions,
  };
}

function main(argv: ReadonlyArray<string>): number {
  const parsed = parseArgs(argv);
  if (!parsed) {
    console.error(
      'Usage: purge-alias-misclassifications.ts --db-path <path> [--apply] [--verbose] [--limit N]',
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

export { parseArgs };
export type { Args, CandidateRow, Action, RowDecision };
