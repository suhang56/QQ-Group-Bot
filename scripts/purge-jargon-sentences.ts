import { DatabaseSync } from 'node:sqlite';
import { STRUCTURAL_PARTICLES } from '../src/modules/jargon-miner.js';

const DB_PATH = process.env.DATABASE_PATH ?? 'data/bot.db';
const args = process.argv.slice(2);
const groupId = args[args.indexOf('--group') + 1] ?? null;
const dryRun = args.includes('--dry-run');

if (!groupId) {
  console.error('Usage: purge-jargon-sentences.ts --group <id> [--dry-run]');
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
const nowSec = Math.floor(Date.now() / 1000);

// Pass A: particle filter
const allPending = db.prepare(
  'SELECT content FROM jargon_candidates WHERE group_id = ? AND is_jargon = 0'
).all(groupId) as { content: string }[];

const passAContents: string[] = [];
for (const row of allPending) {
  for (const ch of row.content) {
    if (STRUCTURAL_PARTICLES.has(ch)) { passAContents.push(row.content); break; }
  }
}

// Pass B: length > 4 AND no ASCII (pure Chinese sentence fragments not caught by A)
const notPrunedByA = new Set(allPending.map(r => r.content));
for (const c of passAContents) notPrunedByA.delete(c);

const passBContents: string[] = [];
const longPureChinese = db.prepare(
  'SELECT content FROM jargon_candidates WHERE group_id = ? AND is_jargon = 0 AND length(content) > 4'
).all(groupId) as { content: string }[];

for (const row of longPureChinese) {
  if (!notPrunedByA.has(row.content)) continue;
  if (!/[a-zA-Z0-9]/.test(row.content)) passBContents.push(row.content);
}

const totalRows = allPending.length;
console.log(`Pass A (particle match): ${passAContents.length} rows would be pruned`);
console.log(`Pass B (length+no-ASCII): ${passBContents.length} rows would be pruned`);
console.log(`Total: ${passAContents.length + passBContents.length} / ${totalRows} rows`);
console.log(`Survivors: ${totalRows - passAContents.length - passBContents.length} rows`);

if (dryRun) {
  console.log('[dry-run] No writes performed.');
  db.close();
  process.exit(0);
}

async function batchUpdate(contents: string[]): Promise<void> {
  const CHUNK = 200;
  for (let i = 0; i < contents.length; i += CHUNK) {
    const chunk = contents.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    db.prepare(
      `UPDATE jargon_candidates SET is_jargon = -1, updated_at = ${nowSec} WHERE group_id = ? AND content IN (${placeholders})`
    ).run(groupId, ...chunk);
    if (i + CHUNK < contents.length) await new Promise(r => { const t = setTimeout(r, 10); t.unref?.(); });
  }
}

await batchUpdate([...passAContents, ...passBContents]);
console.log('Done. Rows pruned:', passAContents.length + passBContents.length);
db.close();
