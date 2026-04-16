import { existsSync } from 'node:fs';
import type { ILocalStickerRepository } from '../storage/db.js';
import type { IEmbeddingService } from '../storage/embeddings.js';
import { cosineSimilarity } from '../storage/embeddings.js';
import { createLogger } from '../utils/logger.js';
import { ThompsonSampler, type IStickerSampler } from '../services/sticker-sampler.js';

const logger = createLogger('sticker-first');

const THOMPSON_POOL_SIZE = 20;
const MIN_SCORABLE_CHARS = 6;
const SUPPRESS_TTL_MS = 30 * 60_000; // 30 minutes
const SUPPRESS_CAP = 50;
const SOFTMAX_TEMPERATURE = 0.15;
const SOFTMAX_TOP_K = 3;

export interface StickerChoice {
  key: string;
  cqCode: string;
  score: number;
}

export interface IStickerFirstModule {
  pickSticker(
    groupId: string,
    intendedText: string,
    threshold: number,
    enabled: boolean,
  ): Promise<StickerChoice | null>;
  suppressSticker(groupId: string, key: string): void;
  /** Record mface keys from bot output for rotation cooldown. */
  recordMfaceOutput(groupId: string, keys: string[]): void;
  /** Get recently used mface keys for prompt rotation filtering. */
  getRecentMfaceKeys(groupId: string): ReadonlySet<string>;
}

export class StickerFirstModule implements IStickerFirstModule {
  // Unified suppress state: per-group key -> expiresAt
  private readonly _suppress = new Map<string, Map<string, number>>();
  // Recent mface output tracking (moved from chat.ts)
  private readonly _recentMface = new Map<string, string[]>();
  private readonly sampler: IStickerSampler;

  constructor(
    private readonly repo: ILocalStickerRepository,
    private readonly embedder: IEmbeddingService,
    sampler?: IStickerSampler,
  ) {
    this.sampler = sampler ?? new ThompsonSampler();
  }

  suppressSticker(groupId: string, key: string): void {
    let group = this._suppress.get(groupId);
    if (!group) {
      group = new Map();
      this._suppress.set(groupId, group);
    }
    group.set(key, Date.now() + SUPPRESS_TTL_MS);
    if (group.size > SUPPRESS_CAP) {
      const oldest = group.keys().next().value;
      if (oldest !== undefined) group.delete(oldest);
    }
  }

  recordMfaceOutput(groupId: string, keys: string[]): void {
    if (keys.length === 0) return;
    let recent = this._recentMface.get(groupId) ?? [];
    recent = [...recent, ...keys].slice(-8);
    this._recentMface.set(groupId, recent);
    // Also suppress these keys
    for (const k of keys) this.suppressSticker(groupId, k);
  }

  getRecentMfaceKeys(groupId: string): ReadonlySet<string> {
    return new Set(this._recentMface.get(groupId) ?? []);
  }

  private _isSuppressed(groupId: string, key: string): boolean {
    const group = this._suppress.get(groupId);
    if (!group) return false;
    const exp = group.get(key);
    if (exp === undefined) return false;
    if (Date.now() >= exp) { group.delete(key); return false; }
    return true;
  }

  async pickSticker(
    groupId: string,
    intendedText: string,
    threshold: number,
    enabled: boolean,
  ): Promise<StickerChoice | null> {
    if (!enabled) return null;
    if (!this.embedder.isReady) return null;

    // Thompson sampling from full candidate pool (not top-N argmax)
    const allCandidates = this.repo.getAllCandidates(groupId);
    const sampled = this.sampler.sample(allCandidates, THOMPSON_POOL_SIZE);

    const candidates = sampled.filter(s => {
      if (!s.localPath || !existsSync(s.localPath)) return false;
      const totalText = [s.summary, ...s.contextSamples].filter(Boolean).join('');
      if (totalText.length < MIN_SCORABLE_CHARS) return false;
      if (this._isSuppressed(groupId, s.key)) return false;
      return true;
    });

    if (candidates.length === 0) return null;

    let queryVec: number[];
    try {
      queryVec = await this.embedder.embed(intendedText);
    } catch (err) {
      logger.warn({ err, groupId }, 'sticker-first: embed query failed');
      return null;
    }

    // Score all candidates by embedding similarity.
    // Try cached embedding from DB first, fall back to live computation.
    const scored: Array<{ key: string; cqCode: string; score: number }> = [];
    for (const sticker of candidates) {
      let stickerVec: number[] | null = this.repo.getEmbeddingVec(sticker.groupId, sticker.key);
      if (!stickerVec) {
        const scorableText = [sticker.summary, ...sticker.contextSamples].filter(Boolean).join(' ');
        try {
          stickerVec = await this.embedder.embed(scorableText);
          // Cache the computed embedding for future use
          this.repo.setEmbeddingVec(sticker.groupId, sticker.key, stickerVec);
        } catch (err) {
          logger.warn({ err, groupId, key: sticker.key }, 'sticker-first: embed sticker failed');
          continue;
        }
      }
      const score = cosineSimilarity(queryVec, stickerVec);
      scored.push({ key: sticker.key, cqCode: sticker.cqCode, score });
    }

    if (scored.length === 0) return null;

    // Sort descending and take top-K for softmax selection
    scored.sort((a, b) => b.score - a.score);
    const topK = scored.slice(0, SOFTMAX_TOP_K);

    // Filter: all top-K must meet threshold for any selection
    const aboveThreshold = topK.filter(s => s.score >= threshold);
    if (aboveThreshold.length === 0) return null;

    // Softmax sampling from top-K candidates above threshold
    const selected = softmaxSample(aboveThreshold, SOFTMAX_TEMPERATURE);
    return selected;
  }
}

/** Softmax temperature sampling from scored candidates. */
function softmaxSample(
  candidates: ReadonlyArray<{ key: string; cqCode: string; score: number }>,
  temperature: number,
): { key: string; cqCode: string; score: number } {
  if (candidates.length === 1) return candidates[0]!;

  // Compute softmax probabilities with temperature scaling
  const maxScore = candidates[0]!.score;
  const exps = candidates.map(c => Math.exp((c.score - maxScore) / temperature));
  const sumExp = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map(e => e / sumExp);

  // Weighted random selection
  const r = Math.random();
  let cumulative = 0;
  for (let i = 0; i < candidates.length; i++) {
    cumulative += probs[i]!;
    if (r < cumulative) return candidates[i]!;
  }
  return candidates[candidates.length - 1]!;
}
