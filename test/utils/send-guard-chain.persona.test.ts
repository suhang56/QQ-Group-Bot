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
import { personaFabricationGuard } from '../../src/utils/persona-fabrication-guard.js';

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

describe('buildSendGuards — PR4 chain composition', () => {
  it('returns [stickerLeakGuard, harassmentHardGate, personaFabricationGuard] in exact order', () => {
    const guards = buildSendGuards();
    expect(guards.length).toBe(3);
    expect(guards[0]).toBe(stickerLeakGuard);
    expect(guards[1]).toBe(harassmentHardGate);
    expect(guards[2]).toBe(personaFabricationGuard);
  });
});

describe('send-guard-chain + personaFabricationGuard ordering (short-circuit)', () => {
  it('sticker fail short-circuits → persona spy NOT called', () => {
    const personaSpy = vi.fn<SendGuard>((text) => personaFabricationGuard(text, ctx));
    const harassSpy = vi.fn<SendGuard>((text) => harassmentHardGate(text, ctx));
    const r = runSendGuardChain([stickerLeakGuard, harassSpy, personaSpy], '<sticker:5>', ctx);
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.reason).toBe('sticker-leak-stripped');
    expect(harassSpy).not.toHaveBeenCalled();
    expect(personaSpy).not.toHaveBeenCalled();
  });

  it('sticker pass + harassment fail short-circuits → persona spy NOT called', () => {
    const personaSpy = vi.fn<SendGuard>((text) => personaFabricationGuard(text, ctx));
    const r = runSendGuardChain([stickerLeakGuard, harassmentHardGate, personaSpy], '你傻逼', ctx);
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.reason).toBe('hard-gate-blocked');
    expect(personaSpy).not.toHaveBeenCalled();
  });

  it('sticker pass + harassment pass + persona fail → persona-fabricated, replacement:deflection', () => {
    const r = runSendGuardChain(buildSendGuards(), '我22岁', ctx);
    expect(r.passed).toBe(false);
    if (!r.passed) {
      expect(r.reason).toBe('persona-fabricated');
      expect(r.replacement).toBe('deflection');
    }
  });

  it('all pass → clean text threads through unchanged', () => {
    const r = runSendGuardChain(buildSendGuards(), '今天天气不错', ctx);
    expect(r.passed).toBe(true);
    if (r.passed) expect(r.text).toBe('今天天气不错');
  });

  it('3rd-person reply passes chain (她22岁 — R3 fact-retrieval territory)', () => {
    const r = runSendGuardChain(buildSendGuards(), '她22岁', ctx);
    expect(r.passed).toBe(true);
  });

  it('tsundere deflection passes chain (自己猜)', () => {
    const r = runSendGuardChain(buildSendGuards(), '自己猜', ctx);
    expect(r.passed).toBe(true);
  });
});
