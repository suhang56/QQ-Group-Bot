import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runPurge, parseArgs } from '../../scripts/maintenance/purge-alias-misclassifications.js';

const TARGET_GROUP = '958751334';

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS learned_facts (
      id                INTEGER PRIMARY KEY,
      group_id          TEXT    NOT NULL,
      topic             TEXT,
      canonical_form    TEXT,
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
  id: number,
  groupId: string,
  topic: string | null,
  canonicalForm: string | null,
  fact: string,
  status: 'active' | 'pending' | 'rejected' | 'superseded' = 'active',
  createdAt = 100,
  updatedAt = 100,
): number {
  db.prepare(
    `INSERT INTO learned_facts
       (id, group_id, topic, canonical_form, fact, source_user_id, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id, groupId, topic, canonicalForm, fact, null, status, createdAt, updatedAt);
  return id;
}

function selectStatus(db: DatabaseSync, id: number): string {
  return (db.prepare('SELECT status FROM learned_facts WHERE id = ?').get(id) as { status: string }).status;
}

function selectUpdatedAt(db: DatabaseSync, id: number): number {
  return (db.prepare('SELECT updated_at FROM learned_facts WHERE id = ?').get(id) as { updated_at: number }).updated_at;
}

function totalCount(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM learned_facts').get() as { n: number }).n;
}

function seedFixture(db: DatabaseSync) {
  // 5 in-list active 群友别名 rows — expect superseded
  seed(db,  46, TARGET_GROUP, '群友别名:洛天依', '洛天依', '洛天依 = someone alias', 'active');
  seed(db, 530, TARGET_GROUP, '群友别名:钉宫',   '钉宫',   '钉宫 = QQ alias',         'active');
  seed(db, 544, TARGET_GROUP, '群友别名:山新',   '山新',   '山新 = QQ alias',         'active');
  seed(db,  66, TARGET_GROUP, '群友别名:艾斯比', '艾斯比', '艾斯比 = someone alias',  'active');
  seed(db, 159, TARGET_GROUP, '群友别名:a380',   'a380',   'a380 = someone alias',    'active');

  // In-list + already-superseded -> skipped-already-superseded
  seed(db, 872, TARGET_GROUP, '群友别名:hyw',    'hyw',    'hyw = QQ alias',          'superseded');

  // In-list id but wrong topic -> skipped-wrong-topic
  seed(db, 158, TARGET_GROUP, 'nga:something',  'nga_term', 'nga row sharing in-list id', 'active');

  // Controls — NOT in-list, must remain untouched
  seed(db,  300, TARGET_GROUP, '群友别名:真实成员甲', '真实成员甲', 'legit alias A',          'active');
  seed(db,  301, TARGET_GROUP, '群友别名:真实成员乙', '真实成员乙', 'legit alias B',          'active');
  seed(db,  400, TARGET_GROUP, 'user-taught:foo',     'foo_term',   'user-taught fact',       'active');
  seed(db, 1001, TARGET_GROUP, '群友别名:新成员别名', '新成员别名', 'post-audit alias',       'active');
}

describe('purge-alias-misclassifications — runPurge', () => {

  it('t1 dry-run: 5 eligible, 1 already-superseded, 1 wrong-topic, mutates nothing', () => {
    const db = makeDb();
    seedFixture(db);
    const before = totalCount(db);
    const lines: string[] = [];

    const result = runPurge({
      db, apply: false, verbose: false,
      log: (l) => lines.push(l),
      now: () => 2_000_000_000_000,
    });

    expect(result.totalPlanned).toBe(45);
    expect(result.eligible).toBe(5);
    expect(result.applied).toBe(0);
    expect(result.skippedAlreadySuperseded).toBe(1);
    expect(result.skippedWrongTopic).toBe(1);
    expect(result.skippedNonexistent).toBe(38);

    expect(totalCount(db)).toBe(before);
    for (const id of [46, 530, 544, 66, 159]) {
      expect(selectStatus(db, id)).toBe('active');
      expect(selectUpdatedAt(db, id)).toBe(100);
    }
    expect(selectStatus(db, 872)).toBe('superseded');
    expect(selectUpdatedAt(db, 872)).toBe(100);
    expect(selectStatus(db, 158)).toBe('active');
    expect(selectUpdatedAt(db, 158)).toBe(100);
    for (const id of [300, 301, 400, 1001]) {
      expect(selectStatus(db, id)).toBe('active');
      expect(selectUpdatedAt(db, id)).toBe(100);
    }

    const joined = lines.join('\n');
    expect(joined).toMatch(/\[DRY RUN\]/);
    expect(joined).toMatch(/Would supersede 5 of 45 candidates/);
    expect(joined).toMatch(/0 superseded \/ 1 already-superseded \/ 1 wrong-topic \/ 38 nonexistent/);
    db.close();
  });

  it('t2 --apply: 5 in-list flipped to superseded; 872/158/300/301/400/1001 untouched; updated_at advances only on flipped', () => {
    const db = makeDb();
    seedFixture(db);
    const before = totalCount(db);

    const result = runPurge({
      db, apply: true, verbose: false,
      log: () => {},
      now: () => 1_700_000_000_000,
    });

    expect(result.applied).toBe(5);
    expect(result.eligible).toBe(5);
    expect(totalCount(db)).toBe(before);

    const nowSec = Math.floor(1_700_000_000_000 / 1000);
    for (const id of [46, 530, 544, 66, 159]) {
      expect(selectStatus(db, id)).toBe('superseded');
      expect(selectUpdatedAt(db, id)).toBe(nowSec);
    }
    expect(selectStatus(db, 872)).toBe('superseded');
    expect(selectUpdatedAt(db, 872)).toBe(100);
    expect(selectStatus(db, 158)).toBe('active');
    expect(selectUpdatedAt(db, 158)).toBe(100);
    for (const id of [300, 301, 400, 1001]) {
      expect(selectStatus(db, id)).toBe('active');
      expect(selectUpdatedAt(db, id)).toBe(100);
    }
    db.close();
  });

  it('t3 idempotency: second --apply changes nothing, updated_at frozen at first run', () => {
    const db = makeDb();
    seed(db,  46, TARGET_GROUP, '群友别名:洛天依', '洛天依', 'a', 'active');
    seed(db, 530, TARGET_GROUP, '群友别名:钉宫',   '钉宫',   'b', 'active');
    seed(db, 544, TARGET_GROUP, '群友别名:山新',   '山新',   'c', 'active');

    runPurge({ db, apply: true, verbose: false, log: () => {}, now: () => 1_700_000_000_000 });
    const r2 = runPurge({ db, apply: true, verbose: false, log: () => {}, now: () => 1_800_000_000_000 });

    expect(r2.applied).toBe(0);
    expect(r2.eligible).toBe(0);
    expect(r2.skippedAlreadySuperseded).toBe(3);

    const firstNowSec = Math.floor(1_700_000_000_000 / 1000);
    for (const id of [46, 530, 544]) {
      expect(selectStatus(db, id)).toBe('superseded');
      expect(selectUpdatedAt(db, id)).toBe(firstNowSec);
    }
    db.close();
  });

  it('t4 out-of-scope prefix on in-list ids: zero updated, all rows still active', () => {
    const db = makeDb();
    seed(db,  46, TARGET_GROUP, '群内黑话',         '洛天依', 'a', 'active');
    seed(db, 530, TARGET_GROUP, '群内黑话',         '钉宫',   'b', 'active');
    seed(db, 544, TARGET_GROUP, '群内黑话',         '山新',   'c', 'active');
    seed(db,  66, TARGET_GROUP, 'user-taught:foo',  '艾斯比', 'd', 'active');
    seed(db, 159, TARGET_GROUP, 'user-taught:foo',  'a380',   'e', 'active');

    const result = runPurge({ db, apply: true, verbose: false, log: () => {} });

    expect(result.applied).toBe(0);
    expect(result.eligible).toBe(0);
    expect(result.skippedWrongTopic).toBe(5);
    for (const id of [46, 530, 544, 66, 159]) {
      expect(selectStatus(db, id)).toBe('active');
      expect(selectUpdatedAt(db, id)).toBe(100);
    }
    db.close();
  });

  it('t5 parseArgs returns null when --db-path missing or malformed', () => {
    expect(parseArgs([])).toBeNull();
    expect(parseArgs(['--apply'])).toBeNull();
    expect(parseArgs(['--db-path'])).toBeNull();
    expect(parseArgs(['--db-path', '/tmp/x.db'])).toEqual({
      dbPath: '/tmp/x.db', apply: false, verbose: false, limit: 100,
    });
    expect(parseArgs(['--db-path', '/tmp/x.db', '--apply', '--verbose'])).toEqual({
      dbPath: '/tmp/x.db', apply: true, verbose: true, limit: 100,
    });
    expect(parseArgs(['--db-path', '/tmp/x.db', '--limit', 'abc'])).toBeNull();
    expect(parseArgs(['--db-path', '/tmp/x.db', '--limit', '50'])).toEqual({
      dbPath: '/tmp/x.db', apply: false, verbose: false, limit: 50,
    });
  });

  it('t6 source invariant: no DELETE, correct guards, no widened LIKE, transaction tokens present', async () => {
    const fs = await import('node:fs/promises');
    const url = new URL('../../scripts/maintenance/purge-alias-misclassifications.ts', import.meta.url);
    const src = await fs.readFile(url, 'utf8');

    expect(src).not.toMatch(/DELETE\s+FROM/i);
    expect(src).toMatch(/status = 'superseded'/);
    expect(src).toMatch(/topic LIKE '群友别名%'/);
    expect(src).toMatch(/AND status = 'active'/);
    expect(src).not.toMatch(/LIKE '群友%'/);
    expect(src).toMatch(/db\.exec\('BEGIN'\)/);
    expect(src).toMatch(/db\.exec\('COMMIT'\)/);
    expect(src).toMatch(/db\.exec\('ROLLBACK'\)/);
    expect(src).toMatch(/SUPERSEDE_IDS\.length !== 45/);
  });

  it('t7 nonexistent ids: empty DB -> applied=0, skippedNonexistent=45, no throw', () => {
    const db = makeDb();
    const result = runPurge({ db, apply: true, verbose: false, log: () => {} });
    expect(result.applied).toBe(0);
    expect(result.eligible).toBe(0);
    expect(result.skippedNonexistent).toBe(45);
    expect(result.skippedAlreadySuperseded).toBe(0);
    expect(result.skippedWrongTopic).toBe(0);
    db.close();
  });

  it('t8 limit: refuses to write when eligible > limit, no partial commit', () => {
    const db = makeDb();
    seed(db,  46, TARGET_GROUP, '群友别名:a', '洛天依', 'a', 'active');
    seed(db, 530, TARGET_GROUP, '群友别名:b', '钉宫',   'b', 'active');
    seed(db, 544, TARGET_GROUP, '群友别名:c', '山新',   'c', 'active');
    seed(db,  66, TARGET_GROUP, '群友别名:d', '艾斯比', 'd', 'active');
    seed(db, 159, TARGET_GROUP, '群友别名:e', 'a380',   'e', 'active');

    expect(() =>
      runPurge({ db, apply: true, verbose: false, limit: 3, log: () => {} }),
    ).toThrow(/exceeds --limit 3/);

    for (const id of [46, 530, 544, 66, 159]) {
      expect(selectStatus(db, id)).toBe('active');
      expect(selectUpdatedAt(db, id)).toBe(100);
    }
    db.close();
  });
});
