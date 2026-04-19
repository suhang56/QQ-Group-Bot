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

describe('Path A routing glue -- 3-outcome matrix', () => {
  let chat: ChatModule;
  let mockLookup: { lookupTerm: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    chat = new ChatModule(makeMockClaude(), makeMockDb(), {
      moodProactiveEnabled: false,
      deflectCacheEnabled: false,
    });
    mockLookup = { lookupTerm: vi.fn() };
    chat.setOnDemandLookup(mockLookup as unknown as OnDemandLookup);
  });

  it('found outcome: injects "已知: termA = X" into block', async () => {
    mockLookup.lookupTerm.mockResolvedValue({ type: 'found', meaning: 'X' });
    vi.spyOn(chat as never, '_getKnownTermsSet').mockReturnValue(new Set());
    const { block } = await (chat as never)._buildOnDemandBlock(
      'g1',
      '[termA] 是什么',
      'u1',
    );
    expect(block).toContain('必须用下面“已知”内容直接回答');
    expect(block).toContain('已知: termA = X');
  });

  it('weak outcome: injects "你猜 termB 可能是指 Y" into block', async () => {
    mockLookup.lookupTerm.mockResolvedValue({ type: 'weak', guess: 'Y' });
    vi.spyOn(chat as never, '_getKnownTermsSet').mockReturnValue(new Set());
    const { block } = await (chat as never)._buildOnDemandBlock(
      'g1',
      '[termB] 啥意思',
      'u1',
    );
    expect(block).toContain('你猜 termB 可能是指 Y');
  });

  it('unknown + direct question: injects "你没听过" block', async () => {
    mockLookup.lookupTerm.mockResolvedValue(null);
    vi.spyOn(chat as never, '_getKnownTermsSet').mockReturnValue(new Set());
    const { block } = await (chat as never)._buildOnDemandBlock(
      'g1',
      '[termC] 是谁？',
      'u1',
    );
    expect(block).toContain('你没听过');
  });

  it('found term suppresses ask-back for leftover unknown candidates', async () => {
    mockLookup.lookupTerm.mockImplementation(async (_groupId: string, term: string) => (
      term === 'xtt'
        ? { type: 'found', meaning: '小团体' }
        : { type: 'unknown' }
    ));
    vi.spyOn(chat as never, '_getKnownTermsSet').mockReturnValue(new Set());
    const { block } = await (chat as never)._buildOnDemandBlock(
      'g1',
      'xtt foo 是啥',
      'u1',
    );
    expect(block).toContain('已知: xtt = 小团体');
    expect(block).toContain('不能装不知道');
    expect(block).not.toContain('你没听过');
    expect(block).not.toContain('foo');
  });
});
