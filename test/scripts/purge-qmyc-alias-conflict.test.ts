import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runPurge } from '../../scripts/maintenance/purge-qmyc-alias-conflict.js';

const TARGET_GROUP = '958751334';

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS learned_facts (
      id                INTEGER PRIMARY KEY,
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
  id: number,
  groupId: string,
  topic: string,
  fact: string,
  status: 'active' | 'pending' | 'rejected' | 'superseded' = 'active',
): number {
  db.prepare(
    'INSERT INTO learned_facts (id, group_id, topic, fact, source_user_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run(id, groupId, topic, fact, null, status, 100, 100);
  return id;
}

function selectStatus(db: DatabaseSync, id: number): string {
  return (db.prepare('SELECT status FROM learned_facts WHERE id = ?').get(id) as { status: string }).status;
}

function totalCount(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM learned_facts').get() as { n: number }).n;
}

/** Seed the 6-row prod-shaped fixture from DESIGNER-SPEC §2. */
function seedProdFixture(db: DatabaseSync) {
  seed(db, 531,  TARGET_GROUP, '群友别名:qmyc', 'qmyc = 西瓜🍉 (QQ 2331924739)', 'active');
  seed(db, 637,  TARGET_GROUP, '群友别名:qmyc', 'qmyc = 青木阳菜 (QQ 2331924739)', 'active');
  seed(db, 2081, TARGET_GROUP, 'nga:声优',     '青木阳菜 (qmyc) 是…',           'active');
  seed(db, 4573, TARGET_GROUP, '群友别名:ygfn', 'ygfn = 羊宫妃那',              'active');
  seed(db, 700,  TARGET_GROUP, '群友别名:qmyc', 'qmyc = 某人 (QQ 999)',         'pending');
  seed(db, 800,  TARGET_GROUP, '群友别名:qmyc', 'qmyc = 旧数据',                'rejected');
}

describe('purge-qmyc-alias-conflict — runPurge', () => {
  it('S1+S2 dry-run: finds id 531 and 637, mutates nothing', () => {
    const db = makeDb();
    seedProdFixture(db);

    const before = totalCount(db);
    const lines: string[] = [];
    const result = runPurge({
      db, apply: false, verbose: false,
      log: (l) => lines.push(l),
      now: () => 2_000_000_000_000,
    });

    expect(result.found).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.matched.map(r => r.id).sort()).toEqual([531, 637]);
    expect(totalCount(db)).toBe(before);

    // nothing flipped
    expect(selectStatus(db, 531)).toBe('active');
    expect(selectStatus(db, 637)).toBe('active');

    const joined = lines.join('\n');
    expect(joined).toMatch(/\[DRY RUN\]/);
    expect(joined).toMatch(/2 found, 0 would update/);
    db.close();
  });

  it('S1+S2 --apply: flips id 531 and 637 to rejected; N1–N5 stay put; no DELETE', () => {
    const db = makeDb();
    seedProdFixture(db);

    const before = totalCount(db);
    const result = runPurge({
      db, apply: true, verbose: false,
      log: () => {},
      now: () => 1_700_000_000_000,
    });

    expect(result.found).toBe(2);
    expect(result.updated).toBe(2);
    expect(totalCount(db)).toBe(before); // no DELETE

    // S1, S2: flipped
    expect(selectStatus(db, 531)).toBe('rejected');
    expect(selectStatus(db, 637)).toBe('rejected');

    // N1: nga:声优 topic stays active (id not in set)
    expect(selectStatus(db, 2081)).toBe('active');
    // N2: pending qmyc row untouched (status filter)
    expect(selectStatus(db, 700)).toBe('pending');
    // N3: rejected qmyc row untouched (status filter, no double-write)
    expect(selectStatus(db, 800)).toBe('rejected');
    // N5: ygfn alias row untouched (id not in set)
    expect(selectStatus(db, 4573)).toBe('active');

    // updated_at written for the two flipped rows
    const nowSec = Math.floor(1_700_000_000_000 / 1000);
    const r531 = db.prepare('SELECT updated_at FROM learned_facts WHERE id = ?').get(531) as { updated_at: number };
    const r637 = db.prepare('SELECT updated_at FROM learned_facts WHERE id = ?').get(637) as { updated_at: number };
    expect(r531.updated_at).toBe(nowSec);
    expect(r637.updated_at).toBe(nowSec);

    // updated_at on untouched rows did NOT move
    const r2081 = db.prepare('SELECT updated_at FROM learned_facts WHERE id = ?').get(2081) as { updated_at: number };
    expect(r2081.updated_at).toBe(100);

    db.close();
  });

  it('N4: id 531/637 in a different group_id → untouched (group_id filter)', () => {
    const db = makeDb();
    // Same ids, but wrong group. Use fresh DB so PK does not collide with prod fixture.
    seed(db, 531, '000000000', '群友别名:qmyc', 'qmyc = 西瓜🍉 (QQ 2331924739)', 'active');
    seed(db, 637, '000000000', '群友别名:qmyc', 'qmyc = 青木阳菜 (QQ 2331924739)', 'active');

    const result = runPurge({ db, apply: true, verbose: false, log: () => {} });

    expect(result.found).toBe(0);
    expect(result.updated).toBe(0);
    expect(selectStatus(db, 531)).toBe('active');
    expect(selectStatus(db, 637)).toBe('active');
    db.close();
  });

  it('superseded status → untouched (status filter excludes superseded)', () => {
    const db = makeDb();
    seed(db, 531, TARGET_GROUP, '群友别名:qmyc', 'qmyc = 西瓜🍉 (QQ 2331924739)', 'superseded');
    seed(db, 637, TARGET_GROUP, '群友别名:qmyc', 'qmyc = 青木阳菜 (QQ 2331924739)', 'superseded');

    const result = runPurge({ db, apply: true, verbose: false, log: () => {} });

    expect(result.found).toBe(0);
    expect(selectStatus(db, 531)).toBe('superseded');
    expect(selectStatus(db, 637)).toBe('superseded');
    db.close();
  });

  it('fact LIKE belt-and-suspenders: id 531 with fact missing "qmyc" → untouched', () => {
    const db = makeDb();
    // Hypothetical drift: fact text edited to no longer contain `qmyc`. The
    // id-set still matches but the fact LIKE rail prevents the UPDATE.
    seed(db, 531, TARGET_GROUP, '群友别名:qmyc', '已被人手动改过内容', 'active');
    seed(db, 637, TARGET_GROUP, '群友别名:qmyc', 'qmyc = 青木阳菜 (QQ 2331924739)', 'active');

    const result = runPurge({ db, apply: true, verbose: false, log: () => {} });

    expect(result.found).toBe(1);
    expect(result.matched[0]!.id).toBe(637);
    expect(selectStatus(db, 531)).toBe('active'); // safety rail held
    expect(selectStatus(db, 637)).toBe('rejected');
    db.close();
  });

  it('N6: dry-run is the default (no --apply flag) — zero writes, found still reported', () => {
    const db = makeDb();
    seedProdFixture(db);

    const lines: string[] = [];
    const result = runPurge({ db, apply: false, verbose: false, log: (l) => lines.push(l) });

    expect(result.found).toBe(2);
    expect(result.updated).toBe(0);
    expect(selectStatus(db, 531)).toBe('active');
    expect(selectStatus(db, 637)).toBe('active');
    expect(lines.join('\n')).toMatch(/\[DRY RUN\]/);
    db.close();
  });

  it('N7: in-process dry-run on matched rows → result.updated === 0, DB rows unchanged', () => {
    const db = makeDb();
    seedProdFixture(db);

    const result = runPurge({ db, apply: false, verbose: false, log: () => {} });

    expect(result.matched.map(r => r.id).sort()).toEqual([531, 637]);
    expect(result.updated).toBe(0);
    expect(selectStatus(db, 531)).toBe('active');
    expect(selectStatus(db, 637)).toBe('active');
    db.close();
  });

  it('verbose=true logs per-row id/topic/fact detail', () => {
    const db = makeDb();
    seedProdFixture(db);

    const lines: string[] = [];
    runPurge({ db, apply: false, verbose: true, log: (l) => lines.push(l) });
    const joined = lines.join('\n');
    expect(joined).toMatch(/\[id=531\].*topic=群友别名:qmyc/);
    expect(joined).toMatch(/\[id=637\].*topic=群友别名:qmyc/);
    db.close();
  });

  it('empty DB → found=0, updated=0, no error', () => {
    const db = makeDb();
    const result = runPurge({ db, apply: true, verbose: false, log: () => {} });
    expect(result.found).toBe(0);
    expect(result.updated).toBe(0);
    db.close();
  });

  it('script source contains NO `DELETE FROM` (safety invariant) and keeps all 4 SQL safety rails', async () => {
    const fs = await import('node:fs/promises');
    const url = new URL('../../scripts/maintenance/purge-qmyc-alias-conflict.ts', import.meta.url);
    const src = await fs.readFile(url, 'utf8');
    expect(src).not.toMatch(/DELETE\s+FROM/i);
    expect(src).toMatch(/UPDATE learned_facts SET status = 'rejected'/);
    // Byte-exact safety rails
    expect(src).toMatch(/id IN \(531, 637\)/);
    expect(src).toMatch(/status = 'active'/);
    expect(src).toMatch(/group_id = '958751334'/);
    expect(src).toMatch(/fact LIKE '%qmyc%'/);
  });
});
