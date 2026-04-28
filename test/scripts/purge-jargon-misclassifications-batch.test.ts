import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runPurge, parseArgs } from '../../scripts/maintenance/purge-jargon-misclassifications-batch.js';

const TARGET_GROUP = '958751334';

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS learned_facts (
      id                     INTEGER PRIMARY KEY,
      group_id               TEXT    NOT NULL,
      topic                  TEXT,
      canonical_form         TEXT,
      fact                   TEXT    NOT NULL,
      source_user_id         TEXT,
      source_user_nickname   TEXT,
      status                 TEXT    NOT NULL DEFAULT 'active',
      created_at             INTEGER NOT NULL DEFAULT 0,
      updated_at             INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function seed(
  db: DatabaseSync,
  id: number,
  groupId: string,
  topic: string | null,
  canonicalForm: string | null,
  fact: string,
  status: 'active' | 'pending' | 'rejected' | 'superseded' = 'active',
  createdAt = 100,
  updatedAt = 100,
  sourceUserNickname: string | null = 'user',
): number {
  db.prepare(
    `INSERT INTO learned_facts
       (id, group_id, topic, canonical_form, fact,
        source_user_id, source_user_nickname,
        status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, groupId, topic, canonicalForm, fact, null, sourceUserNickname, status, createdAt, updatedAt);
  return id;
}

function selectStatus(db: DatabaseSync, id: number): string {
  return (db.prepare('SELECT status FROM learned_facts WHERE id = ?').get(id) as { status: string }).status;
}

function selectUpdatedAt(db: DatabaseSync, id: number): number {
  return (db.prepare('SELECT updated_at FROM learned_facts WHERE id = ?').get(id) as { updated_at: number }).updated_at;
}

function seedFixture(db: DatabaseSync) {
  // List 1 active (3 rows) — expect superseded
  seed(db, 3070, TARGET_GROUP, '群内黑话', null, 'jargon a', 'active', 100, 100, 'user');
  seed(db, 3100, TARGET_GROUP, '群内黑话', null, 'jargon b', 'active', 100, 100, 'user');
  seed(db, 3132, TARGET_GROUP, '群内黑话', null, 'jargon c', 'active', 100, 100, 'user');

  // List 1 already-superseded — expect skipped-already-superseded
  seed(db, 3200, TARGET_GROUP, '群内黑话', null, 'jargon d', 'superseded', 100, 100, 'user');

  // List 2 active (2 rows) — expect superseded
  seed(db, 8801, TARGET_GROUP, 'opus-rest-classified:slang/foo',  null, 'l2 a', 'active',     1776505050, 1776505050, 'opus-classifier-rest');
  seed(db, 8802, TARGET_GROUP, 'opus-rest-classified:fandom/bar', null, 'l2 b', 'active',     1776505050, 1776505050, 'opus-classifier-rest');

  // List 2 already-superseded — should be excluded by SELECT (status filter)
  seed(db, 8803, TARGET_GROUP, 'opus-rest-classified:slang/baz',  null, 'l2 c', 'superseded', 1776505050, 1776505050, 'opus-classifier-rest');

  // KEEP rows — must NOT be touched
  seed(db, 3763, TARGET_GROUP, '群内黑话', null, 'KEEP 莲之空万岁', 'active', 100, 100, 'user');
  seed(db, 3971, TARGET_GROUP, '群内黑话', null, 'KEEP 我忏悔',     'active', 100, 100, 'user');
  seed(db, 3972, TARGET_GROUP, '群内黑话', null, 'KEEP 犯过错',     'active', 100, 100, 'user');

  // Unrelated prefixes — must NOT be touched
  seed(db, 9901, TARGET_GROUP, '群友别名:观夜',                null, 'alias',      'active', 100, 100, 'user');
  seed(db, 9902, TARGET_GROUP, 'opus-classified:slang:strong', null, 'classified', 'active', 100, 100, 'user');

  // List 2 lookalike — same created_at but wrong nickname — must NOT be picked up
  seed(db, 8804, TARGET_GROUP, 'opus-rest-classified:slang/qux', null, 'wrong source', 'active', 1776505050, 1776505050, 'human-poster');

  // Unvetted bare-topic 群内黑话 NOT in SUPERSEDE_IDS — must NOT be touched
  seed(db, 9903, TARGET_GROUP, '群内黑话', null, 'unvetted', 'active', 100, 100, 'user');
}

describe('purge-jargon-misclassifications-batch — runPurge', () => {

  it('t1 dry-run: nothing mutates; eligible=5 (List1=3 + List2=2); log shows DRY RUN + Would supersede', () => {
    const db = makeDb();
    seedFixture(db);
    const lines: string[] = [];

    const result = runPurge({
      db, apply: false, verbose: false,
      log: (l) => lines.push(l),
      now: () => 2_000_000_000_000,
    });

    expect(result.eligible).toBe(5);
    expect(result.applied).toBe(0);
    expect(result.list1Applied).toBe(0);
    expect(result.list2Applied).toBe(0);
    expect(result.list2Fetched).toBe(2);
    expect(result.skippedAlreadySuperseded).toBeGreaterThanOrEqual(1);

    for (const id of [3070, 3100, 3132, 8801, 8802, 3763, 3971, 3972, 9901, 9902, 8804, 9903]) {
      expect(selectStatus(db, id)).toBe('active');
    }
    expect(selectStatus(db, 3200)).toBe('superseded');
    expect(selectStatus(db, 8803)).toBe('superseded');

    const joined = lines.join('\n');
    expect(joined).toMatch(/\[DRY RUN\]/);
    expect(joined).toMatch(/Would supersede 5 rows \(List1=3, List2=2\)/);
    db.close();
  });

  it('t2 --apply: 3 List1 + 2 List2 superseded; KEEP/unrelated/wrong-source untouched; updated_at advances only on flipped', () => {
    const db = makeDb();
    seedFixture(db);
    const NOW_MS = 1_700_000_000_000;
    const NOW_SEC = Math.floor(NOW_MS / 1000);

    const result = runPurge({
      db, apply: true, verbose: false,
      log: () => {},
      now: () => NOW_MS,
    });

    expect(result.applied).toBe(5);
    expect(result.list1Applied).toBe(3);
    expect(result.list2Applied).toBe(2);
    expect(result.list2Fetched).toBe(2);

    for (const id of [3070, 3100, 3132, 8801, 8802]) {
      expect(selectStatus(db, id)).toBe('superseded');
      expect(selectUpdatedAt(db, id)).toBe(NOW_SEC);
    }
    for (const id of [3763, 3971, 3972, 9901, 9902, 9903]) {
      expect(selectStatus(db, id)).toBe('active');
      expect(selectUpdatedAt(db, id)).toBe(100);
    }
    // 8804 was seeded with updated_at=1776505050 (List 2 lookalike) — must
    // remain unchanged because its source_user_nickname excludes it from List 2.
    expect(selectStatus(db, 8804)).toBe('active');
    expect(selectUpdatedAt(db, 8804)).toBe(1776505050);
    expect(selectStatus(db, 3200)).toBe('superseded');
    expect(selectUpdatedAt(db, 3200)).toBe(100);
    expect(selectStatus(db, 8803)).toBe('superseded');
    expect(selectUpdatedAt(db, 8803)).toBe(1776505050);
    db.close();
  });

  it('t3 idempotency: second --apply changes nothing; both lists report 0 applied', () => {
    const db = makeDb();
    seedFixture(db);

    runPurge({ db, apply: true, verbose: false, log: () => {}, now: () => 1_700_000_000_000 });
    const r2 = runPurge({ db, apply: true, verbose: false, log: () => {}, now: () => 1_800_000_000_000 });

    expect(r2.applied).toBe(0);
    expect(r2.eligible).toBe(0);
    expect(r2.list1Applied).toBe(0);
    expect(r2.list2Applied).toBe(0);
    expect(r2.list2Fetched).toBe(0);

    const firstNowSec = Math.floor(1_700_000_000_000 / 1000);
    for (const id of [3070, 3100, 3132, 8801, 8802]) {
      expect(selectStatus(db, id)).toBe('superseded');
      expect(selectUpdatedAt(db, id)).toBe(firstNowSec);
    }
    db.close();
  });

  it('t4 List 2 SELECT scope: created_at match but wrong source_user_nickname is excluded', () => {
    const db = makeDb();
    seed(db, 8804, TARGET_GROUP, 'opus-rest-classified:slang/qux', null, 'wrong source', 'active', 1776505050, 1776505050, 'human-poster');
    seed(db, 7777, TARGET_GROUP, 'opus-rest-classified:fandom/yes', null, 'right source', 'active', 1776505050, 1776505050, 'opus-classifier-rest');

    const result = runPurge({ db, apply: true, verbose: false, log: () => {} });

    expect(result.list2Fetched).toBe(1);
    expect(result.list2Applied).toBe(1);
    expect(selectStatus(db, 7777)).toBe('superseded');
    expect(selectStatus(db, 8804)).toBe('active');
    db.close();
  });

  it('t5 parseArgs: --db-path required; --limit defaults 500; rejects malformed --limit', () => {
    expect(parseArgs([])).toBeNull();
    expect(parseArgs(['--apply'])).toBeNull();
    expect(parseArgs(['--db-path'])).toBeNull();
    expect(parseArgs(['--db-path', '/tmp/x.db'])).toEqual({
      dbPath: '/tmp/x.db', apply: false, verbose: false, limit: 500,
    });
    expect(parseArgs(['--db-path', '/tmp/x.db', '--apply', '--verbose'])).toEqual({
      dbPath: '/tmp/x.db', apply: true, verbose: true, limit: 500,
    });
    expect(parseArgs(['--db-path', '/tmp/x.db', '--limit', 'abc'])).toBeNull();
    expect(parseArgs(['--db-path', '/tmp/x.db', '--limit', '50'])).toEqual({
      dbPath: '/tmp/x.db', apply: false, verbose: false, limit: 50,
    });
  });

  it('t6 KEEP rows untouched; List 1 wrong-topic id (PR1-migrated) is skipped, not updated', () => {
    const db = makeDb();
    seed(db, 3763, TARGET_GROUP, '群内黑话', null, 'KEEP A', 'active', 100, 100, 'user');
    seed(db, 3971, TARGET_GROUP, '群内黑话', null, 'KEEP B', 'active', 100, 100, 'user');
    seed(db, 3972, TARGET_GROUP, '群内黑话', null, 'KEEP C', 'active', 100, 100, 'user');
    // List 1 id but topic is non-jargon (PR1 reclassified) — must skip-wrong-topic.
    seed(db, 3070, TARGET_GROUP, 'nga:something', null, 'wrong topic', 'active', 100, 100, 'user');

    const result = runPurge({ db, apply: true, verbose: false, log: () => {} });

    expect(selectStatus(db, 3763)).toBe('active');
    expect(selectStatus(db, 3971)).toBe('active');
    expect(selectStatus(db, 3972)).toBe('active');
    expect(selectStatus(db, 3070)).toBe('active');
    expect(result.skippedWrongTopic).toBeGreaterThanOrEqual(1);
    expect(result.list1Applied).toBe(0);
    db.close();
  });

  it('t7 source invariant: no DELETE; correct guards; transaction tokens; locked SUPERSEDE_IDS length', async () => {
    const fs = await import('node:fs/promises');
    const url = new URL('../../scripts/maintenance/purge-jargon-misclassifications-batch.ts', import.meta.url);
    const src = await fs.readFile(url, 'utf8');

    expect(src).not.toMatch(/DELETE\s+FROM/i);
    expect(src).toMatch(/status = 'superseded'/);
    expect(src).toMatch(/AND status = 'active'/);
    expect(src).toMatch(/db\.exec\('BEGIN'\)/);
    expect(src).toMatch(/db\.exec\('COMMIT'\)/);
    expect(src).toMatch(/db\.exec\('ROLLBACK'\)/);
    expect(src).toMatch(/created_at = 1776505050/);
    expect(src).toMatch(/source_user_nickname = 'opus-classifier-rest'/);
    expect(src).toMatch(/SUPERSEDE_IDS\.length !== 99/);

    // KEEP ids must NOT appear in the SUPERSEDE_IDS literal block; they MAY
    // appear in the KEEP_IDS array and assert messages — gate on the
    // SUPERSEDE_IDS literal only.
    const supersedeBlockMatch = src.match(/const SUPERSEDE_IDS[\s\S]*?\] as const;/);
    expect(supersedeBlockMatch).not.toBeNull();
    const supersedeBlock = supersedeBlockMatch![0];
    expect(supersedeBlock).not.toMatch(/\b3763\b/);
    expect(supersedeBlock).not.toMatch(/\b3971\b/);
    expect(supersedeBlock).not.toMatch(/\b3972\b/);
  });

  it('t8 limit guard: refuses to write when combined eligible > limit; no partial commit', () => {
    const db = makeDb();
    seed(db, 3070, TARGET_GROUP, '群内黑话', null, 'a', 'active', 100, 100, 'user');
    seed(db, 3100, TARGET_GROUP, '群内黑话', null, 'b', 'active', 100, 100, 'user');
    seed(db, 3132, TARGET_GROUP, '群内黑话', null, 'c', 'active', 100, 100, 'user');

    expect(() =>
      runPurge({ db, apply: true, verbose: false, limit: 2, log: () => {} }),
    ).toThrow(/exceeds --limit 2/);

    for (const id of [3070, 3100, 3132]) {
      expect(selectStatus(db, id)).toBe('active');
      expect(selectUpdatedAt(db, id)).toBe(100);
    }
    db.close();
  });
});
