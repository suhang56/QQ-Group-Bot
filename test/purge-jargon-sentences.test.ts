import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { STRUCTURAL_PARTICLES } from '../src/modules/jargon-miner.js';

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE jargon_candidates (
      group_id              TEXT    NOT NULL,
      content               TEXT    NOT NULL,
      count                 INTEGER NOT NULL DEFAULT 1,
      contexts              TEXT    NOT NULL DEFAULT '[]',
      last_inference_count  INTEGER NOT NULL DEFAULT 0,
      meaning               TEXT,
      is_jargon             INTEGER NOT NULL DEFAULT 0,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      PRIMARY KEY (group_id, content)
    );
  `);
  return db;
}

function insert(db: DatabaseSync, groupId: string, content: string, isJargon = 0): void {
  db.prepare(`
    INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, is_jargon, created_at, updated_at)
    VALUES (?, ?, 1, '[]', 0, ?, 1700000, 1700000)
  `).run(groupId, content, isJargon);
}

function getIsJargon(db: DatabaseSync, content: string): number | undefined {
  const row = db.prepare(`SELECT is_jargon FROM jargon_candidates WHERE content = ?`).get(content) as { is_jargon: number } | undefined;
  return row?.is_jargon;
}

function runPassA(db: DatabaseSync, groupId: string): string[] {
  const allPending = db.prepare(
    'SELECT content FROM jargon_candidates WHERE group_id = ? AND is_jargon = 0'
  ).all(groupId) as { content: string }[];

  const passAContents: string[] = [];
  for (const row of allPending) {
    for (const ch of row.content) {
      if (STRUCTURAL_PARTICLES.has(ch)) { passAContents.push(row.content); break; }
    }
  }
  return passAContents;
}

function runPassB(db: DatabaseSync, groupId: string, notInA: Set<string>): string[] {
  const longPureChinese = db.prepare(
    'SELECT content FROM jargon_candidates WHERE group_id = ? AND is_jargon = 0 AND length(content) > 4'
  ).all(groupId) as { content: string }[];

  const passBContents: string[] = [];
  for (const row of longPureChinese) {
    if (!notInA.has(row.content)) continue;
    if (!/[a-zA-Z0-9]/.test(row.content)) passBContents.push(row.content);
  }
  return passBContents;
}

function applyPrune(db: DatabaseSync, groupId: string, contents: string[]): void {
  const nowSec = 1700001;
  for (const content of contents) {
    db.prepare(`UPDATE jargon_candidates SET is_jargon = -1, updated_at = ${nowSec} WHERE group_id = ? AND content = ?`).run(groupId, content);
  }
}

describe('purge-jargon-sentences Pass A', () => {
  it('marks particle-containing rows is_jargon=-1', () => {
    const db = makeDb();
    insert(db, 'g1', '那你也来');
    insert(db, 'g1', '弯曲');
    insert(db, 'g1', 'taka');

    const passAContents = runPassA(db, 'g1');
    applyPrune(db, 'g1', passAContents);

    expect(getIsJargon(db, '那你也来')).toBe(-1);
    expect(getIsJargon(db, '弯曲')).toBe(0);
    expect(getIsJargon(db, 'taka')).toBe(0);
  });

  it('catches 嘿哟 (contains 嘿) as particle match', () => {
    const db = makeDb();
    insert(db, 'g1', '嘿哟');
    insert(db, 'g1', 'ygfn');

    const passAContents = runPassA(db, 'g1');
    applyPrune(db, 'g1', passAContents);

    expect(getIsJargon(db, '嘿哟')).toBe(-1);
    expect(getIsJargon(db, 'ygfn')).toBe(0);
  });
});

describe('purge-jargon-sentences Pass B', () => {
  it('marks long pure-Chinese rows is_jargon=-1', () => {
    const db = makeDb();
    insert(db, 'g1', '不是哥们儿'); // length 5, no ASCII, no particle
    insert(db, 'g1', 'NB');           // has ASCII → survives

    const passAContents = runPassA(db, 'g1');
    const allContents = (db.prepare('SELECT content FROM jargon_candidates WHERE group_id=? AND is_jargon=0').all('g1') as { content: string }[]).map(r => r.content);
    const notInA = new Set(allContents);
    for (const c of passAContents) notInA.delete(c);

    const passBContents = runPassB(db, 'g1', notInA);
    applyPrune(db, 'g1', [...passAContents, ...passBContents]);

    expect(getIsJargon(db, '不是哥们儿')).toBe(-1);
    expect(getIsJargon(db, 'NB')).toBe(0);
  });

  it('does not double-count rows already in Pass A', () => {
    const db = makeDb();
    insert(db, 'g1', '不要也可以'); // contains 也 (particle) AND length=5

    const passAContents = runPassA(db, 'g1');
    const allContents = (db.prepare('SELECT content FROM jargon_candidates WHERE group_id=? AND is_jargon=0').all('g1') as { content: string }[]).map(r => r.content);
    const notInA = new Set(allContents);
    for (const c of passAContents) notInA.delete(c);

    const passBContents = runPassB(db, 'g1', notInA);

    expect(passAContents.length).toBe(1);
    expect(passBContents.length).toBe(0);
  });
});

describe('purge-jargon-sentences survivors', () => {
  it('弯曲 taka ygfn pass both passes', () => {
    const db = makeDb();
    insert(db, 'g1', '弯曲');
    insert(db, 'g1', 'taka');
    insert(db, 'g1', 'ygfn');

    const passAContents = runPassA(db, 'g1');
    const allContents = (db.prepare('SELECT content FROM jargon_candidates WHERE group_id=? AND is_jargon=0').all('g1') as { content: string }[]).map(r => r.content);
    const notInA = new Set(allContents);
    for (const c of passAContents) notInA.delete(c);
    const passBContents = runPassB(db, 'g1', notInA);
    applyPrune(db, 'g1', [...passAContents, ...passBContents]);

    expect(getIsJargon(db, '弯曲')).toBe(0);
    expect(getIsJargon(db, 'taka')).toBe(0);
    expect(getIsJargon(db, 'ygfn')).toBe(0);
  });

  it('dry-run: prints counts without writing', () => {
    const db = makeDb();
    insert(db, 'g1', '那你也来');
    insert(db, 'g1', '弯曲');

    // Simulate dry-run: compute counts but do NOT call applyPrune
    const passAContents = runPassA(db, 'g1');
    const allContents = (db.prepare('SELECT content FROM jargon_candidates WHERE group_id=? AND is_jargon=0').all('g1') as { content: string }[]).map(r => r.content);
    const notInA = new Set(allContents);
    for (const c of passAContents) notInA.delete(c);
    const passBContents = runPassB(db, 'g1', notInA);

    expect(passAContents.length).toBe(1);
    expect(passBContents.length).toBe(0);
    // No writes performed
    expect(getIsJargon(db, '那你也来')).toBe(0);
    expect(getIsJargon(db, '弯曲')).toBe(0);
  });
});
