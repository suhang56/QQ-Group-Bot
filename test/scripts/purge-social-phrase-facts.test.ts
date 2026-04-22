import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runPurge } from '../../scripts/maintenance/purge-social-phrase-facts.js';

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  // Matches src/storage/schema.sql:212 minus the embedding columns the purge
  // doesn't touch. NO `canonical` column — the canonical lives in the topic
  // suffix and is parsed by extractTermFromTopic.
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

function seed(
  db: DatabaseSync,
  topic: string,
  fact: string,
  status: 'active' | 'pending' | 'rejected' = 'active',
): number {
  const info = db.prepare(
    'INSERT INTO learned_facts (group_id, topic, fact, source_user_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run('g1', topic, fact, null, status, 100, 100);
  return Number(info.lastInsertRowid);
}

function selectStatus(db: DatabaseSync, id: number): string {
  return (db.prepare('SELECT status FROM learned_facts WHERE id = ?').get(id) as { status: string }).status;
}

function totalCount(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM learned_facts').get() as { n: number }).n;
}

describe('purge-social-phrase-facts — runPurge', () => {
  it('dry-run: finds social-phrase slang rows, does NOT mutate', () => {
    const db = makeDb();
    seed(db, 'opus-classified:slang:贴贴', '表达亲密的社交动作');
    seed(db, 'opus-classified:slang:宝宝', '称呼对方为宝宝');
    seed(db, 'opus-rest-classified:slang:晚安', '道晚安');
    // non-social
    seed(db, 'opus-classified:slang:ykn', 'BanG Dream 凑友希那别名');
    // lore-topic exempt
    seed(db, 'opus-classified:slang:lore:宝宝', 'lore-confirmed 称呼');

    const before = totalCount(db);
    const lines: string[] = [];
    const result = runPurge({
      db, apply: false, verbose: false,
      log: (l) => lines.push(l),
      now: () => 2_000_000_000_000,
    });

    expect(result.found).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.skippedLoreCount).toBe(1);
    expect(result.skippedNonSocialCount).toBe(1);
    expect(totalCount(db)).toBe(before);
    // nothing rejected yet
    const rej = db.prepare("SELECT COUNT(*) AS n FROM learned_facts WHERE status = 'rejected'").get() as { n: number };
    expect(rej.n).toBe(0);

    const joined = lines.join('\n');
    expect(joined).toMatch(/\[DRY RUN\]/);
    expect(joined).toMatch(/3 found, 0 would update/);
    expect(joined).toMatch(/lore-topic exempt\): 1/);
    db.close();
  });

  it('--apply: flips ONLY matched rows to rejected; lore + non-social untouched; no DELETE', () => {
    const db = makeDb();
    const tiepie = seed(db, 'opus-classified:slang:贴贴', 'a');
    const baobao = seed(db, 'opus-classified:slang:宝宝', 'b');
    const wanan = seed(db, 'opus-rest-classified:slang:晚安', 'c');
    const ykn = seed(db, 'opus-classified:slang:ykn', 'fandom');
    const loreRow = seed(db, 'opus-classified:slang:lore:宝宝', 'fandom-lore');

    const before = totalCount(db);
    const result = runPurge({
      db, apply: true, verbose: false,
      log: () => {},
      now: () => 1_700_000_000_000,
    });

    expect(result.found).toBe(3);
    expect(result.updated).toBe(3);
    expect(totalCount(db)).toBe(before); // no DELETE

    expect(selectStatus(db, tiepie)).toBe('rejected');
    expect(selectStatus(db, baobao)).toBe('rejected');
    expect(selectStatus(db, wanan)).toBe('rejected');
    expect(selectStatus(db, ykn)).toBe('active'); // non-social skipped
    expect(selectStatus(db, loreRow)).toBe('active'); // lore-topic exempt

    // updated_at was written
    const nowSec = Math.floor(1_700_000_000_000 / 1000);
    const up = db.prepare('SELECT updated_at FROM learned_facts WHERE id = ?').get(tiepie) as { updated_at: number };
    expect(up.updated_at).toBe(nowSec);

    db.close();
  });

  it('lore-exempt: topic containing `lore:` never enters candidate set', () => {
    const db = makeDb();
    // lore slang topic — social-phrase canonical, but lore-exempt
    seed(db, 'opus-classified:slang:lore:晚安', 'lore greeting');
    seed(db, 'user-taught:slang:lore:宝宝', 'fandom addr');

    const result = runPurge({
      db, apply: true, verbose: false, log: () => {}, now: () => 1e12,
    });
    expect(result.found).toBe(0);
    expect(result.skippedLoreCount).toBe(1); // only the `opus-classified:slang:lore:...` matches the prefix filter + lore filter
    db.close();
  });

  it('already-rejected rows NOT re-flipped (no double-churn)', () => {
    const db = makeDb();
    seed(db, 'opus-classified:slang:贴贴', 'x', 'rejected');
    seed(db, 'opus-classified:slang:晚安', '晚安', 'x', 'active');

    const result = runPurge({
      db, apply: false, verbose: false, log: () => {},
    });
    expect(result.found).toBe(1); // rejected one filtered out
    db.close();
  });

  it('non-slang prefix topics untouched (e.g. user-taught non-slang)', () => {
    const db = makeDb();
    seed(db, 'user-taught:fandom:ykn', 'BanG Dream alias');
    seed(db, 'opus-classified:other:晚安', 'off-prefix');

    const result = runPurge({
      db, apply: true, verbose: false, log: () => {},
    });
    expect(result.found).toBe(0);
    db.close();
  });

  it('empty DB → found=0, updated=0, no error', () => {
    const db = makeDb();
    const result = runPurge({ db, apply: true, verbose: false, log: () => {} });
    expect(result.found).toBe(0);
    expect(result.updated).toBe(0);
    db.close();
  });

  it('verbose=true logs per-row detail', () => {
    const db = makeDb();
    seed(db, 'opus-classified:slang:贴贴', 'some fact');
    const lines: string[] = [];
    runPurge({ db, apply: false, verbose: true, log: (l) => lines.push(l) });
    const joined = lines.join('\n');
    expect(joined).toMatch(/\[id=\d+\].*term=贴贴/);
    db.close();
  });

  it('script source contains NO `DELETE FROM` (safety invariant)', async () => {
    const fs = await import('node:fs/promises');
    const url = new URL('../../scripts/maintenance/purge-social-phrase-facts.ts', import.meta.url);
    const src = await fs.readFile(url, 'utf8');
    expect(src).not.toMatch(/DELETE\s+FROM/i);
    expect(src).toMatch(/UPDATE learned_facts SET status = 'rejected'/);
  });
});
