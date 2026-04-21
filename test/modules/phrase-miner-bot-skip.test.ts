import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { IClaudeClient, ClaudeResponse } from '../../src/ai/claude.js';
import type { IMessageRepository, IPhraseCandidatesRepo, Message } from '../../src/storage/db.js';
import { PhraseCandidatesRepository } from '../../src/storage/meme-repos.js';
import { PhraseMiner } from '../../src/modules/phrase-miner.js';
import { initLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = '1705075399';
const USER_ID = 'user-42';

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS phrase_candidates (
      group_id              TEXT    NOT NULL,
      content               TEXT    NOT NULL,
      gram_len              INTEGER NOT NULL DEFAULT 2,
      count                 INTEGER NOT NULL DEFAULT 1,
      contexts              TEXT    NOT NULL DEFAULT '[]',
      last_inference_count  INTEGER NOT NULL DEFAULT 0,
      meaning               TEXT,
      is_jargon             INTEGER NOT NULL DEFAULT 0,
      promoted              INTEGER NOT NULL DEFAULT 0,
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
    userId: USER_ID,
    nickname: 'TestUser',
    content: '智械危机来了',
    rawContent: '智械危机来了',
    timestamp: Math.floor(Date.now() / 1000),
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
  };
}

function makeClaude(): IClaudeClient {
  return {
    complete: vi.fn().mockImplementation((): Promise<ClaudeResponse> => Promise.resolve({
      text: '{"meaning":"unknown"}',
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    })),
    describeImage: vi.fn().mockResolvedValue(''),
    visionWithPrompt: vi.fn().mockResolvedValue(''),
  };
}

function makeRepoSpy(db: DatabaseSync): IPhraseCandidatesRepo {
  const real = new PhraseCandidatesRepository(db);
  return {
    upsert: vi.fn((...a: Parameters<IPhraseCandidatesRepo['upsert']>) => real.upsert(...a)),
    findAtThreshold: vi.fn((...a: Parameters<IPhraseCandidatesRepo['findAtThreshold']>) => real.findAtThreshold(...a)),
    updateInference: vi.fn((...a: Parameters<IPhraseCandidatesRepo['updateInference']>) => real.updateInference(...a)),
    listUnpromoted: vi.fn((...a: Parameters<IPhraseCandidatesRepo['listUnpromoted']>) => real.listUnpromoted(...a)),
    markPromoted: vi.fn((...a: Parameters<IPhraseCandidatesRepo['markPromoted']>) => real.markPromoted(...a)),
  };
}

function rowCount(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM phrase_candidates').get() as { n: number }).n;
}

describe('PhraseMiner — bot-output skip', () => {
  it('MUST-FIRE: user message triggers repo.upsert', () => {
    const db = makeDb();
    const msgs = [makeMessage({ content: '智械危机 来了', userId: USER_ID })];
    const repo = makeRepoSpy(db);
    const miner = new PhraseMiner({
      messages: makeMessageRepo(msgs),
      claude: makeClaude(),
      phraseCandidates: repo,
      activeGroups: ['g1'],
      botUserId: BOT_ID,
      now: () => 1_700_000_000_000,
    });
    miner.extractCandidates('g1');
    expect(repo.upsert).toHaveBeenCalled();
    expect(rowCount(db)).toBeGreaterThan(0);
    db.close();
  });

  it('MUST-NOT-FIRE: bot message (userId === botUserId) is fully skipped', () => {
    const db = makeDb();
    const msgs = Array.from({ length: 10 }, (_, i) =>
      makeMessage({ id: i + 1, content: '再@我你试试 一下', userId: BOT_ID }),
    );
    const repo = makeRepoSpy(db);
    const miner = new PhraseMiner({
      messages: makeMessageRepo(msgs),
      claude: makeClaude(),
      phraseCandidates: repo,
      activeGroups: ['g1'],
      botUserId: BOT_ID,
      now: () => 1_700_000_000_000,
    });
    miner.extractCandidates('g1');
    expect(repo.upsert).not.toHaveBeenCalled();
    expect(rowCount(db)).toBe(0);
    db.close();
  });

  it('MUST-NOT-FIRE: botUserId = undefined — filter no-op, bot msgs still processed', () => {
    const db = makeDb();
    const msgs = [makeMessage({ content: '智械危机 来了', userId: BOT_ID })];
    const repo = makeRepoSpy(db);
    const miner = new PhraseMiner({
      messages: makeMessageRepo(msgs),
      claude: makeClaude(),
      phraseCandidates: repo,
      activeGroups: ['g1'],
      now: () => 1_700_000_000_000,
    });
    miner.extractCandidates('g1');
    expect(repo.upsert).toHaveBeenCalled();
    db.close();
  });

  it('MUST-NOT-FIRE: botUserId = "" — truthy guard no-op even with empty userId', () => {
    const db = makeDb();
    const msgs = [makeMessage({ content: '智械危机 来了', userId: '' as unknown as string })];
    const repo = makeRepoSpy(db);
    const miner = new PhraseMiner({
      messages: makeMessageRepo(msgs),
      claude: makeClaude(),
      phraseCandidates: repo,
      activeGroups: ['g1'],
      botUserId: '',
      now: () => 1_700_000_000_000,
    });
    miner.extractCandidates('g1');
    expect(repo.upsert).toHaveBeenCalled();
    db.close();
  });

  it('MUST-NOT-FIRE: user msg containing bot nickname — nickname is NOT userId, writes normally', () => {
    const db = makeDb();
    const msgs = [makeMessage({
      content: '@bot 智械危机 来了',
      userId: USER_ID,
      nickname: 'HumanUser',
    })];
    const repo = makeRepoSpy(db);
    const miner = new PhraseMiner({
      messages: makeMessageRepo(msgs),
      claude: makeClaude(),
      phraseCandidates: repo,
      activeGroups: ['g1'],
      botUserId: BOT_ID,
      now: () => 1_700_000_000_000,
    });
    miner.extractCandidates('g1');
    expect(repo.upsert).toHaveBeenCalled();
    db.close();
  });

  it('MUST-NOT-FIRE: msg.userId === null (historical import) — treated non-bot, writes', () => {
    const db = makeDb();
    const msgs = [makeMessage({
      content: '智械危机 来了',
      userId: null as unknown as string,
    })];
    const repo = makeRepoSpy(db);
    const miner = new PhraseMiner({
      messages: makeMessageRepo(msgs),
      claude: makeClaude(),
      phraseCandidates: repo,
      activeGroups: ['g1'],
      botUserId: BOT_ID,
      now: () => 1_700_000_000_000,
    });
    miner.extractCandidates('g1');
    expect(repo.upsert).toHaveBeenCalled();
    db.close();
  });

  it('mixed batch: skips bot rows, processes user rows', () => {
    const db = makeDb();
    const msgs = [
      makeMessage({ id: 1, content: '再@我你试试 啊', userId: BOT_ID }),
      makeMessage({ id: 2, content: '智械危机 来了', userId: USER_ID }),
      makeMessage({ id: 3, content: '烦死了 真的', userId: BOT_ID }),
      makeMessage({ id: 4, content: '周五 放假 真好', userId: 'user-99' }),
    ];
    const repo = makeRepoSpy(db);
    const miner = new PhraseMiner({
      messages: makeMessageRepo(msgs),
      claude: makeClaude(),
      phraseCandidates: repo,
      activeGroups: ['g1'],
      botUserId: BOT_ID,
      now: () => 1_700_000_000_000,
    });
    miner.extractCandidates('g1');

    // Contexts in stored rows must all come from user-authored msgs; no bot content leaked
    const rows = db.prepare('SELECT content FROM phrase_candidates').all() as Array<{ content: string }>;
    for (const r of rows) {
      expect(r.content).not.toMatch(/再@我你试试|烦死了/);
    }
    expect(rows.length).toBeGreaterThan(0);
    db.close();
  });
});
