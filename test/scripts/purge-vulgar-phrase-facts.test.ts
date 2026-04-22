import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runPurge } from '../../scripts/maintenance/purge-vulgar-phrase-facts.js';

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
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

describe('purge-vulgar-phrase-facts — runPurge', () => {
  it('dry-run: finds vulgar-dismissal rows across 3 prefixes, does NOT mutate', () => {
    const db = makeDb();
    // 3 x ondemand-lookup vulgar (incl. 你懂个毛 — matches prod factId=5488 shape).
    // NOTE: 去你的/滚你的 contain `的` which isValidStructuredTerm rejects, so they
    // could never have been inserted as topic-suffix in the first place; they
    // correctly round-trip as non-vulgar here (term extracts to null). Use only
    // 的-free vulgar canonicals in fixtures.
    seed(db, 'ondemand-lookup:你懂个毛', '粗俗回怼');
    seed(db, 'ondemand-lookup:懂个屁', '粗俗回怼');
    seed(db, 'ondemand-lookup:你个毛', '粗俗回怼');
    // 2 x opus-classified:slang vulgar
    seed(db, 'opus-classified:slang:你个屁', 'a');
    seed(db, 'opus-rest-classified:slang:你懂个毛', 'b');
    // 1 x lore-topic vulgar (exempt)
    seed(db, 'ondemand-lookup:lore:你懂个屁', 'lore-confirmed');
    // 1 x user-taught vulgar (not in prefix scope)
    seed(db, 'user-taught:你懂个毛', 'user-taught, exempt');
    // 2 x ondemand-lookup non-vulgar (must skip)
    seed(db, 'ondemand-lookup:ykn', 'fandom');
    seed(db, 'ondemand-lookup:laplace', 'fandom');

    const before = totalCount(db);
    const lines: string[] = [];
    const result = runPurge({
      db, apply: false, verbose: false,
      log: (l) => lines.push(l),
      now: () => 2_000_000_000_000,
    });

    expect(result.found).toBe(5);
    expect(result.updated).toBe(0);
    expect(result.skippedLoreCount).toBe(1);
    expect(result.skippedNonVulgarCount).toBe(2);
    expect(totalCount(db)).toBe(before);

    // nothing rejected yet
    const rej = db.prepare("SELECT COUNT(*) AS n FROM learned_facts WHERE status = 'rejected'").get() as { n: number };
    expect(rej.n).toBe(0);

    const joined = lines.join('\n');
    expect(joined).toMatch(/\[DRY RUN\]/);
    expect(joined).toMatch(/5 found, 0 would update/);
    expect(joined).toMatch(/lore-topic exempt\): 1/);
    expect(joined).toMatch(/non-vulgar canonical\): 2/);
    db.close();
  });

  it('--apply: flips ONLY matched rows to rejected; lore + user-taught + non-vulgar untouched; no DELETE', () => {
    const db = makeDb();
    const v1 = seed(db, 'ondemand-lookup:你懂个毛', 'a');
    const v2 = seed(db, 'ondemand-lookup:懂个屁', 'b');
    const v3 = seed(db, 'opus-classified:slang:你个屁', 'c');
    const v4 = seed(db, 'opus-rest-classified:slang:你懂个毛', 'd');
    const v5 = seed(db, 'ondemand-lookup:你个毛', 'e');
    const loreRow = seed(db, 'ondemand-lookup:lore:你懂个屁', 'lore-exempt');
    const userTaughtRow = seed(db, 'user-taught:你懂个毛', 'user-taught exempt');
    const nvYkn = seed(db, 'ondemand-lookup:ykn', 'fandom');
    const nvLap = seed(db, 'ondemand-lookup:laplace', 'fandom');

    const before = totalCount(db);
    const result = runPurge({
      db, apply: true, verbose: false,
      log: () => {},
      now: () => 1_700_000_000_000,
    });

    expect(result.found).toBe(5);
    expect(result.updated).toBe(5);
    expect(totalCount(db)).toBe(before); // no DELETE

    // 5 vulgar → rejected
    for (const id of [v1, v2, v3, v4, v5]) {
      expect(selectStatus(db, id)).toBe('rejected');
    }
    // exempt rows stay active
    expect(selectStatus(db, loreRow)).toBe('active');
    expect(selectStatus(db, userTaughtRow)).toBe('active');
    expect(selectStatus(db, nvYkn)).toBe('active');
    expect(selectStatus(db, nvLap)).toBe('active');

    // updated_at was written
    const nowSec = Math.floor(1_700_000_000_000 / 1000);
    const up = db.prepare('SELECT updated_at FROM learned_facts WHERE id = ?').get(v1) as { updated_at: number };
    expect(up.updated_at).toBe(nowSec);

    db.close();
  });

  it('lore-exempt: topic containing `lore:` never enters candidate set', () => {
    const db = makeDb();
    seed(db, 'ondemand-lookup:lore:你懂个毛', 'lore greeting');
    seed(db, 'opus-classified:slang:lore:懂个屁', 'fandom');

    const result = runPurge({
      db, apply: true, verbose: false, log: () => {}, now: () => 1e12,
    });
    expect(result.found).toBe(0);
    expect(result.skippedLoreCount).toBe(2);
    db.close();
  });

  it('user-taught vulgar row NOT touched (out-of-prefix)', () => {
    const db = makeDb();
    const id = seed(db, 'user-taught:你懂个毛', 'user curated');
    const result = runPurge({ db, apply: true, verbose: false, log: () => {} });
    expect(result.found).toBe(0);
    expect(selectStatus(db, id)).toBe('active');
    db.close();
  });

  it('群内黑话 vulgar row NOT touched (out-of-prefix)', () => {
    const db = makeDb();
    const id = seed(db, '群内黑话:你懂个毛', 'curated');
    const result = runPurge({ db, apply: true, verbose: false, log: () => {} });
    expect(result.found).toBe(0);
    expect(selectStatus(db, id)).toBe('active');
    db.close();
  });

  it('already-rejected rows NOT re-flipped (no double-churn)', () => {
    const db = makeDb();
    seed(db, 'ondemand-lookup:你懂个毛', 'x', 'rejected');
    seed(db, 'ondemand-lookup:懂个屁', 'y', 'active');

    const result = runPurge({ db, apply: false, verbose: false, log: () => {} });
    expect(result.found).toBe(1);
    db.close();
  });

  it('non-slang prefix topics untouched (e.g. opus-classified:fandom)', () => {
    const db = makeDb();
    seed(db, 'opus-classified:fandom:你懂个毛', 'fandom bucket');
    seed(db, 'passive:你懂个毛', 'passive bucket');
    seed(db, 'online-research:你懂个毛', 'research bucket');

    const result = runPurge({ db, apply: true, verbose: false, log: () => {} });
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
    seed(db, 'ondemand-lookup:你懂个毛', 'some fact');
    const lines: string[] = [];
    runPurge({ db, apply: false, verbose: true, log: (l) => lines.push(l) });
    const joined = lines.join('\n');
    expect(joined).toMatch(/\[id=\d+\].*term=你懂个毛/);
    db.close();
  });

  it('script source contains NO `DELETE FROM` (safety invariant)', async () => {
    const fs = await import('node:fs/promises');
    const url = new URL('../../scripts/maintenance/purge-vulgar-phrase-facts.ts', import.meta.url);
    const src = await fs.readFile(url, 'utf8');
    expect(src).not.toMatch(/DELETE\s+FROM/i);
    expect(src).toMatch(/UPDATE learned_facts SET status = 'rejected'/);
  });
});
