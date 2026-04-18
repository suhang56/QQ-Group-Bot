import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { novelTokenCount, runBackfill } from '../scripts/backfill-persona-form.js';
import type { LlmClient } from '../scripts/backfill-persona-form.js';

function makeInMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE learned_facts (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id             TEXT    NOT NULL,
      topic                TEXT,
      fact                 TEXT    NOT NULL DEFAULT '',
      source_user_id       TEXT,
      source_user_nickname TEXT,
      source_msg_id        TEXT,
      bot_reply_id         INTEGER,
      confidence           REAL    NOT NULL DEFAULT 1.0,
      status               TEXT    NOT NULL DEFAULT 'active',
      created_at           INTEGER NOT NULL DEFAULT 0,
      updated_at           INTEGER NOT NULL DEFAULT 0,
      embedding_vec        BLOB,
      embedding_status     TEXT    DEFAULT 'pending',
      last_attempt_at      INTEGER,
      canonical_form       TEXT,
      persona_form         TEXT
    )
  `);
  return db;
}

function insertRow(db: DatabaseSync, opts: {
  groupId: string;
  canonicalForm: string;
  personaForm?: string;
  status?: string;
}): number {
  const result = db.prepare(`
    INSERT INTO learned_facts (group_id, canonical_form, persona_form, status, fact, created_at, updated_at)
    VALUES (?, ?, ?, ?, '', 0, 0)
  `).run(opts.groupId, opts.canonicalForm, opts.personaForm ?? null, opts.status ?? 'active') as { lastInsertRowid: number };
  return result.lastInsertRowid;
}

function makeMockLlm(lines: string[] | null, shouldThrow = false): LlmClient {
  return {
    complete: vi.fn(async () => {
      if (shouldThrow) throw new Error('LLM error');
      return { text: (lines ?? []).join('\n') };
    }),
  };
}

describe('backfill-persona-form', () => {
  describe('novelTokenCount', () => {
    it('poison-guard rejects >2 novel tokens', () => {
      const { count } = novelTokenCount('苹果是红色的', '苹果是红色的而且含有维生素C和纤维素');
      expect(count).toBeGreaterThan(2);
    });

    it('poison-guard accepts <=2 novel tokens', () => {
      const { count } = novelTokenCount('苹果是红色的', '苹果是红色哒');
      expect(count).toBeLessThanOrEqual(2);
    });
  });

  describe('runBackfill', () => {
    it('dry-run writes nothing', async () => {
      const db = makeInMemoryDb();
      const id = insertRow(db, { groupId: 'g1', canonicalForm: '苹果是红色的' });
      const llm = makeMockLlm(['苹果是红色哒']);

      await runBackfill({ internalDb: db, groupId: 'g1', batchSize: 20, dryRun: true, model: 'test-model', llm });

      const row = db.prepare('SELECT persona_form FROM learned_facts WHERE id = ?').get(id) as { persona_form: string | null };
      expect(row.persona_form).toBeNull();
    });

    it('skip rows with non-empty persona_form', async () => {
      const db = makeInMemoryDb();
      insertRow(db, { groupId: 'g1', canonicalForm: '苹果是红色的', personaForm: 'existing' });
      const llm = makeMockLlm([]);

      const result = await runBackfill({ internalDb: db, groupId: 'g1', batchSize: 20, dryRun: false, model: 'test-model', llm });

      expect(result.processed).toBe(0);
      expect(llm.complete).not.toHaveBeenCalled();
    });

    it('skip rows with empty canonical_form', async () => {
      const db = makeInMemoryDb();
      insertRow(db, { groupId: 'g1', canonicalForm: '' });
      const llm = makeMockLlm([]);

      const result = await runBackfill({ internalDb: db, groupId: 'g1', batchSize: 20, dryRun: false, model: 'test-model', llm });

      expect(result.processed).toBe(0);
      expect(llm.complete).not.toHaveBeenCalled();
    });

    it('line-count mismatch skips entire batch', async () => {
      const db = makeInMemoryDb();
      const id1 = insertRow(db, { groupId: 'g1', canonicalForm: '苹果是红色的' });
      const id2 = insertRow(db, { groupId: 'g1', canonicalForm: '香蕉是黄色的' });
      const id3 = insertRow(db, { groupId: 'g1', canonicalForm: '葡萄是紫色的' });
      // LLM returns only 1 line for a 3-row batch
      const llm = makeMockLlm(['苹果是红色哒']);

      const result = await runBackfill({ internalDb: db, groupId: 'g1', batchSize: 20, dryRun: false, model: 'test-model', llm });

      expect(result.written).toBe(0);
      for (const id of [id1, id2, id3]) {
        const row = db.prepare('SELECT persona_form FROM learned_facts WHERE id = ?').get(id) as { persona_form: string | null };
        expect(row.persona_form).toBeNull();
      }
    });

    it('LLM error skips batch, does not crash', async () => {
      const db = makeInMemoryDb();
      insertRow(db, { groupId: 'g1', canonicalForm: '苹果是红色的' });
      const llm = makeMockLlm(null, true);

      await expect(
        runBackfill({ internalDb: db, groupId: 'g1', batchSize: 20, dryRun: false, model: 'test-model', llm })
      ).resolves.not.toThrow();
    });

    it('writes accepted row in non-dry-run mode', async () => {
      const db = makeInMemoryDb();
      const id = insertRow(db, { groupId: 'g1', canonicalForm: '苹果是红色的' });
      const llm = makeMockLlm(['苹果是红色哒']);

      const result = await runBackfill({ internalDb: db, groupId: 'g1', batchSize: 20, dryRun: false, model: 'test-model', llm });

      expect(result.written).toBe(1);
      const row = db.prepare('SELECT persona_form FROM learned_facts WHERE id = ?').get(id) as { persona_form: string | null };
      expect(row.persona_form).toBe('苹果是红色哒');
    });
  });
});
