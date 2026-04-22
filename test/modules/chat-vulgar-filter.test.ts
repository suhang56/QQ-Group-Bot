import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OnDemandLookup } from '../../src/modules/on-demand-lookup.js';
import { ChatModule } from '../../src/modules/chat.js';
import type { IClaudeClient } from '../../src/clients/claude-client.js';
import type { Database } from '../../src/storage/db.js';
import { isVulgarDismissal } from '../../src/utils/is-vulgar-dismissal.js';

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

describe('chat vulgar-filter — _buildOnDemandBlock candidate chain (R2.5.1-annex)', () => {
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

  // Case A: vulgar-dismissal is filtered BEFORE lookup
  it('Case A: vulgar "你懂个毛" does not reach onDemandLookup.lookupTerm', async () => {
    await (chat as never)._buildOnDemandBlock('g1', '你懂个毛', 'u1');
    for (const call of mockLookup.lookupTerm.mock.calls) {
      expect(call[1]).not.toBe('你懂个毛');
      expect(call[1]).not.toBe('懂个毛');
    }
  });

  it('Case A2: vulgar "懂个屁" (no 你 prefix) is also filtered', async () => {
    await (chat as never)._buildOnDemandBlock('g1', '懂个屁', 'u1');
    for (const call of mockLookup.lookupTerm.mock.calls) {
      expect(call[1]).not.toBe('懂个屁');
    }
  });

  // Case B: non-vulgar valid jargon still passes
  it('Case B: "ykn是什么" still reaches onDemandLookup.lookupTerm with "ykn"', async () => {
    await (chat as never)._buildOnDemandBlock('g1', 'ykn是什么', 'u1');
    const termsLookedUp = mockLookup.lookupTerm.mock.calls.map((c) => c[1]);
    expect(termsLookedUp).toContain('ykn');
  });

  // Case C: block stays empty when ONLY a vulgar candidate is present
  it('Case C: vulgar-only input yields empty on-demand block', async () => {
    const result = await (chat as never)._buildOnDemandBlock('g1', '你懂个毛', 'u1') as {
      block: string;
      foundTerms: ReadonlySet<string>;
    };
    expect(result.block).toBe('');
  });

  // Case D: third-person 他懂个屁 passes the predicate (NOT filtered) —
  // guards against regex over-reach. extractCandidateTerms may or may not
  // extract it as a single candidate depending on tokenizer, so we only
  // assert the predicate is consistent with spec: if the module did call
  // lookup with "他懂个屁", that's fine (predicate lets it through); if it
  // didn't, extractCandidateTerms rejected it. Either is acceptable — the
  // anti-regression here is that the vulgar regex did NOT accidentally
  // match third-person at the predicate layer.
  it('Case D: predicate does not misclassify third-person as vulgar (unit-level)', () => {
    // integration module-level varies with tokenizer; predicate is the invariant
    expect(isVulgarDismissal('他懂个屁')).toBe(false);
    expect(isVulgarDismissal('她懂个毛')).toBe(false);
  });
});
