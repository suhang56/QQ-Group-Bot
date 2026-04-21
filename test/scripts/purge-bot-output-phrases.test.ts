import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runPurge } from '../../scripts/maintenance/purge-bot-output-phrases.js';

const BOT_ID = '1705075399';
const USER_ID = 'user-42';

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  // Minimal learned_facts schema (only columns the purge touches).
  db.exec(`
    CREATE TABLE IF NOT EXISTS learned_facts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id          TEXT    NOT NULL,
      topic             TEXT,
      fact              TEXT    NOT NULL,
      source_user_id    TEXT,
      status            TEXT    NOT NULL DEFAULT 'active',
      created_at        INTEGER NOT NULL DEFAULT 0,
      updated_at        INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function seed(db: DatabaseSync, sourceUserId: string | null, fact: string, status = 'active'): number {
  const info = db.prepare(
    'INSERT INTO learned_facts (group_id, topic, fact, source_user_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run('g1', 'user-taught:x', fact, sourceUserId, status, 100, 100);
  return Number(info.lastInsertRowid);
}

function selectStatus(db: DatabaseSync, id: number): string {
  return (db.prepare('SELECT status FROM learned_facts WHERE id = ?').get(id) as { status: string }).status;
}

function totalCount(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM learned_facts').get() as { n: number }).n;
}

describe('purge-bot-output-phrases — runPurge', () => {
  it('MUST-NOT-FIRE: dry-run (default) writes nothing to DB', () => {
    const db = makeDb();
    seed(db, BOT_ID, '再@我你试试');
    seed(db, BOT_ID, '烦死了');
    seed(db, USER_ID, '智械危机是好梗');

    const before = totalCount(db);
    const lines: string[] = [];
    const result = runPurge({
      db, botUserId: BOT_ID, apply: false, verbose: false,
      log: (l) => lines.push(l),
      now: () => 2_000_000_000_000,
    });

    expect(result.found).toBe(2);
    expect(result.updated).toBe(0);
    // No status change
    expect(db.prepare("SELECT COUNT(*) AS n FROM learned_facts WHERE status = 'rejected'").get()).toEqual({ n: 0 });
    expect(totalCount(db)).toBe(before);

    const joined = lines.join('\n');
    expect(joined).toMatch(/\[DRY RUN\]/);
    expect(joined).toMatch(/learned_facts \(source_user_id = '1705075399'\): 2 found, 0 would update/);
    expect(joined).toMatch(/skipped: jargon_candidates/);
    expect(joined).toMatch(/skipped: phrase_candidates/);
    expect(joined).toMatch(/skipped: meme_graph/);
    expect(joined).toMatch(/skipped: groupmate_expression_samples/);

    db.close();
  });

  it('MUST-FIRE: --apply flips ONLY bot rows to rejected; user rows untouched; no rows deleted', () => {
    const db = makeDb();
    const botId1 = seed(db, BOT_ID, '再@我你试试');
    const botId2 = seed(db, BOT_ID, '烦死了');
    const userId1 = seed(db, USER_ID, '智械危机是好梗');
    const userId2 = seed(db, 'user-99', '这个梗群里都在用');
    const nullSrcId = seed(db, null, '系统自动学习的事实');

    const before = totalCount(db);

    const result = runPurge({
      db, botUserId: BOT_ID, apply: true, verbose: false,
      log: () => {},
      now: () => 2_000_000_000_000,
    });

    expect(result.found).toBe(2);
    expect(result.updated).toBe(2);
    // Row count unchanged — no DELETE
    expect(totalCount(db)).toBe(before);

    expect(selectStatus(db, botId1)).toBe('rejected');
    expect(selectStatus(db, botId2)).toBe('rejected');
    expect(selectStatus(db, userId1)).toBe('active');
    expect(selectStatus(db, userId2)).toBe('active');
    expect(selectStatus(db, nullSrcId)).toBe('active');

    // Verify updated_at was set
    const nowSec = Math.floor(2_000_000_000_000 / 1000);
    const updated = db.prepare('SELECT updated_at FROM learned_facts WHERE id = ?').get(botId1) as { updated_at: number };
    expect(updated.updated_at).toBe(nowSec);

    db.close();
  });

  it('MUST-NOT-FIRE: rows already status=rejected are NOT re-flipped (no double-reject churn)', () => {
    const db = makeDb();
    seed(db, BOT_ID, 'already rejected', 'rejected');
    seed(db, BOT_ID, 'active', 'active');

    const result = runPurge({
      db, botUserId: BOT_ID, apply: false, verbose: false, log: () => {},
    });

    expect(result.found).toBe(1);
    db.close();
  });

  it('user-source rows UNCHANGED by apply (pre/post select)', () => {
    const db = makeDb();
    seed(db, USER_ID, '用户教的事实');
    const before = db.prepare("SELECT COUNT(*) AS n FROM learned_facts WHERE source_user_id = ? AND status='active'").get(USER_ID) as { n: number };

    runPurge({
      db, botUserId: BOT_ID, apply: true, verbose: false, log: () => {},
    });

    const after = db.prepare("SELECT COUNT(*) AS n FROM learned_facts WHERE source_user_id = ? AND status='active'").get(USER_ID) as { n: number };
    expect(after.n).toBe(before.n);
    db.close();
  });

  it('empty DB — found=0, updated=0, no error', () => {
    const db = makeDb();
    const result = runPurge({
      db, botUserId: BOT_ID, apply: true, verbose: false, log: () => {},
    });
    expect(result.found).toBe(0);
    expect(result.updated).toBe(0);
    db.close();
  });

  it('verbose=true logs per-row detail', () => {
    const db = makeDb();
    seed(db, BOT_ID, '再@我你试试');
    seed(db, BOT_ID, '烦死了');

    const lines: string[] = [];
    runPurge({
      db, botUserId: BOT_ID, apply: false, verbose: true,
      log: (l) => lines.push(l),
    });

    const joined = lines.join('\n');
    expect(joined).toMatch(/\[id=\d+\].*再@我你试试/);
    expect(joined).toMatch(/\[id=\d+\].*烦死了/);
    db.close();
  });

  it('script contains NO `DELETE FROM` statement (safety invariant)', async () => {
    const fs = await import('node:fs/promises');
    const url = new URL('../../scripts/maintenance/purge-bot-output-phrases.ts', import.meta.url);
    const src = await fs.readFile(url, 'utf8');
    // Allow the string `DELETE` elsewhere (none expected) but assert no SQL DELETE FROM statement.
    expect(src).not.toMatch(/DELETE\s+FROM/i);
    // And that UPDATE with status='rejected' is present
    expect(src).toMatch(/UPDATE learned_facts SET status = 'rejected'/);
  });
});
