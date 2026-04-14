import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { INapCatAdapter } from '../adapter/napcat.js';
import type { ILocalStickerRepository } from '../storage/db.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('sticker-capture');

export interface StickerCaptureOptions {
  localDir?: string;
  maxContextSamples?: number;
  downloadRateLimitMs?: number;
}

export class StickerCaptureService {
  private readonly localDir: string;
  private readonly maxContextSamples: number;
  private readonly downloadRateLimitMs: number;
  // groupId → last download timestamp
  private readonly lastDownload = new Map<string, number>();

  constructor(
    private readonly repo: ILocalStickerRepository,
    private readonly adapter: INapCatAdapter,
    options: StickerCaptureOptions = {},
  ) {
    this.localDir = options.localDir ?? path.join(process.cwd(), 'data', 'stickers-local');
    this.maxContextSamples = options.maxContextSamples ?? 3;
    this.downloadRateLimitMs = options.downloadRateLimitMs ?? 10_000;
  }

  /** Extract up to 2 recent text context strings from preceding messages. */
  static buildContextSample(recentTexts: string[]): string | null {
    const texts = recentTexts.filter(t => t.trim().length > 0).slice(0, 2);
    return texts.length > 0 ? texts.join(' / ') : null;
  }

  /** Extract image sticker file token from rawContent (sub_type=1 only). */
  static extractImageStickerFile(rawContent: string): string | null {
    for (const match of rawContent.matchAll(/\[CQ:image,([^\]]+)\]/g)) {
      const attrs = Object.fromEntries(
        match[1]!.split(',').map(p => { const [k, ...v] = p.split('='); return [k, v.join('=')] as [string, string]; })
      );
      if (attrs['sub_type'] === '1' && (attrs['file'] || attrs['url'])) {
        return attrs['file'] ?? null;
      }
    }
    return null;
  }

  /** Extract mface CQ codes from rawContent. Returns array of { key, cqCode, summary }. */
  static extractMfaces(rawContent: string): Array<{ key: string; cqCode: string; summary: string | null }> {
    const results: Array<{ key: string; cqCode: string; summary: string | null }> = [];
    for (const match of rawContent.matchAll(/\[CQ:mface,([^\]]+)\]/g)) {
      const attrs = Object.fromEntries(
        match[1]!.split(',').map(p => { const [k, ...v] = p.split('='); return [k, v.join('=')] as [string, string]; })
      );
      const pkg = attrs['package_id'] ?? attrs['pkg'] ?? '';
      const id = attrs['emoji_id'] ?? attrs['id'] ?? '';
      if (!pkg || !id) continue;
      results.push({
        key: `mface:${pkg}:${id}`,
        cqCode: match[0]!,
        summary: attrs['summary'] ?? attrs['text'] ?? null,
      });
    }
    return results;
  }

  async captureFromMessage(
    groupId: string,
    rawContent: string,
    contextSample: string | null,
    senderUserId: string,
    botUserId: string,
  ): Promise<void> {
    if (senderUserId === botUserId) return;

    // Capture mfaces (stable CQ code, no download needed)
    for (const mf of StickerCaptureService.extractMfaces(rawContent)) {
      this.repo.upsert(
        groupId, mf.key, 'mface', null, mf.cqCode,
        mf.summary, contextSample, Math.floor(Date.now() / 1000), this.maxContextSamples,
      );
    }

    // Capture image stickers (sub_type=1): download and save locally
    const fileToken = StickerCaptureService.extractImageStickerFile(rawContent);
    if (!fileToken) return;

    // Rate limit per group
    const now = Date.now();
    const last = this.lastDownload.get(groupId) ?? 0;
    if (now - last < this.downloadRateLimitMs) {
      logger.debug({ groupId }, 'sticker download rate limited — skipping');
      return;
    }
    this.lastDownload.set(groupId, now);

    try {
      const imgInfo = await this.adapter.getImage(fileToken);
      if (!imgInfo.url && !imgInfo.base64) return;

      let imageBytes: Buffer;
      if (imgInfo.base64) {
        imageBytes = Buffer.from(imgInfo.base64, 'base64');
      } else {
        const resp = await fetch(imgInfo.url);
        if (!resp.ok) return;
        imageBytes = Buffer.from(await resp.arrayBuffer());
      }

      const hash = createHash('sha256').update(imageBytes).digest('hex').slice(0, 16);
      const ext = imgInfo.filename?.match(/\.(jpe?g|png|gif|webp)$/i)?.[1] ?? 'jpg';
      const groupDir = path.join(this.localDir, groupId);
      const filePath = path.join(groupDir, `${hash}.${ext}`);
      const cqCode = `[CQ:image,file=file:///${filePath.replace(/\\/g, '/')}]`;
      const nowSec = Math.floor(Date.now() / 1000);

      const result = this.repo.upsert(
        groupId, hash, 'image', filePath, cqCode,
        null, contextSample, nowSec, this.maxContextSamples,
      );

      if (result === 'inserted') {
        mkdirSync(groupDir, { recursive: true });
        writeFileSync(filePath, imageBytes);
        logger.info({ groupId, hash, filePath }, 'new image sticker saved');
      }
    } catch (err) {
      logger.warn({ err, groupId }, 'failed to capture image sticker');
    }
  }
}
