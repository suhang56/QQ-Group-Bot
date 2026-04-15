import { existsSync } from 'node:fs';
import type { ILocalStickerRepository } from '../storage/db.js';
import type { IEmbeddingService } from '../storage/embeddings.js';
import { cosineSimilarity } from '../storage/embeddings.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('sticker-first');

const STICKER_FIRST_TOP_N = 20;
const MIN_SCORABLE_CHARS = 6;
const SUPPRESS_TTL_MS = 5 * 60_000;
const SUPPRESS_CAP = 50;

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
}

export class StickerFirstModule implements IStickerFirstModule {
  // per-group cooldown map: key → expiresAt
  private readonly _suppress = new Map<string, Map<string, number>>();

  constructor(
    private readonly repo: ILocalStickerRepository,
    private readonly embedder: IEmbeddingService,
  ) {}

  suppressSticker(groupId: string, key: string): void {
    let group = this._suppress.get(groupId);
    if (!group) {
      group = new Map();
      this._suppress.set(groupId, group);
    }
    group.set(key, Date.now() + SUPPRESS_TTL_MS);
    // Evict oldest if over cap
    if (group.size > SUPPRESS_CAP) {
      const oldest = group.keys().next().value;
      if (oldest !== undefined) group.delete(oldest);
    }
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

    const candidates = this.repo.getTopByGroup(groupId, STICKER_FIRST_TOP_N).filter(s => {
      // Must have a valid localPath that exists on disk
      if (!s.localPath || !existsSync(s.localPath)) return false;
      // Must have enough scorable text
      const totalText = [s.summary, ...s.contextSamples].filter(Boolean).join('');
      if (totalText.length < MIN_SCORABLE_CHARS) return false;
      // Must not be suppressed
      if (this._isSuppressed(groupId, s.key)) return false;
      return true;
    });

    if (candidates.length === 0) return null;

    let queryVec: number[];
    try {
      queryVec = await this.embedder.embed(intendedText);
    } catch (err) {
      logger.warn({ err, groupId }, 'sticker-first: embed query failed — falling through to text');
      return null;
    }

    let best: StickerChoice | null = null;

    for (const sticker of candidates) {
      const scorableText = [sticker.summary, ...sticker.contextSamples].filter(Boolean).join(' ');
      let stickerVec: number[];
      try {
        stickerVec = await this.embedder.embed(scorableText);
      } catch (err) {
        logger.warn({ err, groupId, key: sticker.key }, 'sticker-first: embed sticker failed — skipping');
        continue;
      }
      const score = cosineSimilarity(queryVec, stickerVec);
      if (best === null || score > best.score) {
        best = { key: sticker.key, cqCode: sticker.cqCode, score };
      }
    }

    if (best === null || best.score < threshold) return null;
    return best;
  }
}
