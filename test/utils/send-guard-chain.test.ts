import { describe, it, expect, vi } from 'vitest';
import type { GroupMessage } from '../../src/adapter/napcat.js';
import {
  runSendGuardChain,
  stickerLeakGuard,
  type SendGuard,
  type SendGuardCtx,
} from '../../src/utils/send-guard-chain.js';

const ctxFor = (resultKind: 'reply' | 'fallback' | 'sticker'): SendGuardCtx => ({
  groupId: 'g1',
  triggerMessage: { groupId: 'g1', userId: 'u1', nickname: 'u', content: '', rawContent: '', messageId: 'm', timestamp: 0 } as unknown as GroupMessage,
  isDirect: false,
  resultKind,
});

describe('runSendGuardChain', () => {
  it('empty guards array returns passed with input text', () => {
    const r = runSendGuardChain([], 'hello', ctxFor('reply'));
    expect(r).toEqual({ passed: true, text: 'hello' });
  });

  it('single passing guard threads text through', () => {
    const g: SendGuard = (text) => ({ passed: true, text: text + '!' });
    const r = runSendGuardChain([g], 'hi', ctxFor('reply'));
    expect(r).toEqual({ passed: true, text: 'hi!' });
  });

  it('first guard fails → second guard is NOT called (short-circuit)', () => {
    const first: SendGuard = () => ({ passed: false, reason: 'stop', replacement: 'silent' });
    const second = vi.fn<SendGuard>((text) => ({ passed: true, text }));
    const r = runSendGuardChain([first, second], 'x', ctxFor('reply'));
    expect(r).toEqual({ passed: false, reason: 'stop', replacement: 'silent' });
    expect(second).not.toHaveBeenCalled();
  });

  it('passing guard mutates text, next guard receives mutated', () => {
    const first: SendGuard = (text) => ({ passed: true, text: text.toUpperCase() });
    const spy = vi.fn<SendGuard>((text) => ({ passed: true, text }));
    const r = runSendGuardChain([first, spy], 'ab', ctxFor('reply'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe('AB');
    expect(r).toEqual({ passed: true, text: 'AB' });
  });
});

describe('stickerLeakGuard', () => {
  it('resultKind=sticker skips regardless of text', () => {
    const r = stickerLeakGuard('sticker:18', ctxFor('sticker'));
    expect(r).toEqual({ passed: true, text: 'sticker:18' });
  });

  it('token-only text → fails silent with reason', () => {
    const r = stickerLeakGuard('sticker:18', ctxFor('reply'));
    expect(r).toEqual({
      passed: false,
      reason: 'sticker-leak-stripped',
      replacement: 'silent',
    });
  });

  it('partial-strip text → passes with stripped text', () => {
    const r = stickerLeakGuard('haha <sticker:1>', ctxFor('reply'));
    expect(r.passed).toBe(true);
    if (r.passed) expect(r.text).toBe('haha');
  });

  it('no token → passes unchanged', () => {
    const r = stickerLeakGuard('hello world', ctxFor('reply'));
    expect(r).toEqual({ passed: true, text: 'hello world' });
  });

  it('fallback kind with token-only → silent', () => {
    const r = stickerLeakGuard('<sticker:34>', ctxFor('fallback'));
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.replacement).toBe('silent');
  });
});
