#!/usr/bin/env tsx
/**
 * Manually import rules into the rules table from a text file or inline args.
 * One rule per line. Blank lines and lines starting with # are ignored.
 *
 * Usage:
 *   npx tsx scripts/add-rules.ts --group 958751334 --file rules.txt
 *   npx tsx scripts/add-rules.ts --group 958751334 --rule "禁止恶意攻击声优" --rule "禁止下头发言"
 *   npx tsx scripts/add-rules.ts --group 958751334 --file rules.txt [--db data/bot.db] [--source manual] [--dry-run]
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { initLogger, createLogger } from '../src/utils/logger.js';

initLogger({ level: 'info' });
const logger = createLogger('add-rules');

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function flag(name: string): string | null {
  const i = args.indexOf(name);
  return i !== -1 ? (args[i + 1] ?? null) : null;
}

function flags(name: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === name) result.push(args[i + 1]!);
  }
  return result;
}

const groupId = flag('--group');
const dbPath = flag('--db') ?? 'data/bot.db';
const filePath = flag('--file');
const source = flag('--source') ?? 'manual';
const dryRun = args.includes('--dry-run');
const inlineRules = flags('--rule');

if (!groupId) {
  console.error('Usage: npx tsx scripts/add-rules.ts --group <groupId> [--file <file>] [--rule <rule>...] [--db <path>] [--source <source>] [--dry-run]');
  process.exit(1);
}

// ── Collect rules ────────────────────────────────────────────────────────────

const ruleLines: string[] = [];

if (filePath) {
  const raw = readFileSync(path.resolve(filePath), 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) ruleLines.push(trimmed);
  }
}

for (const r of inlineRules) {
  const trimmed = r.trim();
  if (trimmed) ruleLines.push(trimmed);
}

if (ruleLines.length === 0) {
  console.error('No rules to insert — provide --file or --rule args');
  process.exit(1);
}

// ── Insert ───────────────────────────────────────────────────────────────────

const db = new DatabaseSync(path.resolve(dbPath));

// Check for duplicates by content
const existing = new Set<string>(
  (db.prepare("SELECT content FROM rules WHERE group_id = ?").all(groupId) as { content: string }[])
    .map(r => r.content.trim())
);

let inserted = 0;
let skipped = 0;

for (const rule of ruleLines) {
  if (existing.has(rule)) {
    logger.info({ rule }, 'Skipped (duplicate)');
    skipped++;
    continue;
  }
  if (!dryRun) {
    db.prepare(
      "INSERT INTO rules (group_id, content, type, source) VALUES (?, ?, 'positive', ?)"
    ).run(groupId, rule, source);
  }
  logger.info({ rule, dryRun }, 'Inserted rule');
  inserted++;
}

db.close();

const tag = dryRun ? ' [DRY RUN]' : '';
console.log(`\nDone${tag}: ${inserted} rules inserted, ${skipped} skipped (duplicates).`);

// Show current rule count
if (!dryRun) {
  const db2 = new DatabaseSync(path.resolve(dbPath));
  const count = (db2.prepare("SELECT COUNT(*) as c FROM rules WHERE group_id = ?").get(groupId) as { c: number }).c;
  db2.close();
  console.log(`Total rules for group ${groupId}: ${count}`);
}
