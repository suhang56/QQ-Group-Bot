#!/usr/bin/env tsx
import { DatabaseSync } from 'node:sqlite';
import { extractTermFromTopic } from '../src/modules/fact-topic-prefixes.js';
import { isEmotivePhrase } from '../src/utils/is-emotive-phrase.js';

const args = process.argv.slice(2);
const dbPathIdx = args.indexOf('--db-path');
const apply = args.includes('--apply');
const verbose = args.includes('--verbose');

if (dbPathIdx === -1 || !args[dbPathIdx + 1]) {
  console.error('Usage: purge-emotive-facts.ts --db-path <path> [--apply] [--verbose]');
  process.exit(2);
}

const dbPath = args[dbPathIdx + 1]!;
const db = new DatabaseSync(dbPath);

try {
  const rows = db
    .prepare(
      "SELECT id, topic, fact, status FROM learned_facts WHERE topic LIKE 'ondemand-lookup:%' AND status = 'active'",
    )
    .all() as Array<{ id: number; topic: string; fact: string; status: string }>;

  const matchedIds: number[] = [];
  const matchedDetails: Array<{ id: number; term: string; topic: string }> = [];
  for (const row of rows) {
    const term = extractTermFromTopic(row.topic);
    if (term && isEmotivePhrase(term)) {
      matchedIds.push(row.id);
      matchedDetails.push({ id: row.id, term, topic: row.topic });
    }
  }

  const found = matchedIds.length;
  const updated = apply ? found : 0;

  console.log(apply ? 'Rows updated:' : '[DRY RUN] Rows that would be updated:');
  console.log(
    `  ondemand-lookup emotive: ${found} found, ${updated} ${apply ? 'updated' : 'would update'}`,
  );
  console.log(`  TOTAL: ${found} found, ${updated} ${apply ? 'updated' : 'would update'}`);

  if (verbose) {
    for (const d of matchedDetails) {
      console.log(`  [id=${d.id}] ${d.term} (topic=${d.topic})`);
    }
  }

  if (apply && matchedIds.length > 0) {
    const nowSec = Math.floor(Date.now() / 1000);
    const upd = db.prepare(
      "UPDATE learned_facts SET status = 'rejected', updated_at = ? WHERE id = ?",
    );
    db.exec('BEGIN');
    try {
      for (const id of matchedIds) {
        upd.run(nowSec, id);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  process.exit(0);
} catch (err) {
  console.error('Runtime error:', err);
  process.exit(1);
} finally {
  db.close();
}
