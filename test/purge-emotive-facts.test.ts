import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = 'scripts/purge-emotive-facts.ts';
const SEED_UPDATED_AT = 1700000;

type Row = {
  id: number;
  topic: string;
  fact: string;
  status: string;
  updated_at: number;
};

function makeFixtureDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE learned_facts (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id             TEXT    NOT NULL,
      topic                TEXT,
      fact                 TEXT    NOT NULL,
      source_user_id       TEXT,
      source_user_nickname TEXT,
      source_msg_id        TEXT,
      bot_reply_id         INTEGER,
      confidence           REAL    NOT NULL DEFAULT 1.0,
      status               TEXT    NOT NULL DEFAULT 'active',
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      embedding_vec        BLOB,
      embedding_status     TEXT    DEFAULT 'pending',
      last_attempt_at      INTEGER,
      canonical_form       TEXT,
      persona_form         TEXT
    );
  `);
  const ins = db.prepare(`
    INSERT INTO learned_facts (id, group_id, topic, fact, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `);
  ins.run(1, 'g1', 'ondemand-lookup:烦死了', 'meaning-1', SEED_UPDATED_AT, SEED_UPDATED_AT);
  ins.run(2, 'g1', 'ondemand-lookup:气死了', 'meaning-2', SEED_UPDATED_AT, SEED_UPDATED_AT);
  ins.run(3, 'g1', 'ondemand-lookup:不要烦', 'meaning-3', SEED_UPDATED_AT, SEED_UPDATED_AT);
  ins.run(4, 'g1', 'ondemand-lookup:ykn', 'meaning-4', SEED_UPDATED_AT, SEED_UPDATED_AT);
  ins.run(5, 'g1', 'user-taught:ykn', 'meaning-5', SEED_UPDATED_AT, SEED_UPDATED_AT);
  db.close();
}

function readAll(dbPath: string): Row[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare('SELECT id, topic, fact, status, updated_at FROM learned_facts ORDER BY id')
      .all() as Row[];
  } finally {
    db.close();
  }
}

function runScript(flags: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('npx', ['tsx', SCRIPT, ...flags], {
    encoding: 'utf8',
    shell: true,
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'purge-emotive-'));
  dbPath = join(tmpDir, 'fixture.db');
  makeFixtureDb(dbPath);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('purge-emotive-facts CLI', () => {
  it('Case A: dry-run (default) — zero writes, counts emotive matches', () => {
    const { stdout, status } = runScript(['--db-path', dbPath]);
    expect(status).toBe(0);
    expect(stdout).toContain('3 found, 0 would update');
    const rows = readAll(dbPath);
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.status).toBe('active');
      expect(row.updated_at).toBe(SEED_UPDATED_AT);
    }
  });

  it('Case B: --apply — flips 3 emotive ondemand rows to rejected, leaves non-emotive + non-ondemand rows', () => {
    const { stdout, status } = runScript(['--db-path', dbPath, '--apply']);
    expect(status).toBe(0);
    expect(stdout).toContain('3 found, 3 updated');
    const rows = readAll(dbPath);
    expect(rows).toHaveLength(5);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(1)?.status).toBe('rejected');
    expect(byId.get(1)?.updated_at).toBeGreaterThan(SEED_UPDATED_AT);
    expect(byId.get(2)?.status).toBe('rejected');
    expect(byId.get(2)?.updated_at).toBeGreaterThan(SEED_UPDATED_AT);
    expect(byId.get(3)?.status).toBe('rejected');
    expect(byId.get(3)?.updated_at).toBeGreaterThan(SEED_UPDATED_AT);
    expect(byId.get(4)?.status).toBe('active');
    expect(byId.get(4)?.updated_at).toBe(SEED_UPDATED_AT);
    expect(byId.get(5)?.status).toBe('active');
    expect(byId.get(5)?.updated_at).toBe(SEED_UPDATED_AT);
  });

  it('Case C: --verbose dry-run — stdout lists each matched id + term', () => {
    const { stdout, status } = runScript(['--db-path', dbPath, '--verbose']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/\[id=1\].*烦死了/);
    expect(stdout).toMatch(/\[id=2\].*气死了/);
    expect(stdout).toMatch(/\[id=3\].*不要烦/);
    expect(stdout).not.toMatch(/\[id=4\]/);
    expect(stdout).not.toMatch(/\[id=5\]/);
  });

  it('Case D: missing --db-path — exit 2, stderr has Usage', () => {
    const { stderr, status } = runScript([]);
    expect(status).toBe(2);
    expect(stderr).toContain('Usage');
  });

  it("Case E: pending-status emotive row is purged, superseded emotive row is not", () => {
    const db = new DatabaseSync(dbPath);
    const ins = db.prepare(`
      INSERT INTO learned_facts (id, group_id, topic, fact, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    // Real-prod motivation shape: emotive row at status='pending'. Different term
    // from id=1 to keep fixture distinct (multiple rows can share a topic string in prod).
    ins.run(6, 'g1', 'ondemand-lookup:好烦', 'meaning-pending-emotive', 'pending', SEED_UPDATED_AT, SEED_UPDATED_AT);
    // Pending ondemand non-emotive — must NOT flip
    ins.run(7, 'g1', 'ondemand-lookup:xtt', 'meaning-pending-valid', 'pending', SEED_UPDATED_AT, SEED_UPDATED_AT);
    // Superseded emotive — historical, must NOT flip (per team-lead)
    ins.run(8, 'g1', 'ondemand-lookup:累死了', 'meaning-superseded-emotive', 'superseded', SEED_UPDATED_AT, SEED_UPDATED_AT);
    db.close();

    // Dry-run first — verify 4 found (3 active emotive + 1 pending emotive), 0 writes
    const dry = runScript(['--db-path', dbPath]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('4 found, 0 would update');
    const dryRows = readAll(dbPath);
    for (const row of dryRows) {
      expect(row.updated_at).toBe(SEED_UPDATED_AT);
    }

    // Apply — flips 4 (3 active + 1 pending), leaves superseded + non-emotive + non-ondemand
    const apply = runScript(['--db-path', dbPath, '--apply']);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain('4 found, 4 updated');
    const rows = readAll(dbPath);
    expect(rows).toHaveLength(8);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(6)?.status).toBe('rejected');
    expect(byId.get(6)?.updated_at).toBeGreaterThan(SEED_UPDATED_AT);
    expect(byId.get(7)?.status).toBe('pending');
    expect(byId.get(7)?.updated_at).toBe(SEED_UPDATED_AT);
    expect(byId.get(8)?.status).toBe('superseded');
    expect(byId.get(8)?.updated_at).toBe(SEED_UPDATED_AT);
  });
});
