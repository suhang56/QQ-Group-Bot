import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runPurge } from '../../scripts/maintenance/purge-classified-fandom-dups.js';

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
  // Dup pair A — opus-rest-classified:fandom:ykn
  seed(db, 101, TARGET_GROUP, 'opus-rest-classified:fandom:ykn', '凑友希那', 'ykn = 凑友希那 (BanG Dream)', 'active');
  seed(db, 102, TARGET_GROUP, 'opus-rest-classified:fandom:ykn', '凑友希那', 'ykn = 凑友希那', 'active');

  // Dup pair B — opus-rest-classified:slang:Pro
  seed(db, 201, TARGET_GROUP, 'opus-rest-classified:slang:Pro', '草', 'Pro = 草', 'active');
  seed(db, 202, TARGET_GROUP, 'opus-rest-classified:slang:Pro', '草', 'Pro means 草', 'active');

  // True conflict (same topic, different canonical_form) — KEEP both
  seed(db, 301, TARGET_GROUP, 'opus-rest-classified:fandom:ygfn', '羊宫妃那',  'ygfn = 羊宫妃那', 'active');
  seed(db, 302, TARGET_GROUP, 'opus-rest-classified:fandom:ygfn', 'Morfonica', 'ygfn = Morfonica', 'active');

  // Generic single-row — KEEP
  seed(db, 401, TARGET_GROUP, '群内黑话', '鸽了', '鸽了 = cancel', 'active');

  // Generic multi-row distinct facts — KEEP all
  seed(db, 501, TARGET_GROUP, '群内黑话', '傻了',     '傻了 = stunned', 'active');
  seed(db, 502, TARGET_GROUP, '群内黑话', '蚌埠住了', '蚌埠住了 = lol', 'active');

  // Already-superseded dup partner — KEEP, must NOT re-touch
  seed(db, 601, TARGET_GROUP, 'opus-rest-classified:fandom:ykn', '凑友希那', 'old', 'superseded');

  // Out-of-scope prefix — KEEP both even though they share canonical_form
  seed(db, 701, TARGET_GROUP, 'user-taught:fandom:x', '凑友希那', 'tagged', 'active');
  seed(db, 702, TARGET_GROUP, 'user-taught:fandom:x', '凑友希那', 'tagged again', 'active');

  // Null canonical_form — KEEP, IS NOT NULL guard
  seed(db, 801, TARGET_GROUP, 'opus-rest-classified:fandom:null_c', null, 'no canonical', 'active');
}

describe('purge-classified-fandom-dups — runPurge', () => {
  it('t1 dry-run: finds 2 groups (102, 202 candidates), mutates nothing', () => {
    const db = makeDb();
    seedFixture(db);

    const before = totalCount(db);
    const lines: string[] = [];
    const result = runPurge({
      db, apply: false, verbose: false,
      log: (l) => lines.push(l),
      now: () => 2_000_000_000_000,
    });

    expect(result.groupCount).toBe(2);
    expect(result.found).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.groups.map(g => ({ topic: g.topic, keep: g.keepId, sup: g.supersededIds })))
      .toEqual([
        { topic: 'opus-rest-classified:fandom:ykn', keep: 101, sup: [102] },
        { topic: 'opus-rest-classified:slang:Pro',  keep: 201, sup: [202] },
      ]);
    expect(totalCount(db)).toBe(before);
    expect(selectStatus(db, 101)).toBe('active');
    expect(selectStatus(db, 102)).toBe('active');
    expect(selectStatus(db, 201)).toBe('active');
    expect(selectStatus(db, 202)).toBe('active');

    const joined = lines.join('\n');
    expect(joined).toMatch(/\[DRY RUN\]/);
    expect(joined).toMatch(/2 groups \/ 2 rows would be superseded/);
    db.close();
  });

  it('t2 --apply: 102 and 202 -> superseded; survivors + KEEP rows + already-superseded all unchanged', () => {
    const db = makeDb();
    seedFixture(db);
    const before = totalCount(db);

    const result = runPurge({
      db, apply: true, verbose: false,
      log: () => {},
      now: () => 1_700_000_000_000,
    });

    expect(result.groupCount).toBe(2);
    expect(result.found).toBe(2);
    expect(result.updated).toBe(2);
    expect(totalCount(db)).toBe(before); // no DELETE

    // Targets flipped
    expect(selectStatus(db, 102)).toBe('superseded');
    expect(selectStatus(db, 202)).toBe('superseded');

    // MIN-id survivors stay active
    expect(selectStatus(db, 101)).toBe('active');
    expect(selectStatus(db, 201)).toBe('active');

    // True conflicts kept
    expect(selectStatus(db, 301)).toBe('active');
    expect(selectStatus(db, 302)).toBe('active');

    // Generic-topic rows untouched (must-NOT-fire #1)
    expect(selectStatus(db, 401)).toBe('active');
    expect(selectStatus(db, 501)).toBe('active');
    expect(selectStatus(db, 502)).toBe('active');

    // Already-superseded row untouched (status filter; updated_at unchanged)
    expect(selectStatus(db, 601)).toBe('superseded');
    expect(selectUpdatedAt(db, 601)).toBe(100);

    // Out-of-scope prefix untouched (must-NOT-fire #4)
    expect(selectStatus(db, 701)).toBe('active');
    expect(selectStatus(db, 702)).toBe('active');

    // Null canonical_form untouched (must-NOT-fire #2)
    expect(selectStatus(db, 801)).toBe('active');

    // updated_at written for the two flipped rows
    const nowSec = Math.floor(1_700_000_000_000 / 1000);
    expect(selectUpdatedAt(db, 102)).toBe(nowSec);
    expect(selectUpdatedAt(db, 202)).toBe(nowSec);

    // updated_at on a survivor did NOT move
    expect(selectUpdatedAt(db, 101)).toBe(100);
    db.close();
  });

  it('t3 idempotency: second --apply makes 0 changes', () => {
    const db = makeDb();
    seedFixture(db);

    runPurge({ db, apply: true, verbose: false, log: () => {}, now: () => 1_700_000_000_000 });
    const result = runPurge({ db, apply: true, verbose: false, log: () => {}, now: () => 1_800_000_000_000 });

    expect(result.groupCount).toBe(0);
    expect(result.found).toBe(0);
    expect(result.updated).toBe(0);

    // updated_at on already-flipped rows must NOT advance to the second run's "now"
    const firstNowSec = Math.floor(1_700_000_000_000 / 1000);
    expect(selectUpdatedAt(db, 102)).toBe(firstNowSec);
    expect(selectUpdatedAt(db, 202)).toBe(firstNowSec);
    db.close();
  });

  it('t4 generic-topic rows untouched even with shared canonical_form (must-NOT-fire #1 boundary)', () => {
    const db = makeDb();
    seed(db, 1001, TARGET_GROUP, '群内黑话', '同一个梗', 'A', 'active');
    seed(db, 1002, TARGET_GROUP, '群内黑话', '同一个梗', 'B', 'active');

    const result = runPurge({ db, apply: true, verbose: false, log: () => {} });

    expect(result.groupCount).toBe(0);
    expect(result.updated).toBe(0);
    expect(selectStatus(db, 1001)).toBe('active');
    expect(selectStatus(db, 1002)).toBe('active');
    db.close();
  });

  it('t5 user-taught:fandom:% prefix never touched even with dup canonicals', () => {
    const db = makeDb();
    seed(db, 1101, TARGET_GROUP, 'user-taught:fandom:x', '同一个canonical', 'A', 'active');
    seed(db, 1102, TARGET_GROUP, 'user-taught:fandom:x', '同一个canonical', 'B', 'active');

    // Also seed an opus-classified:%  (note: missing the 'rest-' part — prefix-drift trap)
    seed(db, 1201, TARGET_GROUP, 'opus-classified:fandom:x', 'X', 'A', 'active');
    seed(db, 1202, TARGET_GROUP, 'opus-classified:fandom:x', 'X', 'B', 'active');

    const result = runPurge({ db, apply: true, verbose: false, log: () => {} });

    expect(result.groupCount).toBe(0);
    expect(result.updated).toBe(0);
    expect(selectStatus(db, 1101)).toBe('active');
    expect(selectStatus(db, 1102)).toBe('active');
    expect(selectStatus(db, 1201)).toBe('active');
    expect(selectStatus(db, 1202)).toBe('active');
    db.close();
  });

  it('t6 null canonical_form: even when there are 2+ active rows, IS NOT NULL guard excludes them', () => {
    const db = makeDb();
    seed(db, 1301, TARGET_GROUP, 'opus-rest-classified:fandom:null_c', null, 'A', 'active');
    seed(db, 1302, TARGET_GROUP, 'opus-rest-classified:fandom:null_c', null, 'B', 'active');

    const result = runPurge({ db, apply: true, verbose: false, log: () => {} });

    expect(result.groupCount).toBe(0);
    expect(result.updated).toBe(0);
    expect(selectStatus(db, 1301)).toBe('active');
    expect(selectStatus(db, 1302)).toBe('active');
    db.close();
  });

  it('t7 same topic but different canonical_form: zero supersedes, both rows stay active', () => {
    const db = makeDb();
    seed(db, 1401, TARGET_GROUP, 'opus-rest-classified:slang:Pro', 'meaning A', 'A', 'active');
    seed(db, 1402, TARGET_GROUP, 'opus-rest-classified:slang:Pro', 'meaning B', 'B', 'active');

    const result = runPurge({ db, apply: true, verbose: false, log: () => {} });

    expect(result.groupCount).toBe(0);
    expect(result.updated).toBe(0);
    expect(selectStatus(db, 1401)).toBe('active');
    expect(selectStatus(db, 1402)).toBe('active');
    db.close();
  });

  it('t8 limit: refuses to write when found > limit', () => {
    const db = makeDb();
    // Seed 3 dup pairs (6 rows total -> 3 supersede candidates)
    for (let i = 0; i < 3; i++) {
      const base = 2000 + i * 10;
      const topic = `opus-rest-classified:fandom:t${i}`;
      seed(db, base,     TARGET_GROUP, topic, 'C', 'A', 'active');
      seed(db, base + 1, TARGET_GROUP, topic, 'C', 'B', 'active');
    }

    expect(() =>
      runPurge({ db, apply: true, verbose: false, limit: 2, log: () => {} }),
    ).toThrow(/exceeds --limit 2/);

    // No partial writes: still 3 groups, all rows still active
    for (let i = 0; i < 3; i++) {
      const base = 2000 + i * 10;
      expect(selectStatus(db, base)).toBe('active');
      expect(selectStatus(db, base + 1)).toBe('active');
    }
    db.close();
  });

  it('t9 empty DB -> no-op', () => {
    const db = makeDb();
    const result = runPurge({ db, apply: true, verbose: false, log: () => {} });
    expect(result.groupCount).toBe(0);
    expect(result.found).toBe(0);
    expect(result.updated).toBe(0);
    db.close();
  });

  it('t10 verbose=true logs all_ids detail', () => {
    const db = makeDb();
    seedFixture(db);

    const lines: string[] = [];
    runPurge({ db, apply: false, verbose: true, log: (l) => lines.push(l) });

    const joined = lines.join('\n');
    expect(joined).toMatch(/\[verbose\] all_ids=\[101,102\]/);
    expect(joined).toMatch(/\[verbose\] all_ids=\[201,202\]/);
    db.close();
  });

  it('t11 source invariant: no DELETE FROM, target status is superseded, exactly the two LIKE prefixes, no opus-classified prefix-drift', async () => {
    const fs = await import('node:fs/promises');
    const url = new URL('../../scripts/maintenance/purge-classified-fandom-dups.ts', import.meta.url);
    const src = await fs.readFile(url, 'utf8');

    expect(src).not.toMatch(/DELETE\s+FROM/i);
    expect(src).toMatch(/status = 'superseded'/);
    expect(src).toMatch(/topic LIKE 'opus-rest-classified:fandom:%'/);
    expect(src).toMatch(/topic LIKE 'opus-rest-classified:slang:%'/);

    // Prefix-drift guard: 'opus-classified:' (missing 'rest-') must NOT appear as a LIKE pattern.
    expect(src).not.toMatch(/LIKE 'opus-classified:/);

    // canonical_form IS NOT NULL guard present
    expect(src).toMatch(/canonical_form IS NOT NULL/);

    // GROUP BY pair is intact
    expect(src).toMatch(/GROUP BY topic, canonical_form/);
    expect(src).toMatch(/HAVING COUNT\(\*\) > 1/);
  });
});
