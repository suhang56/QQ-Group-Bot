#!/usr/bin/env tsx
import { DatabaseSync } from 'node:sqlite';
import { CQ_PLACEHOLDER_TERMS, EMOJI_ONLY_RE } from '../src/modules/honest-gaps.js';

const args = process.argv.slice(2);
const groupIdx = args.indexOf('--group');
const dryRun = args.includes('--dry-run');

if (groupIdx === -1 || !args[groupIdx + 1]) {
  console.error('Usage: purge-honest-gaps-noise.ts --group <id> [--dry-run]');
  process.exit(2);
}

const groupId = args[groupIdx + 1]!;
const dbPath = process.env['DB_PATH'] ?? 'data/bot.db';
const db = new DatabaseSync(dbPath);

try {
  const results: Array<{ category: string; beforeCount: number; deletedCount: number }> = [];

  // Category A: @-prefixed tokens
  {
    const before = (db.prepare(
      "SELECT COUNT(*) as n FROM honest_gaps WHERE group_id = ? AND term LIKE '@%'"
    ).get(groupId) as { n: number }).n;
    if (!dryRun) {
      db.prepare("DELETE FROM honest_gaps WHERE group_id = ? AND term LIKE '@%'").run(groupId);
    }
    results.push({ category: '@-mention', beforeCount: before, deletedCount: dryRun ? 0 : before });
  }

  // Category B: CQ placeholder blocklist
  {
    const terms = [...CQ_PLACEHOLDER_TERMS];
    const placeholders = terms.map(() => '?').join(',');
    const before = (db.prepare(
      `SELECT COUNT(*) as n FROM honest_gaps WHERE group_id = ? AND term IN (${placeholders})`
    ).get(groupId, ...terms) as { n: number }).n;
    if (!dryRun) {
      db.prepare(
        `DELETE FROM honest_gaps WHERE group_id = ? AND term IN (${placeholders})`
      ).run(groupId, ...terms);
    }
    results.push({ category: 'CQ-placeholder', beforeCount: before, deletedCount: dryRun ? 0 : before });
  }

  // Category C: emoji-only tokens (SQLite has no native REGEXP — iterate and delete in batch)
  {
    const rows = db.prepare(
      'SELECT term FROM honest_gaps WHERE group_id = ?'
    ).all(groupId) as Array<{ term: string }>;
    const emojiTerms = rows.map(r => r.term).filter(t => EMOJI_ONLY_RE.test(t));
    const before = emojiTerms.length;
    if (!dryRun && emojiTerms.length > 0) {
      const del = db.prepare('DELETE FROM honest_gaps WHERE group_id = ? AND term = ?');
      for (const term of emojiTerms) {
        del.run(groupId, term);
      }
    }
    results.push({ category: 'emoji-only', beforeCount: before, deletedCount: dryRun ? 0 : before });
  }

  const grandTotal = results.reduce((sum, r) => sum + r.beforeCount, 0);
  const grandDeleted = results.reduce((sum, r) => sum + r.deletedCount, 0);

  console.log(dryRun ? '[DRY RUN] Rows that would be deleted:' : 'Rows deleted:');
  for (const r of results) {
    console.log(`  ${r.category}: ${r.beforeCount} found, ${r.deletedCount} ${dryRun ? 'would delete' : 'deleted'}`);
  }
  console.log(`  TOTAL: ${grandTotal} found, ${grandDeleted} ${dryRun ? 'would delete' : 'deleted'}`);

  process.exit(0);
} catch (err) {
  console.error('Runtime error:', err);
  process.exit(1);
} finally {
  db.close();
}
