import { describe, it, expect } from 'vitest';
import {
  isSendable, isReply, isSticker, isSilent, isDefer,
  nonEmptyBlock,
} from '../src/utils/chat-result.js';
import type { ChatResult, ReplyMeta, StickerMeta, BaseResultMeta } from '../src/utils/chat-result.js';

const replyMeta: ReplyMeta = {
  decisionPath: 'normal', evasive: false,
  injectedFactIds: [], matchedFactIds: [],
  usedVoiceCount: 0, usedFactHint: false,
};

const baseMeta: BaseResultMeta = { decisionPath: 'silent' };

function makeReply(text = 'hi'): ChatResult {
  return { kind: 'reply', text, meta: replyMeta, reasonCode: 'engaged' };
}

function makeStickerResult(): ChatResult {
  const meta: StickerMeta = { decisionPath: 'sticker', key: 'k1' };
  return { kind: 'sticker', cqCode: '[CQ:image,file=x]', meta, reasonCode: 'engaged' };
}

function makeSilent(): ChatResult {
  return { kind: 'silent', meta: baseMeta, reasonCode: 'timing' };
}

function makeFallback(): ChatResult {
  return { kind: 'fallback', text: 'fallback text', meta: { decisionPath: 'fallback' }, reasonCode: 'pure-at' };
}

function makeDefer(): ChatResult {
  return { kind: 'defer', untilSec: 9999, targetMsgId: 'm1', meta: { decisionPath: 'defer' }, reasonCode: 'rate-limit' };
}

describe('isSendable', () => {
  it('true for reply', () => expect(isSendable(makeReply())).toBe(true));
  it('true for sticker', () => expect(isSendable(makeStickerResult())).toBe(true));
  it('true for fallback', () => expect(isSendable(makeFallback())).toBe(true));
  it('false for silent', () => expect(isSendable(makeSilent())).toBe(false));
  it('false for defer', () => expect(isSendable(makeDefer())).toBe(false));
});

describe('type guards', () => {
  it('isReply: true only for reply', () => {
    expect(isReply(makeReply())).toBe(true);
    expect(isReply(makeSilent())).toBe(false);
    expect(isReply(makeStickerResult())).toBe(false);
  });

  it('isSticker: true only for sticker', () => {
    expect(isSticker(makeStickerResult())).toBe(true);
    expect(isSticker(makeReply())).toBe(false);
  });

  it('isSilent: true only for silent', () => {
    expect(isSilent(makeSilent())).toBe(true);
    expect(isSilent(makeReply())).toBe(false);
    expect(isSilent(makeDefer())).toBe(false);
  });

  it('isDefer: true only for defer', () => {
    expect(isDefer(makeDefer())).toBe(true);
    expect(isDefer(makeSilent())).toBe(false);
  });
});

describe('ChatResult discriminated union exhaustiveness', () => {
  it('reply carries text + meta.evasive', () => {
    const r = makeReply('hello');
    expect(r.kind).toBe('reply');
    if (r.kind === 'reply') {
      expect(r.text).toBe('hello');
      expect(typeof r.meta.evasive).toBe('boolean');
      expect(Array.isArray(r.meta.injectedFactIds)).toBe(true);
      expect(Array.isArray(r.meta.matchedFactIds)).toBe(true);
    }
  });

  it('sticker carries cqCode + meta.key', () => {
    const r = makeStickerResult();
    if (r.kind === 'sticker') {
      expect(r.cqCode).toContain('[CQ:');
      expect(r.meta.key).toBe('k1');
    }
  });

  it('silent has no text field', () => {
    const r = makeSilent();
    expect('text' in r).toBe(false);
    expect('cqCode' in r).toBe(false);
  });

  it('defer carries untilSec + targetMsgId', () => {
    const r = makeDefer();
    if (r.kind === 'defer') {
      expect(r.untilSec).toBeGreaterThan(0);
      expect(typeof r.targetMsgId).toBe('string');
    }
  });

  it('fallback carries text and narrow reasonCode', () => {
    const r = makeFallback();
    if (r.kind === 'fallback') {
      expect(r.text).toBe('fallback text');
      expect(['pure-at', 'low-comprehension-direct', 'bot-blank-needed-ack']).toContain(r.reasonCode);
    }
  });
});

describe('isSendable — edge cases', () => {
  it('empty reply text is still sendable', () => {
    const r = makeReply('');
    expect(isSendable(r)).toBe(true);
  });

  it('sticker with no score field is sendable', () => {
    const meta: StickerMeta = { decisionPath: 'sticker', key: 'k2' };
    const r: ChatResult = { kind: 'sticker', cqCode: '[CQ:image,file=y]', meta, reasonCode: 'engaged' };
    expect(isSendable(r)).toBe(true);
  });
});

describe('nonEmptyBlock', () => {
  it('true for non-empty string', () => expect(nonEmptyBlock('hi')).toBe(true));
  it('false for empty string', () => expect(nonEmptyBlock('')).toBe(false));
  it('false for null', () => expect(nonEmptyBlock(null)).toBe(false));
  it('false for undefined', () => expect(nonEmptyBlock(undefined)).toBe(false));
});
