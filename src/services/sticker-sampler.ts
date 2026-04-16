/**
 * Thompson Sampling for sticker candidate selection.
 *
 * Uses Beta distribution sampling to balance exploration (new stickers)
 * vs exploitation (proven stickers). The Beta distribution is parameterized
 * by (usagePositive + 1, usageNegative + 1) so new stickers with zero
 * feedback get Beta(1,1) = Uniform(0,1), giving them a fair chance.
 */

export interface StickerCandidate {
  readonly id: number;
  readonly groupId: string;
  readonly key: string;
  readonly type: 'image' | 'mface';
  readonly localPath: string | null;
  readonly cqCode: string;
  readonly summary: string | null;
  readonly contextSamples: string[];
  readonly count: number;
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly usagePositive: number;
  readonly usageNegative: number;
}

export interface IStickerSampler {
  /**
   * Thompson Sampling: for each candidate, draw from Beta(pos+1, neg+1),
   * sort descending by sampled score, return top `limit`.
   *
   * @param rng - optional deterministic RNG for testing (returns values in [0,1))
   */
  sample(
    candidates: readonly StickerCandidate[],
    limit: number,
    rng?: () => number,
  ): StickerCandidate[];
}

/**
 * Sample from Beta(alpha, beta) using the gamma variate method.
 * gamma(a) is computed via Marsaglia & Tsang's method for a >= 1,
 * with Ahrens-Dieter shift for a < 1.
 */
export function sampleBeta(
  alpha: number,
  beta: number,
  rng: () => number = Math.random,
): number {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  if (x + y === 0) return 0.5; // degenerate case guard
  return x / (x + y);
}

// Marsaglia & Tsang's method for Gamma(a, 1) where a >= 1
function sampleGammaGe1(a: number, rng: () => number): number {
  const d = a - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      // Box-Muller for standard normal
      x = boxMullerNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleGamma(a: number, rng: () => number): number {
  if (a < 1) {
    // Ahrens-Dieter shift: Gamma(a) = Gamma(a+1) * U^(1/a)
    return sampleGammaGe1(a + 1, rng) * Math.pow(rng(), 1 / a);
  }
  return sampleGammaGe1(a, rng);
}

function boxMullerNormal(rng: () => number): number {
  let u1: number;
  let u2: number;
  do { u1 = rng(); } while (u1 === 0);
  u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export class ThompsonSampler implements IStickerSampler {
  sample(
    candidates: readonly StickerCandidate[],
    limit: number,
    rng: () => number = Math.random,
  ): StickerCandidate[] {
    if (candidates.length === 0) return [];

    const scored = candidates.map(c => ({
      candidate: c,
      score: sampleBeta(c.usagePositive + 1, c.usageNegative + 1, rng),
    }));

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map(s => s.candidate);
  }
}
