import { describe, it, expect, vi } from 'vitest';
import { MemeClusterer } from '../../src/modules/meme-clusterer.js';
import type { IClaudeClient, ClaudeRequest, ClaudeResponse } from '../../src/ai/claude.js';
import type { IMemeGraphRepo, IPhraseCandidatesRepo, MemeGraphEntry, PhraseCandidateRow } from '../../src/storage/db.js';
import { Database } from '../../src/storage/db.js';
import { initLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = '1705075399';
const USER_ID = 'user-42';

function mockClaude(responses: string[]): IClaudeClient {
  let callIdx = 0;
  return {
    complete: vi.fn(async (_req: ClaudeRequest): Promise<ClaudeResponse> => {
      const text = responses[callIdx] ?? '{}';
      callIdx++;
      return { text, inputTokens: 10, outputTokens: 10 };
    }),
    describeImage: vi.fn() as never,
    visionWithPrompt: vi.fn() as never,
  };
}

function mockMemeGraphRepo(): IMemeGraphRepo {
  const store = new Map<number, MemeGraphEntry>();
  let nextId = 100;
  return {
    insert: vi.fn((entry: Omit<MemeGraphEntry, 'id'>) => {
      const id = nextId++;
      store.set(id, { id, ...entry } as MemeGraphEntry);
      return id;
    }),
    update: vi.fn(),
    findByCanonical: vi.fn(() => null),
    findByVariant: vi.fn(() => []),
    listActive: vi.fn(() => []),
    listActiveWithEmbeddings: vi.fn(() => []),
    listNullEmbedding: vi.fn(() => []),
    findById: vi.fn((id: number) => store.get(id) ?? null),
    adminEdit: vi.fn(),
  };
}

function mockPhraseRepo(unpromoted: PhraseCandidateRow[] = []): IPhraseCandidatesRepo {
  return {
    upsert: vi.fn(),
    findAtThreshold: vi.fn(() => []),
    updateInference: vi.fn(),
    listUnpromoted: vi.fn(() => unpromoted),
    markPromoted: vi.fn(),
  };
}

function seedJargon(db: Database, canonical: string, contextsJson: string): void {
  db.rawDb.prepare(`
    INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at)
    VALUES ('g1', ?, 10, ?, 10, '谁会这么说话', 1, 0, 100, 100)
  `).run(canonical, contextsJson);
}

describe('MemeClusterer — bot-output skip', () => {
  it('MUST-FIRE: jargon row with all user contexts is promoted', async () => {
    const db = new Database(':memory:');
    const userCtx = JSON.stringify([
      { user_id: USER_ID, content: '智械危机真好' },
      { user_id: 'user-99', content: '智械危机是什么' },
    ]);
    seedJargon(db, '智械危机', userCtx);

    const memeGraph = mockMemeGraphRepo();
    const clusterer = new MemeClusterer({
      db: db.rawDb,
      memeGraph,
      phraseCandidates: mockPhraseRepo(),
      claude: mockClaude(['{"origin_event":"group talk"}']),
      botUserId: BOT_ID,
      now: () => 1_700_000_000_000,
    });
    await clusterer.clusterAll('g1');
    expect(memeGraph.insert).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('MUST-NOT-FIRE: jargon row with ALL bot contexts is skipped (100%)', async () => {
    const db = new Database(':memory:');
    const botCtx = JSON.stringify([
      { user_id: BOT_ID, content: '再@我你试试' },
      { user_id: BOT_ID, content: '再@我你试试 啊' },
      { user_id: BOT_ID, content: '再@我你试试 真的' },
    ]);
    seedJargon(db, '再@我你试试', botCtx);

    const memeGraph = mockMemeGraphRepo();
    const clusterer = new MemeClusterer({
      db: db.rawDb,
      memeGraph,
      phraseCandidates: mockPhraseRepo(),
      claude: mockClaude(['{}']),
      botUserId: BOT_ID,
      now: () => 1_700_000_000_000,
    });
    await clusterer.clusterAll('g1');
    expect(memeGraph.insert).not.toHaveBeenCalled();
    db.close();
  });

  it('MUST-NOT-FIRE: 50/50 split — >=50% threshold filters (3 bot / 3 user)', async () => {
    const db = new Database(':memory:');
    const mixedCtx = JSON.stringify([
      { user_id: BOT_ID, content: 'A' },
      { user_id: BOT_ID, content: 'B' },
      { user_id: BOT_ID, content: 'C' },
      { user_id: USER_ID, content: 'D' },
      { user_id: USER_ID, content: 'E' },
      { user_id: 'user-99', content: 'F' },
    ]);
    seedJargon(db, '烦死了', mixedCtx);

    const memeGraph = mockMemeGraphRepo();
    const clusterer = new MemeClusterer({
      db: db.rawDb,
      memeGraph,
      phraseCandidates: mockPhraseRepo(),
      claude: mockClaude(['{}']),
      botUserId: BOT_ID,
      now: () => 1_700_000_000_000,
    });
    await clusterer.clusterAll('g1');
    expect(memeGraph.insert).not.toHaveBeenCalled();
    db.close();
  });

  it('MUST-FIRE: 2 bot / 4 user (33%) — under threshold, promoted', async () => {
    const db = new Database(':memory:');
    const mixedCtx = JSON.stringify([
      { user_id: BOT_ID, content: 'A' },
      { user_id: BOT_ID, content: 'B' },
      { user_id: USER_ID, content: 'C' },
      { user_id: USER_ID, content: 'D' },
      { user_id: 'user-99', content: 'E' },
      { user_id: 'user-88', content: 'F' },
    ]);
    seedJargon(db, '智械危机', mixedCtx);

    const memeGraph = mockMemeGraphRepo();
    const clusterer = new MemeClusterer({
      db: db.rawDb,
      memeGraph,
      phraseCandidates: mockPhraseRepo(),
      claude: mockClaude(['{"origin_event":"group talk"}']),
      botUserId: BOT_ID,
      now: () => 1_700_000_000_000,
    });
    await clusterer.clusterAll('g1');
    expect(memeGraph.insert).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('MUST-FIRE: botUserId undefined — filter no-op, all rows promoted', async () => {
    const db = new Database(':memory:');
    const botCtx = JSON.stringify([
      { user_id: BOT_ID, content: '再@我你试试' },
    ]);
    seedJargon(db, '再@我你试试', botCtx);

    const memeGraph = mockMemeGraphRepo();
    const clusterer = new MemeClusterer({
      db: db.rawDb,
      memeGraph,
      phraseCandidates: mockPhraseRepo(),
      claude: mockClaude(['{}']),
      now: () => 1_700_000_000_000,
    });
    await clusterer.clusterAll('g1');
    expect(memeGraph.insert).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('legacy string-only contexts (no user_id field) — pass through (no false-positive skip)', async () => {
    const db = new Database(':memory:');
    // Legacy: contexts was string[]; lacks user_id entirely. Filter must NOT skip.
    const legacyCtx = JSON.stringify(['ctx1', 'ctx2', 'ctx3']);
    seedJargon(db, 'legacy-term', legacyCtx);

    const memeGraph = mockMemeGraphRepo();
    const clusterer = new MemeClusterer({
      db: db.rawDb,
      memeGraph,
      phraseCandidates: mockPhraseRepo(),
      claude: mockClaude(['{}']),
      botUserId: BOT_ID,
      now: () => 1_700_000_000_000,
    });
    await clusterer.clusterAll('g1');
    expect(memeGraph.insert).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('empty contexts array — no division-by-zero, passes through', async () => {
    const db = new Database(':memory:');
    seedJargon(db, '空ctx', '[]');

    const memeGraph = mockMemeGraphRepo();
    const clusterer = new MemeClusterer({
      db: db.rawDb,
      memeGraph,
      phraseCandidates: mockPhraseRepo(),
      claude: mockClaude(['{}']),
      botUserId: BOT_ID,
      now: () => 1_700_000_000_000,
    });
    await clusterer.clusterAll('g1');
    expect(memeGraph.insert).toHaveBeenCalledTimes(1);
    db.close();
  });
});
