#!/usr/bin/env node
// Repair wrongly-superseded rows left behind by the old canonical-substring
// supersede. Decisions gate on structured-topic validation — dirty legacy
// topics are never resurrected.
//
// MIRROR of src/modules/fact-topic-prefixes.ts — keep in sync.
// If that file changes (new prefix, validator tweak), update this script.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { parseArgs } from 'node:util';

export const LEARNED_FACT_TOPIC_PREFIXES = [
  'user-taught',
  'opus-classified:slang',
  'opus-classified:fandom',
  'opus-rest-classified:slang',
  'opus-rest-classified:fandom',
  '群内黑话',
  'passive',
  'online-research',
  'ondemand-lookup',
];

const DIRTY_HAN_TOKEN_RE =
  /(?:是谁|是啥|是什么|什么意思|的意思|牛逼|[吗啊呢嘛哦]|^在|的|这个|那个)/u;

export function isValidStructuredTerm(term) {
  const s = String(term ?? '').trim();
  if (s.length < 2) return false;
  if (/^[A-Za-z][A-Za-z0-9_]{1,19}$/.test(s)) return true;
  if (/^[0-9A-Za-z_]{2,20}$/.test(s)) return true;
  if (/^\p{Script=Han}{2,10}$/u.test(s)) {
    if (DIRTY_HAN_TOKEN_RE.test(s)) return false;
    return true;
  }
  return false;
}

export function extractTermFromTopic(topic) {
  if (!topic) return null;
  for (const p of LEARNED_FACT_TOPIC_PREFIXES) {
    if (topic.startsWith(p + ':')) {
      const term = topic.slice(p.length + 1);
      return isValidStructuredTerm(term) ? term : null;
    }
  }
  return null;
}

function usage(msg) {
  const text = [
    msg ? `Error: ${msg}\n` : '',
    'Usage:',
    '  node scripts/repair-wrongly-superseded-knowledge.mjs --dry-run --allowlist 4573,4387',
    '  node scripts/repair-wrongly-superseded-knowledge.mjs --commit --allowlist 4573,4387',
    '  node scripts/repair-wrongly-superseded-knowledge.mjs --dry-run --full-scan',
    '  node scripts/repair-wrongly-superseded-knowledge.mjs --commit --full-scan --yes',
    'Optional: --db <path>   (default: data/bot.db)',
  ].join('\n');
  process.stderr.write(text + '\n');
  process.exit(2);
}

/**
 * Decide what to do with a superseded row.
 * Returns { decision: 'reactivate'|'keep-superseded', reason }.
 * Gates on extractTermFromTopic (dirty legacy topics never resurrected).
 * Skips if an active peer with same topic exists, or a NEWER superseded
 * peer with same topic exists (that newer row should be reactivated first).
 */
export function decideRowAction(db, row) {
  const term = extractTermFromTopic(row.topic);
  if (!term) {
    return { decision: 'keep-superseded', reason: 'topic fails isValidStructuredTerm (dirty/bare/unknown)' };
  }
  const activePeer = db.prepare(
    `SELECT 1 FROM learned_facts WHERE group_id=? AND status='active' AND topic=? LIMIT 1`,
  ).get(row.group_id, row.topic);
  if (activePeer) {
    return { decision: 'keep-superseded', reason: 'active peer exists with same topic' };
  }
  const newerSuperseded = db.prepare(
    `SELECT 1 FROM learned_facts WHERE group_id=? AND status='superseded' AND topic=? AND updated_at > ? AND id != ? LIMIT 1`,
  ).get(row.group_id, row.topic, row.updated_at, row.id);
  if (newerSuperseded) {
    return { decision: 'keep-superseded', reason: 'newer superseded peer with same topic (will be reactivated first)' };
  }
  return { decision: 'reactivate', reason: 'no active peer with same topic' };
}

/**
 * Core runner — usable from tests by passing an opened DatabaseSync instance.
 * @param db       open node:sqlite DatabaseSync
 * @param options  { mode: 'dry-run'|'commit', allowlist?: number[], fullScan?: boolean, log?: (line: string) => void }
 * @returns        { reactivated: number, decisions: Array<{ id, groupId, topic, updated_at, decision, reason }> }
 */
export function runRepair(db, options) {
  const mode = options.mode;
  const log = options.log ?? ((line) => process.stdout.write(line + '\n'));

  let candidates;
  if (options.allowlist && options.allowlist.length > 0) {
    const placeholders = options.allowlist.map(() => '?').join(',');
    candidates = db.prepare(
      `SELECT id, group_id, topic, updated_at FROM learned_facts
       WHERE status='superseded' AND id IN (${placeholders})`,
    ).all(...options.allowlist);
  } else if (options.fullScan) {
    candidates = db.prepare(
      `SELECT id, group_id, topic, updated_at FROM learned_facts WHERE status='superseded'`,
    ).all();
  } else {
    throw new Error('runRepair: must supply either allowlist or fullScan');
  }

  const decisions = [];
  for (const row of candidates) {
    const { decision, reason } = decideRowAction(db, row);
    const record = {
      id: row.id,
      groupId: row.group_id,
      topic: row.topic,
      updated_at: row.updated_at,
      decision,
      reason,
    };
    decisions.push(record);
    log(JSON.stringify(record));
  }

  let reactivated = 0;
  if (mode === 'commit') {
    const now = Math.floor(Date.now() / 1000);
    const ids = decisions.filter(d => d.decision === 'reactivate').map(d => d.id);
    db.exec('BEGIN IMMEDIATE');
    try {
      const upd = db.prepare(`UPDATE learned_facts SET status='active', updated_at=? WHERE id=?`);
      for (const id of ids) upd.run(now, id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    reactivated = ids.length;
    log(JSON.stringify({ summary: 'commit', reactivated }));
  } else {
    const wouldReactivate = decisions.filter(d => d.decision === 'reactivate').length;
    log(JSON.stringify({ summary: 'dry-run', wouldReactivate }));
  }
  return { reactivated, decisions };
}

// CLI entry — only runs when invoked directly, not when imported by tests.
// On Windows, import.meta.url uses file:// paths with forward slashes; compare
// normalized absolute paths for robust detection.
const modulePath = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(modulePath);

if (isMain) {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        'dry-run': { type: 'boolean' },
        commit: { type: 'boolean' },
        allowlist: { type: 'string' },
        'full-scan': { type: 'boolean' },
        yes: { type: 'boolean' },
        db: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    usage(err?.message ?? 'argument parsing failed');
  }
  const values = parsed.values;

  if (!!values['dry-run'] === !!values.commit) usage('must specify exactly one of --dry-run or --commit');
  if (!!values.allowlist === !!values['full-scan']) usage('must specify exactly one of --allowlist <ids> or --full-scan');
  if (values.commit && values['full-scan'] && !values.yes) usage('--commit --full-scan requires --yes');

  const dbPath = path.resolve(values.db ?? 'data/bot.db');
  process.stdout.write(`DB: ${dbPath}\n`);

  let allowlist;
  if (values.allowlist) {
    allowlist = values.allowlist.split(',').map(s => {
      const n = Number.parseInt(s.trim(), 10);
      if (!Number.isInteger(n) || n <= 0) usage(`invalid id in --allowlist: "${s}"`);
      return n;
    });
  }

  const db = new DatabaseSync(dbPath);
  try {
    runRepair(db, {
      mode: values.commit ? 'commit' : 'dry-run',
      allowlist,
      fullScan: !!values['full-scan'],
    });
  } finally {
    db.close();
  }
}
