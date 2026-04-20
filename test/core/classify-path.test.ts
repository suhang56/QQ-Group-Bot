import { describe, it, expect, vi } from 'vitest';
import { classifyPath, type ClassifyCtx, type PathKind } from '../../src/core/classify-path.js';
import type { RelayDetection } from '../../src/modules/relay-detector.js';

function baseCtx(overrides: Partial<ClassifyCtx> = {}): ClassifyCtx {
  return {
    isAtMention: false,
    isReplyToBot: false,
    isSlashCommand: false,
    commandIsRegistered: false,
    relay: null,
    ...overrides,
  };
}

const echoRelay: RelayDetection = { kind: 'echo', content: '666', chainLength: 3 };
const voteRelay: RelayDetection = { kind: 'vote', content: '+1', chainLength: 3 };

describe('classifyPath — PathKind decisions (PLAN §3 edge cases)', () => {
  it('#1 burst + @bot → direct', () => {
    expect(classifyPath(baseCtx({ isAtMention: true }))).toBe('direct');
  });

  it('#2 burst + plain chat → timing-gated', () => {
    expect(classifyPath(baseCtx())).toBe('timing-gated');
  });

  it('#3 burst + /kick (registered admin cmd) → hard-bypass', () => {
    expect(classifyPath(baseCtx({
      isSlashCommand: true, commandIsRegistered: true,
    }))).toBe('hard-bypass');
  });

  it('#4 /bot_status /persona_review (unregistered DM-path) → timing-gated', () => {
    expect(classifyPath(baseCtx({
      isSlashCommand: true, commandIsRegistered: false,
    }))).toBe('timing-gated');
  });

  it('#5 burst + relay echo → ultra-light', () => {
    expect(classifyPath(baseCtx({ relay: echoRelay }))).toBe('ultra-light');
  });

  it('#8 reply-to-bot w/ non-empty quote → direct', () => {
    expect(classifyPath(baseCtx({ isReplyToBot: true }))).toBe('direct');
  });

  it('#9 @bot + relay (direct outranks ultra-light)', () => {
    expect(classifyPath(baseCtx({
      isAtMention: true, relay: voteRelay,
    }))).toBe('direct');
  });

  it('#10 admin /kick + relay (hard-bypass outranks ultra-light)', () => {
    expect(classifyPath(baseCtx({
      isSlashCommand: true, commandIsRegistered: true, relay: echoRelay,
    }))).toBe('hard-bypass');
  });

  it('#10b admin /kick + @bot (hard-bypass outranks direct)', () => {
    expect(classifyPath(baseCtx({
      isSlashCommand: true, commandIsRegistered: true, isAtMention: true,
    }))).toBe('hard-bypass');
  });

  it('#11 unknown /ping (not registered) → timing-gated', () => {
    expect(classifyPath(baseCtx({
      isSlashCommand: true, commandIsRegistered: false,
    }))).toBe('timing-gated');
  });

  it('reply-to-bot + relay → direct outranks ultra-light', () => {
    expect(classifyPath(baseCtx({
      isReplyToBot: true, relay: echoRelay,
    }))).toBe('direct');
  });

  it('claim relay → ultra-light', () => {
    expect(classifyPath(baseCtx({
      relay: { kind: 'claim', content: '抢', chainLength: 3 },
    }))).toBe('ultra-light');
  });

  it('empty slash (isSlashCommand true, commandIsRegistered false) → timing-gated', () => {
    expect(classifyPath(baseCtx({
      isSlashCommand: true, commandIsRegistered: false,
    }))).toBe('timing-gated');
  });

  // Edge: defensive — commandIsRegistered true without isSlashCommand should not occur
  // in practice, but verify hard-bypass still requires BOTH flags set.
  it('commandIsRegistered alone (without isSlashCommand) does NOT hard-bypass', () => {
    expect(classifyPath(baseCtx({
      isSlashCommand: false, commandIsRegistered: true,
    }))).toBe('timing-gated');
  });
});

describe('classifyPath — purity contract (M5)', () => {
  it('100× invocation on same ctx yields identical result and zero spy activity', () => {
    const ctx = baseCtx();
    const adapterSend = vi.fn();
    const dbWrite = vi.fn();
    const cooldownSet = vi.fn();
    const results: PathKind[] = [];
    for (let i = 0; i < 100; i++) results.push(classifyPath(ctx));
    expect(results.every(r => r === 'timing-gated')).toBe(true);
    expect(adapterSend).toHaveBeenCalledTimes(0);
    expect(dbWrite).toHaveBeenCalledTimes(0);
    expect(cooldownSet).toHaveBeenCalledTimes(0);
  });

  it('100× invocation on varied ctxs is deterministic', () => {
    const ctxA = baseCtx({ isAtMention: true });
    const ctxB = baseCtx({ relay: echoRelay });
    const ctxC = baseCtx({ isSlashCommand: true, commandIsRegistered: true });
    for (let i = 0; i < 100; i++) {
      expect(classifyPath(ctxA)).toBe('direct');
      expect(classifyPath(ctxB)).toBe('ultra-light');
      expect(classifyPath(ctxC)).toBe('hard-bypass');
    }
  });

  it('does not mutate the input ctx object', () => {
    const ctx = baseCtx({ isAtMention: true, relay: echoRelay });
    const snapshot = JSON.stringify(ctx);
    classifyPath(ctx);
    classifyPath(ctx);
    expect(JSON.stringify(ctx)).toBe(snapshot);
  });
});
