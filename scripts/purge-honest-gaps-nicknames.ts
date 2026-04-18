#!/usr/bin/env tsx
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const groupIdx = args.indexOf('--group');
const dryRun = args.includes('--dry-run');

if (groupIdx === -1 || !args[groupIdx + 1]) {
  console.error('Usage: purge-honest-gaps-nicknames.ts --group <id> [--dry-run]');
  process.exit(2);
}

const groupId = args[groupIdx + 1]!;
const dbPath = process.env['DB_PATH'] ?? 'data/bot.db';
const db = new DatabaseSync(dbPath);

try {
  const countRow = (db.prepare(
    `SELECT COUNT(*) as n FROM honest_gaps
     WHERE group_id = ?
       AND term IN (
         SELECT DISTINCT nickname FROM messages
         WHERE group_id = ? AND nickname IS NOT NULL AND nickname != ''
       )`
  ).get(groupId, groupId) as { n: number }).n;

  const previewRows = db.prepare(
    `SELECT term FROM honest_gaps
     WHERE group_id = ?
       AND term IN (
         SELECT DISTINCT nickname FROM messages
         WHERE group_id = ? AND nickname IS NOT NULL AND nickname != ''
       )
     LIMIT 20`
  ).all(groupId, groupId) as Array<{ term: string }>;

  if (dryRun) {
    console.log('[DRY RUN] Rows that would be deleted:');
    console.log(`  nickname-match: ${countRow} found`);
    if (previewRows.length > 0) {
      console.log('  Preview (up to 20):');
      for (const r of previewRows) {
        console.log(`    ${r.term}`);
      }
    }
  } else {
    db.prepare(
      `DELETE FROM honest_gaps
       WHERE group_id = ?
         AND term IN (
           SELECT DISTINCT nickname FROM messages
           WHERE group_id = ? AND nickname IS NOT NULL AND nickname != ''
         )`
    ).run(groupId, groupId);
    console.log(`Deleted ${countRow} nickname-matching rows from honest_gaps for group ${groupId}.`);
  }

  process.exit(0);
} catch (err) {
  console.error('Runtime error:', err);
  process.exit(1);
} finally {
  db.close();
}
