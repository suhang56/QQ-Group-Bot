import type { INapCatAdapter } from '../adapter/napcat.js';
import type { IForwardCacheRepository } from '../storage/db.js';
import type { Logger } from 'pino';

const FORWARD_RE = /\[CQ:forward,id=([^\],]+)[^\]]*\]/g;
const IMAGE_KEY_RE = /\[CQ:image,[^\]]*\bfile=([^\],]+)/g;
const FORWARD_RATE_LIMIT_PER_HOUR = 30;
const CACHE_TTL_SEC = 24 * 3600;

/** Extract all [CQ:image file=X] keys from a text string. */
export function extractImageKeys(raw: string): string[] {
  const keys: string[] = [];
  let m: RegExpExecArray | null;
  IMAGE_KEY_RE.lastIndex = 0;
  while ((m = IMAGE_KEY_RE.exec(raw)) !== null) {
    keys.push(m[1]!.trim());
  }
  return keys;
}

/** Rate-limit tracker: groupId → { hour, count } */
const rateCounts = new Map<string, { hour: number; count: number }>();

function checkRateLimit(groupId: string): boolean {
  const hour = Math.floor(Date.now() / 3_600_000);
  const entry = rateCounts.get(groupId);
  if (!entry || entry.hour !== hour) {
    rateCounts.set(groupId, { hour, count: 1 });
    return true;
  }
  if (entry.count >= FORWARD_RATE_LIMIT_PER_HOUR) return false;
  entry.count++;
  return true;
}

/**
 * Expand all [CQ:forward,id=X] blocks in rawContent.
 * Cache-first: hits return stored expansion without adapter call.
 * Recursion up to maxDepth; deeper nesting shows [转发过深，省略].
 */
export async function expandForwards(
  rawContent: string,
  adapter: INapCatAdapter,
  cache: IForwardCacheRepository,
  groupId: string,
  logger: Logger,
  maxDepth = 2,
  _currentDepth = 0,
): Promise<string> {
  if (!rawContent.includes('[CQ:forward,')) return rawContent;

  let result = rawContent;
  const matches = [...rawContent.matchAll(FORWARD_RE)];
  if (matches.length === 0) return rawContent;

  for (const match of matches) {
    const full = match[0]!;
    const forwardId = match[1]!.trim();

    let expandedBlock: string;
    try {
      expandedBlock = await _expandOne(forwardId, adapter, cache, groupId, logger, maxDepth, _currentDepth);
    } catch (err) {
      logger.warn({ err, forwardId }, 'forward expand failed — using fallback');
      expandedBlock = '[转发: (无法读取)]';
    }
    result = result.replace(full, expandedBlock);
  }
  return result;
}

async function _expandOne(
  forwardId: string,
  adapter: INapCatAdapter,
  cache: IForwardCacheRepository,
  groupId: string,
  logger: Logger,
  maxDepth: number,
  currentDepth: number,
): Promise<string> {
  if (currentDepth >= maxDepth) return '[转发过深，省略]';

  // Cache lookup
  const now = Math.floor(Date.now() / 1000);
  const cached = cache.get(forwardId);
  if (cached) return cached.expandedText;

  // Rate limit
  if (!checkRateLimit(groupId)) {
    logger.warn({ groupId, forwardId }, 'forward expand rate limit exceeded');
    return '[转发: (超出频率限制)]';
  }

  const messages = await adapter.getForwardMessages(forwardId);
  if (messages.length === 0) {
    const empty = '[空转发]';
    cache.put(forwardId, empty, [], now);
    return empty;
  }

  const imageKeys: string[] = [];
  const lines: string[] = [];

  for (const m of messages) {
    // Recursively expand nested forwards
    const expandedRaw = await expandForwards(
      m.rawContent, adapter, cache, groupId, logger, maxDepth, currentDepth + 1,
    );
    const text = m.content || expandedRaw.replace(/\[CQ:[^\]]+\]/g, '').trim();
    const imgKeys = extractImageKeys(m.rawContent);
    imageKeys.push(...imgKeys);
    const imgNote = imgKeys.length > 0 ? ` [图片×${imgKeys.length}]` : '';
    lines.push(`${m.senderNickname}: ${text}${imgNote}`);
  }

  const expanded = `[转发开始 (${messages.length} 条)]\n${lines.join('\n')}\n[转发结束]`;
  cache.put(forwardId, expanded, imageKeys, now);
  return expanded;
}

/** Purge cache entries older than 24h. Call hourly. */
export function purgeExpiredForwardCache(cache: IForwardCacheRepository): number {
  const cutoff = Math.floor(Date.now() / 1000) - CACHE_TTL_SEC;
  return cache.deleteExpired(cutoff);
}
