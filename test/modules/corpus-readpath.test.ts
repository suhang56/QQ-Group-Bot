import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { MemeGraphRepository, PhraseCandidatesRepository } from '../../src/storage/meme-repos.js';
import { loadGroupJargon } from '../../src/modules/jargon-provider.js';

const GROUP = 'g_test';

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
  `);
  return db;
}

function seedJargon(db: DatabaseSync, content: string, rejected: number, count = 5, isJargon = 1, meaning: string | null = 'm'): void {
  db.prepare(
    `INSERT INTO jargon_candidates
     (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at, rejected)
     VALUES (?, ?, ?, '[]', 0, ?, ?, 0, 100, 100, ?)`,
  ).run(GROUP, content, count, meaning, isJargon, rejected);
}

function seedPhrase(db: DatabaseSync, content: string, rejected: number, count = 5, isJargon = 1): void {
  db.prepare(
    `INSERT INTO phrase_candidates
     (group_id, content, gram_len, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at, rejected)
     VALUES (?, ?, 3, ?, '[]', 0, 'm', ?, 0, 100, 100, ?)`,
  ).run(GROUP, content, count, isJargon, rejected);
}

function seedMeme(db: DatabaseSync, canonical: string, status: 'active' | 'demoted' | 'manual_edit', variants: string[] = []): void {
  db.prepare(
    `INSERT INTO meme_graph (group_id, canonical, variants, meaning, status, created_at, updated_at)
     VALUES (?, ?, ?, 'm', ?, 100, 100)`,
  ).run(GROUP, canonical, JSON.stringify(variants), status);
}

function seedGes(db: DatabaseSync, expression: string, rejected: number, speakers: string[] = ['user-a', 'user-b']): void {
  db.prepare(
    `INSERT INTO groupmate_expression_samples
     (group_id, expression, expression_hash, speaker_user_ids, speaker_count,
      source_message_ids, occurrence_count, first_seen_at, last_active_at, rejected, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, 5, 100, 100, ?, 2)`,
  ).run(GROUP, expression, `h-${expression}`, JSON.stringify(speakers), speakers.length, JSON.stringify(['m1']), rejected);
}

describe('corpus read-path filter', () => {
  it('jargon_candidates rejected=1 excluded from inferJargon batch (lifted SQL)', () => {
    // Mirrors jargon-miner.ts:308 SELECT after R6 patch.
    const db = makeDb();
    // count must be in INFERENCE_THRESHOLDS (e.g. 5, 10, 20, 50). Use 5.
    seedJargon(db, 'kept', 0, 5, 0);
    seedJargon(db, 'rejected', 1, 5, 0);

    const rows = db.prepare(`
      SELECT * FROM jargon_candidates
      WHERE group_id = ?
        AND rejected = 0
        AND count IN (5, 10, 20, 50)
        AND count > last_inference_count
      ORDER BY count DESC
      LIMIT 100
    `).all(GROUP) as Array<{ content: string }>;
    expect(rows.map(r => r.content)).toEqual(['kept']);
    db.close();
  });

  it('jargon_candidates rejected=1 excluded from promoteToFacts batch (lifted SQL)', () => {
    const db = makeDb();
    seedJargon(db, 'kept', 0, 5, 1);
    seedJargon(db, 'rejected', 1, 5, 1);

    const rows = db.prepare(`
      SELECT * FROM jargon_candidates
      WHERE group_id = ? AND is_jargon = 1 AND rejected = 0
    `).all(GROUP) as Array<{ content: string }>;
    expect(rows.map(r => r.content)).toEqual(['kept']);
    db.close();
  });

  it('jargon_candidates rejected=1 excluded from jargon-provider.loadGroupJargon', () => {
    const db = makeDb();
    seedJargon(db, 'kept', 0, 5, 1, 'kept-meaning');
    seedJargon(db, 'rejected', 1, 5, 1, 'rejected-meaning');

    const entries = loadGroupJargon(db, GROUP, 30);
    expect(entries.map(e => e.term)).toEqual(['kept']);
    db.close();
  });

  it('jargon_candidates rejected=1 excluded from meme-clusterer candidate read (lifted SQL)', () => {
    const db = makeDb();
    seedJargon(db, 'kept', 0, 5, 1);
    seedJargon(db, 'rejected', 1, 5, 1);

    const rows = db.prepare(`
      SELECT * FROM jargon_candidates
      WHERE group_id = ? AND is_jargon = 1 AND promoted = 0 AND rejected = 0
      ORDER BY count DESC
    `).all(GROUP) as Array<{ content: string }>;
    expect(rows.map(r => r.content)).toEqual(['kept']);
    db.close();
  });

  it('phrase_candidates rejected=1 excluded from PhraseCandidatesRepository.findAtThreshold', () => {
    const db = makeDb();
    seedPhrase(db, 'kept', 0, 5, 0);
    seedPhrase(db, 'rejected', 1, 5, 0);

    const repo = new PhraseCandidatesRepository(db);
    const rows = repo.findAtThreshold(GROUP, [5, 10], 100);
    expect(rows.map(r => r.content)).toEqual(['kept']);
    db.close();
  });

  it('phrase_candidates rejected=1 excluded from PhraseCandidatesRepository.listUnpromoted', () => {
    const db = makeDb();
    seedPhrase(db, 'kept', 0, 5, 1);
    seedPhrase(db, 'rejected', 1, 5, 1);

    const repo = new PhraseCandidatesRepository(db);
    const rows = repo.listUnpromoted(GROUP);
    expect(rows.map(r => r.content)).toEqual(['kept']);
    db.close();
  });

  it('meme_graph status=demoted excluded from MemeGraphRepository.findByCanonical (post-patch)', () => {
    const db = makeDb();
    seedMeme(db, 'active-meme', 'active');
    seedMeme(db, 'demoted-meme', 'demoted');
    seedMeme(db, 'manual-meme', 'manual_edit');

    const repo = new MemeGraphRepository(db);
    expect(repo.findByCanonical(GROUP, 'active-meme')?.canonical).toBe('active-meme');
    expect(repo.findByCanonical(GROUP, 'manual-meme')?.canonical).toBe('manual-meme');
    expect(repo.findByCanonical(GROUP, 'demoted-meme')).toBeNull();
    db.close();
  });

  it('meme_graph status=demoted excluded from MemeGraphRepository.findByVariant (post-patch)', () => {
    const db = makeDb();
    seedMeme(db, 'active-canon', 'active', ['shared-term']);
    seedMeme(db, 'demoted-canon', 'demoted', ['shared-term']);
    seedMeme(db, 'edit-canon', 'manual_edit', ['shared-term']);

    const repo = new MemeGraphRepository(db);
    const matches = repo.findByVariant(GROUP, 'shared-term');
    const canonicals = matches.map(m => m.canonical).sort();
    expect(canonicals).toEqual(['active-canon', 'edit-canon']);
    expect(canonicals).not.toContain('demoted-canon');
    db.close();
  });

  it('groupmate_expression_samples rejected=1 excluded from listQualified-style read (regression guard)', () => {
    // Mirrors db.ts:2996 listQualified SELECT — confirms LENIENT-purged GES
    // rows are removed from the prompt path.
    const db = makeDb();
    seedGes(db, 'kept-1', 0);
    seedGes(db, 'kept-2', 0, ['user-a']);
    // rejected=1 must NOT appear regardless of speaker_count/occurrence_count
    seedGes(db, 'purged-1', 1);
    seedGes(db, 'purged-2', 1, ['bot']);

    const rows = db.prepare(`
      SELECT * FROM groupmate_expression_samples
      WHERE group_id = ? AND rejected = 0
        AND (occurrence_count >= 3 OR speaker_count >= 2)
      ORDER BY speaker_count DESC, occurrence_count DESC, last_active_at DESC
      LIMIT 100
    `).all(GROUP) as Array<{ expression: string }>;
    const exprs = rows.map(r => r.expression).sort();
    expect(exprs).toEqual(['kept-1', 'kept-2']);
    db.close();
  });
});
