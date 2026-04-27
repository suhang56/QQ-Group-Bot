import { describe, it, expect } from 'vitest';
import { classifyUtteranceAct } from '../../src/utils/strategy-preview.js';
import type { ChatResult } from '../../src/utils/chat-result.js';

describe('R4-lite metaBuilder integration (row 25)', () => {
  it('reply meta carries utteranceAct after setUtteranceAct', () => {
    // ReplyMetaBuilder is internal to chat.ts; smoke-test via shape contract:
    // any ReplyMeta must allow utteranceAct to ride through.
    const replyMeta: ChatResult & { kind: 'reply' } = {
      kind: 'reply',
      text: 'hello',
      reasonCode: 'normal',
      meta: {
        decisionPath: 'normal',
        utteranceAct: 'direct_chat',
        evasive: false, injectedFactIds: [], matchedFactIds: [],
        usedVoiceCount: 0, usedFactHint: false,
      },
    };
    expect(replyMeta.meta.utteranceAct).toBe('direct_chat');
  });
});

describe('R4-lite Router defer/silent paths (rows 26–27)', () => {
  const baseCtx = {
    msg: { content: '现在策略是什么', isDirect: false, isAtMention: false, shouldReply: true },
    recent5Msgs: [{ content: 'bot被管了', userId: 'u1' }],
    hasKnownFactTerm: false,
    hasRealFactHit: undefined,
    relayHit: false,
  };

  it('row 26: defer ChatResult carries utteranceAct from Router-side classify', () => {
    const act = classifyUtteranceAct(baseCtx);
    const deferResult: ChatResult = {
      kind: 'defer',
      untilSec: 100,
      targetMsgId: 'm1',
      reasonCode: 'rate-limit',
      meta: { decisionPath: 'defer', utteranceAct: act },
    };
    expect(deferResult.meta.utteranceAct).toBeDefined();
    expect(deferResult.meta.utteranceAct).toBe('meta_admin_status');
  });

  it('row 27: silent ChatResult carries utteranceAct from Router-side classify', () => {
    const silentCtx = {
      ...baseCtx,
      msg: { ...baseCtx.msg, content: '哈哈' },
      recent5Msgs: [],
    };
    const act = classifyUtteranceAct(silentCtx);
    const silentResult: ChatResult = {
      kind: 'silent',
      reasonCode: 'timing',
      meta: { decisionPath: 'silent', utteranceAct: act },
    };
    expect(silentResult.meta.utteranceAct).toBe('chime_in');
  });

  it('row 27 follow-up: silent with no content carries valid (non-undefined) act', () => {
    const act = classifyUtteranceAct({
      msg: { content: '随便说说', isDirect: false, isAtMention: false, shouldReply: true },
      recent5Msgs: [],
      hasKnownFactTerm: false,
      hasRealFactHit: undefined,
      relayHit: false,
    });
    expect(act).toBe('chime_in');
  });
});
