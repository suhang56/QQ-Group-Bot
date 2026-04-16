import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tokenizeLore } from './chat.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('lore-retrieval');

export interface LoreChunk {
  chunkIndex: number;
  summary: string;
}

const IDENTITY_CORE_CAP = 800;
const TOTAL_CAP = 8000;

/**
 * Parse chunks.jsonl and build alias -> chunkIndex[] map.
 * Extracts aliases from:
 *   1. ### headings: names, parenthesized aliases, slash-separated variants
 *   2. | **bold** | table entries: meme/slang terms, slash-separated variants
 * Single-character tokens are excluded.
 */
export function buildAliasMap(chunksPath: string): Map<string, number[]> {
  const aliasMap = new Map<string, number[]>();

  let raw: string;
  try {
    raw = readFileSync(chunksPath, 'utf8');
  } catch {
    logger.warn({ chunksPath }, 'Failed to read chunks.jsonl');
    return aliasMap;
  }

  const lines = raw.split('\n').filter(l => l.trim());
  for (const line of lines) {
    let chunk: LoreChunk;
    try {
      chunk = JSON.parse(line) as LoreChunk;
    } catch {
      continue;
    }

    const { chunkIndex, summary } = chunk;
    const aliases = new Set<string>();

    // 1. Extract from ### headings
    const headingMatches = summary.matchAll(/###\s*[^\n]*/g);
    for (const hm of headingMatches) {
      const heading = hm[0];
      // Strip emoji prefixes and ### marker
      const cleaned = heading
        .replace(/^###\s*/, '')
        .replace(/[\p{Emoji_Presentation}\p{Emoji}\uFE0F\u200D]+/gu, '')
        .trim();

      if (!cleaned) continue;

      // Extract parenthesized aliases: name（alias1 / alias2）or name (alias1 / alias2)
      const parenMatch = cleaned.match(/[（(]([^）)]+)[）)]/);
      if (parenMatch) {
        const parenContent = parenMatch[1];
        // Split on / and extract each alias
        for (const part of parenContent.split('/')) {
          const alias = part.trim().toLowerCase();
          if (alias.length >= 2) aliases.add(alias);
        }
      }

      // Extract the main name (before parentheses)
      let mainName = cleaned.replace(/[（(][^）)]*[）)]/, '').trim();
      // Strip common prefixes like [CA], [TX], [NB], [Québec], etc.
      mainName = mainName.replace(/^\[[^\]]*\]\s*/, '').trim();
      // Also strip leading number/dot (e.g. "1. 吃什么")
      mainName = mainName.replace(/^\d+\.\s*/, '').trim();

      // Handle slash-separated names: 飞鸟/飝鳥
      if (mainName.includes('/')) {
        for (const part of mainName.split('/')) {
          const alias = part.trim().toLowerCase();
          if (alias.length >= 2) aliases.add(alias);
        }
      } else if (mainName.length >= 2) {
        aliases.add(mainName.toLowerCase());
      }
    }

    // 2. Extract from | **bold** | table entries
    const tableMatches = summary.matchAll(/\|\s*\*\*([^*]+)\*\*\s*\|/g);
    for (const tm of tableMatches) {
      const entry = tm[1].trim();
      // Skip field labels like 说话风格, 身份线索, 关系, etc.
      if (/^(说话风格|身份线索|关系|人物特质|与他人关系|风格|行为特征)$/.test(entry)) continue;

      // Split on / for slash-separated clusters
      for (const part of entry.split('/')) {
        const alias = part.trim().toLowerCase();
        if (alias.length >= 2) aliases.add(alias);
      }
    }

    // Register all aliases for this chunk
    for (const alias of aliases) {
      const existing = aliasMap.get(alias);
      if (existing) {
        if (!existing.includes(chunkIndex)) {
          existing.push(chunkIndex);
        }
      } else {
        aliasMap.set(alias, [chunkIndex]);
      }
    }
  }

  logger.debug({ chunksPath, aliasCount: aliasMap.size }, 'Alias map built');
  return aliasMap;
}

/**
 * Extract entity chunk indices from a query message + context messages.
 * Uses the alias map for matching with short-token guard:
 *   - 2-3 char tokens: exact match only (must be a key in aliasMap)
 *   - 4+ char tokens: substring containment within alias keys
 */
export function extractEntities(
  query: string,
  contextMessages: { nickname: string; content: string }[],
  aliasMap: Map<string, number[]>,
): Set<number> {
  const matchedChunks = new Set<number>();

  // Collect all text to tokenize
  const allText = [
    query,
    ...contextMessages.map(m => `${m.nickname} ${m.content}`),
  ].join(' ');

  // Tokenize using the same function used for lore keywords
  const tokens = tokenizeLore(allText);

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.length < 2) continue;

    if (lower.length <= 3) {
      // Short token: exact match only
      const indices = aliasMap.get(lower);
      if (indices) {
        for (const idx of indices) matchedChunks.add(idx);
      }
    } else {
      // 4+ chars: first try exact match, then substring containment
      const exactIndices = aliasMap.get(lower);
      if (exactIndices) {
        for (const idx of exactIndices) matchedChunks.add(idx);
      } else {
        // Substring match: check if any alias contains this token or vice versa
        for (const [alias, indices] of aliasMap) {
          if (alias.includes(lower) || lower.includes(alias)) {
            for (const idx of indices) matchedChunks.add(idx);
          }
        }
      }
    }
  }

  return matchedChunks;
}

/**
 * Build the filtered lore payload for injection into the system prompt.
 * Always includes the identity core. Adds matched chunks in document order up to TOTAL_CAP.
 */
export function buildLorePayload(
  groupId: string,
  matchedChunkIndices: Set<number>,
  loreDirPath: string,
): string | null {
  // 1. Load identity core
  const identityCore = loadIdentityCore(groupId, loreDirPath);
  if (!identityCore) return null;

  // If no chunks matched, return identity core only
  if (matchedChunkIndices.size === 0) {
    logger.info({ groupId, matchedChunks: [], totalChars: identityCore.length, fallbackUsed: true },
      'Lore payload: identity core only (no entity match)');
    return identityCore;
  }

  // 2. Load chunks and assemble payload
  const chunksPath = path.join(loreDirPath, `${groupId}.md.chunks.jsonl`);
  let raw: string;
  try {
    raw = readFileSync(chunksPath, 'utf8');
  } catch {
    logger.warn({ groupId, chunksPath }, 'Failed to read chunks.jsonl for payload assembly');
    return identityCore;
  }

  const lines = raw.split('\n').filter(l => l.trim());
  const chunks: LoreChunk[] = [];
  for (const line of lines) {
    try {
      chunks.push(JSON.parse(line) as LoreChunk);
    } catch { /* skip malformed */ }
  }

  // Sort matched chunks by document order (chunkIndex ascending)
  const sortedIndices = [...matchedChunkIndices].sort((a, b) => a - b);

  const SEPARATOR = '\n\n';
  const parts: string[] = [identityCore];
  let totalLen = identityCore.length;

  const injectedChunks: number[] = [];
  for (const idx of sortedIndices) {
    if (totalLen >= TOTAL_CAP) break;
    const chunk = chunks.find(c => c.chunkIndex === idx);
    if (!chunk) continue;

    // Account for separator between parts
    const separatorCost = SEPARATOR.length;
    const remaining = TOTAL_CAP - totalLen - separatorCost;
    if (remaining <= 0) break;

    let content = chunk.summary;
    if (content.length > remaining) {
      content = content.slice(0, remaining);
    }
    parts.push(content);
    totalLen += separatorCost + content.length;
    injectedChunks.push(idx);
  }

  logger.debug({ groupId, matchedChunks: injectedChunks, totalChars: totalLen, fallbackUsed: false },
    'Lore payload assembled with entity-filtered chunks');

  return parts.join(SEPARATOR);
}

/**
 * Load the identity core for a group.
 * Tries {groupId}_identity_core.md first, falls back to first 800 chars of chunk 0.
 */
function loadIdentityCore(groupId: string, loreDirPath: string): string | null {
  // Try dedicated identity core file
  const corePath = path.join(loreDirPath, `${groupId}_identity_core.md`);
  if (existsSync(corePath)) {
    try {
      let content = readFileSync(corePath, 'utf8').trim();
      if (content.length > IDENTITY_CORE_CAP) {
        content = content.slice(0, IDENTITY_CORE_CAP);
      }
      return content;
    } catch { /* fall through */ }
  }

  // Fallback: extract from chunk 0
  const chunksPath = path.join(loreDirPath, `${groupId}.md.chunks.jsonl`);
  if (!existsSync(chunksPath)) return null;

  try {
    const raw = readFileSync(chunksPath, 'utf8');
    const firstLine = raw.split('\n')[0];
    if (!firstLine) return null;
    const chunk = JSON.parse(firstLine) as LoreChunk;
    return chunk.summary.slice(0, IDENTITY_CORE_CAP);
  } catch {
    return null;
  }
}
