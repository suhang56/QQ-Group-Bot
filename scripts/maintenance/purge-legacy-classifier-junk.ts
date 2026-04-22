#!/usr/bin/env tsx
/**
 * Cleanup — purge legacy classifier junk from `learned_facts`.
 *
 * Three disjoint targets (run independently or `--target all`):
 *
 *   T1 `opus-ext-classified:%`  — 467 active rows; writer retired, no runtime
 *                                 reader (grep clean in src/). Reject all.
 *   T2 `[harvest:%` / `[deep-tune:%` source_user_nickname — 909 active rows;
 *                                 batch-harvest artefacts. Alias-miner rows
 *                                 (`topic LIKE '群友别名%'`) are PRIMARY-guarded
 *                                 so the 16-row harvest∩alias overlap stays
 *                                 active; `source_user_nickname !=
 *                                 '[alias-miner]'` is kept as belt-and-
 *                                 suspenders. Lore-topic exempt.
 *   T3 `opus-classified:slang:%`  — 50 active rows; dedup + noise purge:
 *                                   3 lexical loser pairs + 2 known-noise
 *                                   terms rejected (5 total); 45 untouched.
 *                                   Hardcoded LEXICAL_KEEP_PAIRS +
 *                                   OPUS_SLANG_NOISE_LIST, no CLI args.
 *
 * UPDATE `status='rejected'` only — no DELETE. `learned_facts_au` trigger
 * keeps the FTS5 mirror in sync.
 *
 * Usage:
 *   purge-legacy-classifier-junk.ts --db-path <path> --target 1|2|3|all [--apply] [--verbose]
 * Default is DRY RUN. Pass --apply to persist.
 *
 * Exit codes:
 *   0 — success (dry run or apply)
 *   1 — runtime error
 *   2 — bad args
 */
import { DatabaseSync } from 'node:sqlite';

const T3_TOPIC_PREFIX = 'opus-classified:slang:';

/**
 * Raw suffix extraction for T3 only. Does NOT apply isValidStructuredTerm —
 * prod contains rows like `opus-classified:slang:哦耶` (contains 哦) and
 * `:到底是什么感觉` (contains 是什么) which the validator rejects as dirty-Han,
 * but which the dedup spec explicitly names as lexical winners. Those rows
 * are legitimate inventory that the purge must see and preserve.
 */
function rawSuffixForT3(topic: string): string | null {
  if (!topic.startsWith(T3_TOPIC_PREFIX)) return null;
  const suffix = topic.slice(T3_TOPIC_PREFIX.length);
  return suffix.length > 0 ? suffix : null;
}

export type TargetSelector = 1 | 2 | 3 | 'all';

export interface PurgeArgs {
  dbPath: string;
  target: TargetSelector;
  apply: boolean;
  verbose: boolean;
}

export interface Target1Result {
  found: number;
  updated: number;
  ids: ReadonlyArray<number>;
}

export interface Target2Result {
  found: number;
  updated: number;
  skippedAliasMiner: number;
  ids: ReadonlyArray<number>;
}

export interface Target3Row {
  id: number;
  topic: string;
  term: string;
}

export interface Target3Reject extends Target3Row {
  reason: 'dedup-loser' | 'noise';
}

export interface Target3Result {
  found: number;
  updated: number;
  kept: ReadonlyArray<Target3Row>;
  rejected: ReadonlyArray<Target3Reject>;
}

export interface PurgeResult {
  target1: Target1Result;
  target2: Target2Result;
  target3: Target3Result;
  totalFound: number;
  totalUpdated: number;
}

/**
 * Lexical winner map. Keys are LOSER terms; values are the WINNER term.
 * Purge rejects the key if the winner term also appears in the T3 SELECT
 * result (dedup-loser). Keep is identity-based on term; no case folding
 * (`NB` and `nb` are distinct rows, and both can appear).
 */
const LEXICAL_WINNERS: ReadonlyMap<string, string> = new Map([
  ['nb', 'NB'],
  ['欧耶', '哦耶'],
  ['是什么感觉', '到底是什么感觉'],
]);

/** Terms that are always rejected from opus-classified:slang regardless of dedup. */
const OPUS_SLANG_NOISE_LIST: ReadonlySet<string> = new Set(['yes', '周六']);

const LEXICAL_WINNERS_VALUES: ReadonlySet<string> = new Set(LEXICAL_WINNERS.values());

interface IdRow {
  id: number;
}

interface T2Row {
  id: number;
  source_user_nickname: string | null;
  topic: string | null;
}

interface T3RawRow {
  id: number;
  topic: string;
  canonical_form: string | null;
  persona_form: string | null;
}

const SELECT_T1_SQL = `
  SELECT id FROM learned_facts
   WHERE status = 'active'
     AND topic LIKE 'opus-ext-classified:%' ESCAPE '!'
     AND topic NOT LIKE '%lore:%' ESCAPE '!'
`;

const SELECT_T2_SQL = `
  SELECT id, source_user_nickname, topic FROM learned_facts
   WHERE status = 'active'
     AND topic NOT LIKE '%lore:%' ESCAPE '!'
     AND topic NOT LIKE '群友别名%' ESCAPE '!'
     AND (source_user_nickname LIKE '[harvest:%' ESCAPE '!'
       OR source_user_nickname LIKE '[deep-tune:%' ESCAPE '!')
     AND source_user_nickname != '[alias-miner]'
`;

const SELECT_T3_SQL = `
  SELECT id, topic, canonical_form, persona_form FROM learned_facts
   WHERE status = 'active'
     AND topic LIKE 'opus-classified:slang:%' ESCAPE '!'
     AND topic NOT LIKE '%lore:%' ESCAPE '!'
`;

const UPDATE_SQL = "UPDATE learned_facts SET status = 'rejected', updated_at = ? WHERE id = ?";

function runT1(db: DatabaseSync): ReadonlyArray<number> {
  const rows = db.prepare(SELECT_T1_SQL).all() as unknown as IdRow[];
  return rows.map(r => r.id).sort((a, b) => a - b);
}

function runT2(db: DatabaseSync): { ids: ReadonlyArray<number>; skippedAliasMiner: number } {
  const rows = db.prepare(SELECT_T2_SQL).all() as unknown as T2Row[];
  // Belt-and-suspenders counter: SQL already filters [alias-miner] out, so this
  // should always read 0 on prod. Kept non-zero would surface a SQL regression.
  let skippedAliasMiner = 0;
  const ids: number[] = [];
  for (const r of rows) {
    if (r.source_user_nickname === '[alias-miner]') {
      skippedAliasMiner++;
      continue;
    }
    ids.push(r.id);
  }
  return { ids: ids.sort((a, b) => a - b), skippedAliasMiner };
}

function runT3(
  db: DatabaseSync,
): { kept: ReadonlyArray<Target3Row>; rejected: ReadonlyArray<Target3Reject>; found: number } {
  const rows = db.prepare(SELECT_T3_SQL).all() as unknown as T3RawRow[];

  const rowsWithTerm: Array<Target3Row> = [];
  for (const r of rows) {
    const term = rawSuffixForT3(r.topic);
    if (term === null) continue; // defensive — SELECT already filters by prefix
    rowsWithTerm.push({ id: r.id, topic: r.topic, term });
  }

  const termSet = new Set(rowsWithTerm.map(r => r.term));

  const kept: Target3Row[] = [];
  const rejected: Target3Reject[] = [];

  for (const row of rowsWithTerm) {
    if (OPUS_SLANG_NOISE_LIST.has(row.term)) {
      rejected.push({ ...row, reason: 'noise' });
      continue;
    }
    const winner = LEXICAL_WINNERS.get(row.term);
    if (winner !== undefined && termSet.has(winner)) {
      // Winner term also present → this row is the loser → reject.
      rejected.push({ ...row, reason: 'dedup-loser' });
      continue;
    }
    kept.push(row);
  }

  kept.sort((a, b) => a.id - b.id);
  rejected.sort((a, b) => a.id - b.id);

  return { kept, rejected, found: rows.length };
}

function applyUpdates(
  db: DatabaseSync,
  ids: ReadonlyArray<number>,
  nowSec: number,
): number {
  if (ids.length === 0) return 0;
  const upd = db.prepare(UPDATE_SQL);
  let updated = 0;
  for (const id of ids) {
    const info = upd.run(nowSec, id);
    if (typeof info.changes === 'bigint' ? info.changes > 0n : info.changes > 0) {
      updated += 1;
    }
  }
  return updated;
}

export function runPurge(opts: {
  db: DatabaseSync;
  target: TargetSelector;
  apply: boolean;
  verbose: boolean;
  log?: (line: string) => void;
  now?: () => number;
}): PurgeResult {
  const log = opts.log ?? ((line: string) => process.stderr.write(line + '\n'));
  const nowSec = Math.floor((opts.now?.() ?? Date.now()) / 1000);

  const doT1 = opts.target === 1 || opts.target === 'all';
  const doT2 = opts.target === 2 || opts.target === 'all';
  const doT3 = opts.target === 3 || opts.target === 'all';

  const t1Ids = doT1 ? runT1(opts.db) : [];
  const t2 = doT2 ? runT2(opts.db) : { ids: [], skippedAliasMiner: 0 };
  const t3 = doT3 ? runT3(opts.db) : { kept: [], rejected: [], found: 0 };

  const rejectIds: number[] = [
    ...t1Ids,
    ...t2.ids,
    ...t3.rejected.map(r => r.id),
  ];

  let t1Updated = 0;
  let t2Updated = 0;
  let t3Updated = 0;
  if (opts.apply && rejectIds.length > 0) {
    opts.db.exec('BEGIN');
    try {
      t1Updated = applyUpdates(opts.db, t1Ids, nowSec);
      t2Updated = applyUpdates(opts.db, t2.ids, nowSec);
      t3Updated = applyUpdates(opts.db, t3.rejected.map(r => r.id), nowSec);
      opts.db.exec('COMMIT');
    } catch (err) {
      opts.db.exec('ROLLBACK');
      throw err;
    }
  }

  const action = opts.apply ? 'updated' : 'would update';
  const heading = opts.apply ? 'Rows updated:' : '[DRY RUN] Rows that would be updated:';
  log(heading);
  if (doT1) {
    log(`  Target 1 (opus-ext-classified dead):     ${t1Ids.length} found, ${opts.apply ? t1Updated : 0} ${action}`);
  }
  if (doT2) {
    log(`  Target 2 (batch-harvest junk):           ${t2.ids.length} found, ${opts.apply ? t2Updated : 0} ${action}` +
        (t2.skippedAliasMiner > 0 ? ` (skipped [alias-miner]: ${t2.skippedAliasMiner})` : ''));
  }
  if (doT3) {
    log(`  Target 3 (opus-classified:slang dedup):  ${t3.found} found, ${opts.apply ? t3Updated : 0} ${action}`);
    if (t3.kept.length > 0 || t3.rejected.length > 0) {
      const keptTerms = t3.kept
        .filter(k => LEXICAL_WINNERS_VALUES.has(k.term))
        .map(k => k.term);
      const dedupLosers = t3.rejected
        .filter(r => r.reason === 'dedup-loser')
        .map(r => r.term);
      const noise = t3.rejected
        .filter(r => r.reason === 'noise')
        .map(r => r.term);
      if (keptTerms.length > 0) log(`    Kept (lexical): [${keptTerms.join(', ')}]`);
      if (dedupLosers.length > 0) log(`    Rejected (dedup-loser): [${dedupLosers.join(', ')}]`);
      if (noise.length > 0) log(`    Rejected (noise):       [${noise.join(', ')}]`);
    }
  }

  const totalFound = t1Ids.length + t2.ids.length + t3.found;
  const totalUpdated = t1Updated + t2Updated + t3Updated;
  const wouldUpdate = t1Ids.length + t2.ids.length + t3.rejected.length;
  log(`TOTAL: ${totalFound} found, ${opts.apply ? totalUpdated : wouldUpdate} ${action}`);

  if (opts.verbose) {
    for (const id of t1Ids) log(`  [T1 id=${id}] rejected`);
    for (const id of t2.ids) log(`  [T2 id=${id}] rejected`);
    for (const r of t3.rejected) log(`  [T3 id=${r.id}] term=${r.term} reason=${r.reason}`);
  }

  return {
    target1: { found: t1Ids.length, updated: opts.apply ? t1Updated : 0, ids: t1Ids },
    target2: {
      found: t2.ids.length,
      updated: opts.apply ? t2Updated : 0,
      skippedAliasMiner: t2.skippedAliasMiner,
      ids: t2.ids,
    },
    target3: {
      found: t3.found,
      updated: opts.apply ? t3Updated : 0,
      kept: t3.kept,
      rejected: t3.rejected,
    },
    totalFound,
    totalUpdated: opts.apply ? totalUpdated : wouldUpdate,
  };
}

function parseArgs(argv: ReadonlyArray<string>): PurgeArgs | null {
  const args = [...argv];
  const dbPathIdx = args.indexOf('--db-path');
  if (dbPathIdx === -1 || !args[dbPathIdx + 1]) return null;
  const targetIdx = args.indexOf('--target');
  if (targetIdx === -1 || !args[targetIdx + 1]) return null;
  const rawTarget = args[targetIdx + 1]!;
  let target: TargetSelector;
  if (rawTarget === '1') target = 1;
  else if (rawTarget === '2') target = 2;
  else if (rawTarget === '3') target = 3;
  else if (rawTarget === 'all') target = 'all';
  else return null;
  return {
    dbPath: args[dbPathIdx + 1]!,
    target,
    apply: args.includes('--apply'),
    verbose: args.includes('--verbose'),
  };
}

function main(argv: ReadonlyArray<string>): number {
  const parsed = parseArgs(argv);
  if (!parsed) {
    process.stderr.write(
      'Usage: purge-legacy-classifier-junk.ts --db-path <path> --target 1|2|3|all [--apply] [--verbose]\n',
    );
    return 2;
  }
  const db = new DatabaseSync(parsed.dbPath);
  try {
    runPurge({ db, target: parsed.target, apply: parsed.apply, verbose: parsed.verbose });
    return 0;
  } catch (err) {
    process.stderr.write(`Runtime error: ${err instanceof Error ? err.message : String(err)}\n`);
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
