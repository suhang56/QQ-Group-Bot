import { describe, it, expect, vi } from 'vitest';
import type { GroupMessage } from '../../src/adapter/napcat.js';
import {
  runSendGuardChain,
  buildSendGuards,
  stickerLeakGuard,
  type SendGuard,
  type SendGuardCtx,
} from '../../src/utils/send-guard-chain.js';
import { harassmentHardGate } from '../../src/utils/output-hard-gate.js';

const ctx: SendGuardCtx = {
  groupId: 'g1',
  triggerMessage: {
    groupId: 'g1',
    userId: 'u1',
    nickname: 'u',
    content: '',
    rawContent: '',
    messageId: 'm',
    timestamp: 0,
  } as unknown as GroupMessage,
  isDirect: false,
  resultKind: 'reply',
};

describe('buildSendGuards — PR2 chain composition (sticker + harassment order preserved)', () => {
  it('starts with [stickerLeakGuard, harassmentHardGate] in order', () => {
    const guards = buildSendGuards();
    // PR4 appends a third guard; PR2 invariant is only that the first two
    // slots are stickerLeakGuard then harassmentHardGate.
    expect(guards.length).toBeGreaterThanOrEqual(2);
    expect(guards[0]).toBe(stickerLeakGuard);
    expect(guards[1]).toBe(harassmentHardGate);
  });
});

describe('send-guard-chain + harassmentHardGate ordering', () => {
  it('sticker-only text → sticker fires, harassment never invoked', () => {
    const spy = vi.fn<SendGuard>((text) => harassmentHardGate(text, ctx));
    const r = runSendGuardChain([stickerLeakGuard, spy], '<sticker:1>', ctx);
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.reason).toBe('sticker-leak-stripped');
    expect(spy).not.toHaveBeenCalled();
  });

  it('sticker strips then harassment passes → final text is stripped', () => {
    const r = runSendGuardChain(buildSendGuards(), 'hello <sticker:1>', ctx);
    expect(r.passed).toBe(true);
    if (r.passed) expect(r.text).toBe('hello');
  });

  it('sticker passes (no token), harassment fires → reason hard-gate-blocked', () => {
    const r = runSendGuardChain(buildSendGuards(), '怡你妈', ctx);
    expect(r.passed).toBe(false);
    if (!r.passed) {
      expect(r.reason).toBe('hard-gate-blocked');
      expect(r.replacement).toBe('neutral-ack');
    }
  });

  it('both pass → clean text threads through', () => {
    const r = runSendGuardChain(buildSendGuards(), '哼', ctx);
    expect(r.passed).toBe(true);
    if (r.passed) expect(r.text).toBe('哼');
  });

  it('sticker strips residual, harassment fires on residual blocked content', () => {
    const r = runSendGuardChain(buildSendGuards(), '<sticker:1> 怡你妈', ctx);
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.reason).toBe('hard-gate-blocked');
  });

  it('ALLOWLIST 炒你妈 passes full chain', () => {
    const r = runSendGuardChain(buildSendGuards(), '炒你妈', ctx);
    expect(r.passed).toBe(true);
  });

  it('empty text passes full chain', () => {
    const r = runSendGuardChain(buildSendGuards(), '', ctx);
    expect(r.passed).toBe(true);
  });
});
