import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  runRepair,
  decideRowAction,
  isValidStructuredTerm,
  extractTermFromTopic,
} from '../scripts/repair-wrongly-superseded-knowledge.mjs';
// Import the TS source of truth for divergence check.
import {
  isValidStructuredTerm as tsValidator,
  extractTermFromTopic as tsExtractor,
} from '../src/modules/fact-topic-prefixes.js';

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  // Minimal learned_facts shape matching schema.sql — enough for repair script.
  db.exec(`
    CREATE TABLE learned_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      topic TEXT,
      fact TEXT NOT NULL,
      canonical_form TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      updated_at INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function seedRow(
  db: DatabaseSync,
  args: { id?: number; groupId?: string; topic: string | null; status: string; updatedAt: number; fact?: string },
): number {
  const { id, groupId = 'g1', topic, status, updatedAt, fact = 'content' } = args;
  if (id !== undefined) {
    db.prepare(
      `INSERT INTO learned_facts (id, group_id, topic, fact, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, groupId, topic, fact, status, updatedAt);
    return id;
  }
  const result = db.prepare(
    `INSERT INTO learned_facts (group_id, topic, fact, status, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(groupId, topic, fact, status, updatedAt);
  return Number(result.lastInsertRowid);
}

function getStatus(db: DatabaseSync, id: number): string {
  const row = db.prepare(`SELECT status FROM learned_facts WHERE id=?`).get(id) as { status: string };
  return row.status;
}

describe('repair-wrongly-superseded script (cases 12, 13)', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = openDb();
  });

  it('case 12: allowlist mode — only acts on allowlisted ids', () => {
    seedRow(db, { id: 4573, topic: 'user-taught:ygfn', status: 'superseded', updatedAt: 100 });
    seedRow(db, { id: 4387, topic: 'user-taught:xtt', status: 'superseded', updatedAt: 100 });
    seedRow(db, { id: 4500, topic: 'user-taught:lsycx', status: 'superseded', updatedAt: 100 });

    // Dry-run — no mutation
    const captured: string[] = [];
    const dry = runRepair(db, {
      mode: 'dry-run',
      allowlist: [4573, 4387],
      log: (line: string) => captured.push(line),
    });
    const dryIds = dry.decisions.map((d: { id: number }) => d.id).sort();
    expect(dryIds).toEqual([4387, 4573]);
    expect(dry.reactivated).toBe(0);
    expect(getStatus(db, 4573)).toBe('superseded');
    expect(getStatus(db, 4387)).toBe('superseded');
    expect(getStatus(db, 4500)).toBe('superseded');

    // Commit — 4500 untouched
    const commit = runRepair(db, {
      mode: 'commit',
      allowlist: [4573, 4387],
      log: () => undefined,
    });
    expect(commit.reactivated).toBe(2);
    expect(getStatus(db, 4573)).toBe('active');
    expect(getStatus(db, 4387)).toBe('active');
    expect(getStatus(db, 4500)).toBe('superseded');
  });

  it('case 13a: full-scan — superseded with no active peer → reactivate', () => {
    const rowA = seedRow(db, { topic: 'user-taught:ygfn', status: 'superseded', updatedAt: 100 });
    const decision = decideRowAction(db, {
      id: rowA,
      group_id: 'g1',
      topic: 'user-taught:ygfn',
      updated_at: 100,
    });
    expect(decision.decision).toBe('reactivate');
  });

  it('case 13b: full-scan — active peer with same topic → keep-superseded', () => {
    seedRow(db, { topic: 'user-taught:xtt', status: 'active', updatedAt: 200 });
    const rowB = seedRow(db, { topic: 'user-taught:xtt', status: 'superseded', updatedAt: 100 });
    const decision = decideRowAction(db, {
      id: rowB,
      group_id: 'g1',
      topic: 'user-taught:xtt',
      updated_at: 100,
    });
    expect(decision.decision).toBe('keep-superseded');
    expect(decision.reason).toMatch(/active peer/);
  });

  it('case 13c: full-scan — dirty suffix topic → keep-superseded (not resurrected)', () => {
    const rowC = seedRow(db, {
      topic: 'user-taught:ygfn是谁啊',
      status: 'superseded',
      updatedAt: 100,
    });
    const decision = decideRowAction(db, {
      id: rowC,
      group_id: 'g1',
      topic: 'user-taught:ygfn是谁啊',
      updated_at: 100,
    });
    expect(decision.decision).toBe('keep-superseded');
    expect(decision.reason).toMatch(/isValidStructuredTerm/i);
  });

  it('case 13d: full-scan — two superseded same topic no active peer → reactivate only newer', () => {
    const d1 = seedRow(db, { topic: 'user-taught:abc', status: 'superseded', updatedAt: 100 });
    const d2 = seedRow(db, { topic: 'user-taught:abc', status: 'superseded', updatedAt: 200 });

    // d1 has a newer superseded peer (d2) → keep-superseded
    expect(decideRowAction(db, { id: d1, group_id: 'g1', topic: 'user-taught:abc', updated_at: 100 }).decision)
      .toBe('keep-superseded');
    // d2 is the newest → reactivate
    expect(decideRowAction(db, { id: d2, group_id: 'g1', topic: 'user-taught:abc', updated_at: 200 }).decision)
      .toBe('reactivate');

    // End-to-end full-scan commit: only d2 flips to active.
    const result = runRepair(db, { mode: 'commit', fullScan: true, log: () => undefined });
    expect(result.reactivated).toBe(1);
    expect(getStatus(db, d1)).toBe('superseded');
    expect(getStatus(db, d2)).toBe('active');
  });

  // Case 12/13 subpart: validator divergence catch.
  // If the TS validator and the .mjs validator ever disagree on the same
  // input, this test flags it so MIRROR comment stays honest.
  it('validators stay in sync: TS ↔ mjs agree on representative inputs', () => {
    const probeTerms = [
      'ygfn', 'xtt', '羊宫妃那', '120w', '7_11',
      'ygfn是谁啊', 'X', '', '   ', '一整句很长的东西',
      '在家里', '这个梗', 'A_b', '是谁',
    ];
    for (const t of probeTerms) {
      expect({ term: t, js: isValidStructuredTerm(t) }).toEqual({ term: t, js: tsValidator(t) });
    }
    const probeTopics = [
      'user-taught:ygfn', 'unknown-prefix:ygfn', 'user-taught', null,
      'user-taught:ygfn是谁啊', 'ondemand-lookup:xtt', '群内黑话:羊宫妃那',
    ];
    for (const topic of probeTopics) {
      expect({ topic, js: extractTermFromTopic(topic) }).toEqual({ topic, js: tsExtractor(topic) });
    }
  });
});
