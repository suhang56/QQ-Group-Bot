import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database, type IMemeGraphRepository, type MemeGraph } from '../../src/storage/db.js';
import { SelfLearningModule } from '../../src/modules/self-learning.js';
import type { IClaudeClient, ClaudeRequest, ClaudeResponse } from '../../src/ai/claude.js';
import type { IEmbeddingService } from '../../src/storage/embeddings.js';
import { initLogger } from '../../src/utils/logger.js';

initLogger({ level: 'silent' });

function makeDb(): Database {
  return new Database(':memory:');
}

function stubClaude(): IClaudeClient {
  return {
    async complete(_req: ClaudeRequest): Promise<ClaudeResponse> {
      return { text: '', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    },
    async describeImage(): Promise<string> { return ''; },
  };
}

function fakeEmbedder(): IEmbeddingService {
  const lookup = (text: string): number[] => {
    const v = [0, 0, 0, 0];
    if (text.includes('hyw') || text.includes('何意味')) v[0] = 1;
    else if (text.includes('智械危机')) v[1] = 1;
    else if (text.includes('roselia')) v[2] = 1;
    else v[3] = 1;
    return v;
  };
  return {
    isReady: true,
    async embed(text: string): Promise<number[]> { return lookup(text); },
    async waitReady(): Promise<void> {},
  };
}

function makeMemeGraphRepo(entries: MemeGraph[]): IMemeGraphRepository {
  return {
    findSimilarActive(groupId: string, _embedding: number[], _threshold: number, limit: number): MemeGraph[] {
      return entries
        .filter(e => e.groupId === groupId && e.status === 'active')
        .slice(0, limit);
    },
    listActive(groupId: string, limit: number): MemeGraph[] {
      return entries.filter(e => e.groupId === groupId && e.status === 'active').slice(0, limit);
    },
  } as unknown as IMemeGraphRepository;
}

const now = Math.floor(Date.now() / 1000);

const MEME_HYW: MemeGraph = {
  id: 1, groupId: 'g1', canonical: '何意味',
  variants: ['hyw', 'mmhyw', 'ohnmmhyw'],
  meaning: '表示困惑或不解',
  originEvent: 'dangzhili 发了一张图',
  originMsgId: null, originUserId: null, originTs: null,
  firstSeenCount: null, totalCount: 5, confidence: 0.6,
  status: 'active', embedding: [1, 0, 0, 0],
  createdAt: now, updatedAt: now,
};

const MEME_ZHIXIE: MemeGraph = {
  id: 2, groupId: 'g1', canonical: '智械危机',
  variants: ['智械危机', '我草智械危机'],
  meaning: 'bot 说了太像人的话',
  originEvent: null,
  originMsgId: null, originUserId: null, originTs: null,
  firstSeenCount: null, totalCount: 3, confidence: 0.5,
  status: 'active', embedding: [0, 1, 0, 0],
  createdAt: now, updatedAt: now,
};

const MEME_DEMOTED: MemeGraph = {
  id: 3, groupId: 'g1', canonical: '过气梗',
  variants: ['过气'],
  meaning: '不再使用的梗',
  originEvent: null,
  originMsgId: null, originUserId: null, originTs: null,
  firstSeenCount: null, totalCount: 1, confidence: 0.3,
  status: 'demoted', embedding: [0, 0, 0, 1],
  createdAt: now, updatedAt: now,
};

describe('SelfLearningModule meme_graph injection', () => {
  let db: Database;
  const originalEnv = process.env['MEMES_V1_DISABLED'];

  beforeEach(() => {
    db = makeDb();
    delete process.env['MEMES_V1_DISABLED'];
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['MEMES_V1_DISABLED'] = originalEnv;
    } else {
      delete process.env['MEMES_V1_DISABLED'];
    }
  });

  it('injects [群梗] lines when meme_graph has matching entries', async () => {
    const learner = new SelfLearningModule({
      db,
      claude: stubClaude(),
      embeddingService: fakeEmbedder(),
    });
    learner.setMemeGraphRepo(makeMemeGraphRepo([MEME_HYW, MEME_ZHIXIE]));

    const result = await learner.formatFactsForPrompt('g1', 50, 'hyw是什么');
    expect(result.text).toContain('[群梗]');
    expect(result.text).toContain('何意味');
    expect(result.text).toContain('hyw/mmhyw/ohnmmhyw');
    expect(result.text).toContain('表示困惑或不解');
  });

  it('includes origin_event when present', async () => {
    const learner = new SelfLearningModule({
      db,
      claude: stubClaude(),
      embeddingService: fakeEmbedder(),
    });
    learner.setMemeGraphRepo(makeMemeGraphRepo([MEME_HYW]));

    const result = await learner.formatFactsForPrompt('g1', 50, 'hyw是什么');
    expect(result.text).toContain('dangzhili');
  });

  it('omits origin_event suffix when null', async () => {
    const learner = new SelfLearningModule({
      db,
      claude: stubClaude(),
      embeddingService: fakeEmbedder(),
    });
    learner.setMemeGraphRepo(makeMemeGraphRepo([MEME_ZHIXIE]));

    const result = await learner.formatFactsForPrompt('g1', 50, '智械危机');
    expect(result.text).toContain('智械危机');
    expect(result.text).not.toContain('Source:');
  });

  it('filters out demoted meme entries', async () => {
    const learner = new SelfLearningModule({
      db,
      claude: stubClaude(),
      embeddingService: fakeEmbedder(),
    });
    learner.setMemeGraphRepo(makeMemeGraphRepo([MEME_DEMOTED]));

    const result = await learner.formatFactsForPrompt('g1', 50, '过气梗');
    // demoted entries should not appear
    expect(result.text).not.toContain('过气梗');
  });

  it('skips meme injection when MEMES_V1_DISABLED=1', async () => {
    process.env['MEMES_V1_DISABLED'] = '1';
    const learner = new SelfLearningModule({
      db,
      claude: stubClaude(),
      embeddingService: fakeEmbedder(),
    });
    learner.setMemeGraphRepo(makeMemeGraphRepo([MEME_HYW]));

    const result = await learner.formatFactsForPrompt('g1', 50, 'hyw');
    expect(result.text).not.toContain('[群梗]');
  });

  it('skips meme injection when memeGraphRepo not set', async () => {
    const learner = new SelfLearningModule({
      db,
      claude: stubClaude(),
      embeddingService: fakeEmbedder(),
    });
    // do NOT call setMemeGraphRepo

    const result = await learner.formatFactsForPrompt('g1', 50, 'hyw');
    expect(result.text).not.toContain('[群梗]');
  });

  it('returns meme block even when no learned facts exist', async () => {
    const learner = new SelfLearningModule({
      db,
      claude: stubClaude(),
      embeddingService: fakeEmbedder(),
    });
    learner.setMemeGraphRepo(makeMemeGraphRepo([MEME_HYW]));

    // No learned_facts inserted, but meme_graph has entries
    const result = await learner.formatFactsForPrompt('g1', 50, 'hyw');
    expect(result.text).toContain('[群梗]');
    expect(result.factIds).toEqual([]);
  });

  it('limits variant display to first 3', async () => {
    const manyVariants: MemeGraph = {
      ...MEME_HYW,
      variants: ['v1', 'v2', 'v3', 'v4', 'v5'],
    };
    const learner = new SelfLearningModule({
      db,
      claude: stubClaude(),
      embeddingService: fakeEmbedder(),
    });
    learner.setMemeGraphRepo(makeMemeGraphRepo([manyVariants]));

    const result = await learner.formatFactsForPrompt('g1', 50, 'hyw');
    expect(result.text).toContain('v1/v2/v3');
    expect(result.text).not.toContain('v4');
    expect(result.text).not.toContain('v5');
  });
});
