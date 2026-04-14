import { createHash } from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import { VISION_MODEL } from '../config.js';
import type { IClaudeClient, ClaudeModel } from '../ai/claude.js';
import type { INapCatAdapter } from '../adapter/napcat.js';
import type { IImageDescriptionRepository } from '../storage/db.js';

const logger = createLogger('vision');

// Matches [CQ:image,...] and extracts the file param
const IMAGE_CQ_RE = /\[CQ:image,[^\]]*\bfile=([^,\]]+)/;

export interface VisionOptions {
  enabled?: boolean;
  model?: ClaudeModel;
  rateLimitMs?: number;
  cacheDays?: number;
}

export class VisionService {
  private readonly enabled: boolean;
  private readonly model: ClaudeModel;
  private readonly rateLimitMs: number;
  private readonly cacheDays: number;
  // per-group last vision call timestamp
  private readonly lastCall = new Map<string, number>();

  constructor(
    private readonly claude: IClaudeClient,
    private readonly adapter: INapCatAdapter,
    private readonly repo: IImageDescriptionRepository,
    opts: VisionOptions = {},
  ) {
    this.enabled = opts.enabled ?? true;
    this.model = opts.model ?? VISION_MODEL;
    this.rateLimitMs = opts.rateLimitMs ?? 10_000;
    this.cacheDays = opts.cacheDays ?? 30;
  }

  /**
   * If rawContent contains a [CQ:image,...], attempt to describe the image.
   * Returns a string like "[图片: DESC]" to prepend to content, or "" if skipped.
   */
  async describeFromMessage(groupId: string, rawContent: string, senderUserId: string, botUserId: string): Promise<string> {
    if (!this.enabled) return '';

    // Skip bot's own images
    if (senderUserId === botUserId) return '';

    const m = IMAGE_CQ_RE.exec(rawContent);
    if (!m) return '';
    const fileToken = m[1]!;

    // Cache key: sha256 of the file token (stable identifier from QQ)
    const fileKey = createHash('sha256').update(fileToken).digest('hex');

    // Check description cache first
    const cached = this.repo.get(fileKey);
    if (cached) {
      logger.debug({ groupId, fileKey }, 'image description cache hit');
      return `[图片: ${cached}]`;
    }

    // Rate limit check
    const now = Date.now();
    const lastTs = this.lastCall.get(groupId) ?? 0;
    if (now - lastTs < this.rateLimitMs) {
      logger.warn({ groupId, rateLimitMs: this.rateLimitMs }, 'vision rate limited — skipping image description');
      return '';
    }
    this.lastCall.set(groupId, now);

    // Fetch image bytes via adapter
    let imageBytes: Buffer;
    try {
      const imageInfo = await this.adapter.getImage(fileToken);
      if (!imageInfo.base64 && !imageInfo.url) {
        logger.warn({ groupId, fileToken }, 'getImage returned no base64 or url');
        return '';
      }
      if (imageInfo.base64) {
        imageBytes = Buffer.from(imageInfo.base64, 'base64');
      } else {
        // Fetch from URL
        const resp = await fetch(imageInfo.url);
        if (!resp.ok) {
          logger.warn({ groupId, url: imageInfo.url, status: resp.status }, 'image fetch failed');
          return '';
        }
        imageBytes = Buffer.from(await resp.arrayBuffer());
      }
    } catch (err) {
      logger.warn({ err, groupId, fileToken }, 'failed to fetch image — skipping description');
      return '';
    }

    // Describe via Claude vision
    let description: string;
    try {
      description = await this.claude.describeImage(imageBytes, this.model);
    } catch (err) {
      logger.warn({ err, groupId }, 'vision Claude call failed — skipping description');
      return '';
    }

    // Cache result
    const createdAt = Math.floor(now / 1000);
    this.repo.set(fileKey, description, createdAt);

    // Async purge stale entries (don't block)
    const cutoffDays = this.cacheDays * 86_400;
    void Promise.resolve().then(() => {
      const purged = this.repo.purgeOlderThan(createdAt - cutoffDays);
      if (purged > 0) logger.debug({ purged }, 'purged stale image descriptions');
    });

    logger.debug({ groupId, fileKey, description }, 'image described');
    return `[图片: ${description}]`;
  }

  /**
   * Check whether an image (identified by CQ file token) contains a PRC ID card number.
   * Returns the number string if found, null otherwise. Fail-safe: throws on API error.
   */
  async checkIdCard(fileToken: string): Promise<string | null> {
    let imageBytes: Buffer;
    try {
      const imageInfo = await this.adapter.getImage(fileToken);
      if (imageInfo.base64) {
        imageBytes = Buffer.from(imageInfo.base64, 'base64');
      } else if (imageInfo.url) {
        const resp = await fetch(imageInfo.url);
        if (!resp.ok) throw new Error(`image fetch failed: ${resp.status}`);
        imageBytes = Buffer.from(await resp.arrayBuffer());
      } else {
        return null;
      }
    } catch (err) {
      logger.warn({ err, fileToken }, 'checkIdCard: image fetch failed');
      throw err;
    }

    const idCardPrompt = 'Does this image contain a PRC resident ID card number (18 or 15 digits)? Reply with JSON only: {"found":true,"number":"<the number>"} or {"found":false,"number":null}. Numbers in memes or decorative text still count. No other text.';
    let raw: string;
    try {
      raw = await this.claude.visionWithPrompt(imageBytes, this.model, idCardPrompt, 100);
    } catch (err) {
      logger.warn({ err }, 'checkIdCard: Claude call failed');
      throw err;
    }

    try {
      const parsed = JSON.parse(raw.trim()) as { found: boolean; number: string | null };
      return parsed.found ? (parsed.number ?? 'unknown') : null;
    } catch {
      // Claude didn't return valid JSON — treat as no-find
      logger.debug({ raw }, 'checkIdCard: JSON parse failed, treating as not found');
      return null;
    }
  }

  /** Extract the file token from a rawContent string (exposed for testing). */
  static extractFileToken(rawContent: string): string | null {
    const m = IMAGE_CQ_RE.exec(rawContent);
    return m ? m[1]! : null;
  }

  /** Compute the cache key for a file token (exposed for testing). */
  static fileKey(fileToken: string): string {
    return createHash('sha256').update(fileToken).digest('hex');
  }
}
