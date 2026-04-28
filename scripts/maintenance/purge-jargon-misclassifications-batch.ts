#!/usr/bin/env tsx
/**
 * One-shot maintenance — PR3: supersede 99 user-curated 群内黑话
 * misclassifications (List 1) + the ~296-row 04-18 09:37 batch from
 * `opus-classifier-rest` (List 2) in `learned_facts`.
 *
 * List 1: hardcoded SUPERSEDE_IDS (99 entries) — user audit on 2026-04-28
 * confirmed each row is misclassified jargon; skip-and-warn if a row was
 * already migrated by PR1 (status != 'active' or wrong topic prefix).
 *
 * List 2: dynamic SELECT — every active row with
 *   created_at = 1776505050 AND source_user_nickname = 'opus-classifier-rest'
 * is the 2026-04-18 09:37 batch from the rest classifier; PR2-equivalent
 * data hygiene supersede.
 *
 * Both lists run inside a SINGLE BEGIN/COMMIT transaction — partial commits
 * are prohibited. The List 2 ID list is fetched OUTSIDE the transaction so
 * the runtime ID set is treated as immutable input to the write phase.
 *
 * SAFETY RAILS:
 *   1. SUPERSEDE_IDS is a frozen 99-item ReadonlyArray<number> — module-load
 *      asserts catch length / dedup / KEEP-overlap regressions at import time
 *   2. KEEP_IDS [3763, 3971, 3972] are checked against SUPERSEDE_IDS at load
 *   3. List 1 uses topic-prefix narrow ('群内黑话'); List 2 uses status-only
 *      (its scope is enforced by the SELECT criteria)
 *   4. UPDATE WHERE carries belt-and-suspenders `AND status = 'active'`
 *   5. Single BEGIN/COMMIT — any error -> ROLLBACK; limit guard runs before BEGIN
 *   6. No DELETE — superseded rows remain auditable
 *
 * Usage:
 *   purge-jargon-misclassifications-batch.ts --db-path <path> [--apply] [--verbose] [--limit N]
 *
 * Default is DRY RUN. Pass --apply to persist. --limit defaults to 500.
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

  let limit = 500;
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

// LIST 1 — verbatim 99 IDs from planner spec § Hardcoded SUPERSEDE_IDS lines 37-46.
// Order preserved exactly; no reordering, no per-id annotation.
const SUPERSEDE_IDS: ReadonlyArray<number> = [
  3070, 3100, 3132, 3133, 3168, 3176, 3200, 3208, 3233, 3250,
  3263, 3266, 3303, 3305, 3306, 3403, 3456, 3577, 3599, 3661,
  3673, 3693, 3694, 3713, 3714, 3722, 3723, 3727, 3742, 3747,
  3750, 3751, 3753, 3754, 3774, 3846, 3847, 3860, 3874, 3886,
  3887, 3893, 3906, 3909, 3911, 3913, 3931, 3950, 3951, 3955,
  3967, 3974, 3979, 3980, 3984, 4001, 4038, 4049, 4076, 4090,
  4094, 4098, 4103, 4107, 4197, 4271, 4272, 4274, 4297, 4298,
  4300, 4333, 4336, 4337, 4338, 4341, 4342, 4353, 4357, 4359,
  4374, 4376, 4379, 4399, 4402, 4423, 4428, 4453, 4456, 4533,
  4534, 4538, 4539, 4541, 4550, 4553, 4555, 9011, 11163,
] as const;

// KEEP — these IDs were considered for the supersede walk but the user
// confirmed they are legitimate jargon entries; they MUST NEVER appear in
// SUPERSEDE_IDS (planner Must-NOT-fire #8).
const KEEP_IDS: ReadonlyArray<number> = [3763, 3971, 3972] as const;

if (SUPERSEDE_IDS.length !== 99) {
  throw new Error(`SUPERSEDE_IDS must have exactly 99 ids, got ${SUPERSEDE_IDS.length}`);
}
if (new Set(SUPERSEDE_IDS).size !== 99) {
  throw new Error('SUPERSEDE_IDS contains duplicates');
}
for (const keepId of KEEP_IDS) {
  if (SUPERSEDE_IDS.includes(keepId)) {
    throw new Error(`KEEP id ${keepId} must NOT appear in SUPERSEDE_IDS`);
  }
}

// LIST 2 batch scope — verified by Designer §A against prod (296 rows).
const LIST2_BATCH_CREATED_AT = 1776505050;
const LIST2_BATCH_SOURCE = 'opus-classifier-rest';

// List 1 only — topic-prefix narrow.
const LIST1_TOPIC_PREFIX = '群内黑话';

const SELECT_ONE_SQL = `
  SELECT id, topic, status, fact
    FROM learned_facts
   WHERE id = ?
`;

const SELECT_LIST2_IDS_SQL = `
  SELECT id, topic, status, fact
    FROM learned_facts
   WHERE created_at = 1776505050
     AND source_user_nickname = 'opus-classifier-rest'
     AND status = 'active'
   ORDER BY id
`;

const UPDATE_SQL = `
  UPDATE learned_facts
     SET status = 'superseded', updated_at = ?
   WHERE id = ?
     AND status = 'active'
`;

type Action =
  | 'superseded'
  | 'skipped-already-superseded'
  | 'skipped-wrong-topic'
  | 'skipped-nonexistent';

type RowList = 'list1' | 'list2';

interface RowDecision {
  id: number;
  list: RowList;
  topic: string | null;
  factPreview: string;
  action: Action;
}

function fetchList2Ids(db: DatabaseSync): ReadonlyArray<number> {
  const rows = db.prepare(SELECT_LIST2_IDS_SQL).all() as ReadonlyArray<{ id: number | bigint }>;
  return rows.map((r) => (typeof r.id === 'bigint' ? Number(r.id) : r.id));
}

function classifyList1Row(db: DatabaseSync, id: number): RowDecision {
  const row = db.prepare(SELECT_ONE_SQL).get(id) as
    | { id: number | bigint; topic: string | null; status: string; fact: string }
    | undefined;

  if (!row) {
    return { id, list: 'list1', topic: null, factPreview: '', action: 'skipped-nonexistent' };
  }
  const topic = row.topic;
  const factPreview = (row.fact ?? '').slice(0, 60);
  if (row.status === 'superseded') {
    return { id, list: 'list1', topic, factPreview, action: 'skipped-already-superseded' };
  }
  if (!topic || !topic.startsWith(LIST1_TOPIC_PREFIX)) {
    return { id, list: 'list1', topic, factPreview, action: 'skipped-wrong-topic' };
  }
  return { id, list: 'list1', topic, factPreview, action: 'superseded' };
}

function classifyList2Row(db: DatabaseSync, id: number): RowDecision {
  const row = db.prepare(SELECT_ONE_SQL).get(id) as
    | { id: number | bigint; topic: string | null; status: string; fact: string }
    | undefined;

  if (!row) {
    // Race: row vanished between fetchList2Ids and re-classify.
    return { id, list: 'list2', topic: null, factPreview: '', action: 'skipped-nonexistent' };
  }
  const topic = row.topic;
  const factPreview = (row.fact ?? '').slice(0, 60);
  if (row.status !== 'active') {
    return { id, list: 'list2', topic, factPreview, action: 'skipped-already-superseded' };
  }
  return { id, list: 'list2', topic, factPreview, action: 'superseded' };
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
          `Belt-and-suspenders WHERE rejected the row after classify approved it — ` +
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
  list1Applied: number;
  list2Applied: number;
  list2Fetched: number;
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
  const limit = opts.limit ?? 500;

  // Phase 1: pre-fetch List 2 IDs OUTSIDE the transaction.
  const list2Ids = fetchList2Ids(opts.db);

  // Phase 2: classify both lists.
  const decisions1: RowDecision[] = SUPERSEDE_IDS.map((id) => classifyList1Row(opts.db, id));
  const decisions2: RowDecision[] = list2Ids.map((id) => classifyList2Row(opts.db, id));
  const decisions: RowDecision[] = [...decisions1, ...decisions2];

  const eligible1Ids = decisions1.filter((d) => d.action === 'superseded').map((d) => d.id);
  const eligible2Ids = decisions2.filter((d) => d.action === 'superseded').map((d) => d.id);
  const combinedEligibleIds = [...eligible1Ids, ...eligible2Ids];

  const skippedAlreadySuperseded = decisions.filter((d) => d.action === 'skipped-already-superseded').length;
  const skippedWrongTopic = decisions.filter((d) => d.action === 'skipped-wrong-topic').length;
  const skippedNonexistent = decisions.filter((d) => d.action === 'skipped-nonexistent').length;

  // Phase 3: limit guard — BEFORE any transaction begins.
  if (combinedEligibleIds.length > limit) {
    throw new Error(
      `Refusing to supersede ${combinedEligibleIds.length} rows - exceeds --limit ${limit}`,
    );
  }

  // Phase 4: header log.
  const header = opts.apply
    ? `Apply mode — superseding ${combinedEligibleIds.length} rows ` +
      `(List1=${eligible1Ids.length}, List2=${eligible2Ids.length}) ` +
      `of ${SUPERSEDE_IDS.length + list2Ids.length} candidates`
    : `[DRY RUN] Would supersede ${combinedEligibleIds.length} rows ` +
      `(List1=${eligible1Ids.length}, List2=${eligible2Ids.length}) ` +
      `of ${SUPERSEDE_IDS.length + list2Ids.length} candidates`;
  log(header);

  if (opts.verbose || opts.apply) {
    for (const d of decisions) {
      const tag = d.list === 'list1' ? '[LIST1]' : '[LIST2]';
      log(`  ${tag} ${d.id} | ${d.topic ?? '<null>'} | ${d.factPreview} | ${d.action}`);
    }
  }

  // Phase 5: single transaction over BOTH lists.
  const applied = opts.apply ? applySupersede(opts.db, combinedEligibleIds, nowSec) : 0;
  const list1Applied = opts.apply ? eligible1Ids.length : 0;
  const list2Applied = opts.apply ? eligible2Ids.length : 0;

  log(
    `TOTAL: ${applied} superseded ` +
    `(List1=${list1Applied}, List2=${list2Applied}) / ` +
    `${skippedAlreadySuperseded} already-superseded / ` +
    `${skippedWrongTopic} wrong-topic / ` +
    `${skippedNonexistent} nonexistent ` +
    `(planned=${SUPERSEDE_IDS.length}+${list2Ids.length}, eligible=${combinedEligibleIds.length})`,
  );
  log(`       KEEP rows [${KEEP_IDS.join(',')}]: verified NOT in supersede path`);

  return {
    totalPlanned: SUPERSEDE_IDS.length + list2Ids.length,
    eligible: combinedEligibleIds.length,
    applied,
    list1Applied,
    list2Applied,
    list2Fetched: list2Ids.length,
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
      'Usage: purge-jargon-misclassifications-batch.ts --db-path <path> [--apply] [--verbose] [--limit N]',
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
export type { Args, Action, RowDecision, RowList };
