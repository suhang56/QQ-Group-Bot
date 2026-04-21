import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { IClaudeClient, ClaudeResponse } from '../../src/ai/claude.js';
import type { IMessageRepository, ILearnedFactsRepository, Message } from '../../src/storage/db.js';
import { JargonMiner } from '../../src/modules/jargon-miner.js';
import { initLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = '1705075399';
const USER_ID = 'user-42';

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
    content: '智械危机',
    rawContent: '智械危机',
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
      text: '{"meaning":"unknown"}', inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    })),
    describeImage: vi.fn().mockResolvedValue(''),
    visionWithPrompt: vi.fn().mockResolvedValue(''),
  };
}

function makeLearnedFactsStub(): ILearnedFactsRepository {
  return {
    insertOrSupersede: vi.fn().mockReturnValue({ newId: 1, supersededIds: [] }),
    listActive: vi.fn().mockReturnValue([]),
    findActiveByTopicTerm: vi.fn().mockReturnValue([]),
    findActiveByFactText: vi.fn().mockReturnValue(null),
    findById: vi.fn().mockReturnValue(null),
    updateStatus: vi.fn(),
    listPending: vi.fn().mockReturnValue([]),
    listStale: vi.fn().mockReturnValue([]),
    adminEdit: vi.fn(),
    pruneOld: vi.fn(),
  } as unknown as ILearnedFactsRepository;
}

function jcRowCount(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM jargon_candidates').get() as { n: number }).n;
}

describe('JargonMiner — bot-output skip', () => {
  it('MUST-FIRE: user message triggers INSERT INTO jargon_candidates', () => {
    const db = makeDb();
    const msgs = [makeMessage({ content: '智械危机', userId: USER_ID })];
    const miner = new JargonMiner({
      db,
      messages: makeMessageRepo(msgs),
      learnedFacts: makeLearnedFactsStub(),
      claude: makeClaude(),
      activeGroups: ['g1'],
      botUserId: BOT_ID,
      now: () => 1_700_000_000_000,
    });
    miner.extractCandidatesFromMessages('g1', msgs);
    expect(jcRowCount(db)).toBeGreaterThan(0);
    db.close();
  });

  it('MUST-NOT-FIRE: bot message (userId === botUserId) — 0 inserts', () => {
    const db = makeDb();
    const msgs = Array.from({ length: 10 }, (_, i) =>
      makeMessage({ id: i + 1, content: '再@我你试试', userId: BOT_ID }),
    );
    const miner = new JargonMiner({
      db,
      messages: makeMessageRepo(msgs),
      learnedFacts: makeLearnedFactsStub(),
      claude: makeClaude(),
      activeGroups: ['g1'],
      botUserId: BOT_ID,
      now: () => 1_700_000_000_000,
    });
    miner.extractCandidatesFromMessages('g1', msgs);
    expect(jcRowCount(db)).toBe(0);
    db.close();
  });

  it('MUST-NOT-FIRE: botUserId undefined — filter no-op, bot msgs still ingested', () => {
    const db = makeDb();
    const msgs = [makeMessage({ content: '智械危机', userId: BOT_ID })];
    const miner = new JargonMiner({
      db,
      messages: makeMessageRepo(msgs),
      learnedFacts: makeLearnedFactsStub(),
      claude: makeClaude(),
      activeGroups: ['g1'],
      now: () => 1_700_000_000_000,
    });
    miner.extractCandidatesFromMessages('g1', msgs);
    expect(jcRowCount(db)).toBeGreaterThan(0);
    db.close();
  });

  it('MUST-NOT-FIRE: botUserId = "" — truthy guard, empty-string safe', () => {
    const db = makeDb();
    const msgs = [makeMessage({ content: '智械危机', userId: '' as unknown as string })];
    const miner = new JargonMiner({
      db,
      messages: makeMessageRepo(msgs),
      learnedFacts: makeLearnedFactsStub(),
      claude: makeClaude(),
      activeGroups: ['g1'],
      botUserId: '',
      now: () => 1_700_000_000_000,
    });
    miner.extractCandidatesFromMessages('g1', msgs);
    expect(jcRowCount(db)).toBeGreaterThan(0);
    db.close();
  });

  it('MUST-NOT-FIRE: msg.userId null — treated non-bot, writes proceed', () => {
    const db = makeDb();
    const msgs = [makeMessage({ content: '智械危机', userId: null as unknown as string })];
    const miner = new JargonMiner({
      db,
      messages: makeMessageRepo(msgs),
      learnedFacts: makeLearnedFactsStub(),
      claude: makeClaude(),
      activeGroups: ['g1'],
      botUserId: BOT_ID,
      now: () => 1_700_000_000_000,
    });
    miner.extractCandidatesFromMessages('g1', msgs);
    expect(jcRowCount(db)).toBeGreaterThan(0);
    db.close();
  });

  it('mixed batch: bot rows filtered, user rows inserted', () => {
    const db = makeDb();
    const msgs = [
      makeMessage({ id: 1, content: '再@我你试试', userId: BOT_ID }),
      makeMessage({ id: 2, content: '智械危机', userId: USER_ID }),
      makeMessage({ id: 3, content: '女的22岁', userId: BOT_ID }),
      makeMessage({ id: 4, content: '摆烂', userId: 'user-99' }),
    ];
    const miner = new JargonMiner({
      db,
      messages: makeMessageRepo(msgs),
      learnedFacts: makeLearnedFactsStub(),
      claude: makeClaude(),
      activeGroups: ['g1'],
      botUserId: BOT_ID,
      now: () => 1_700_000_000_000,
    });
    miner.extractCandidatesFromMessages('g1', msgs);

    const rows = db.prepare('SELECT content FROM jargon_candidates').all() as Array<{ content: string }>;
    for (const r of rows) {
      expect(r.content).not.toMatch(/再@我你试试|女的22岁/);
    }
    expect(rows.length).toBeGreaterThan(0);
    db.close();
  });
});
