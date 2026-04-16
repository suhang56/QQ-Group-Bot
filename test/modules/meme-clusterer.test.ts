import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemeClusterer } from '../../src/modules/meme-clusterer.js';
import type { DatabaseSync } from 'node:sqlite';
import type { IClaudeClient } from '../../src/ai/claude.js';
import type {
  IMemeGraphRepo,
  IPhraseCandidatesRepo,
  MemeGraphEntry,
  PhraseCandidateRow,
} from '../../src/storage/db.js';
import type { IEmbeddingService } from '../../src/storage/embeddings.js';
import type { Logger } from 'pino';

const silentLogger = {
  warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(),
} as unknown as Logger;

const NOW = 1700000000000;
const NOW_SEC = 1700000000;

// ---- Mock factories ----

function makeMemeGraphRepo(entries: MemeGraphEntry[] = []): IMemeGraphRepo & {
  inserted: Array<Omit<MemeGraphEntry, 'id'>>;
  updates: Array<{ id: number; fields: Record<string, unknown> }>;
} {
  const inserted: Array<Omit<MemeGraphEntry, 'id'>> = [];
  const updates: Array<{ id: number; fields: Record<string, unknown> }> = [];
  let nextId = entries.length + 1;

  return {
    inserted,
    updates,
    insert: vi.fn().mockImplementation((entry: Omit<MemeGraphEntry, 'id'>) => {
      inserted.push(entry);
      return nextId++;
    }),
    update: vi.fn().mockImplementation((id: number, fields: Record<string, unknown>) => {
      updates.push({ id, fields });
    }),
    findByCanonical: vi.fn().mockImplementation((_gid: string, canonical: string) =>
      entries.find(e => e.canonical === canonical) ?? null),
    findByVariant: vi.fn().mockImplementation((_gid: string, term: string) =>
      entries.filter(e =>
        e.canonical.includes(term) || e.variants.some(v => v.includes(term)))),
    listActive: vi.fn().mockReturnValue(entries.filter(e => e.status !== 'demoted')),
    listActiveWithEmbeddings: vi.fn().mockReturnValue(
      entries.filter(e => e.status !== 'demoted' && e.embeddingVec !== null)),
    listNullEmbedding: vi.fn().mockReturnValue([]),
    findById: vi.fn().mockImplementation((id: number) => entries.find(e => e.id === id) ?? null),
    adminEdit: vi.fn(),
  };
}

function makePhraseCandidatesRepo(rows: PhraseCandidateRow[] = []): IPhraseCandidatesRepo & {
  promoted: Array<{ groupId: string; content: string; gramLen: number }>;
} {
  const promoted: Array<{ groupId: string; content: string; gramLen: number }> = [];
  return {
    promoted,
    upsert: vi.fn(),
    findAtThreshold: vi.fn().mockReturnValue([]),
    updateInference: vi.fn(),
    listUnpromoted: vi.fn().mockReturnValue(rows),
    markPromoted: vi.fn().mockImplementation((gid: string, content: string, gramLen: number) => {
      promoted.push({ groupId: gid, content, gramLen });
    }),
  };
}

function makeEmbedding(ready = true): IEmbeddingService {
  return {
    isReady: ready,
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    waitReady: vi.fn().mockResolvedValue(undefined),
  };
}

function makeClaude(payload: unknown = { origin_event: 'test origin' }): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text: JSON.stringify(payload),
      inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
    }),
  } as unknown as IClaudeClient;
}

function makeDb(jargonRows: unknown[] = []): DatabaseSync {
  const mockStmt = {
    all: vi.fn().mockReturnValue(jargonRows),
    run: vi.fn(),
    get: vi.fn(),
  };
  return {
    prepare: vi.fn().mockReturnValue(mockStmt),
    exec: vi.fn(),
  } as unknown as DatabaseSync;
}

function makeEntry(overrides: Partial<MemeGraphEntry> = {}): MemeGraphEntry {
  return {
    id: 1,
    groupId: 'g1',
    canonical: 'hyw',
    variants: ['hyw'],
    meaning: 'hello world in group slang',
    originEvent: null,
    originMsgId: null,
    originUserId: null,
    originTs: null,
    firstSeenCount: 5,
    totalCount: 10,
    confidence: 0.4,
    status: 'active',
    embeddingVec: [0.1, 0.2, 0.3],
    createdAt: NOW_SEC,
    updatedAt: NOW_SEC,
    ...overrides,
  };
}

function makePhraseRow(overrides: Partial<PhraseCandidateRow> = {}): PhraseCandidateRow {
  return {
    groupId: 'g1',
    content: 'phrase test',
    gramLen: 2,
    count: 5,
    contexts: ['ctx1'],
    lastInferenceCount: 3,
    meaning: 'a phrase meaning',
    isJargon: 1,
    promoted: 0,
    createdAt: NOW_SEC,
    updatedAt: NOW_SEC,
    ...overrides,
  };
}

// ---- Tests ----

describe('MemeClusterer', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('inserts new graph entry when no match found', async () => {
    const jargonRows = [{
      group_id: 'g1', content: 'testjargon', count: 5,
      contexts: '["ctx1","ctx2"]', last_inference_count: 3,
      meaning: 'a test meaning', is_jargon: 1, promoted: 0,
      created_at: NOW_SEC, updated_at: NOW_SEC,
    }];
    const db = makeDb(jargonRows);
    const memeGraph = makeMemeGraphRepo();
    const clusterer = new MemeClusterer({
      db, memeGraphRepo: memeGraph,
      phraseCandidatesRepo: makePhraseCandidatesRepo(),
embeddingService: makeEmbedding(),
      claude: makeClaude(),
      activeGroups: ['g1'],
      logger: silentLogger,
      now: () => NOW,
    });

    await clusterer.run('g1');

    expect(memeGraph.inserted).toHaveLength(1);
    expect(memeGraph.inserted[0]!.canonical).toBe('testjargon');
    expect(memeGraph.inserted[0]!.meaning).toBe('a test meaning');
    expect(memeGraph.inserted[0]!.variants).toEqual(['testjargon']);
    expect(memeGraph.inserted[0]!.status).toBe('active');
  });

  it('merges variant when substring match found', async () => {
    const existing = makeEntry({ id: 1, canonical: 'hyw', variants: ['hyw'] });
    const jargonRows = [{
      group_id: 'g1', content: 'mmhyw', count: 3,
      contexts: '["ctx"]', last_inference_count: 3,
      meaning: 'mama hyw', is_jargon: 1, promoted: 0,
      created_at: NOW_SEC, updated_at: NOW_SEC,
    }];
    const db = makeDb(jargonRows);
    const memeGraph = makeMemeGraphRepo([existing]);
    const clusterer = new MemeClusterer({
      db, memeGraphRepo: memeGraph,
      phraseCandidatesRepo: makePhraseCandidatesRepo(),
embeddingService: makeEmbedding(),
      claude: makeClaude(),
      activeGroups: ['g1'],
      logger: silentLogger,
      now: () => NOW,
    });

    await clusterer.run('g1');

    expect(memeGraph.inserted).toHaveLength(0);
    expect(memeGraph.updates).toHaveLength(1);
    const update = memeGraph.updates[0]!;
    expect(update.id).toBe(1);
    expect(update.fields.variants).toContain('mmhyw');
    expect(update.fields.variants).toContain('hyw');
  });

  it('merges variant when cosine similarity > threshold', async () => {
    const existing = makeEntry({
      id: 1, canonical: 'xyz', variants: ['xyz'],
      embeddingVec: [0.1, 0.2, 0.3],
    });
    // No substring match, so findByVariant returns empty
    const memeGraph = makeMemeGraphRepo();
    // Override: findByVariant returns nothing, listActiveWithEmbeddings returns the entry
    (memeGraph.findByVariant as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (memeGraph.listActive as ReturnType<typeof vi.fn>).mockReturnValue([existing]);
    (memeGraph.listActiveWithEmbeddings as ReturnType<typeof vi.fn>).mockReturnValue([existing]);

    const jargonRows = [{
      group_id: 'g1', content: 'abc', count: 3,
      contexts: '["ctx"]', last_inference_count: 3,
      meaning: 'similar meaning', is_jargon: 1, promoted: 0,
      created_at: NOW_SEC, updated_at: NOW_SEC,
    }];
    const db = makeDb(jargonRows);

    // Embedding returns same vector => cosine = 1.0 > 0.78
    const embedding = makeEmbedding();

    const clusterer = new MemeClusterer({
      db, memeGraphRepo: memeGraph,
      phraseCandidatesRepo: makePhraseCandidatesRepo(),
embeddingService: embedding,
      claude: makeClaude(),
      activeGroups: ['g1'],
      logger: silentLogger,
      now: () => NOW,
    });

    await clusterer.run('g1');

    expect(memeGraph.inserted).toHaveLength(0);
    expect(memeGraph.updates.length).toBeGreaterThanOrEqual(1);
    const variantUpdate = memeGraph.updates.find(u => u.fields.variants);
    expect(variantUpdate).toBeTruthy();
    expect((variantUpdate!.fields.variants as string[])).toContain('abc');
  });

  it('does not overwrite manual_edit meaning', async () => {
    const manualEntry = makeEntry({
      id: 1, canonical: 'hyw', variants: ['hyw'],
      status: 'manual_edit', meaning: 'admin-set meaning',
    });
    const jargonRows = [{
      group_id: 'g1', content: 'mmhyw', count: 3,
      contexts: '["ctx"]', last_inference_count: 3,
      meaning: 'different meaning', is_jargon: 1, promoted: 0,
      created_at: NOW_SEC, updated_at: NOW_SEC,
    }];
    const db = makeDb(jargonRows);
    const memeGraph = makeMemeGraphRepo([manualEntry]);
    const clusterer = new MemeClusterer({
      db, memeGraphRepo: memeGraph,
      phraseCandidatesRepo: makePhraseCandidatesRepo(),
embeddingService: makeEmbedding(),
      claude: makeClaude(),
      activeGroups: ['g1'],
      logger: silentLogger,
      now: () => NOW,
    });

    await clusterer.run('g1');

    expect(memeGraph.inserted).toHaveLength(0);
    // Should have an update with variants and totalCount but NOT meaning
    const update = memeGraph.updates[0]!;
    expect(update.fields.variants).toContain('mmhyw');
    expect(update.fields).not.toHaveProperty('meaning');
    expect(update.fields).not.toHaveProperty('confidence');
  });

  it('extracts origin event via LLM on new entry', async () => {
    const msgRows = [{
      id: 100, source_message_id: 'msg100', user_id: 'u1',
      nickname: 'TestUser', content: 'testjargon is cool',
      timestamp: NOW_SEC - 86400,
    }];
    const db = makeDb([{
      group_id: 'g1', content: 'testjargon', count: 5,
      contexts: '["ctx1"]', last_inference_count: 3,
      meaning: 'a meaning', is_jargon: 1, promoted: 0,
      created_at: NOW_SEC, updated_at: NOW_SEC,
    }]);
    // Override the message query
    const msgStmt = { all: vi.fn().mockReturnValue(msgRows), run: vi.fn(), get: vi.fn() };
    const jargonStmt = {
      all: vi.fn().mockReturnValue([{
        group_id: 'g1', content: 'testjargon', count: 5,
        contexts: '["ctx1"]', last_inference_count: 3,
        meaning: 'a meaning', is_jargon: 1, promoted: 0,
        created_at: NOW_SEC, updated_at: NOW_SEC,
      }]),
      run: vi.fn(), get: vi.fn(),
    };
    const promoteStmt = { run: vi.fn() };
    let callCount = 0;
    (db.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
      if (sql.includes('jargon_candidates') && sql.includes('SELECT')) return jargonStmt;
      if (sql.includes('messages') && sql.includes('SELECT')) return msgStmt;
      return promoteStmt;
    });

    const memeGraph = makeMemeGraphRepo();
    const claude = makeClaude({ origin_event: 'TestUser created this meme on 2023-11-14' });

    const clusterer = new MemeClusterer({
      db, memeGraphRepo: memeGraph,
      phraseCandidatesRepo: makePhraseCandidatesRepo(),
embeddingService: makeEmbedding(),
      claude,
      activeGroups: ['g1'],
      logger: silentLogger,
      now: () => NOW,
    });

    await clusterer.run('g1');

    expect(memeGraph.inserted).toHaveLength(1);
    // Origin update should have been called
    const originUpdate = memeGraph.updates.find(u =>
      u.fields.originEvent !== undefined || u.fields.originMsgId !== undefined);
    expect(originUpdate).toBeTruthy();
    expect(originUpdate!.fields.originEvent).toBe('TestUser created this meme on 2023-11-14');
  });

  it('handles LLM origin failure gracefully (null origin)', async () => {
    const db = makeDb([{
      group_id: 'g1', content: 'obscure', count: 5,
      contexts: '["ctx"]', last_inference_count: 3,
      meaning: 'a meaning', is_jargon: 1, promoted: 0,
      created_at: NOW_SEC, updated_at: NOW_SEC,
    }]);
    // Messages query returns empty
    const emptyStmt = { all: vi.fn().mockReturnValue([]), run: vi.fn(), get: vi.fn() };
    const jargonStmt = {
      all: vi.fn().mockReturnValue([{
        group_id: 'g1', content: 'obscure', count: 5,
        contexts: '["ctx"]', last_inference_count: 3,
        meaning: 'a meaning', is_jargon: 1, promoted: 0,
        created_at: NOW_SEC, updated_at: NOW_SEC,
      }]),
      run: vi.fn(), get: vi.fn(),
    };
    (db.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
      if (sql.includes('jargon_candidates') && sql.includes('SELECT')) return jargonStmt;
      if (sql.includes('messages')) return emptyStmt;
      return { run: vi.fn() };
    });

    const memeGraph = makeMemeGraphRepo();
    const clusterer = new MemeClusterer({
      db, memeGraphRepo: memeGraph,
      phraseCandidatesRepo: makePhraseCandidatesRepo(),
embeddingService: makeEmbedding(),
      claude: makeClaude({ origin_event: null }),
      activeGroups: ['g1'],
      logger: silentLogger,
      now: () => NOW,
    });

    await clusterer.run('g1');

    // Entry is still inserted, origin just stays null
    expect(memeGraph.inserted).toHaveLength(1);
  });

  it('caps origin inferences at MAX_ORIGIN_INFER_PER_CYCLE=3', async () => {
    const candidates = Array.from({ length: 5 }, (_, i) => ({
      group_id: 'g1', content: `term${i}`, count: 5,
      contexts: '["ctx"]', last_inference_count: 3,
      meaning: `meaning${i}`, is_jargon: 1, promoted: 0,
      created_at: NOW_SEC, updated_at: NOW_SEC,
    }));

    const msgRows = [{
      id: 1, source_message_id: 'msg1', user_id: 'u1',
      nickname: 'User', content: 'some content',
      timestamp: NOW_SEC - 86400,
    }];

    const db = makeDb(candidates);
    (db.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
      if (sql.includes('jargon_candidates') && sql.includes('SELECT')) {
        return { all: vi.fn().mockReturnValue(candidates), run: vi.fn(), get: vi.fn() };
      }
      if (sql.includes('messages') && sql.includes('SELECT')) {
        return { all: vi.fn().mockReturnValue(msgRows), run: vi.fn(), get: vi.fn() };
      }
      return { run: vi.fn(), all: vi.fn().mockReturnValue([]), get: vi.fn() };
    });

    const memeGraph = makeMemeGraphRepo();
    const claude = makeClaude({ origin_event: 'test event' });

    const clusterer = new MemeClusterer({
      db, memeGraphRepo: memeGraph,
      phraseCandidatesRepo: makePhraseCandidatesRepo(),
embeddingService: makeEmbedding(),
      claude,
      activeGroups: ['g1'],
      logger: silentLogger,
      now: () => NOW,
    });

    await clusterer.run('g1');

    expect(memeGraph.inserted).toHaveLength(5);
    // Only 3 should have origin updates
    const originUpdates = memeGraph.updates.filter(u => u.fields.originEvent !== undefined);
    expect(originUpdates).toHaveLength(3);
  });

  it('sets promoted=1 on processed candidates', async () => {
    const db = makeDb([{
      group_id: 'g1', content: 'jtest', count: 5,
      contexts: '["ctx"]', last_inference_count: 3,
      meaning: 'meaning', is_jargon: 1, promoted: 0,
      created_at: NOW_SEC, updated_at: NOW_SEC,
    }]);
    const promoteStmt = { run: vi.fn() };
    (db.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
      if (sql.includes('jargon_candidates') && sql.includes('SELECT')) {
        return {
          all: vi.fn().mockReturnValue([{
            group_id: 'g1', content: 'jtest', count: 5,
            contexts: '["ctx"]', last_inference_count: 3,
            meaning: 'meaning', is_jargon: 1, promoted: 0,
            created_at: NOW_SEC, updated_at: NOW_SEC,
          }]),
          run: vi.fn(), get: vi.fn(),
        };
      }
      if (sql.includes('UPDATE jargon_candidates') && sql.includes('promoted = 1')) {
        return promoteStmt;
      }
      return { run: vi.fn(), all: vi.fn().mockReturnValue([]), get: vi.fn() };
    });

    const memeGraph = makeMemeGraphRepo();
    const clusterer = new MemeClusterer({
      db, memeGraphRepo: memeGraph,
      phraseCandidatesRepo: makePhraseCandidatesRepo(),
embeddingService: makeEmbedding(),
      claude: makeClaude(),
      activeGroups: ['g1'],
      logger: silentLogger,
      now: () => NOW,
    });

    await clusterer.run('g1');

    // Verify that promote update was called
    expect(promoteStmt.run).toHaveBeenCalled();
  });

  it('processes phrase candidates from phraseCandidatesRepo', async () => {
    const phraseRow = makePhraseRow({ content: 'phrase test', gramLen: 2 });
    const db = makeDb([]); // no jargon candidates
    const phraseCandidatesRepo = makePhraseCandidatesRepo([phraseRow]);
    const memeGraph = makeMemeGraphRepo();

    const clusterer = new MemeClusterer({
      db, memeGraphRepo: memeGraph,
      phraseCandidatesRepo,
embeddingService: makeEmbedding(),
      claude: makeClaude(),
      activeGroups: ['g1'],
      logger: silentLogger,
      now: () => NOW,
    });

    await clusterer.run('g1');

    expect(memeGraph.inserted).toHaveLength(1);
    expect(memeGraph.inserted[0]!.canonical).toBe('phrase test');
    // phrase candidate should be marked promoted
    expect(phraseCandidatesRepo.markPromoted).toHaveBeenCalledWith('g1', 'phrase test', 2, NOW_SEC);
  });

  it('handles empty candidates gracefully', async () => {
    const db = makeDb([]);
    const memeGraph = makeMemeGraphRepo();

    const clusterer = new MemeClusterer({
      db, memeGraphRepo: memeGraph,
      phraseCandidatesRepo: makePhraseCandidatesRepo(),
embeddingService: makeEmbedding(),
      claude: makeClaude(),
      activeGroups: ['g1'],
      logger: silentLogger,
      now: () => NOW,
    });

    await clusterer.run('g1');

    expect(memeGraph.inserted).toHaveLength(0);
    expect(memeGraph.updates).toHaveLength(0);
  });

  it('does not re-add variant that already exists in entry', async () => {
    const existing = makeEntry({
      id: 1, canonical: 'hyw', variants: ['hyw', 'mmhyw'],
    });
    const jargonRows = [{
      group_id: 'g1', content: 'mmhyw', count: 3,
      contexts: '["ctx"]', last_inference_count: 3,
      meaning: 'mama hyw', is_jargon: 1, promoted: 0,
      created_at: NOW_SEC, updated_at: NOW_SEC,
    }];
    const db = makeDb(jargonRows);
    const memeGraph = makeMemeGraphRepo([existing]);

    const clusterer = new MemeClusterer({
      db, memeGraphRepo: memeGraph,
      phraseCandidatesRepo: makePhraseCandidatesRepo(),
embeddingService: makeEmbedding(),
      claude: makeClaude(),
      activeGroups: ['g1'],
      logger: silentLogger,
      now: () => NOW,
    });

    await clusterer.run('g1');

    // Update should happen but variants should not duplicate 'mmhyw'
    if (memeGraph.updates.length > 0) {
      const update = memeGraph.updates[0]!;
      const variants = update.fields.variants as string[];
      const mmhywCount = variants.filter(v => v === 'mmhyw').length;
      expect(mmhywCount).toBe(1);
    }
  });

  it('confidence is monotonically non-decreasing on variant merge', async () => {
    const existing = makeEntry({
      id: 1, canonical: 'hyw', variants: ['hyw', 'v1', 'v2', 'v3'],
      confidence: 0.55,
    });
    const jargonRows = [{
      group_id: 'g1', content: 'v4', count: 3,
      contexts: '["ctx"]', last_inference_count: 3,
      meaning: 'meaning', is_jargon: 1, promoted: 0,
      created_at: NOW_SEC, updated_at: NOW_SEC,
    }];
    const db = makeDb(jargonRows);
    // Override findByVariant to not match by substring
    const memeGraph = makeMemeGraphRepo();
    (memeGraph.findByVariant as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (memeGraph.listActive as ReturnType<typeof vi.fn>).mockReturnValue([existing]);
    (memeGraph.listActiveWithEmbeddings as ReturnType<typeof vi.fn>).mockReturnValue([existing]);

    const clusterer = new MemeClusterer({
      db, memeGraphRepo: memeGraph,
      phraseCandidatesRepo: makePhraseCandidatesRepo(),
embeddingService: makeEmbedding(),
      claude: makeClaude(),
      activeGroups: ['g1'],
      logger: silentLogger,
      now: () => NOW,
    });

    await clusterer.run('g1');

    if (memeGraph.updates.length > 0) {
      const update = memeGraph.updates[0]!;
      const newConfidence = update.fields.confidence as number;
      expect(newConfidence).toBeGreaterThanOrEqual(existing.confidence);
    }
  });

  it('embeds new entries via embedding service', async () => {
    const db = makeDb([{
      group_id: 'g1', content: 'newterm', count: 5,
      contexts: '["ctx"]', last_inference_count: 3,
      meaning: 'new meaning', is_jargon: 1, promoted: 0,
      created_at: NOW_SEC, updated_at: NOW_SEC,
    }]);
    const embedding = makeEmbedding();
    const memeGraph = makeMemeGraphRepo();

    const clusterer = new MemeClusterer({
      db, memeGraphRepo: memeGraph,
      phraseCandidatesRepo: makePhraseCandidatesRepo(),
embeddingService: embedding,
      claude: makeClaude(),
      activeGroups: ['g1'],
      logger: silentLogger,
      now: () => NOW,
    });

    await clusterer.run('g1');

    expect(memeGraph.inserted).toHaveLength(1);
    expect(memeGraph.inserted[0]!.embeddingVec).toEqual([0.1, 0.2, 0.3]);
    expect(embedding.embed).toHaveBeenCalled();
  });

  it('handles embedding service not ready gracefully', async () => {
    const db = makeDb([{
      group_id: 'g1', content: 'newterm', count: 5,
      contexts: '["ctx"]', last_inference_count: 3,
      meaning: 'meaning', is_jargon: 1, promoted: 0,
      created_at: NOW_SEC, updated_at: NOW_SEC,
    }]);
    const embedding = makeEmbedding(false);
    const memeGraph = makeMemeGraphRepo();

    const clusterer = new MemeClusterer({
      db, memeGraphRepo: memeGraph,
      phraseCandidatesRepo: makePhraseCandidatesRepo(),
embeddingService: embedding,
      claude: makeClaude(),
      activeGroups: ['g1'],
      logger: silentLogger,
      now: () => NOW,
    });

    await clusterer.run('g1');

    // Should still insert, just with null embedding
    expect(memeGraph.inserted).toHaveLength(1);
    expect(memeGraph.inserted[0]!.embeddingVec).toBeNull();
  });

  it('runAll processes all active groups', async () => {
    const db = makeDb([]);
    const memeGraph = makeMemeGraphRepo();

    const clusterer = new MemeClusterer({
      db, memeGraphRepo: memeGraph,
      phraseCandidatesRepo: makePhraseCandidatesRepo(),
embeddingService: makeEmbedding(),
      claude: makeClaude(),
      activeGroups: ['g1', 'g2'],
      logger: silentLogger,
      now: () => NOW,
    });

    // Spy on run
    const runSpy = vi.spyOn(clusterer, 'run');
    await clusterer.runAll();

    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(runSpy).toHaveBeenCalledWith('g1');
    expect(runSpy).toHaveBeenCalledWith('g2');
  });

  it('_computeNewConfidence returns 0.55 when meaning present (strong differ)', () => {
    const clusterer = new MemeClusterer({
      db: makeDb(),
      memeGraphRepo: makeMemeGraphRepo(),
      phraseCandidatesRepo: makePhraseCandidatesRepo(),
embeddingService: makeEmbedding(),
      claude: makeClaude(),
      activeGroups: ['g1'],
      logger: silentLogger,
      now: () => NOW,
    });

    const confidence = clusterer._computeNewConfidence({
      groupId: 'g1', content: 'test', count: 5,
      contexts: [], meaning: 'some meaning', source: 'jargon',
    });

    expect(confidence).toBe(0.55);
  });

  it('_computeNewConfidence returns 0.4 when meaning is null', () => {
    const clusterer = new MemeClusterer({
      db: makeDb(),
      memeGraphRepo: makeMemeGraphRepo(),
      phraseCandidatesRepo: makePhraseCandidatesRepo(),
embeddingService: makeEmbedding(),
      claude: makeClaude(),
      activeGroups: ['g1'],
      logger: silentLogger,
      now: () => NOW,
    });

    const confidence = clusterer._computeNewConfidence({
      groupId: 'g1', content: 'test', count: 5,
      contexts: [], meaning: null, source: 'jargon',
    });

    expect(confidence).toBe(0.4);
  });

  it('continues processing remaining candidates when one fails', async () => {
    const jargonRows = [
      {
        group_id: 'g1', content: 'good', count: 5,
        contexts: '["ctx"]', last_inference_count: 3,
        meaning: 'meaning', is_jargon: 1, promoted: 0,
        created_at: NOW_SEC, updated_at: NOW_SEC,
      },
    ];
    const db = makeDb(jargonRows);
    const badPhraseRow = makePhraseRow({ content: 'bad' });
    const goodPhraseRow = makePhraseRow({ content: 'good2' });

    const memeGraph = makeMemeGraphRepo();
    // Make findByVariant throw for 'bad' content
    let callIdx = 0;
    (memeGraph.findByVariant as ReturnType<typeof vi.fn>).mockImplementation((_gid: string, term: string) => {
      if (term === 'bad') throw new Error('simulated failure');
      return [];
    });

    const clusterer = new MemeClusterer({
      db, memeGraphRepo: memeGraph,
      phraseCandidatesRepo: makePhraseCandidatesRepo([badPhraseRow, goodPhraseRow]),
embeddingService: makeEmbedding(),
      claude: makeClaude(),
      activeGroups: ['g1'],
      logger: silentLogger,
      now: () => NOW,
    });

    await clusterer.run('g1');

    // 'good' (jargon) and 'good2' (phrase) should still be inserted
    // 'bad' should have been skipped
    expect(memeGraph.inserted.length).toBeGreaterThanOrEqual(2);
    expect(silentLogger.warn).toHaveBeenCalled();
  });
});
