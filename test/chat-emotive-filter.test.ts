import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OnDemandLookup } from '../src/modules/on-demand-lookup.js';
import { ChatModule } from '../src/modules/chat.js';
import type { IClaudeClient } from '../src/clients/claude-client.js';
import type { Database } from '../src/storage/db.js';

function makeMockDb(): Database {
  return {
    learnedFacts: {
      listActive: vi.fn().mockReturnValue([]),
      listActiveWithEmbeddings: vi.fn().mockReturnValue([]),
      listAllNullEmbeddingActive: vi.fn().mockReturnValue([]),
      listNullEmbeddingActive: vi.fn().mockReturnValue([]),
      insert: vi.fn(),
      updateEmbedding: vi.fn(),
      markStatus: vi.fn(),
      clearGroup: vi.fn(),
      countActive: vi.fn().mockReturnValue(0),
      setEmbeddingService: vi.fn(),
      recordEmbeddingFailure: vi.fn().mockReturnValue(false),
    },
    messages: {
      insert: vi.fn(),
      getRecent: vi.fn().mockReturnValue([]),
      getByUser: vi.fn().mockReturnValue([]),
      sampleRandomHistorical: vi.fn().mockReturnValue([]),
      searchByKeywords: vi.fn().mockReturnValue([]),
      getTopUsers: vi.fn().mockReturnValue([]),
      softDelete: vi.fn(),
      findBySourceId: vi.fn().mockReturnValue(null),
      findNearTimestamp: vi.fn().mockReturnValue(null),
      getAroundTimestamp: vi.fn().mockReturnValue([]),
      getByTimeRange: vi.fn().mockReturnValue([]),
      listActiveGroupIds: vi.fn().mockReturnValue([]),
      searchFts: vi.fn().mockReturnValue([]),
    },
    mood: {
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
    },
    botReplies: {
      insert: vi.fn(),
      getRecentTexts: vi.fn().mockReturnValue([]),
    },
    jargon: {
      listActive: vi.fn().mockReturnValue([]),
    },
    rawDb: {} as never,
  } as unknown as Database;
}

function makeMockClaude(): IClaudeClient {
  return {
    sendMessage: vi.fn().mockResolvedValue({ text: 'ok', inputTokens: 0, outputTokens: 0 }),
  } as unknown as IClaudeClient;
}

describe('chat emotive-filter — _buildOnDemandBlock candidate chain', () => {
  let chat: ChatModule;
  let mockLookup: { lookupTerm: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    chat = new ChatModule(makeMockClaude(), makeMockDb(), {
      moodProactiveEnabled: false,
      deflectCacheEnabled: false,
    });
    mockLookup = { lookupTerm: vi.fn().mockResolvedValue({ type: 'unknown' }) };
    chat.setOnDemandLookup(mockLookup as unknown as OnDemandLookup);
    vi.spyOn(chat as never, '_getKnownTermsSet').mockReturnValue(new Set());
  });

  // Case A: emotive phrase is filtered BEFORE lookup
  it('Case A: emotive "不要烦" does not reach onDemandLookup.lookupTerm', async () => {
    await (chat as never)._buildOnDemandBlock('g1', '不要烦', 'u1');
    for (const call of mockLookup.lookupTerm.mock.calls) {
      expect(call[1]).not.toBe('不要烦');
    }
  });

  // Case B: non-emotive valid jargon still passes filter
  it('Case B: "ykn是什么" still reaches onDemandLookup.lookupTerm with "ykn"', async () => {
    await (chat as never)._buildOnDemandBlock('g1', 'ykn是什么', 'u1');
    const termsLookedUp = mockLookup.lookupTerm.mock.calls.map((c) => c[1]);
    expect(termsLookedUp).toContain('ykn');
  });
});
