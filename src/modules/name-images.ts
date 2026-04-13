import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { INameImageRepository, NameImage } from '../storage/db.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('name-images');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

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
   * Download an image from url, validate, save to disk, insert into DB.
   * Returns the saved NameImage, or null on dedup.
   * Throws on download failure, size limit exceeded, or non-image content.
   */
  async saveImage(
    groupId: string,
    name: string,
    imageUrl: string,
    sourceFile: string,
    addedBy: string,
    maxPerName: number,
  ): Promise<NameImage | 'dedup' | 'cap_reached'> {
    // Early cap check to avoid downloading if already at limit
    if (this.repo.countByName(groupId, name) >= maxPerName) return 'cap_reached';

    // Download
    let buf: Buffer;
    try {
      const resp = await fetch(imageUrl, { signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const contentType = resp.headers.get('content-type') ?? '';
      if (!contentType.startsWith('image/')) {
        throw new Error(`Non-image content-type: ${contentType}`);
      }
      const arrayBuf = await resp.arrayBuffer();
      if (arrayBuf.byteLength > MAX_IMAGE_BYTES) {
        throw new Error(`Image too large: ${arrayBuf.byteLength} bytes`);
      }
      buf = Buffer.from(arrayBuf);
    } catch (err) {
      logger.warn({ err, imageUrl }, 'Image download failed');
      throw err;
    }

    // Filename is sha256 hash only — no user-supplied name or URL in path
    const ext = _sniffExt(buf);
    const hash = createHash('sha256').update(buf).digest('hex');
    const filePath = path.join(this.namesDirPath, `${hash}${ext}`);

    mkdirSync(this.namesDirPath, { recursive: true });
    writeFileSync(filePath, buf);

    const result = this.repo.insert(groupId, name, filePath, sourceFile, addedBy, maxPerName);
    if (result === null) {
      // null means either dedup or cap race — check which
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

  /**
   * Find the longest name (case-insensitive) that appears as a substring
   * in `text`. Returns null if none found.
   */
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

function _sniffExt(buf: Buffer): string {
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';
  // GIF: 47 49 46
  if (buf[0] === 0x47 && buf[1] === 0x49) return '.gif';
  // WEBP: 52 49 46 46 ... 57 45 42 50
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 && buf[9] === 0x45) return '.webp';
  // Default JPEG
  return '.jpg';
}
