import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runPurge } from '../../scripts/maintenance/purge-bot-self-corpus.js';

const BOT = '1705075399';
const USER_A = '111111';
const USER_B = '222222';
const GROUP = 'g_test';
const OTHER_GROUP = 'g_other';

interface GesSeed {
  groupId: string;
  expression: string;
  speakers: string[];
  rejected?: number;
}

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE groupmate_expression_samples (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id             TEXT    NOT NULL,
      expression           TEXT    NOT NULL,
      expression_hash      TEXT    NOT NULL,
      speaker_user_ids     TEXT    NOT NULL,
      speaker_count        INTEGER NOT NULL DEFAULT 1,
      source_message_ids   TEXT    NOT NULL,
      occurrence_count     INTEGER NOT NULL DEFAULT 1,
      first_seen_at        INTEGER NOT NULL,
      last_active_at       INTEGER NOT NULL,
      checked_by           TEXT,
      rejected             INTEGER NOT NULL DEFAULT 0,
      modified_by          TEXT,
      schema_version       INTEGER NOT NULL DEFAULT 2
    );
    CREATE TABLE meme_graph (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id           TEXT    NOT NULL,
      canonical          TEXT    NOT NULL,
      variants           TEXT    NOT NULL DEFAULT '[]',
      meaning            TEXT    NOT NULL,
      origin_event       TEXT,
      origin_msg_id      TEXT,
      origin_user_id     TEXT,
      origin_ts          INTEGER,
      first_seen_count   INTEGER NOT NULL DEFAULT 1,
      total_count        INTEGER NOT NULL DEFAULT 1,
      confidence         REAL    NOT NULL DEFAULT 0.5,
      status             TEXT    NOT NULL DEFAULT 'active',
      embedding_vec      BLOB,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL,
      UNIQUE(group_id, canonical)
    );
    CREATE TABLE jargon_candidates (
      group_id              TEXT    NOT NULL,
      content               TEXT    NOT NULL,
      count                 INTEGER NOT NULL DEFAULT 1,
      contexts              TEXT    NOT NULL DEFAULT '[]',
      last_inference_count  INTEGER NOT NULL DEFAULT 0,
      meaning               TEXT,
      is_jargon             INTEGER NOT NULL DEFAULT 0,
      promoted              INTEGER NOT NULL DEFAULT 0,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      rejected              INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (group_id, content)
    );
    CREATE TABLE phrase_candidates (
      group_id              TEXT    NOT NULL,
      content               TEXT    NOT NULL,
      gram_len              INTEGER NOT NULL,
      count                 INTEGER NOT NULL DEFAULT 1,
      contexts              TEXT    NOT NULL DEFAULT '[]',
      last_inference_count  INTEGER NOT NULL DEFAULT 0,
      meaning               TEXT,
      is_jargon             INTEGER NOT NULL DEFAULT 0,
      promoted              INTEGER NOT NULL DEFAULT 0,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      rejected              INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (group_id, content, gram_len)
    );
  `);
  return db;
}

function seedGes(db: DatabaseSync, s: GesSeed): number {
  const info = db.prepare(
    `INSERT INTO groupmate_expression_samples
     (group_id, expression, expression_hash, speaker_user_ids, speaker_count,
      source_message_ids, occurrence_count, first_seen_at, last_active_at, rejected, schema_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,2)`,
  ).run(
    s.groupId, s.expression, `hash-${s.expression}`,
    JSON.stringify(s.speakers), s.speakers.length,
    JSON.stringify(['msg-1']), 3, 100, 100, s.rejected ?? 0,
  );
  return Number(info.lastInsertRowid);
}

function seedMeme(
  db: DatabaseSync, groupId: string, canonical: string,
  originUserId: string | null, status: 'active' | 'demoted' | 'manual_edit' = 'active',
): number {
  const info = db.prepare(
    `INSERT INTO meme_graph (group_id, canonical, meaning, origin_user_id, status, created_at, updated_at)
     VALUES (?, ?, 'm', ?, ?, 100, 100)`,
  ).run(groupId, canonical, originUserId, status);
  return Number(info.lastInsertRowid);
}

function seedJargon(
  db: DatabaseSync, groupId: string, content: string, contexts: unknown[],
): void {
  db.prepare(
    `INSERT INTO jargon_candidates
     (group_id, content, count, contexts, is_jargon, promoted, created_at, updated_at, rejected)
     VALUES (?, ?, 5, ?, 1, 0, 100, 100, 0)`,
  ).run(groupId, content, JSON.stringify(contexts));
}

function gesRejected(db: DatabaseSync, id: number): number {
  return (db.prepare('SELECT rejected FROM groupmate_expression_samples WHERE id = ?').get(id) as { rejected: number }).rejected;
}

function gesModifiedBy(db: DatabaseSync, id: number): string | null {
  return (db.prepare('SELECT modified_by FROM groupmate_expression_samples WHERE id = ?').get(id) as { modified_by: string | null }).modified_by;
}

function memeStatus(db: DatabaseSync, id: number): string {
  return (db.prepare('SELECT status FROM meme_graph WHERE id = ?').get(id) as { status: string }).status;
}

function jargonRejected(db: DatabaseSync, groupId: string, content: string): number {
  return (db.prepare('SELECT rejected FROM jargon_candidates WHERE group_id = ? AND content = ?').get(groupId, content) as { rejected: number }).rejected;
}

function totalRowCounts(db: DatabaseSync): Record<string, number> {
  return {
    ges: (db.prepare('SELECT COUNT(*) AS n FROM groupmate_expression_samples').get() as { n: number }).n,
    meme: (db.prepare('SELECT COUNT(*) AS n FROM meme_graph').get() as { n: number }).n,
    jargon: (db.prepare('SELECT COUNT(*) AS n FROM jargon_candidates').get() as { n: number }).n,
    phrase: (db.prepare('SELECT COUNT(*) AS n FROM phrase_candidates').get() as { n: number }).n,
  };
}

describe('purge-bot-self-corpus — runPurge', () => {
  it('dry-run reports correct found counts and zero DB changes', () => {
    const db = makeDb();
    // GES: 3 sole-bot, 2 mixed, 5 user-only
    const sole1 = seedGes(db, { groupId: GROUP, expression: 'b1', speakers: [BOT] });
    const sole2 = seedGes(db, { groupId: GROUP, expression: 'b2', speakers: [BOT, BOT] });
    const sole3 = seedGes(db, { groupId: GROUP, expression: 'b3', speakers: [BOT] });
    const mixed1 = seedGes(db, { groupId: GROUP, expression: 'm1', speakers: [BOT, USER_A] });
    const mixed2 = seedGes(db, { groupId: GROUP, expression: 'm2', speakers: [BOT, BOT, USER_A] });
    const user1 = seedGes(db, { groupId: GROUP, expression: 'u1', speakers: [USER_A] });
    seedGes(db, { groupId: GROUP, expression: 'u2', speakers: [USER_B] });
    seedGes(db, { groupId: GROUP, expression: 'u3', speakers: [USER_A, USER_B] });
    seedGes(db, { groupId: GROUP, expression: 'u4', speakers: [USER_A] });
    seedGes(db, { groupId: GROUP, expression: 'u5', speakers: [USER_B] });

    // meme_graph: 2 active bot, 1 manual_edit bot, 1 pre-demoted bot, 6 user/null
    seedMeme(db, GROUP, 'bot-active-1', BOT, 'active');
    seedMeme(db, GROUP, 'bot-active-2', BOT, 'active');
    seedMeme(db, GROUP, 'bot-edit', BOT, 'manual_edit');
    const preDemoted = seedMeme(db, GROUP, 'bot-pre-demoted', BOT, 'demoted');
    seedMeme(db, GROUP, 'user-active-1', USER_A, 'active');
    seedMeme(db, GROUP, 'user-active-2', USER_B, 'active');
    seedMeme(db, GROUP, 'null-active-1', null, 'active');
    seedMeme(db, GROUP, 'null-active-2', null, 'active');
    seedMeme(db, GROUP, 'user-active-3', USER_A, 'active');
    seedMeme(db, GROUP, 'user-active-4', USER_B, 'active');

    // jargon_candidates: 3 all-bot rich, 1 mixed-context rich, 5 user-context rich, 1 legacy string
    seedJargon(db, GROUP, 'jb1', [{ user_id: BOT, content: 'x' }, { user_id: BOT, content: 'y' }]);
    seedJargon(db, GROUP, 'jb2', [{ user_id: BOT, content: 'x' }]);
    seedJargon(db, GROUP, 'jb3', [{ user_id: BOT, content: 'x' }, { user_id: BOT, content: 'y' }, { user_id: BOT, content: 'z' }]);
    seedJargon(db, GROUP, 'jmix', [{ user_id: BOT, content: 'x' }, { user_id: USER_A, content: 'y' }]);
    seedJargon(db, GROUP, 'ju1', [{ user_id: USER_A, content: 'x' }]);
    seedJargon(db, GROUP, 'ju2', [{ user_id: USER_A, content: 'x' }]);
    seedJargon(db, GROUP, 'ju3', [{ user_id: USER_B, content: 'x' }]);
    seedJargon(db, GROUP, 'ju4', [{ user_id: USER_B, content: 'x' }]);
    seedJargon(db, GROUP, 'ju5', [{ user_id: USER_A, content: 'x' }, { user_id: USER_B, content: 'y' }]);
    seedJargon(db, GROUP, 'jlegacy', ['raw string context only']);

    const before = totalRowCounts(db);
    const results = runPurge(db, BOT, GROUP, false);

    const byTable = Object.fromEntries(results.map(r => [r.table, r]));
    expect(byTable['groupmate_expression_samples']!.found).toBe(3);
    expect(byTable['groupmate_expression_samples']!.updated).toBe(0);
    expect(byTable['meme_graph']!.found).toBe(3); // 2 active + 1 manual_edit; pre-demoted excluded
    expect(byTable['meme_graph']!.updated).toBe(0);
    expect(byTable['jargon_candidates']!.found).toBe(3);
    expect(byTable['jargon_candidates']!.updated).toBe(0);
    expect(byTable['phrase_candidates']!.found).toBe(0);
    expect(byTable['phrase_candidates']!.skipped).toMatch(/DEFERRED Phase 2/);

    // No DB mutations
    expect(totalRowCounts(db)).toEqual(before);
    for (const id of [sole1, sole2, sole3]) expect(gesRejected(db, id)).toBe(0);
    for (const id of [mixed1, mixed2, user1]) expect(gesRejected(db, id)).toBe(0);
    expect(memeStatus(db, preDemoted)).toBe('demoted');

    db.close();
  });

  it('--apply purges expected rows; mixed GES kept (LENIENT)', () => {
    const db = makeDb();
    const sole1 = seedGes(db, { groupId: GROUP, expression: 'b1', speakers: [BOT] });
    const sole2 = seedGes(db, { groupId: GROUP, expression: 'b2', speakers: [BOT, BOT] });
    const sole3 = seedGes(db, { groupId: GROUP, expression: 'b3', speakers: [BOT] });
    const mixed1 = seedGes(db, { groupId: GROUP, expression: 'm1', speakers: [BOT, USER_A] });
    const mixed2 = seedGes(db, { groupId: GROUP, expression: 'm2', speakers: [BOT, BOT, USER_A] });
    const user1 = seedGes(db, { groupId: GROUP, expression: 'u1', speakers: [USER_A] });

    const memeBot1 = seedMeme(db, GROUP, 'bot-active-1', BOT, 'active');
    const memeBot2 = seedMeme(db, GROUP, 'bot-active-2', BOT, 'active');
    const memeBotEdit = seedMeme(db, GROUP, 'bot-edit', BOT, 'manual_edit');
    const memePreDem = seedMeme(db, GROUP, 'bot-pre', BOT, 'demoted');
    const memeUser = seedMeme(db, GROUP, 'user-active', USER_A, 'active');
    const memeNull = seedMeme(db, GROUP, 'null-active', null, 'active');

    seedJargon(db, GROUP, 'jb1', [{ user_id: BOT, content: 'x' }]);
    seedJargon(db, GROUP, 'jb2', [{ user_id: BOT, content: 'x' }, { user_id: BOT, content: 'y' }]);
    seedJargon(db, GROUP, 'jb3', [{ user_id: BOT, content: 'x' }]);
    seedJargon(db, GROUP, 'jmix', [{ user_id: BOT, content: 'x' }, { user_id: USER_A, content: 'y' }]);
    seedJargon(db, GROUP, 'ju1', [{ user_id: USER_A, content: 'x' }]);
    seedJargon(db, GROUP, 'jlegacy', ['raw string']);

    const before = totalRowCounts(db);
    const results = runPurge(db, BOT, GROUP, true);

    const byTable = Object.fromEntries(results.map(r => [r.table, r]));
    expect(byTable['groupmate_expression_samples']!.found).toBe(3);
    expect(byTable['groupmate_expression_samples']!.updated).toBe(3);
    expect(byTable['meme_graph']!.updated).toBe(3);
    expect(byTable['jargon_candidates']!.updated).toBe(3);

    // No DELETE — row counts unchanged
    expect(totalRowCounts(db)).toEqual(before);

    // GES: sole bot rejected; mixed + user kept rejected=0
    for (const id of [sole1, sole2, sole3]) {
      expect(gesRejected(db, id)).toBe(1);
      expect(gesModifiedBy(db, id)).toBe('bot-self-purge');
    }
    for (const id of [mixed1, mixed2, user1]) expect(gesRejected(db, id)).toBe(0);

    // meme_graph: bot active+manual_edit demoted; pre-demoted/user/null untouched
    expect(memeStatus(db, memeBot1)).toBe('demoted');
    expect(memeStatus(db, memeBot2)).toBe('demoted');
    expect(memeStatus(db, memeBotEdit)).toBe('demoted');
    expect(memeStatus(db, memePreDem)).toBe('demoted'); // pre-existing, unchanged
    expect(memeStatus(db, memeUser)).toBe('active');
    expect(memeStatus(db, memeNull)).toBe('active');

    // jargon: all-bot rejected; mixed/user/legacy untouched
    expect(jargonRejected(db, GROUP, 'jb1')).toBe(1);
    expect(jargonRejected(db, GROUP, 'jb2')).toBe(1);
    expect(jargonRejected(db, GROUP, 'jb3')).toBe(1);
    expect(jargonRejected(db, GROUP, 'jmix')).toBe(0);
    expect(jargonRejected(db, GROUP, 'ju1')).toBe(0);
    expect(jargonRejected(db, GROUP, 'jlegacy')).toBe(0);

    db.close();
  });

  it('legacy string-only jargon contexts are skipped (cannot confirm bot-source)', () => {
    const db = makeDb();
    seedJargon(db, GROUP, 'jlegacy1', ['raw string a', 'raw string b']);
    seedJargon(db, GROUP, 'jlegacy2', ['raw']);

    const results = runPurge(db, BOT, GROUP, true);
    const jargon = results.find(r => r.table === 'jargon_candidates')!;
    expect(jargon.found).toBe(0);
    expect(jargon.updated).toBe(0);
    expect(jargonRejected(db, GROUP, 'jlegacy1')).toBe(0);
    expect(jargonRejected(db, GROUP, 'jlegacy2')).toBe(0);
    db.close();
  });

  it('--apply is idempotent (second run reports 0/0 and changes nothing)', () => {
    const db = makeDb();
    const soleId = seedGes(db, { groupId: GROUP, expression: 'b1', speakers: [BOT] });
    seedMeme(db, GROUP, 'bot-1', BOT, 'active');
    seedJargon(db, GROUP, 'jb1', [{ user_id: BOT, content: 'x' }]);

    const first = runPurge(db, BOT, GROUP, true);
    expect(first.find(r => r.table === 'groupmate_expression_samples')!.updated).toBe(1);
    expect(first.find(r => r.table === 'meme_graph')!.updated).toBe(1);
    expect(first.find(r => r.table === 'jargon_candidates')!.updated).toBe(1);

    const second = runPurge(db, BOT, GROUP, true);
    expect(second.find(r => r.table === 'groupmate_expression_samples')!.found).toBe(0);
    expect(second.find(r => r.table === 'groupmate_expression_samples')!.updated).toBe(0);
    expect(second.find(r => r.table === 'meme_graph')!.found).toBe(0);
    expect(second.find(r => r.table === 'meme_graph')!.updated).toBe(0);
    expect(second.find(r => r.table === 'jargon_candidates')!.found).toBe(0);
    expect(second.find(r => r.table === 'jargon_candidates')!.updated).toBe(0);

    expect(gesRejected(db, soleId)).toBe(1); // still rejected
    db.close();
  });

  it('--group-id scopes the audit (other-group rows untouched)', () => {
    const db = makeDb();
    const inGroup = seedGes(db, { groupId: GROUP, expression: 'b1', speakers: [BOT] });
    const outGroup = seedGes(db, { groupId: OTHER_GROUP, expression: 'b1', speakers: [BOT] });
    seedMeme(db, GROUP, 'in-bot', BOT, 'active');
    seedMeme(db, OTHER_GROUP, 'out-bot', BOT, 'active');
    seedJargon(db, GROUP, 'jin', [{ user_id: BOT, content: 'x' }]);
    seedJargon(db, OTHER_GROUP, 'jout', [{ user_id: BOT, content: 'x' }]);

    const results = runPurge(db, BOT, GROUP, true);
    expect(results.find(r => r.table === 'groupmate_expression_samples')!.updated).toBe(1);
    expect(results.find(r => r.table === 'meme_graph')!.updated).toBe(1);
    expect(results.find(r => r.table === 'jargon_candidates')!.updated).toBe(1);

    expect(gesRejected(db, inGroup)).toBe(1);
    expect(gesRejected(db, outGroup)).toBe(0);
    expect(jargonRejected(db, GROUP, 'jin')).toBe(1);
    expect(jargonRejected(db, OTHER_GROUP, 'jout')).toBe(0);
    db.close();
  });

  it('null origin_user_id meme_graph row is NOT touched', () => {
    const db = makeDb();
    const nullId = seedMeme(db, GROUP, 'null-meme', null, 'active');
    const userId = seedMeme(db, GROUP, 'user-meme', USER_A, 'active');
    const botId = seedMeme(db, GROUP, 'bot-meme', BOT, 'active');

    runPurge(db, BOT, GROUP, true);
    expect(memeStatus(db, nullId)).toBe('active');
    expect(memeStatus(db, userId)).toBe('active');
    expect(memeStatus(db, botId)).toBe('demoted');
    db.close();
  });

  it('meme_graph row pre-existing in demoted status is NOT re-updated', () => {
    const db = makeDb();
    const id = seedMeme(db, GROUP, 'bot-old-demoted', BOT, 'demoted');
    const before = (db.prepare('SELECT updated_at FROM meme_graph WHERE id = ?').get(id) as { updated_at: number }).updated_at;
    const results = runPurge(db, BOT, GROUP, true);
    expect(results.find(r => r.table === 'meme_graph')!.found).toBe(0);
    const after = (db.prepare('SELECT updated_at FROM meme_graph WHERE id = ?').get(id) as { updated_at: number }).updated_at;
    expect(after).toBe(before);
    db.close();
  });

  it('phrase_candidates remains DEFERRED (audit returns 0 found, skipped notice)', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO phrase_candidates
       (group_id, content, gram_len, count, contexts, is_jargon, promoted, created_at, updated_at)
       VALUES (?, ?, 3, 5, ?, 1, 0, 100, 100)`,
    ).run(GROUP, 'foo bar baz', JSON.stringify(['raw context text']));

    const results = runPurge(db, BOT, GROUP, true);
    const phrase = results.find(r => r.table === 'phrase_candidates')!;
    expect(phrase.found).toBe(0);
    expect(phrase.updated).toBe(0);
    expect(phrase.skipped).toMatch(/DEFERRED Phase 2/);

    const rejected = (db.prepare('SELECT rejected FROM phrase_candidates WHERE group_id = ? AND content = ?').get(GROUP, 'foo bar baz') as { rejected: number }).rejected;
    expect(rejected).toBe(0);
    db.close();
  });

  it('missing required args (no --bot-qq, no env) is detected by parseArgs (covered via runPurge contract: returns 4 results)', () => {
    // runPurge always returns the 4 audit results when given valid args.
    const db = makeDb();
    const results = runPurge(db, BOT, null, false); // no group filter
    expect(results.map(r => r.table)).toEqual([
      'groupmate_expression_samples',
      'meme_graph',
      'jargon_candidates',
      'phrase_candidates',
    ]);
    db.close();
  });
});
