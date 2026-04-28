import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runMigrate } from '../../scripts/maintenance/migrate-alias-prefix-to-colon.js';

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
  topic: string | null,
  fact: string,
  status: 'active' | 'pending' | 'rejected' | 'superseded' = 'active',
): number {
  db.prepare(
    `INSERT INTO learned_facts (id, group_id, topic, fact, source_user_id, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, TARGET_GROUP, topic, fact, null, status, 100, 100);
  return id;
}

function selectTopic(db: DatabaseSync, id: number): string | null {
  return (db.prepare('SELECT topic FROM learned_facts WHERE id = ?').get(id) as { topic: string | null }).topic;
}

function selectUpdatedAt(db: DatabaseSync, id: number): number {
  return (db.prepare('SELECT updated_at FROM learned_facts WHERE id = ?').get(id) as { updated_at: number }).updated_at;
}

function totalActiveSpace(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM learned_facts WHERE topic LIKE '群友别名 %' AND status='active'").get() as { n: number }).n;
}

function totalActiveColon(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM learned_facts WHERE topic LIKE '群友别名:%' AND status='active'").get() as { n: number }).n;
}

function seedFixture(db: DatabaseSync): void {
  // 5 active space-prefix rows - should migrate
  seed(db, 1, '群友别名 拉神',          '拉神 = 拉普兰德');
  seed(db, 2, '群友别名 飞鸟 / 谭博人', '飞鸟 = 谭博人');
  seed(db, 3, '群友别名 常山',          '常山 = NB常山');
  seed(db, 4, '群友别名 yu3',           'yu3 = some ASCII alias');
  seed(db, 5, '群友别名 园田美遊',      '园田美遊 = TX 園田美遊');

  // 2 already canonical colon - must NOT touch (idempotency)
  seed(db, 6, '群友别名:西瓜',     '西瓜 = 西瓜');
  seed(db, 7, '群友别名:SINO1900', 'SINO1900 = some person');

  // 1 superseded space - must NOT touch (status guard)
  seed(db, 8, '群友别名 qmyc', 'old', 'superseded');

  // 2 different prefix - out of scope
  seed(db, 9,  '群内黑话:jt',       'jt = a meme');
  seed(db, 10, 'user-taught:ykn',  'ykn = 凑友希那');
}

describe('migrate-alias-prefix-to-colon - runMigrate', () => {
  it('T1 dry-run: reports candidates, mutates nothing', () => {
    const db = makeDb();
    seedFixture(db);

    const before = {
      space: totalActiveSpace(db),
      colon: totalActiveColon(db),
      ts1: selectUpdatedAt(db, 1),
    };
    const lines: string[] = [];
    const result = runMigrate({
      db, apply: false, verbose: false,
      log: (l) => lines.push(l),
      now: () => 2_000_000_000_000,
    });

    expect(result.candidates).toBe(5);
    expect(result.applied).toBe(0);
    expect(totalActiveSpace(db)).toBe(before.space);
    expect(totalActiveColon(db)).toBe(before.colon);
    expect(selectUpdatedAt(db, 1)).toBe(before.ts1);
    expect(lines.some(l => l.startsWith('[DRY RUN]'))).toBe(true);
  });

  it('T2 apply: 5 space rows renamed; colon, superseded, other-prefix untouched', () => {
    const db = makeDb();
    seedFixture(db);

    const result = runMigrate({
      db, apply: true, verbose: false,
      log: () => {},
      now: () => 2_000_000_000_000,
    });

    expect(result.applied).toBe(5);
    expect(totalActiveSpace(db)).toBe(0);
    expect(totalActiveColon(db)).toBe(7);

    expect(selectTopic(db, 1)).toBe('群友别名:拉神');
    expect(selectTopic(db, 2)).toBe('群友别名:飞鸟 / 谭博人');
    expect(selectTopic(db, 3)).toBe('群友别名:常山');
    expect(selectTopic(db, 4)).toBe('群友别名:yu3');
    expect(selectTopic(db, 5)).toBe('群友别名:园田美遊');

    expect(selectTopic(db, 6)).toBe('群友别名:西瓜');
    expect(selectTopic(db, 7)).toBe('群友别名:SINO1900');

    expect(selectTopic(db, 8)).toBe('群友别名 qmyc');

    expect(selectTopic(db, 9)).toBe('群内黑话:jt');
    expect(selectTopic(db, 10)).toBe('user-taught:ykn');

    expect(selectUpdatedAt(db, 1)).toBe(2_000_000_000);
    expect(selectUpdatedAt(db, 6)).toBe(100);
  });

  it('T3 idempotent: second apply makes 0 changes', () => {
    const db = makeDb();
    seedFixture(db);

    runMigrate({ db, apply: true, verbose: false, log: () => {}, now: () => 2_000_000_000_000 });
    const result2 = runMigrate({
      db, apply: true, verbose: false,
      log: () => {},
      now: () => 2_500_000_000_000,
    });

    expect(result2.candidates).toBe(0);
    expect(result2.applied).toBe(0);
    expect(selectUpdatedAt(db, 1)).toBe(2_000_000_000);
  });

  it('T4 non-active rows skipped', () => {
    const db = makeDb();
    seed(db, 100, '群友别名 西瓜',   'active row',     'active');
    seed(db, 101, '群友别名 飞鸟',   'active row',     'active');
    seed(db, 102, '群友别名 常山',   'pending row',    'pending');
    seed(db, 103, '群友别名 大艾子', 'superseded row', 'superseded');

    runMigrate({ db, apply: true, verbose: false, log: () => {} });

    expect(selectTopic(db, 100)).toBe('群友别名:西瓜');
    expect(selectTopic(db, 101)).toBe('群友别名:飞鸟');
    expect(selectTopic(db, 102)).toBe('群友别名 常山');
    expect(selectTopic(db, 103)).toBe('群友别名 大艾子');
  });

  it('T5 limit exceeded: throws, rolls back, 0 changes', () => {
    const db = makeDb();
    for (let i = 1; i <= 5; i += 1) {
      seed(db, i, `群友别名 row${i}`, `fact ${i}`);
    }

    expect(() =>
      runMigrate({ db, apply: true, verbose: false, log: () => {}, limit: 3 }),
    ).toThrow(/exceeds --limit 3/);

    for (let i = 1; i <= 5; i += 1) {
      expect(selectTopic(db, i)).toBe(`群友别名 row${i}`);
    }
  });

  it('T6 empty-suffix rows skipped (EC2/EC7 guard)', () => {
    const db = makeDb();
    seed(db, 200, '群友别名 ',       'malformed empty');
    seed(db, 201, '群友别名    ',    'malformed all-space');
    seed(db, 202, '群友别名 拉神',   'normal row');
    seed(db, 203, '群友别名 飞鸟',   'normal row 2');

    const result = runMigrate({ db, apply: true, verbose: false, log: () => {} });

    expect(result.candidates).toBe(2);
    expect(result.applied).toBe(2);
    expect(selectTopic(db, 200)).toBe('群友别名 ');
    expect(selectTopic(db, 201)).toBe('群友别名    ');
    expect(selectTopic(db, 202)).toBe('群友别名:拉神');
    expect(selectTopic(db, 203)).toBe('群友别名:飞鸟');
  });
});
