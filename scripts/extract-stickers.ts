#!/usr/bin/env tsx
/**
 * Extract custom sticker/emoji usage from chunked JSONL QQ chat exports.
 *
 * Usage:
 *   npx tsx scripts/extract-stickers.ts \
 *     --source-dir <path to export root with manifest.json and chunks/> \
 *     --target-group <group_id> \
 *     [--output data/stickers/<group_id>.jsonl]
 *
 * Handles two sticker types from the export format:
 *   - market_face: QQ market stickers (field names: emojiId, emojiPackageId, key, name)
 *   - image with sub_type===1 or gchat.qpic.cn url: user uploaded sticker images
 */

import { createReadStream } from 'node:fs';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import path from 'node:path';

// ---- Types ----

interface MarketFaceData {
  name?: string;
  key?: string;
  emojiId?: string;
  emojiPackageId?: number;
  url?: string;
}

interface ImageData {
  filename?: string;
  file?: string;
  file_unique?: string;
  md5?: string;
  url?: string;
  sub_type?: number;
}

interface Element {
  type: string;
  data?: MarketFaceData & ImageData & Record<string, unknown>;
}

interface JsonlMessage {
  id?: string;
  timestamp?: number;
  sender?: { uin?: string; name?: string };
  content?: { elements?: Element[]; text?: string };
  recalled?: boolean;
  system?: boolean;
}

export interface StickerRecord {
  key: string;
  type: 'market_face' | 'image';
  cqCode: string;
  summary: string;
  count: number;
  lastSeen: number;
  samples: string[];
}

interface StickerAccum {
  type: 'market_face' | 'image';
  cqCode: string;
  summary: string;
  count: number;
  lastSeen: number;
  samples: string[];
}

// ---- CLI arg parsing ----

function parseArgs(argv: string[]): { sourceDir: string; targetGroup: string; output: string } {
  const args = argv.slice(2);
  let sourceDir = '';
  let targetGroup = '';
  let output = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source-dir' && args[i + 1]) { sourceDir = args[++i]!; }
    else if (args[i] === '--target-group' && args[i + 1]) { targetGroup = args[++i]!; }
    else if (args[i] === '--output' && args[i + 1]) { output = args[++i]!; }
  }

  if (!sourceDir || !targetGroup) {
    console.error('Usage: extract-stickers.ts --source-dir <path> --target-group <group_id> [--output <path>]');
    process.exit(1);
  }

  if (!output) {
    output = path.join('data', 'stickers', `${targetGroup}.jsonl`);
  }

  return { sourceDir, targetGroup, output };
}

// ---- Sticker detection ----

export function isSticker(el: Element): el is Element & { type: 'market_face' | 'image' } {
  if (el.type === 'market_face') return true;
  if (el.type === 'image') {
    const d = el.data as ImageData | undefined;
    if (!d) return false;
    if (d.sub_type === 1) return true;
    if (d.url && d.url.includes('gchat.qpic.cn')) return true;
    return false;
  }
  return false;
}

export function buildStickerKey(el: Element): string | null {
  if (el.type === 'market_face') {
    const d = el.data as MarketFaceData;
    const pkgId = d?.emojiPackageId;
    const emojiId = d?.emojiId;
    if (pkgId == null || !emojiId) {
      console.warn('[WARN] market_face missing emojiId or emojiPackageId — skipping');
      return null;
    }
    return `mface:${pkgId}:${emojiId}`;
  }
  if (el.type === 'image') {
    const d = el.data as ImageData;
    if (d?.file_unique) return `image:${d.file_unique}`;
    if (d?.md5) return `image:${d.md5}`;
    if (d?.url) return `image:${createHash('md5').update(d.url).digest('hex')}`;
    console.warn('[WARN] image sticker has no identifier — skipping');
    return null;
  }
  return null;
}

export function buildCqCode(el: Element): string {
  if (el.type === 'market_face') {
    const d = el.data as MarketFaceData;
    return `[CQ:mface,emoji_id=${d?.emojiId ?? ''},emoji_package_id=${d?.emojiPackageId ?? ''},key=${d?.key ?? ''},summary=${d?.name ?? ''}]`;
  }
  if (el.type === 'image') {
    const d = el.data as ImageData;
    const fileRef = d?.file_unique ?? d?.md5 ?? d?.filename ?? d?.file ?? '';
    return `[CQ:image,file=${fileRef}]`;
  }
  return '';
}

export function buildSummary(el: Element): string {
  if (el.type === 'market_face') {
    return (el.data as MarketFaceData)?.name ?? '';
  }
  return '';
}

// ---- Context extraction ----

export function extractTextContext(elements: Element[] | undefined): string {
  if (!elements) return '';
  const parts = elements
    .filter(e => e.type === 'text')
    .map(e => (e.data as { text?: string } | undefined)?.text ?? '');
  return parts.join('').trim();
}

// ---- File streaming ----

export async function* streamFileLines(filePath: string): AsyncGenerator<string> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  yield* rl;
}

// ---- Core extraction (injectable line reader for testing) ----

export type LineReader = (filePath: string) => AsyncIterable<string>;

export async function extractStickers(
  chunkFiles: string[],
  lineReader: LineReader = streamFileLines
): Promise<Map<string, StickerAccum>> {
  const stickers = new Map<string, StickerAccum>();
  const textBuffer: string[] = [];

  for (const chunkFile of chunkFiles) {
    let lineNum = 0;
    const pendingStickerKeys: string[] = [];

    for await (const line of lineReader(chunkFile)) {
      lineNum++;
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg: JsonlMessage;
      try {
        msg = JSON.parse(trimmed) as JsonlMessage;
      } catch {
        console.warn(`[WARN] Malformed JSON at line ${lineNum} in ${path.basename(chunkFile)} — skipping`);
        continue;
      }

      const els = msg.content?.elements;
      const ts = typeof msg.timestamp === 'number' ? Math.floor(msg.timestamp / 1000) : 0;

      const currentText = extractTextContext(els);

      // Append "after" context to samples from the previous sticker message
      if (pendingStickerKeys.length > 0 && currentText) {
        for (const pk of pendingStickerKeys) {
          const accum = stickers.get(pk);
          if (accum && accum.samples.length > 0) {
            const last = accum.samples[accum.samples.length - 1]!;
            accum.samples[accum.samples.length - 1] = last ? `${last} | ${currentText}` : currentText;
          }
        }
      }
      pendingStickerKeys.length = 0;

      if (!els) {
        if (currentText) {
          textBuffer.push(currentText);
          if (textBuffer.length > 2) textBuffer.shift();
        }
        continue;
      }

      const stickerEls = els.filter(isSticker);

      for (const el of stickerEls) {
        const key = buildStickerKey(el);
        if (!key) continue;

        const existing = stickers.get(key);
        if (!existing) {
          const accum: StickerAccum = {
            type: el.type as 'market_face' | 'image',
            cqCode: buildCqCode(el),
            summary: buildSummary(el),
            count: 1,
            lastSeen: ts,
            samples: [],
          };
          const before = textBuffer.slice(-2).join(' | ');
          accum.samples.push(before);
          stickers.set(key, accum);
        } else {
          existing.count++;
          if (ts > existing.lastSeen) existing.lastSeen = ts;
          if (existing.samples.length < 3) {
            const before = textBuffer.slice(-2).join(' | ');
            existing.samples.push(before);
          }
        }

        pendingStickerKeys.push(key);
      }

      if (currentText) {
        textBuffer.push(currentText);
        if (textBuffer.length > 2) textBuffer.shift();
      }
    }
  }

  return stickers;
}

// ---- Main ----

async function main(): Promise<void> {
  const { sourceDir, targetGroup, output } = parseArgs(process.argv);

  const manifestPath = path.join(sourceDir, 'manifest.json');
  let manifestContent: string;
  try {
    manifestContent = await readFile(manifestPath, 'utf8');
  } catch {
    console.error(`[ERROR] Cannot read manifest at ${manifestPath}`);
    process.exit(1);
  }

  const manifest = JSON.parse(manifestContent) as {
    chatInfo?: { name?: string };
    statistics?: { totalMessages?: number };
  };
  console.log(`[INFO] Group: ${manifest.chatInfo?.name ?? 'unknown'}`);
  console.log(`[INFO] Total messages in manifest: ${manifest.statistics?.totalMessages ?? 'unknown'}`);

  const chunksDir = path.join(sourceDir, 'chunks');
  let chunkFiles: string[];
  try {
    const names = await readdir(chunksDir);
    chunkFiles = names
      .filter(n => n.endsWith('.jsonl'))
      .sort()
      .map(n => path.join(chunksDir, n));
  } catch {
    console.error(`[ERROR] Cannot read chunks directory at ${chunksDir}`);
    process.exit(1);
  }

  if (chunkFiles.length === 0) {
    console.error('[ERROR] No chunks found in ' + chunksDir);
    process.exit(1);
  }

  console.log(`[INFO] Found ${chunkFiles.length} chunk files`);

  const stickers = await extractStickers(chunkFiles);

  const sorted: StickerRecord[] = Array.from(stickers.entries())
    .map(([key, accum]) => ({ key, ...accum }))
    .sort((a, b) => b.count - a.count);

  console.log(`[INFO] Unique stickers: ${sorted.length}`);
  console.log('[INFO] Top 10 by count:');
  for (const s of sorted.slice(0, 10)) {
    console.log(`  [${s.count}x] ${s.key} — ${s.summary || '(image)'} — ${s.cqCode.slice(0, 60)}`);
  }

  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  const lines = sorted.map(s => JSON.stringify(s)).join('\n');
  await writeFile(output, lines, 'utf8');
  console.log(`[INFO] Written to ${output}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).includes('extract-stickers');
if (isMain) {
  main().catch(err => {
    console.error('[FATAL]', err);
    process.exit(1);
  });
}
