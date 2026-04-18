import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { IMessageRepository, ILearnedFactsRepository, Message, LearnedFact } from '../src/storage/db.js';
import { JargonMiner } from '../src/modules/jargon-miner.js';
import { vi } from 'vitest';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS jargon_candidates (
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

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    groupId: 'g1',
    userId: 'u1',
    nickname: 'TestUser',
    content: 'hello',
    rawContent: 'hello',
    timestamp: 1700000000,
    deleted: false,
    ...overrides,
  };
}

function makeMessageRepo(messages: Message[] = []): IMessageRepository {
  return {
    insert: vi.fn().mockReturnValue(messages[0] ?? makeMessage()),
    getRecent: vi.fn().mockReturnValue(messages),
    getByUser: vi.fn().mockReturnValue([]),
    sampleRandomHistorical: vi.fn().mockReturnValue([]),
    searchByKeywords: vi.fn().mockReturnValue([]),
    getTopUsers: vi.fn().mockReturnValue([]),
    softDelete: vi.fn(),
    findBySourceId: vi.fn().mockReturnValue(null),
    findNearTimestamp: vi.fn().mockReturnValue(null),
    getAroundTimestamp: vi.fn().mockReturnValue([]),
    listDistinctNicknames: vi.fn().mockReturnValue([]),
  };
}

function makeLearnedFactsRepo(): ILearnedFactsRepository {
  return {
    insert: vi.fn().mockReturnValue(1),
    listActive: vi.fn().mockReturnValue([]),
    listActiveWithEmbeddings: vi.fn().mockReturnValue([]),
    listNullEmbeddingActive: vi.fn().mockReturnValue([]),
    listAllNullEmbeddingActive: vi.fn().mockReturnValue([]),
    updateEmbedding: vi.fn(),
    markStatus: vi.fn(),
    clearGroup: vi.fn().mockReturnValue(0),
    countActive: vi.fn().mockReturnValue(0),
    setEmbeddingService: vi.fn(),
    findSimilarActive: vi.fn().mockResolvedValue(null),
    listPending: vi.fn().mockReturnValue([]),
    countPending: vi.fn().mockReturnValue(0),
    expirePendingOlderThan: vi.fn().mockReturnValue(0),
    approveAllPending: vi.fn().mockReturnValue(0),
  };
}

function makeClaude(): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({ text: '{"meaning": "test"}', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    describeImage: vi.fn().mockResolvedValue(''),
    visionWithPrompt: vi.fn().mockResolvedValue(''),
  };
}

function makeMiner(db: DatabaseSync): JargonMiner {
  return new JargonMiner({
    db,
    messages: makeMessageRepo(),
    learnedFacts: makeLearnedFactsRepo(),
    claude: makeClaude(),
    activeGroups: ['g1'],
    now: () => 1700000000000,
  });
}

describe('jargon-miner-contexts M2 write-side', () => {
  it('extractCandidatesFromMessages stores userId in context object', () => {
    const db = makeDb();
    const miner = makeMiner(db);

    const msgs: Message[] = [
      makeMessage({ id: 1, userId: 'user1', content: '弯曲 真的 很好', rawContent: '弯曲 真的 很好' }),
    ];
    miner.extractCandidatesFromMessages('g1', msgs);

    const row = db.prepare(`SELECT contexts FROM jargon_candidates WHERE content = '弯曲'`).get() as { contexts: string } | undefined;
    expect(row).toBeDefined();
    const parsed = JSON.parse(row!.contexts);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]).toMatchObject({ user_id: 'user1' });
    expect(typeof parsed[0].content).toBe('string');
  });

  it('null userId stored as user_id=unknown', () => {
    const db = makeDb();
    const miner = makeMiner(db);

    // Force userId to null via type cast
    const msgs: Message[] = [
      { ...makeMessage({ id: 1, content: '弯曲 好看', rawContent: '弯曲 好看' }), userId: null as unknown as string },
    ];
    miner.extractCandidatesFromMessages('g1', msgs);

    const row = db.prepare(`SELECT contexts FROM jargon_candidates WHERE content = '弯曲'`).get() as { contexts: string } | undefined;
    expect(row).toBeDefined();
    const parsed = JSON.parse(row!.contexts);
    expect(parsed[0]).toMatchObject({ user_id: 'unknown' });
  });

  it('multiple messages from different users accumulate distinct user_id values', () => {
    const db = makeDb();
    const miner = makeMiner(db);

    const msgs: Message[] = [
      makeMessage({ id: 1, userId: 'ua', content: '弯曲 来了', rawContent: '弯曲 来了' }),
      makeMessage({ id: 2, userId: 'ub', content: '弯曲 不错', rawContent: '弯曲 不错' }),
      makeMessage({ id: 3, userId: 'uc', content: '弯曲 很强', rawContent: '弯曲 很强' }),
    ];
    miner.extractCandidatesFromMessages('g1', msgs);

    const row = db.prepare(`SELECT contexts FROM jargon_candidates WHERE content = '弯曲'`).get() as { contexts: string } | undefined;
    expect(row).toBeDefined();
    const parsed: Array<{ user_id: string }> = JSON.parse(row!.contexts);
    const userIds = new Set(parsed.map(c => c.user_id));
    expect(userIds.size).toBeGreaterThanOrEqual(3);
  });

  it('backward-compat: existing string[] contexts are migrated on next upsert', () => {
    const db = makeDb();
    const nowSec = 1700000;
    // Insert old-format string[] contexts directly
    db.prepare(`
      INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, is_jargon, created_at, updated_at)
      VALUES ('g1', '弯曲', 2, '["old context 1","old context 2"]', 0, 0, ?, ?)
    `).run(nowSec, nowSec);

    const miner = makeMiner(db);
    const msgs: Message[] = [
      makeMessage({ id: 10, userId: 'newuser', content: '弯曲 新消息', rawContent: '弯曲 新消息' }),
    ];
    miner.extractCandidatesFromMessages('g1', msgs);

    const row = db.prepare(`SELECT contexts FROM jargon_candidates WHERE content = '弯曲'`).get() as { contexts: string };
    const parsed: unknown[] = JSON.parse(row.contexts);
    // All entries should now be objects, not strings
    for (const entry of parsed) {
      expect(typeof entry).toBe('object');
      expect(entry).not.toBeNull();
    }
  });
});
