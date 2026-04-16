import { describe, it, expect } from 'vitest';
import { sampleBeta, ThompsonSampler } from '../src/services/sticker-sampler.js';
import type { StickerCandidate } from '../src/services/sticker-sampler.js';

// Deterministic RNG using a simple linear congruential generator
function makeRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

describe('sampleBeta', () => {
  it('Beta(1,1) samples are in [0,1]', () => {
    const rng = makeRng(42);
    for (let i = 0; i < 100; i++) {
      const v = sampleBeta(1, 1, rng);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('Beta(1,1) mean is approximately 0.5', () => {
    const rng = makeRng(42);
    let sum = 0;
    const N = 10000;
    for (let i = 0; i < N; i++) sum += sampleBeta(1, 1, rng);
    expect(sum / N).toBeCloseTo(0.5, 1);
  });

  it('Beta(10,1) mean is approximately 0.91', () => {
    const rng = makeRng(123);
    let sum = 0;
    const N = 10000;
    for (let i = 0; i < N; i++) sum += sampleBeta(10, 1, rng);
    expect(sum / N).toBeCloseTo(10 / 11, 1);
  });

  it('Beta(1,10) mean is approximately 0.09', () => {
    const rng = makeRng(456);
    let sum = 0;
    const N = 10000;
    for (let i = 0; i < N; i++) sum += sampleBeta(1, 10, rng);
    expect(sum / N).toBeCloseTo(1 / 11, 1);
  });
});

describe('ThompsonSampler', () => {
  function makeCandidate(
    id: number,
    key: string,
    usagePositive: number,
    usageNegative: number,
  ): StickerCandidate {
    return {
      id,
      groupId: 'g1',
      key,
      type: 'mface',
      localPath: null,
      cqCode: `[CQ:mface,key=${key}]`,
      summary: null,
      contextSamples: [],
      count: 1,
      firstSeen: 0,
      lastSeen: 0,
      usagePositive,
      usageNegative,
    };
  }

  const sampler = new ThompsonSampler();

  it('empty candidates returns empty', () => {
    expect(sampler.sample([], 10)).toEqual([]);
  });

  it('limit > candidates.length returns all candidates', () => {
    const candidates = [makeCandidate(1, 'a', 0, 0)];
    expect(sampler.sample(candidates, 10)).toHaveLength(1);
  });

  it('returns limit items when candidates exceed limit', () => {
    const candidates = Array.from({ length: 50 }, (_, i) =>
      makeCandidate(i, `k${i}`, 0, 0),
    );
    const result = sampler.sample(candidates, 20, makeRng(42));
    expect(result).toHaveLength(20);
  });

  it('high-positive candidate appears more frequently in top-1', () => {
    const candidates = [
      makeCandidate(1, 'star', 100, 0),
      ...Array.from({ length: 19 }, (_, i) =>
        makeCandidate(i + 2, `filler${i}`, 0, 0),
      ),
    ];
    const rng = makeRng(42);
    let starFirst = 0;
    for (let i = 0; i < 100; i++) {
      const result = sampler.sample(candidates, 5, rng);
      if (result[0]?.key === 'star') starFirst++;
    }
    // Star should be top-1 most of the time (>60%)
    expect(starFirst).toBeGreaterThan(60);
  });

  it('all-zero candidates produce varied results (not always same order)', () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeCandidate(i, `k${i}`, 0, 0),
    );
    const rng = makeRng(42);
    const firstKeys = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const result = sampler.sample(candidates, 5, rng);
      firstKeys.add(result[0]!.key);
    }
    // With uniform priors, should see at least 3 different first-place keys
    expect(firstKeys.size).toBeGreaterThanOrEqual(3);
  });

  it('all-negative candidates still return results (never empty)', () => {
    const candidates = [
      makeCandidate(1, 'a', 0, 50),
      makeCandidate(2, 'b', 0, 50),
    ];
    const result = sampler.sample(candidates, 2, makeRng(42));
    expect(result).toHaveLength(2);
  });

  it('same seed produces same results (deterministic)', () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      makeCandidate(i, `k${i}`, i, 20 - i),
    );
    const r1 = sampler.sample(candidates, 10, makeRng(999));
    const r2 = sampler.sample(candidates, 10, makeRng(999));
    expect(r1.map(c => c.key)).toEqual(r2.map(c => c.key));
  });

  it('with fixed rng, 10 calls on same input produce >=3 different top keys', () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      makeCandidate(i, `k${i}`, 0, 0),
    );
    const topKeys = new Set<string>();
    for (let seed = 1; seed <= 10; seed++) {
      const result = sampler.sample(candidates, 5, makeRng(seed));
      topKeys.add(result[0]!.key);
    }
    expect(topKeys.size).toBeGreaterThanOrEqual(3);
  });
});
