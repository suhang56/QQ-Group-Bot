/**
 * One-shot data fix (2026-04-30):
 * 1. Reject prompt-injection capture row (id 9145) — Phase A redline
 * 2. Reject 2 wrong 可变三连 rows (id 824, 836) — content matches neither
 *    "应援文化口号 2017" nor "游戏可灵活三首歌曲模式"; correct meaning per user:
 *    "甩手的 mix"(wotagei 应援动作组合)
 * 3. Insert user-taught:可变三连 row with correct definition
 *
 * Per `feedback_db_writer_lock_with_live_bot.md` — bot must be stopped before run.
 *
 * Run: npx tsx scripts/maintenance/purge-jielong-and-correct-kebian-sanlian.ts --apply
 * Default dry-run.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env['DB_PATH'] ?? 'data/bot.db';

const REJECT_IDS = [9145, 824, 836] as const;
const INSERT_ROW = {
  group_id: '958751334',
  topic: 'user-taught:可变三连',
  fact: '可变三连是甩手的mix（wotagei应援动作的组合,不是游戏模式也不是2017年口号）',
  source_user_id: '2331924739',
  source_user_nickname: '西瓜',
  confidence: 1.0,
};

const db = new DatabaseSync(path.resolve(DB_PATH));

console.log(`[${APPLY ? 'APPLY' : 'DRY-RUN'}] db=${DB_PATH}`);

const before = db.prepare(
  `SELECT id, status, substr(fact, 1, 60) as fact_preview FROM learned_facts WHERE id IN (?, ?, ?)`,
).all(...REJECT_IDS);
console.log('Rows targeted for reject:');
for (const r of before) console.log(' ', r);

const existingTeach = db
  .prepare(`SELECT id, fact FROM learned_facts WHERE topic=? AND status='active'`)
  .all(INSERT_ROW.topic);
console.log('Existing user-taught:可变三连 rows:', existingTeach);

if (!APPLY) {
  console.log('\n[DRY-RUN] No changes applied. Run with --apply to commit.');
  db.close();
  process.exit(0);
}

const now = Math.floor(Date.now() / 1000);
const tx = db.exec.bind(db);

tx('BEGIN');
try {
  const stmt = db.prepare(`UPDATE learned_facts SET status='rejected', updated_at=? WHERE id=?`);
  for (const id of REJECT_IDS) stmt.run(now, id);

  // Insert user-taught row only if no active row already exists with this exact topic
  if (existingTeach.length === 0) {
    db.prepare(
      `INSERT INTO learned_facts (group_id, topic, fact, source_user_id, source_user_nickname, confidence, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      INSERT_ROW.group_id,
      INSERT_ROW.topic,
      INSERT_ROW.fact,
      INSERT_ROW.source_user_id,
      INSERT_ROW.source_user_nickname,
      INSERT_ROW.confidence,
      now,
      now,
    );
  } else {
    console.log('Skipping insert — active user-taught row already exists.');
  }

  tx('COMMIT');
  console.log('\n[OK] committed.');
} catch (e) {
  tx('ROLLBACK');
  console.error('[ERR] rolled back:', e);
  process.exit(1);
}

const after = db
  .prepare(`SELECT id, status FROM learned_facts WHERE id IN (?, ?, ?)`)
  .all(...REJECT_IDS);
console.log('After:');
for (const r of after) console.log(' ', r);

const teach = db
  .prepare(`SELECT id, topic, substr(fact, 1, 80) as fact_preview, status FROM learned_facts WHERE topic=? ORDER BY id DESC LIMIT 3`)
  .all(INSERT_ROW.topic);
console.log('user-taught rows:', teach);

db.close();
