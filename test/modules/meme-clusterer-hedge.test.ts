import { describe, it, expect, vi } from 'vitest';
import { MemeClusterer } from '../../src/modules/meme-clusterer.js';
import type { IClaudeClient, ClaudeRequest, ClaudeResponse } from '../../src/ai/claude.js';
import type { IMemeGraphRepo, IPhraseCandidatesRepo, MemeGraphEntry } from '../../src/storage/db.js';
import { Database } from '../../src/storage/db.js';
import { initLogger } from '../../src/utils/logger.js';
import type { Logger } from 'pino';

initLogger({ level: 'silent' });

function mockClaude(text: string): IClaudeClient {
  return {
    complete: vi.fn(async (_req: ClaudeRequest): Promise<ClaudeResponse> => {
      return { text, inputTokens: 10, outputTokens: 10 };
    }),
    describeImage: vi.fn() as never,
    visionWithPrompt: vi.fn() as never,
  };
}

function mockMemeGraphRepo(): IMemeGraphRepo {
  return {
    insert: vi.fn(() => 1),
    update: vi.fn(),
    findByCanonical: vi.fn(() => null),
    findByVariant: vi.fn(() => []),
    listActive: vi.fn(() => []),
    listActiveWithEmbeddings: vi.fn(() => []),
    listNullEmbedding: vi.fn(() => []),
    findById: vi.fn((_id: number) => null as MemeGraphEntry | null),
    adminEdit: vi.fn(),
  };
}

function mockPhraseRepo(): IPhraseCandidatesRepo {
  return {
    upsert: vi.fn(),
    findAtThreshold: vi.fn(() => []),
    updateInference: vi.fn(),
    listUnpromoted: vi.fn(() => []),
    markPromoted: vi.fn(),
  };
}

interface FakeLogger extends Logger {
  warn: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

function makeLogger(): FakeLogger {
  const logger = {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: 'silent',
  } as unknown as FakeLogger;
  (logger as unknown as { child: () => FakeLogger }).child = () => logger;
  return logger;
}

describe('MemeClusterer._inferOrigin — HEDGE_RE gate', () => {
  it('t3: hedge origin_event rejected — memeGraph.update NOT called; logger.warn fired', async () => {
    const db = new Database(':memory:');
    const memeGraph = mockMemeGraphRepo();
    const logger = makeLogger();
    const clusterer = new MemeClusterer({
      db: db.rawDb,
      memeGraph,
      phraseCandidates: mockPhraseRepo(),
      claude: mockClaude('{"origin_event":"无法判断这个梗的起源","origin_user":null}'),
      logger,
      now: () => 1_700_000_000_000,
    });

    const entryId = 42;
    const candidate = { content: '智械危机', contexts: ['用法示例1', '用法示例2'] };
    await (clusterer as unknown as { _inferOrigin: (id: number, c: typeof candidate) => Promise<void> })._inferOrigin(entryId, candidate);

    expect(memeGraph.update).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [meta, msg] = logger.warn.mock.calls[0]!;
    expect(meta).toMatchObject({ entryId: 42 });
    expect(meta).toHaveProperty('origin_event_truncated');
    expect(typeof (meta as { origin_event_truncated: unknown }).origin_event_truncated).toBe('string');
    expect(msg).toContain('hedge phrase');
    db.close();
  });

  it('t4: clean origin_event accepted — memeGraph.update called once with originEvent', async () => {
    const db = new Database(':memory:');
    const memeGraph = mockMemeGraphRepo();
    const logger = makeLogger();
    const clusterer = new MemeClusterer({
      db: db.rawDb,
      memeGraph,
      phraseCandidates: mockPhraseRepo(),
      claude: mockClaude('{"origin_event":"这个梗起源于群主的一次失误","origin_user":null}'),
      logger,
      now: () => 1_700_000_000_000,
    });

    const entryId = 99;
    const candidate = { content: '智械危机', contexts: ['用法示例1'] };
    await (clusterer as unknown as { _inferOrigin: (id: number, c: typeof candidate) => Promise<void> })._inferOrigin(entryId, candidate);

    expect(memeGraph.update).toHaveBeenCalledTimes(1);
    expect(memeGraph.update).toHaveBeenCalledWith(99, { originEvent: '这个梗起源于群主的一次失误' });
    db.close();
  });
});
