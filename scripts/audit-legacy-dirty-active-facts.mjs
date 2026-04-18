// Read-only audit: surface active learned_facts whose topic is null, bare
// prefix-only (no :term), or a known prefix with a dirty suffix. Does NOT
// modify the DB. Output is JSON-lines for downstream piping.
//
// MIRROR of src/modules/fact-topic-prefixes.ts — keep in sync.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { parseArgs } from 'node:util';

const LEARNED_FACT_TOPIC_PREFIXES = [
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

function isValidStructuredTerm(term) {
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

function usage(msg) {
  const text = [
    msg ? `Error: ${msg}\n` : '',
    'Usage:',
    '  node scripts/audit-legacy-dirty-active-facts.mjs [--db <path>] [--terms ygfn,xtt]',
    'This script is read-only. --commit is rejected.',
  ].join('\n');
  process.stderr.write(text + '\n');
  process.exit(2);
}

function classify(row, knownTerms) {
  if (row.topic === null) return { reason: 'topic IS NULL' };
  // Exactly matches a bare prefix (no colon) — e.g. "群内黑话", "ondemand-lookup"
  if (LEARNED_FACT_TOPIC_PREFIXES.includes(row.topic)) {
    return { reason: 'bare prefix without :term suffix' };
  }
  // Recognized prefix with suffix — check if suffix is valid
  for (const p of LEARNED_FACT_TOPIC_PREFIXES) {
    if (row.topic.startsWith(p + ':')) {
      const suffix = row.topic.slice(p.length + 1);
      if (!isValidStructuredTerm(suffix)) {
        return { reason: `prefix "${p}" with dirty suffix "${suffix}"` };
      }
      // topic is clean — still check canonical mentions a known term without correct topic
      if (knownTerms.length > 0) {
        const canonical = row.canonical_form ?? row.fact ?? '';
        for (const t of knownTerms) {
          if (canonical.includes(t) && !row.topic.includes(`:${t}`)) {
            return { reason: `canonical mentions "${t}" but topic does not identify it` };
          }
        }
      }
      return null;
    }
  }
  // Unknown prefix entirely
  return { reason: `unknown prefix (not in LEARNED_FACT_TOPIC_PREFIXES)` };
}

let parsed;
try {
  parsed = parseArgs({
    options: {
      db: { type: 'string' },
      terms: { type: 'string' },
      commit: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });
} catch (err) {
  usage(err?.message ?? 'argument parsing failed');
}
const values = parsed.values;
if (values.commit) usage('--commit is not supported; this script is read-only');

const dbPath = path.resolve(values.db ?? 'data/bot.db');
process.stdout.write(`DB: ${dbPath}\n`);

const knownTerms = values.terms
  ? values.terms.split(',').map(s => s.trim()).filter(Boolean)
  : [];

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const rows = db.prepare(
    `SELECT id, group_id, topic, canonical_form, fact, updated_at FROM learned_facts WHERE status='active'`,
  ).all();
  let findings = 0;
  for (const row of rows) {
    const c = classify(row, knownTerms);
    if (!c) continue;
    findings++;
    process.stdout.write(JSON.stringify({
      id: row.id,
      groupId: row.group_id,
      topic: row.topic,
      updated_at: row.updated_at,
      reason: c.reason,
    }) + '\n');
  }
  process.stdout.write(JSON.stringify({ summary: 'audit', scanned: rows.length, findings }) + '\n');
} finally {
  db.close();
}
