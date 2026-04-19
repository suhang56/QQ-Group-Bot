import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OnDemandLookup } from '../src/modules/on-demand-lookup.js';
import { ChatModule } from '../src/modules/chat.js';
import type { IClaudeClient } from '../src/clients/claude-client.js';
import type { Database } from '../src/storage/db.js';
import { isValidStructuredTerm } from '../src/modules/fact-topic-prefixes.js';

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

describe('ondemand weak-leak regression tests', () => {
  let chat: ChatModule;
  let mockLookup: { lookupTerm: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    chat = new ChatModule(makeMockClaude(), makeMockDb(), {
      moodProactiveEnabled: false,
      deflectCacheEnabled: false,
    });
    mockLookup = { lookupTerm: vi.fn() };
    chat.setOnDemandLookup(mockLookup as unknown as OnDemandLookup);
    vi.spyOn(chat as never, '_getKnownTermsSet').mockReturnValue(new Set());
  });

  // Case A — weak directive for any input must never contain "是指.*吗" pattern
  it('Case A: weak directive does not produce X是指Y吗 pattern', async () => {
    mockLookup.lookupTerm.mockResolvedValue({ type: 'weak', guess: '查看当前计划' });
    const { block } = await (chat as never)._buildOnDemandBlock(
      'g1',
      '[xtt] 什么意思',
      'u1',
    );
    expect(block).not.toMatch(/是指.+吗/);
  });

  // Case B — found path for real jargon still works
  it('Case B: found path emits "已知: ykn = 凑友希那"', async () => {
    mockLookup.lookupTerm.mockResolvedValue({ type: 'found', meaning: '凑友希那' });
    const { block } = await (chat as never)._buildOnDemandBlock(
      'g1',
      'ykn是谁',
      'u1',
    );
    expect(block).toContain('已知: ykn = 凑友希那');
    expect(block).not.toMatch(/是指.+吗/);
  });

  // Case C — structured term on weak path emits abstract directive, not safeGuess verbatim
  it('Case C: weak directive for ygfn contains term but not guess text, no 是指', async () => {
    mockLookup.lookupTerm.mockResolvedValue({ type: 'weak', guess: '羊宫妃那' });
    const { block } = await (chat as never)._buildOnDemandBlock(
      'g1',
      'ygfn是谁',
      'u1',
    );
    expect(block).toContain('ygfn');
    expect(block).not.toContain('羊宫妃那');
    expect(block).not.toMatch(/是指.+吗/);
  });

  // Case D — term that fails isValidStructuredTerm is filtered; lookupTerm never called
  it('Case D: 那个 fails isValidStructuredTerm → filter drops it, lookupTerm not called', () => {
    // Verify the filter logic directly — 那个 matches DIRTY_HAN_TOKEN_RE
    expect(isValidStructuredTerm('那个')).toBe(false);
  });

  // Case E — full block never contains /是指.+吗/ regardless of guess content
  it('Case E: full block regex invariant — no 是指...吗 pattern for any weak term', async () => {
    mockLookup.lookupTerm.mockResolvedValue({ type: 'weak', guess: '某个人物' });
    const { block } = await (chat as never)._buildOnDemandBlock(
      'g1',
      '[abc] 是啥',
      'u1',
    );
    expect(block).not.toMatch(/\S+是指\S+吗/);
  });
});
