import { describe, it, expect, vi } from 'vitest';
import { MemeClusterer } from '../../src/modules/meme-clusterer.js';
import type { IClaudeClient, ClaudeRequest, ClaudeResponse } from '../../src/ai/claude.js';
import type { IMemeGraphRepo, IPhraseCandidatesRepo, MemeGraphEntry, PhraseCandidateRow } from '../../src/storage/db.js';
import { Database } from '../../src/storage/db.js';
import { initLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

// ---- Helpers ----

function makeEntry(overrides: Partial<MemeGraphEntry> = {}): MemeGraphEntry {
  return {
    id: 1,
    groupId: 'g1',
    canonical: 'hyw',
    variants: [],
    meaning: '何意味',
    originEvent: null,
    originMsgId: null,
    originUserId: null,
    originTs: null,
    firstSeenCount: 3,
    totalCount: 10,
    confidence: 0.3,
    status: 'active',
    embeddingVec: null,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function mockClaude(responses: string[]): IClaudeClient {
  let callIdx = 0;
  return {
    complete: vi.fn(async (_req: ClaudeRequest): Promise<ClaudeResponse> => {
      const text = responses[callIdx] ?? '{}';
      callIdx++;
      return { text, model: 'test', inputTokens: 10, outputTokens: 10 };
    }),
    describeImage: vi.fn() as never,
    visionWithPrompt: vi.fn() as never,
  };
}

function mockMemeGraphRepo(entries: MemeGraphEntry[] = []): IMemeGraphRepo {
  const store = new Map<number, MemeGraphEntry>();
  let nextId = 100;
  for (const e of entries) store.set(e.id, { ...e });

  return {
    insert: vi.fn((entry: Omit<MemeGraphEntry, 'id'>) => {
      const id = nextId++;
      store.set(id, { id, ...entry } as MemeGraphEntry);
      return id;
    }),
    update: vi.fn((id: number, fields: Partial<MemeGraphEntry>) => {
      const e = store.get(id);
      if (!e) return;
      if (e.status === 'manual_edit') {
        delete fields.meaning;
      }
      Object.assign(e, fields);
    }),
    findByCanonical: vi.fn((_gId: string, _canonical: string) => null),
    findByVariant: vi.fn(() => []),
    listActive: vi.fn((_g: string, _l: number) =>
      [...store.values()].filter(e => e.status === 'active' || e.status === 'manual_edit'),
    ),
    listActiveWithEmbeddings: vi.fn(() => []),
    listNullEmbedding: vi.fn(() => []),
    findById: vi.fn((id: number) => store.get(id) ?? null),
    adminEdit: vi.fn(),
  };
}

function mockPhraseCandidatesRepo(unpromoted: PhraseCandidateRow[] = []): IPhraseCandidatesRepo {
  return {
    upsert: vi.fn(),
    findAtThreshold: vi.fn(() => []),
    updateInference: vi.fn(),
    listUnpromoted: vi.fn(() => unpromoted),
    markPromoted: vi.fn(),
  };
}

// ---- Tests ----

describe('MemeClusterer', () => {
  describe('clusterAll — new entry creation', () => {
    it('creates a new meme_graph entry from a jargon candidate', async () => {
      const db = new Database(':memory:');
      db.rawDb.prepare(`
        INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at)
        VALUES ('g1', 'hyw', 10, '["ctx1"]', 10, '何意味', 1, 0, 100, 100)
      `).run();

      const memeGraph = mockMemeGraphRepo();
      const clusterer = new MemeClusterer({
        db: db.rawDb,
        memeGraph,
        phraseCandidates: mockPhraseCandidatesRepo(),
        claude: mockClaude(['{"origin_event": "someone asked hyw"}']),
        now: () => 1_700_000_000_000,
      });

      await clusterer.clusterAll('g1');

      expect(memeGraph.insert).toHaveBeenCalledTimes(1);
      const insertArg = (memeGraph.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(insertArg.canonical).toBe('hyw');
      expect(insertArg.meaning).toBe('何意味');
      expect(insertArg.confidence).toBe(0.3);

      const row = db.rawDb.prepare('SELECT promoted FROM jargon_candidates WHERE content = ?').get('hyw') as { promoted: number };
      expect(row.promoted).toBe(1);

      db.close();
    });

    it('creates entry from phrase candidate', async () => {
      const db = new Database(':memory:');
      const phraseRepo = mockPhraseCandidatesRepo([
        {
          groupId: 'g1', content: 'mmhyw 梗', gramLen: 2, count: 5,
          contexts: ['ctx1'], lastInferenceCount: 5,
          meaning: '妈咪何意味', isJargon: 1, promoted: 0, createdAt: 100, updatedAt: 100,
        },
      ]);

      const memeGraph = mockMemeGraphRepo();
      const clusterer = new MemeClusterer({
        db: db.rawDb,
        memeGraph,
        phraseCandidates: phraseRepo,
        claude: mockClaude(['{"origin_event": "phrase origin"}']),
        now: () => 1_700_000_000_000,
      });

      await clusterer.clusterAll('g1');

      expect(memeGraph.insert).toHaveBeenCalledTimes(1);
      expect(phraseRepo.markPromoted).toHaveBeenCalledWith('g1', 'mmhyw 梗', 2, expect.any(Number));

      db.close();
    });
  });

  describe('clusterAll — variant aggregation', () => {
    it('adds a candidate as variant to existing entry via substring match', async () => {
      const db = new Database(':memory:');
      const existing = makeEntry({ id: 1, canonical: 'hyw', variants: [], confidence: 0.3, totalCount: 10 });
      const memeGraph = mockMemeGraphRepo([existing]);

      db.rawDb.prepare(`
        INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at)
        VALUES ('g1', 'mmhyw', 5, '["ctx"]', 5, '妈咪何意味', 1, 0, 100, 100)
      `).run();

      const clusterer = new MemeClusterer({
        db: db.rawDb,
        memeGraph,
        phraseCandidates: mockPhraseCandidatesRepo(),
        claude: mockClaude([]),
        now: () => 1_700_000_000_000,
      });

      await clusterer.clusterAll('g1');

      expect(memeGraph.insert).not.toHaveBeenCalled();
      expect(memeGraph.update).toHaveBeenCalledWith(1, expect.objectContaining({
        variants: ['mmhyw'],
        totalCount: 15,
      }));

      db.close();
    });

    it('does not duplicate an already-existing variant', async () => {
      const db = new Database(':memory:');
      const existing = makeEntry({ id: 1, canonical: 'hyw', variants: ['mmhyw'], totalCount: 10 });
      const memeGraph = mockMemeGraphRepo([existing]);

      db.rawDb.prepare(`
        INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at)
        VALUES ('g1', 'mmhyw', 3, '["ctx"]', 3, 'test', 1, 0, 100, 100)
      `).run();

      const clusterer = new MemeClusterer({
        db: db.rawDb,
        memeGraph,
        phraseCandidates: mockPhraseCandidatesRepo(),
        claude: mockClaude([]),
        now: () => 1_700_000_000_000,
      });

      await clusterer.clusterAll('g1');

      const updateCall = (memeGraph.update as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(updateCall[1].totalCount).toBe(13);
      expect(updateCall[1].variants).toBeUndefined();

      db.close();
    });
  });

  describe('manual_edit protection', () => {
    it('does not overwrite meaning on manual_edit entries when adding variant', async () => {
      const db = new Database(':memory:');
      const existing = makeEntry({
        id: 1, canonical: 'hyw', variants: [],
        meaning: 'admin curated meaning',
        status: 'manual_edit', totalCount: 10, confidence: 0.5,
      });
      const memeGraph = mockMemeGraphRepo([existing]);

      db.rawDb.prepare(`
        INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at)
        VALUES ('g1', 'mmhyw', 5, '["ctx"]', 5, 'LLM meaning', 1, 0, 100, 100)
      `).run();

      const clusterer = new MemeClusterer({
        db: db.rawDb,
        memeGraph,
        phraseCandidates: mockPhraseCandidatesRepo(),
        claude: mockClaude([]),
        now: () => 1_700_000_000_000,
      });

      await clusterer.clusterAll('g1');

      expect(memeGraph.update).toHaveBeenCalled();
      const updateArgs = (memeGraph.update as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(updateArgs.variants).toEqual(['mmhyw']);
      expect(updateArgs.totalCount).toBe(15);
      expect(updateArgs.meaning).toBeUndefined();

      db.close();
    });
  });

  describe('confidence monotonicity', () => {
    it('increases confidence when adding variants', async () => {
      const db = new Database(':memory:');
      const existing = makeEntry({ id: 1, canonical: 'hyw', variants: [], confidence: 0.3, totalCount: 5 });
      const memeGraph = mockMemeGraphRepo([existing]);

      db.rawDb.prepare(`
        INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at)
        VALUES ('g1', 'mmhyw', 3, '["ctx"]', 3, 'test', 1, 0, 100, 100)
      `).run();

      const clusterer = new MemeClusterer({
        db: db.rawDb,
        memeGraph,
        phraseCandidates: mockPhraseCandidatesRepo(),
        claude: mockClaude([]),
        now: () => 1_700_000_000_000,
      });

      await clusterer.clusterAll('g1');

      const updateArgs = (memeGraph.update as ReturnType<typeof vi.fn>).mock.calls[0][1];
      // 1 variant: confidence = max(0.3, min(0.6, 0.3 + 0.05*1)) = 0.35
      expect(updateArgs.confidence).toBe(0.35);

      db.close();
    });

    it('caps confidence at MAX_AUTO_CONFIDENCE=0.6', async () => {
      const db = new Database(':memory:');
      // Existing entry with 5 variants already (high variant count)
      const existing = makeEntry({
        id: 1, canonical: 'hyw',
        variants: ['ahyw', 'bhyw', 'chyw', 'dhyw', 'ehyw'],
        confidence: 0.55, totalCount: 50,
      });
      const memeGraph = mockMemeGraphRepo([existing]);

      // New candidate "fhyw" contains "hyw" -> matches as variant
      db.rawDb.prepare(`
        INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at)
        VALUES ('g1', 'fhyw', 2, '["ctx"]', 2, 'test', 1, 0, 100, 100)
      `).run();

      const clusterer = new MemeClusterer({
        db: db.rawDb,
        memeGraph,
        phraseCandidates: mockPhraseCandidatesRepo(),
        claude: mockClaude([]),
        now: () => 1_700_000_000_000,
      });

      await clusterer.clusterAll('g1');

      const updateArgs = (memeGraph.update as ReturnType<typeof vi.fn>).mock.calls[0][1];
      // 6 variants now: min(0.6, 0.3 + 0.05*6) = 0.6
      expect(updateArgs.confidence).toBe(0.6);

      db.close();
    });
  });

  describe('origin inference', () => {
    it('infers origin when budget allows', async () => {
      const db = new Database(':memory:');
      db.rawDb.prepare(`
        INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at)
        VALUES ('g1', 'newmeme', 5, '["someone said it"]', 5, 'a meme', 1, 0, 100, 100)
      `).run();

      const memeGraph = mockMemeGraphRepo();
      const claude = mockClaude(['{"origin_event": "originating event"}']);

      const clusterer = new MemeClusterer({
        db: db.rawDb,
        memeGraph,
        phraseCandidates: mockPhraseCandidatesRepo(),
        claude,
        now: () => 1_700_000_000_000,
      });

      await clusterer.clusterAll('g1');

      expect(claude.complete).toHaveBeenCalledTimes(1);
      expect(memeGraph.update).toHaveBeenCalledWith(expect.any(Number), {
        originEvent: 'originating event',
      });

      db.close();
    });

    it('respects MAX_ORIGIN_INFER_PER_CYCLE budget', async () => {
      const db = new Database(':memory:');
      for (let i = 0; i < 5; i++) {
        db.rawDb.prepare(`
          INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at)
          VALUES ('g1', ?, ?, '["ctx"]', ?, ?, 1, 0, 100, 100)
        `).run(`meme${i}`, 5 + i, 5 + i, `meaning${i}`);
      }

      const memeGraph = mockMemeGraphRepo();
      const claude = mockClaude(Array(10).fill('{"origin_event": "test"}'));

      const clusterer = new MemeClusterer({
        db: db.rawDb,
        memeGraph,
        phraseCandidates: mockPhraseCandidatesRepo(),
        claude,
        now: () => 1_700_000_000_000,
        maxOriginInferPerCycle: 3,
      });

      await clusterer.clusterAll('g1');

      expect(memeGraph.insert).toHaveBeenCalledTimes(5);
      expect(claude.complete).toHaveBeenCalledTimes(3);

      db.close();
    });

    it('handles origin inference failure gracefully (entry still created)', async () => {
      const db = new Database(':memory:');
      db.rawDb.prepare(`
        INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at)
        VALUES ('g1', 'failmeme', 5, '["ctx"]', 5, 'test meaning', 1, 0, 100, 100)
      `).run();

      const memeGraph = mockMemeGraphRepo();
      const claude: IClaudeClient = {
        complete: vi.fn(async () => { throw new Error('API error'); }),
        describeImage: vi.fn() as never,
        visionWithPrompt: vi.fn() as never,
      };

      const clusterer = new MemeClusterer({
        db: db.rawDb,
        memeGraph,
        phraseCandidates: mockPhraseCandidatesRepo(),
        claude,
        now: () => 1_700_000_000_000,
      });

      await clusterer.clusterAll('g1');

      expect(memeGraph.insert).toHaveBeenCalledTimes(1);
      expect(memeGraph.update).not.toHaveBeenCalled();

      db.close();
    });
  });

  describe('idempotency', () => {
    it('skips candidates with no meaning', async () => {
      const db = new Database(':memory:');
      db.rawDb.prepare(`
        INSERT INTO jargon_candidates (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at)
        VALUES ('g1', 'nomean', 5, '["ctx"]', 5, NULL, 1, 0, 100, 100)
      `).run();

      const memeGraph = mockMemeGraphRepo();
      const clusterer = new MemeClusterer({
        db: db.rawDb,
        memeGraph,
        phraseCandidates: mockPhraseCandidatesRepo(),
        claude: mockClaude([]),
        now: () => 1_700_000_000_000,
      });

      await clusterer.clusterAll('g1');

      expect(memeGraph.insert).not.toHaveBeenCalled();

      db.close();
    });

    it('does nothing when no unpromoted candidates exist', async () => {
      const db = new Database(':memory:');
      const memeGraph = mockMemeGraphRepo();
      const clusterer = new MemeClusterer({
        db: db.rawDb,
        memeGraph,
        phraseCandidates: mockPhraseCandidatesRepo(),
        claude: mockClaude([]),
        now: () => 1_700_000_000_000,
      });

      await clusterer.clusterAll('g1');

      expect(memeGraph.insert).not.toHaveBeenCalled();
      expect(memeGraph.update).not.toHaveBeenCalled();

      db.close();
    });
  });
});
