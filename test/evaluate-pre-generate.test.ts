import { describe, it, expect } from 'vitest';
import { evaluatePreGenerate, type PreGenerateContext } from '../src/modules/engagement-decision.js';

const NOW_SEC = 1_000_000;

function makeMsg(ts?: number) {
  return { messageId: 'msg-1', userId: 'u1', timestamp: ts ?? NOW_SEC * 1000 };
}

function makeCtx(overrides: Partial<PreGenerateContext> = {}): PreGenerateContext {
  return {
    groupId: 'g1',
    msg: makeMsg(),
    recentMsgs: [],
    nowSec: NOW_SEC,
    isDirect: false,
    hasKnownFactTerm: false,
    recentNegativeScore: 0,
    ...overrides,
  };
}

/** Build N messages all within the last 8 seconds */
function burstMsgs(count: number, nowSec = NOW_SEC) {
  return Array.from({ length: count }, (_, i) => ({
    messageId: `m${i}`,
    userId: 'u1',
    timestamp: (nowSec - 4) * 1000 + i, // all within last 8s
  }));
}

describe('evaluatePreGenerate', () => {
  it('isDirect=true → proceed (bypasses all rules)', () => {
    const result = evaluatePreGenerate(makeCtx({ isDirect: true, recentNegativeScore: -0.9 }));
    expect(result.action).toBe('proceed');
  });

  it('hasKnownFactTerm=true → proceed (bypasses all rules)', () => {
    const result = evaluatePreGenerate(makeCtx({ hasKnownFactTerm: true, recentNegativeScore: -0.9 }));
    expect(result.action).toBe('proceed');
  });

  it('isDirect=true AND recentNegativeScore < -0.4 → proceed (direct wins over cooldown)', () => {
    const result = evaluatePreGenerate(makeCtx({ isDirect: true, recentNegativeScore: -0.5 }));
    expect(result.action).toBe('proceed');
  });

  it('hasKnownFactTerm=true AND burstCount >= 5 → proceed (fact wins over burst)', () => {
    const result = evaluatePreGenerate(makeCtx({
      hasKnownFactTerm: true,
      recentMsgs: burstMsgs(5),
    }));
    expect(result.action).toBe('proceed');
  });

  it('recentNegativeScore = -0.5 → silent(cooldown)', () => {
    const result = evaluatePreGenerate(makeCtx({ recentNegativeScore: -0.5 }));
    expect(result.action).toBe('silent');
    expect((result as { action: 'silent'; reasonCode: string }).reasonCode).toBe('cooldown');
  });

  it('recentNegativeScore = -0.4 → NOT silenced (boundary: threshold is strictly < -0.4)', () => {
    const result = evaluatePreGenerate(makeCtx({ recentNegativeScore: -0.4 }));
    expect(result.action).toBe('proceed');
  });

  it('recentNegativeScore = -0.39 → proceed (above threshold)', () => {
    const result = evaluatePreGenerate(makeCtx({ recentNegativeScore: -0.39 }));
    expect(result.action).toBe('proceed');
  });

  it('burstCount = 5 → defer(burst-settle) (at threshold)', () => {
    const result = evaluatePreGenerate(makeCtx({ recentMsgs: burstMsgs(5) }));
    expect(result.action).toBe('defer');
    expect((result as { action: 'defer'; reasonCode: string }).reasonCode).toBe('burst-settle');
  });

  it('burstCount = 4 → proceed (below threshold)', () => {
    const result = evaluatePreGenerate(makeCtx({ recentMsgs: burstMsgs(4) }));
    expect(result.action).toBe('proceed');
  });

  it('burstCount = 10 → defer(burst-settle) (well above threshold)', () => {
    const result = evaluatePreGenerate(makeCtx({ recentMsgs: burstMsgs(10) }));
    expect(result.action).toBe('defer');
  });

  it('deadlineSec = nowSec + 8 on burst-settle', () => {
    const result = evaluatePreGenerate(makeCtx({ recentMsgs: burstMsgs(5) }));
    expect(result.action).toBe('defer');
    const defer = result as { action: 'defer'; deadlineSec: number };
    expect(defer.deadlineSec).toBe(NOW_SEC + 8);
  });

  it('cooldown checked before burst (Rule 1 fires before Rule 2)', () => {
    // Both conditions met: cooldown should win
    const result = evaluatePreGenerate(makeCtx({
      recentNegativeScore: -0.9,
      recentMsgs: burstMsgs(5),
    }));
    expect(result.action).toBe('silent');
    expect((result as { action: 'silent'; reasonCode: string }).reasonCode).toBe('cooldown');
  });

  it('empty recentMsgs → proceed (no burst)', () => {
    const result = evaluatePreGenerate(makeCtx({ recentMsgs: [] }));
    expect(result.action).toBe('proceed');
  });

  it('recentNegativeScore = 0 (no P4 data) → proceed', () => {
    const result = evaluatePreGenerate(makeCtx({ recentNegativeScore: 0 }));
    expect(result.action).toBe('proceed');
  });

  it('recentNegativeScore = -0.41 → silent(cooldown) (just below threshold)', () => {
    const result = evaluatePreGenerate(makeCtx({ recentNegativeScore: -0.41 }));
    expect(result.action).toBe('silent');
  });

  it('burst: only messages within last 8s counted (older messages ignored)', () => {
    const oldMsg = { messageId: 'old', userId: 'u1', timestamp: (NOW_SEC - 100) * 1000 };
    const recentMsgs = [...burstMsgs(4), oldMsg];
    const result = evaluatePreGenerate(makeCtx({ recentMsgs }));
    // Only 4 within 8s → no burst
    expect(result.action).toBe('proceed');
  });

  it('burst: messages at exactly nowSec - 8 seconds → included (inclusive boundary)', () => {
    const boundaryMsg = { messageId: 'boundary', userId: 'u1', timestamp: (NOW_SEC - 8) * 1000 };
    const recentMsgs = [...burstMsgs(4), boundaryMsg];
    const result = evaluatePreGenerate(makeCtx({ recentMsgs }));
    // 5 within 8s (boundary is inclusive) → burst
    expect(result.action).toBe('defer');
  });

  it('recentNegativeScore = null treated as 0 (no data) → proceed', () => {
    const result = evaluatePreGenerate(makeCtx({ recentNegativeScore: null }));
    expect(result.action).toBe('proceed');
  });
});
