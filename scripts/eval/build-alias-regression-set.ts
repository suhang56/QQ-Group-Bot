#!/usr/bin/env tsx
/**
 * Build alias retrieval regression test set.
 *
 * Output: data/eval/alias-retrieval-regression.jsonl
 *   { trigger_text, source_message_id, alias_term, expected_fact_id, expected_fact_topic, fact_summary, prompt_kind }
 *
 * Source: learned_facts active rows w/ alias prefixes (user-taught:* / 群友别名:* /
 * opus-rest-classified:fandom:* heavy-trust). For each alias term:
 * - Find historical messages where the term appears in question form
 *   ("X是谁" / "评价X" / "X怎么样" / "@bot X")
 * - Emit one regression sample per query
 */
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH ?? 'data/bot.db';
const OUT_PATH = 'data/eval/alias-retrieval-regression.jsonl';
const BOT_USER_ID = '1705075399';

const db = new DatabaseSync(path.resolve(DB_PATH));

interface AliasFact {
  id: number;
  topic: string;
  fact: string;
  prefix: string;
  term: string;
}

interface RegressionSample {
  trigger_text: string;
  source_message_id: string;
  alias_term: string;
  expected_fact_id: number;
  expected_fact_topic: string;
  fact_summary: string;
  prompt_kind: 'identity-query' | 'evaluate' | 'attribute' | 'mention';
}

const ALIAS_PREFIXES = ['user-taught:', '群友别名:'];

const aliasRows = db.prepare(`
  SELECT id, topic, fact
  FROM learned_facts
  WHERE status='active'
    AND (topic LIKE 'user-taught:%' OR topic LIKE '群友别名:%')
  ORDER BY id
`).all() as Array<{ id: number; topic: string; fact: string }>;

const aliases: AliasFact[] = [];
for (const r of aliasRows) {
  const prefix = ALIAS_PREFIXES.find(p => r.topic.startsWith(p));
  if (!prefix) continue;
  const term = r.topic.slice(prefix.length);
  if (!term || term.length < 2) continue;
  aliases.push({ id: r.id, topic: r.topic, fact: r.fact, prefix, term });
}

console.log(`Found ${aliases.length} alias facts (${aliasRows.length} total active rows checked)`);

const samples: RegressionSample[] = [];

for (const alias of aliases) {
  // Match identity-query patterns: "X是谁" / "X 是谁" / "X 是啥"
  const identityRegex = `${alias.term}%是谁` ;
  const identityRows = db.prepare(`
    SELECT source_message_id, content
    FROM messages
    WHERE deleted=0 AND user_id != ?
      AND content LIKE ?
      AND length(content) <= 50
    LIMIT 3
  `).all(BOT_USER_ID, `%${alias.term}%是谁%`) as Array<{ source_message_id: string; content: string }>;

  for (const r of identityRows) {
    samples.push({
      trigger_text: r.content,
      source_message_id: r.source_message_id,
      alias_term: alias.term,
      expected_fact_id: alias.id,
      expected_fact_topic: alias.topic,
      fact_summary: alias.fact.slice(0, 100),
      prompt_kind: 'identity-query',
    });
  }

  // Match evaluate patterns: "评价 X" / "如何评价 X"
  const evalRows = db.prepare(`
    SELECT source_message_id, content
    FROM messages
    WHERE deleted=0 AND user_id != ?
      AND content LIKE ?
      AND length(content) <= 50
    LIMIT 2
  `).all(BOT_USER_ID, `%评价%${alias.term}%`) as Array<{ source_message_id: string; content: string }>;

  for (const r of evalRows) {
    samples.push({
      trigger_text: r.content,
      source_message_id: r.source_message_id,
      alias_term: alias.term,
      expected_fact_id: alias.id,
      expected_fact_topic: alias.topic,
      fact_summary: alias.fact.slice(0, 100),
      prompt_kind: 'evaluate',
    });
  }

  // Match attribute patterns: "X 怎么样" / "你觉得 X"
  const attrRows = db.prepare(`
    SELECT source_message_id, content
    FROM messages
    WHERE deleted=0 AND user_id != ?
      AND (content LIKE ? OR content LIKE ?)
      AND length(content) <= 50
    LIMIT 2
  `).all(BOT_USER_ID, `%${alias.term}%怎么样%`, `%觉得${alias.term}%`) as Array<{ source_message_id: string; content: string }>;

  for (const r of attrRows) {
    samples.push({
      trigger_text: r.content,
      source_message_id: r.source_message_id,
      alias_term: alias.term,
      expected_fact_id: alias.id,
      expected_fact_topic: alias.topic,
      fact_summary: alias.fact.slice(0, 100),
      prompt_kind: 'attribute',
    });
  }
}

// Dedupe by source_message_id
const seen = new Set<string>();
const deduped = samples.filter(s => {
  if (seen.has(s.source_message_id)) return false;
  seen.add(s.source_message_id);
  return true;
});

writeFileSync(OUT_PATH, deduped.map(s => JSON.stringify(s)).join('\n') + '\n', 'utf8');

console.log(`Wrote ${deduped.length} regression samples to ${OUT_PATH}`);
console.log(`  By prompt_kind:`);
const byKind: Record<string, number> = {};
for (const s of deduped) byKind[s.prompt_kind] = (byKind[s.prompt_kind] ?? 0) + 1;
for (const [k, v] of Object.entries(byKind)) console.log(`    ${k}: ${v}`);
console.log(`  By alias term:`);
const byTerm: Record<string, number> = {};
for (const s of deduped) byTerm[s.alias_term] = (byTerm[s.alias_term] ?? 0) + 1;
for (const [k, v] of Object.entries(byTerm).sort((a, b) => b[1] - a[1])) console.log(`    ${k}: ${v}`);

db.close();
