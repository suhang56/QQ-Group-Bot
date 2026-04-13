import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { INameImageRepository, NameImage } from '../storage/db.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('name-images');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

/** Minimal adapter surface needed for image download. */
export interface IImageAdapter {
  getImage(file: string): Promise<{ filename: string; url: string; size: number; base64?: string }>;
}

/** State for an admin currently in image-collection mode. */
interface CollectionState {
  name: string;
  until: number;    // epoch ms
  count: number;    // images saved so far in this session
}

export class NameImagesModule {
  /** groupId → userId → state */
  private readonly collecting = new Map<string, Map<string, CollectionState>>();
  /** groupId → { names, expiresAt } — 60s cache */
  private readonly namesCache = new Map<string, { names: string[]; expiresAt: number }>();
  /** groupId → name → last-sent epoch ms */
  private readonly cooldownMap = new Map<string, Map<string, number>>();

  constructor(
    private readonly repo: INameImageRepository,
    private readonly namesDirPath: string,
    private readonly adapter?: IImageAdapter,
  ) {}

  // ── Collection state ──────────────────────────────────────────────────

  startCollecting(groupId: string, userId: string, name: string, timeoutMs: number): void {
    let group = this.collecting.get(groupId);
    if (!group) { group = new Map(); this.collecting.set(groupId, group); }
    group.set(userId, { name, until: Date.now() + timeoutMs, count: 0 });
    logger.debug({ groupId, userId, name, timeoutMs }, 'Collection mode started');
  }

  stopCollecting(groupId: string, userId: string): void {
    this.collecting.get(groupId)?.delete(userId);
  }

  getCollectionTarget(groupId: string, userId: string): string | null {
    const state = this.collecting.get(groupId)?.get(userId);
    if (!state) return null;
    if (Date.now() > state.until) {
      this.collecting.get(groupId)?.delete(userId);
      return null;
    }
    return state.name;
  }

  // ── Image saving ──────────────────────────────────────────────────────

  /**
   * Download an image, validate, save to disk, insert into DB.
   * `cqFile` is the `file=` field from [CQ:image,...] — used with adapter.getImage().
   * `imageUrl` is the `url=` field — used as fallback if getImage fails or is unavailable.
   * Returns the saved NameImage, 'dedup', or 'cap_reached'.
   * Throws on download failure, size limit exceeded, or non-image content.
   */
  async saveImage(
    groupId: string,
    name: string,
    imageUrl: string,
    sourceFile: string,
    addedBy: string,
    maxPerName: number,
    cqFile?: string,
  ): Promise<NameImage | 'dedup' | 'cap_reached'> {
    // Early cap check to avoid downloading if already at limit
    if (this.repo.countByName(groupId, name) >= maxPerName) return 'cap_reached';

    const buf = await this._downloadImage(cqFile ?? '', imageUrl);

    // Filename is sha256 hash only — no user-supplied name or URL in path
    const ext = _sniffExt(buf);
    const hash = createHash('sha256').update(buf).digest('hex');
    const filePath = path.join(this.namesDirPath, `${hash}${ext}`);

    mkdirSync(this.namesDirPath, { recursive: true });
    writeFileSync(filePath, buf);

    const result = this.repo.insert(groupId, name, filePath, sourceFile, addedBy, maxPerName);
    if (result === null) {
      // Orphaned file — unlink before returning to prevent disk leak
      try { unlinkSync(filePath); } catch { /* already gone — ignore */ }
      if (this.repo.countByName(groupId, name) >= maxPerName) return 'cap_reached';
      logger.debug({ groupId, name, sourceFile }, 'Dedup: image already in library');
      return 'dedup';
    }

    // Advance collection counter
    const state = this.collecting.get(groupId)?.get(addedBy);
    if (state) state.count++;

    // Invalidate names cache
    this.namesCache.delete(groupId);

    logger.info({ groupId, name, filePath }, 'Image saved');
    return result;
  }

  /**
   * Download image bytes. Strategy:
   * 1. adapter.getImage(cqFile) — NapCat action, bypasses QQ URL auth
   *    a. If base64 present → decode directly
   *    b. If url is file:// or absolute path → readFileSync
   *    c. Otherwise fetch the returned URL (NapCat-proxied, no auth issues)
   * 2. Fall back to direct URL fetch with browser-like headers
   */
  private async _downloadImage(cqFile: string, imageUrl: string): Promise<Buffer> {
    // Strategy 1: try adapter.getImage
    if (this.adapter && cqFile) {
      try {
        const meta = await this.adapter.getImage(cqFile);
        if (meta.base64) {
          const buf = Buffer.from(meta.base64, 'base64');
          if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error(`Image too large: ${buf.byteLength} bytes`);
          return buf;
        }
        // Local file path returned by NapCat
        if (meta.url.startsWith('file://') || path.isAbsolute(meta.url)) {
          const localPath = meta.url.startsWith('file://') ? meta.url.slice(7) : meta.url;
          const buf = readFileSync(localPath);
          if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error(`Image too large: ${buf.byteLength} bytes`);
          return buf;
        }
        // NapCat-proxied HTTP URL
        const buf = await _fetchImage(meta.url);
        return buf;
      } catch (err) {
        logger.warn({ err, cqFile }, 'getImage failed — falling back to direct URL fetch');
      }
    }

    // Strategy 2: direct URL fetch with browser-like headers
    logger.debug({ imageUrl }, 'Fetching image directly from URL');
    return _fetchImage(imageUrl);
  }

  // ── Name lookup ──────────────────────────────────────────────────────

  getAllNames(groupId: string): string[] {
    const cached = this.namesCache.get(groupId);
    if (cached && Date.now() < cached.expiresAt) return cached.names;
    const names = this.repo.getAllNames(groupId);
    this.namesCache.set(groupId, { names, expiresAt: Date.now() + 60_000 });
    return names;
  }

  pickRandom(groupId: string, name: string): NameImage | null {
    return this.repo.pickRandom(groupId, name);
  }

  countByName(groupId: string, name: string): number {
    return this.repo.countByName(groupId, name);
  }

  // ── Cooldown ─────────────────────────────────────────────────────────

  checkAndSetCooldown(groupId: string, name: string, cooldownMs: number): boolean {
    let group = this.cooldownMap.get(groupId);
    if (!group) { group = new Map(); this.cooldownMap.set(groupId, group); }
    const last = group.get(name) ?? 0;
    if (Date.now() - last < cooldownMs) return false;
    group.set(name, Date.now());
    return true;
  }

  // ── Longest-match name detection ─────────────────────────────────────

  findLongestMatch(text: string, names: string[]): string | null {
    const lower = text.toLowerCase();
    let best: string | null = null;
    for (const name of names) {
      if (name.length === 0) continue;
      if (lower.includes(name.toLowerCase())) {
        if (best === null || name.length > best.length) best = name;
      }
    }
    return best;
  }
}

async function _fetchImage(url: string): Promise<Buffer> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://qq.com/',
      },
    });
  } catch (err) {
    logger.error({ err, url }, 'Image fetch network error');
    throw err;
  }
  if (!resp.ok) {
    logger.error({ status: resp.status, url }, 'Image fetch HTTP error');
    throw new Error(`HTTP ${resp.status}`);
  }
  const contentType = resp.headers.get('content-type') ?? '';
  if (!contentType.startsWith('image/')) {
    throw new Error(`Non-image content-type: ${contentType}`);
  }
  const arrayBuf = await resp.arrayBuffer();
  if (arrayBuf.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image too large: ${arrayBuf.byteLength} bytes`);
  }
  return Buffer.from(arrayBuf);
}

function _sniffExt(buf: Buffer): string {
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';
  // GIF: 47 49 46
  if (buf[0] === 0x47 && buf[1] === 0x49) return '.gif';
  // WEBP: 52 49 46 46 ... 57 45 42 50
  if (buf.length >= 10 && buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 && buf[9] === 0x45) return '.webp';
  // Default JPEG
  return '.jpg';
}
