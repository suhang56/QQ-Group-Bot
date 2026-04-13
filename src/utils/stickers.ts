import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { IClaudeClient } from '../ai/claude.js';
import { createLogger } from './logger.js';

const logger = createLogger('stickers');

export interface StickerEntry {
  key: string;
  type: 'market_face' | 'image';
  cqCode: string;
  summary: string;
  count: number;
  lastSeen: number;
  samples: string[];
}

export interface LabeledSticker {
  label: string;
  cqCode: string;
}

// In-memory cache: groupId -> formatted section string
const sectionCache = new Map<string, string>();

/**
 * Load top-N market_face stickers for a group and build a system prompt section.
 * Labels are generated once by Claude and cached to disk.
 */
export async function buildStickerSection(
  groupId: string,
  stickersDirPath: string,
  topN: number,
  claude: IClaudeClient,
): Promise<string> {
  const cached = sectionCache.get(groupId);
  if (cached !== undefined) return cached;

  const stickersFile = path.join(stickersDirPath, `${groupId}.jsonl`);
  if (!existsSync(stickersFile)) {
    sectionCache.set(groupId, '');
    return '';
  }

  // Load sticker records (already sorted by count desc)
  const lines = readFileSync(stickersFile, 'utf8').split('\n').filter(Boolean);
  const all: StickerEntry[] = lines
    .map(l => { try { return JSON.parse(l) as StickerEntry; } catch { return null; } })
    .filter((x): x is StickerEntry => x !== null && x.type === 'market_face');

  const top = all.slice(0, topN);
  if (top.length === 0) {
    sectionCache.set(groupId, '');
    return '';
  }

  const labels = await _getOrGenerateLabels(groupId, stickersDirPath, top, claude);
  const lines2 = labels.map(({ label, cqCode }) => `- ${label} → ${cqCode}`).join('\n');
  const section = `\n这个群常用的表情包（当语境合适时直接用CQ码发送，就像群友一样）：\n${lines2}`;

  sectionCache.set(groupId, section);
  logger.info({ groupId, count: labels.length }, 'Sticker section built');
  return section;
}

/** Clear the in-memory section cache (for testing). */
export function clearStickerSectionCache(): void {
  sectionCache.clear();
}

async function _getOrGenerateLabels(
  groupId: string,
  stickersDirPath: string,
  stickers: StickerEntry[],
  claude: IClaudeClient,
): Promise<LabeledSticker[]> {
  const labelsFile = path.join(stickersDirPath, `${groupId}.labels.json`);

  // Try loading existing cache
  if (existsSync(labelsFile)) {
    try {
      const raw = JSON.parse(readFileSync(labelsFile, 'utf8')) as Record<string, string>;
      const result: LabeledSticker[] = stickers
        .filter(s => raw[s.key])
        .map(s => ({ label: raw[s.key]!, cqCode: s.cqCode }));
      if (result.length === stickers.length) {
        logger.debug({ groupId }, 'Sticker labels loaded from cache');
        return result;
      }
    } catch {
      logger.warn({ groupId }, 'Failed to parse sticker labels cache — regenerating');
    }
  }

  // Generate labels via Claude
  logger.info({ groupId, count: stickers.length }, 'Generating sticker labels via Claude');
  const labelMap: Record<string, string> = {};

  for (const s of stickers) {
    const contextHint = s.samples.filter(Boolean).slice(0, 2).join(' / ');
    const prompt = `QQ群里的一个表情包名叫"${s.summary}"，曾被用在这些对话上下文中：${contextHint || '（无上下文）'}。\n用2-4个中文字描述这个表情的情绪/用途（比如：摆烂、笑哭、生气、无奈）。只输出那几个字，不要任何标点或解释。`;
    try {
      const resp = await claude.complete({
        model: 'claude-sonnet-4-6',
        maxTokens: 20,
        system: [{ text: '你是一个简洁的标签生成器。', cache: true }],
        messages: [{ role: 'user', content: prompt }],
      });
      labelMap[s.key] = resp.text.trim().slice(0, 10);
    } catch (err) {
      logger.warn({ err, key: s.key }, 'Label generation failed for sticker — using summary');
      labelMap[s.key] = s.summary.replace(/^\[|\]$/g, '');
    }
  }

  // Save to disk
  try {
    mkdirSync(path.dirname(labelsFile), { recursive: true });
    writeFileSync(labelsFile, JSON.stringify(labelMap, null, 2), 'utf8');
    logger.info({ groupId, labelsFile }, 'Sticker labels saved to cache');
  } catch (err) {
    logger.warn({ err }, 'Failed to save sticker labels cache');
  }

  return stickers.map(s => ({ label: labelMap[s.key] ?? s.summary, cqCode: s.cqCode }));
}
