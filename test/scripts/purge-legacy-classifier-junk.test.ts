import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runPurge } from '../../scripts/maintenance/purge-legacy-classifier-junk.js';

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  // Minimal schema — only columns the purge SQL + tests touch. No FTS mirror
  // needed; tests assert status on learned_facts directly.
  db.exec(`
    CREATE TABLE IF NOT EXISTS learned_facts (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id             TEXT    NOT NULL,
      topic                TEXT,
      fact                 TEXT    NOT NULL,
      source_user_id       TEXT,
      source_user_nickname TEXT,
      confidence           REAL    NOT NULL DEFAULT 1.0,
      status               TEXT    NOT NULL DEFAULT 'active',
      created_at           INTEGER NOT NULL DEFAULT 100,
      updated_at           INTEGER NOT NULL DEFAULT 100,
      canonical_form       TEXT,
      persona_form         TEXT
    );
  `);
  return db;
}

function seed(
  db: DatabaseSync,
  opts: {
    topic: string;
    nickname?: string | null;
    status?: 'active' | 'pending' | 'rejected';
    canonical?: string | null;
    persona?: string | null;
    fact?: string;
    updatedAt?: number;
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO learned_facts
        (group_id, topic, fact, source_user_nickname, status, created_at, updated_at, canonical_form, persona_form)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'g1',
      opts.topic,
      opts.fact ?? 'f',
      opts.nickname ?? null,
      opts.status ?? 'active',
      100,
      opts.updatedAt ?? 100,
      opts.canonical ?? null,
      opts.persona ?? null,
    );
  return Number(info.lastInsertRowid);
}

function statusOf(db: DatabaseSync, id: number): string {
  return (
    db.prepare('SELECT status FROM learned_facts WHERE id = ?').get(id) as { status: string }
  ).status;
}

function updatedAtOf(db: DatabaseSync, id: number): number {
  return (
    db.prepare('SELECT updated_at FROM learned_facts WHERE id = ?').get(id) as {
      updated_at: number;
    }
  ).updated_at;
}

function totalCount(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM learned_facts').get() as { n: number }).n;
}

describe('purge-legacy-classifier-junk — runPurge', () => {
  // ───────────────────────── Must-FIRE (reject on --apply) ─────────────────

  it('T1: opus-ext-classified:slang:X active → rejected', () => {
    const db = makeDb();
    const id = seed(db, { topic: 'opus-ext-classified:slang:foo' });
    const r = runPurge({ db, target: 1, apply: true, verbose: false, log: () => {}, now: () => 1e12 });
    expect(r.target1.found).toBe(1);
    expect(r.target1.updated).toBe(1);
    expect(statusOf(db, id)).toBe('rejected');
    db.close();
  });

  it('T1: 3 rows → rejected count = 3', () => {
    const db = makeDb();
    const a = seed(db, { topic: 'opus-ext-classified:slang:a' });
    const b = seed(db, { topic: 'opus-ext-classified:fandom:b' });
    const c = seed(db, { topic: 'opus-ext-classified:slang:c' });
    const r = runPurge({ db, target: 1, apply: true, verbose: false, log: () => {}, now: () => 1e12 });
    expect(r.target1.found).toBe(3);
    expect(r.target1.updated).toBe(3);
    for (const id of [a, b, c]) expect(statusOf(db, id)).toBe('rejected');
    db.close();
  });

  it('T2: source_user_nickname=[harvest:foo] + topic=群内梗:X → rejected', () => {
    const db = makeDb();
    const id = seed(db, {
      topic: 'opus-classified:slang:foo',
      nickname: '[harvest:nsy]',
    });
    const r = runPurge({ db, target: 2, apply: true, verbose: false, log: () => {}, now: () => 1e12 });
    expect(r.target2.found).toBe(1);
    expect(r.target2.updated).toBe(1);
    expect(statusOf(db, id)).toBe('rejected');
    db.close();
  });

  it('T2: source_user_nickname=[deep-tune:bar] → rejected', () => {
    const db = makeDb();
    const id = seed(db, { topic: 'opus-classified:slang:baz', nickname: '[deep-tune:run1]' });
    const r = runPurge({ db, target: 2, apply: true, verbose: false, log: () => {}, now: () => 1e12 });
    expect(r.target2.found).toBe(1);
    expect(statusOf(db, id)).toBe('rejected');
    db.close();
  });

  it('T3 dedup: :nb + :NB → nb rejected (dedup-loser), NB kept', () => {
    const db = makeDb();
    const loser = seed(db, { topic: 'opus-classified:slang:nb' });
    const winner = seed(db, { topic: 'opus-classified:slang:NB' });
    const r = runPurge({ db, target: 3, apply: true, verbose: false, log: () => {}, now: () => 1e12 });
    expect(r.target3.rejected.map(x => x.term).sort()).toEqual(['nb']);
    expect(r.target3.rejected.find(x => x.term === 'nb')?.reason).toBe('dedup-loser');
    expect(statusOf(db, loser)).toBe('rejected');
    expect(statusOf(db, winner)).toBe('active');
    db.close();
  });

  it('T3 dedup: :欧耶 + :哦耶 → 欧耶 rejected', () => {
    const db = makeDb();
    const loser = seed(db, { topic: 'opus-classified:slang:欧耶' });
    const winner = seed(db, { topic: 'opus-classified:slang:哦耶' });
    const r = runPurge({ db, target: 3, apply: true, verbose: false, log: () => {}, now: () => 1e12 });
    expect(r.target3.rejected.map(x => x.term)).toContain('欧耶');
    expect(statusOf(db, loser)).toBe('rejected');
    expect(statusOf(db, winner)).toBe('active');
    db.close();
  });

  it('T3 dedup: :是什么感觉 + :到底是什么感觉 → 是什么感觉 rejected', () => {
    const db = makeDb();
    const loser = seed(db, { topic: 'opus-classified:slang:是什么感觉' });
    const winner = seed(db, { topic: 'opus-classified:slang:到底是什么感觉' });
    const r = runPurge({ db, target: 3, apply: true, verbose: false, log: () => {}, now: () => 1e12 });
    expect(r.target3.rejected.map(x => x.term)).toContain('是什么感觉');
    expect(statusOf(db, loser)).toBe('rejected');
    expect(statusOf(db, winner)).toBe('active');
    db.close();
  });

  it('T3 noise: :yes (no winner pair) → rejected reason=noise', () => {
    const db = makeDb();
    const id = seed(db, { topic: 'opus-classified:slang:yes' });
    const r = runPurge({ db, target: 3, apply: true, verbose: false, log: () => {}, now: () => 1e12 });
    expect(r.target3.rejected).toHaveLength(1);
    expect(r.target3.rejected[0]?.reason).toBe('noise');
    expect(statusOf(db, id)).toBe('rejected');
    db.close();
  });

  it('T3 noise: :周六 → rejected reason=noise', () => {
    const db = makeDb();
    const id = seed(db, { topic: 'opus-classified:slang:周六' });
    const r = runPurge({ db, target: 3, apply: true, verbose: false, log: () => {}, now: () => 1e12 });
    expect(r.target3.rejected).toHaveLength(1);
    expect(r.target3.rejected[0]?.reason).toBe('noise');
    expect(statusOf(db, id)).toBe('rejected');
    db.close();
  });

  // ───────────────────────── Must-NOT-FIRE (untouched) ─────────────────────

  it('T2 B3 overlap: [harvest:X] + topic 群友别名 小明 → untouched (16-row overlap case)', () => {
    const db = makeDb();
    const id = seed(db, { topic: '群友别名 小明', nickname: '[harvest:nsy]' });
    const r = runPurge({ db, target: 'all', apply: true, verbose: false, log: () => {}, now: () => 1e12 });
    expect(r.target2.found).toBe(0);
    expect(statusOf(db, id)).toBe('active');
    db.close();
  });

  it('T2 alias-miner: [alias-miner] + 群友别名 X → untouched', () => {
    const db = makeDb();
    const id = seed(db, { topic: '群友别名 X', nickname: '[alias-miner]' });
    const r = runPurge({ db, target: 'all', apply: true, verbose: false, log: () => {}, now: () => 1e12 });
    expect(r.target2.found).toBe(0);
    expect(statusOf(db, id)).toBe('active');
    db.close();
  });

  it('T1 lore: opus-ext-classified:lore:xyz → untouched', () => {
    const db = makeDb();
    const id = seed(db, { topic: 'opus-ext-classified:lore:xyz' });
    const r = runPurge({ db, target: 1, apply: true, verbose: false, log: () => {}, now: () => 1e12 });
    expect(r.target1.found).toBe(0);
    expect(statusOf(db, id)).toBe('active');
    db.close();
  });

  it('T2 lore: [harvest:foo] + topic fandom:lore:abc → untouched', () => {
    const db = makeDb();
    const id = seed(db, { topic: 'fandom:lore:abc', nickname: '[harvest:foo]' });
    const r = runPurge({ db, target: 2, apply: true, verbose: false, log: () => {}, now: () => 1e12 });
    expect(r.target2.found).toBe(0);
    expect(statusOf(db, id)).toBe('active');
    db.close();
  });

  it('user-taught:* → untouched (no prefix match)', () => {
    const db = makeDb();
    const ut = seed(db, { topic: 'user-taught:ygfn' });
    const r = runPurge({ db, target: 'all', apply: true, verbose: false, log: () => {}, now: () => 1e12 });
    expect(r.totalUpdated).toBe(0);
    expect(statusOf(db, ut)).toBe('active');
    db.close();
  });

  it('T3 scope: opus-rest-classified:slang:blah → untouched (scope OUT)', () => {
    const db = makeDb();
    const id = seed(db, { topic: 'opus-rest-classified:slang:blah' });
    const r = runPurge({ db, target: 3, apply: true, verbose: false, log: () => {}, now: () => 1e12 });
    expect(r.target3.found).toBe(0);
    expect(statusOf(db, id)).toBe('active');
    db.close();
  });

  it('T3 scope: ondemand-lookup:xyz → untouched', () => {
    const db = makeDb();
    const id = seed(db, { topic: 'ondemand-lookup:xyz' });
    const r = runPurge({ db, target: 'all', apply: true, verbose: false, log: () => {}, now: () => 1e12 });
    expect(r.totalUpdated).toBe(0);
    expect(statusOf(db, id)).toBe('active');
    db.close();
  });

  it('T3 lexical WINNER NB alone (no :nb) → untouched', () => {
    const db = makeDb();
    const id = seed(db, { topic: 'opus-classified:slang:NB' });
    const r = runPurge({ db, target: 3, apply: true, verbose: false, log: () => {}, now: () => 1e12 });
    expect(r.target3.found).toBe(1);
    expect(r.target3.rejected).toHaveLength(0);
    expect(r.target3.kept).toHaveLength(1);
    expect(statusOf(db, id)).toBe('active');
    db.close();
  });

  it('T3 unmatched slang :我草 → untouched (not winner map, not noise)', () => {
    const db = makeDb();
    const id = seed(db, { topic: 'opus-classified:slang:我草' });
    const r = runPurge({ db, target: 3, apply: true, verbose: false, log: () => {}, now: () => 1e12 });
    expect(r.target3.rejected).toHaveLength(0);
    expect(statusOf(db, id)).toBe('active');
    db.close();
  });

  it('T1 already-rejected row → updated_at unchanged', () => {
    const db = makeDb();
    const id = seed(db, {
      topic: 'opus-ext-classified:slang:old',
      status: 'rejected',
      updatedAt: 42,
    });
    runPurge({ db, target: 1, apply: true, verbose: false, log: () => {}, now: () => 9_999_999_999_999 });
    expect(statusOf(db, id)).toBe('rejected');
    expect(updatedAtOf(db, id)).toBe(42);
    db.close();
  });

  // ───────────────────────── Determinism + invariants ─────────────────────

  it('determinism: two --apply runs on cloned fixture → identical rejected id arrays', () => {
    // Seed identical fixtures into two DBs; compare rejected id arrays.
    const seedFixture = (db: DatabaseSync) => {
      seed(db, { topic: 'opus-ext-classified:slang:a' });
      seed(db, { topic: 'opus-ext-classified:slang:b' });
      seed(db, { topic: 'opus-classified:slang:nb' });
      seed(db, { topic: 'opus-classified:slang:NB' });
      seed(db, { topic: 'opus-classified:slang:yes' });
      seed(db, {
        topic: 'opus-classified:slang:harvestFoo',
        nickname: '[harvest:x]',
      });
    };
    const db1 = makeDb();
    const db2 = makeDb();
    seedFixture(db1);
    seedFixture(db2);
    const r1 = runPurge({ db: db1, target: 'all', apply: true, verbose: false, log: () => {}, now: () => 1e12 });
    const r2 = runPurge({ db: db2, target: 'all', apply: true, verbose: false, log: () => {}, now: () => 1e12 });
    const ids1 = [...r1.target1.ids, ...r1.target2.ids, ...r1.target3.rejected.map(r => r.id)].sort((a, b) => a - b);
    const ids2 = [...r2.target1.ids, ...r2.target2.ids, ...r2.target3.rejected.map(r => r.id)].sort((a, b) => a - b);
    expect(ids1).toEqual(ids2);
    db1.close();
    db2.close();
  });

  it('row-count invariant: SELECT COUNT(*) before --apply === after (no DELETE)', () => {
    const db = makeDb();
    seed(db, { topic: 'opus-ext-classified:slang:a' });
    seed(db, { topic: 'opus-classified:slang:yes' });
    seed(db, { topic: 'opus-classified:slang:nb' });
    seed(db, { topic: 'opus-classified:slang:NB' });
    seed(db, { topic: 'user-taught:safe' });
    const before = totalCount(db);
    runPurge({ db, target: 'all', apply: true, verbose: false, log: () => {}, now: () => 1e12 });
    expect(totalCount(db)).toBe(before);
    db.close();
  });

  it('rollback: UPDATE .run throws mid-loop → all rows still active', () => {
    const db = makeDb();
    const a = seed(db, { topic: 'opus-ext-classified:slang:a' });
    const b = seed(db, { topic: 'opus-ext-classified:slang:b' });
    const c = seed(db, { topic: 'opus-ext-classified:slang:c' });
    // Monkey-patch prepare so that the UPDATE statement's .run throws on the
    // 2nd call. BEGIN / COMMIT / SELECT .prepare still go through unmodified.
    const realPrepare = db.prepare.bind(db);
    let updCallCount = 0;
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      const stmt = realPrepare(sql);
      if (sql.includes("UPDATE learned_facts SET status = 'rejected'")) {
        const realRun = stmt.run.bind(stmt);
        (stmt as unknown as { run: typeof stmt.run }).run = ((...args: unknown[]) => {
          updCallCount += 1;
          if (updCallCount === 2) throw new Error('simulated mid-loop failure');
          return realRun(...(args as Parameters<typeof stmt.run>));
        }) as typeof stmt.run;
      }
      return stmt;
    }) as typeof db.prepare;

    expect(() =>
      runPurge({ db, target: 1, apply: true, verbose: false, log: () => {}, now: () => 1e12 }),
    ).toThrow(/simulated mid-loop failure/);
    expect(updCallCount).toBeGreaterThanOrEqual(2);

    for (const id of [a, b, c]) expect(statusOf(db, id)).toBe('active');
    db.close();
  });

  // ───────────────────────── Safety invariant (source-level) ───────────────

  it('script source contains NO `DELETE FROM` (safety invariant)', async () => {
    const fs = await import('node:fs/promises');
    const url = new URL(
      '../../scripts/maintenance/purge-legacy-classifier-junk.ts',
      import.meta.url,
    );
    const src = await fs.readFile(url, 'utf8');
    expect(src).not.toMatch(/DELETE\s+FROM/i);
    expect(src).toMatch(/UPDATE learned_facts SET status = 'rejected'/);
  });
});
