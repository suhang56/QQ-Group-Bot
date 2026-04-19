import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from '../src/core/router.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { Database } from '../src/storage/db.js';
import { initLogger } from '../src/utils/logger.js';
import type { GroupMessage, INapCatAdapter } from '../src/adapter/napcat.js';
import type { ChatResult, ReplyMeta } from '../src/utils/chat-result.js';
import type { SelfLearningModule } from '../src/modules/self-learning.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-rcr';

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm1', groupId: 'g1', userId: 'u1',
    nickname: 'Alice', role: 'member',
    content: 'hello', rawContent: 'hello',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeAdapter(): INapCatAdapter {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    ban: vi.fn().mockResolvedValue(undefined),
    kick: vi.fn().mockResolvedValue(undefined),
    deleteMsg: vi.fn().mockResolvedValue(undefined),
    sendPrivate: vi.fn().mockResolvedValue(undefined),
    sendPrivateMessage: vi.fn().mockResolvedValue(42),
    getGroupNotices: vi.fn().mockResolvedValue([]),
    getGroupInfo: vi.fn().mockResolvedValue({ groupId: 'g1', name: 'Test', description: '', memberCount: 1 }),
    getImage: vi.fn().mockResolvedValue({ filename: '', url: '', size: 0 }),
  };
}

function makeReplyResult(overrides: Partial<ReplyMeta> = {}, text = 'ok'): ChatResult {
  return {
    kind: 'reply', text,
    meta: {
      decisionPath: 'normal', evasive: false,
      injectedFactIds: [], matchedFactIds: [],
      usedVoiceCount: 0, usedFactHint: false,
      ...overrides,
    },
    reasonCode: 'engaged',
  };
}

function makeSilentResult(): ChatResult {
  return { kind: 'silent', meta: { decisionPath: 'silent' }, reasonCode: 'timing' };
}

describe('Router — reads ChatResult.meta instead of deprecated getters', () => {
  let db: Database;
  let adapter: INapCatAdapter;
  let router: Router;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = makeAdapter();
    router = new Router(db, adapter, new RateLimiter());
  });

  it('router sends message when result.kind === reply', async () => {
    router.setChat({
      generateReply: vi.fn().mockResolvedValue(makeReplyResult({}, '你好')),
      recordOutgoingMessage: vi.fn(),
      markReplyToUser: vi.fn(),
      invalidateLore: vi.fn(),
      tickStickerRefresh: vi.fn(),
      noteAdminActivity: vi.fn(),
    });
    await router.dispatch(makeMsg());
    expect(adapter.send).toHaveBeenCalledWith('g1', '你好', undefined);
  });

  it('router does NOT send when result.kind === silent', async () => {
    router.setChat({
      generateReply: vi.fn().mockResolvedValue(makeSilentResult()),
      recordOutgoingMessage: vi.fn(),
      markReplyToUser: vi.fn(),
      invalidateLore: vi.fn(),
      tickStickerRefresh: vi.fn(),
      noteAdminActivity: vi.fn(),
    });
    await router.dispatch(makeMsg());
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('rememberInjection called when injectedFactIds non-empty in result.meta', async () => {
    const rememberInjection = vi.fn();
    const sl = {
      rememberInjection,
      detectCorrection: vi.fn(),
      handleTopLevelCorrection: vi.fn(),
      formatFactsForPrompt: vi.fn(),
      researchOnline: vi.fn().mockResolvedValue(undefined),
      harvestPassiveKnowledge: vi.fn(),
    } as unknown as SelfLearningModule;
    router.setSelfLearning(sl);

    router.setChat({
      generateReply: vi.fn().mockResolvedValue(makeReplyResult({ injectedFactIds: [1, 2, 3] })),
      recordOutgoingMessage: vi.fn(),
      markReplyToUser: vi.fn(),
      invalidateLore: vi.fn(),
      tickStickerRefresh: vi.fn(),
      noteAdminActivity: vi.fn(),
    });

    await router.dispatch(makeMsg());
    expect(rememberInjection).toHaveBeenCalledWith('g1', expect.any(Number), [1, 2, 3]);
  });

  it('rememberInjection NOT called when injectedFactIds is empty', async () => {
    const rememberInjection = vi.fn();
    const sl = {
      rememberInjection,
      detectCorrection: vi.fn(),
      handleTopLevelCorrection: vi.fn(),
      formatFactsForPrompt: vi.fn(),
      researchOnline: vi.fn().mockResolvedValue(undefined),
      harvestPassiveKnowledge: vi.fn(),
    } as unknown as SelfLearningModule;
    router.setSelfLearning(sl);

    router.setChat({
      generateReply: vi.fn().mockResolvedValue(makeReplyResult({ injectedFactIds: [] })),
      recordOutgoingMessage: vi.fn(),
      markReplyToUser: vi.fn(),
      invalidateLore: vi.fn(),
      tickStickerRefresh: vi.fn(),
      noteAdminActivity: vi.fn(),
    });

    await router.dispatch(makeMsg());
    expect(rememberInjection).not.toHaveBeenCalled();
  });

  it('sticker result dispatches cqCode via adapter.send', async () => {
    router.setChat({
      generateReply: vi.fn().mockResolvedValue({
        kind: 'sticker',
        cqCode: '[CQ:image,file=test.jpg]',
        meta: { decisionPath: 'sticker', key: 'k1' },
        reasonCode: 'engaged',
      } as ChatResult),
      recordOutgoingMessage: vi.fn(),
      markReplyToUser: vi.fn(),
      invalidateLore: vi.fn(),
      tickStickerRefresh: vi.fn(),
      noteAdminActivity: vi.fn(),
    });
    await router.dispatch(makeMsg());
    expect(adapter.send).toHaveBeenCalledWith('g1', '[CQ:image,file=test.jpg]', undefined);
  });
});
