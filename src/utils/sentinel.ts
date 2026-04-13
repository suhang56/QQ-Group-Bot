import { createLogger } from './logger.js';

const logger = createLogger('sentinel');

// Terms that must match as whole ASCII words (case-insensitive) to avoid false positives
// on substrings (e.g. "bot" in "robot" or "ai" in Chinese characters).
const WORD_FORBIDDEN = [
  'claude', 'chatgpt', 'gpt', 'anthropic', 'openai', 'llm',
];

// Chinese/multi-char phrases that are always forbidden as substrings
const SUBSTR_FORBIDDEN = [
  '克劳德', '机器人', '助手', 'a.i.',
  'ai模型', '语言模型', '大模型',
  '我是一个', '作为一个',
  '模仿', '尝试模仿',
  '根据您', '历史发言', '不当内容', '无法提供',
  // "bot" and "ai" only as self-referential Chinese compound words
  '我是ai', '我是bot', '一个ai', '一个bot',
];

// Soft-forbidden: if reply STARTS with these, it's assistant meta-framing → regenerate.
const SOFT_FORBIDDEN_STARTS = [
  '好的，', '当然，', '我来', '让我', '这是', '以下是',
];

const WORD_RE = new RegExp(
  `\\b(${WORD_FORBIDDEN.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i'
);

export function hasForbiddenContent(text: string): string | null {
  const m = WORD_RE.exec(text);
  if (m) return m[0]!;

  const lower = text.toLowerCase();
  for (const phrase of SUBSTR_FORBIDDEN) {
    if (lower.includes(phrase.toLowerCase())) return phrase;
  }

  for (const prefix of SOFT_FORBIDDEN_STARTS) {
    if (text.startsWith(prefix)) return prefix;
  }

  return null;
}

/**
 * Run a sentinel check on a generated reply. If it contains forbidden content,
 * call `regenerate()` once. If the second attempt also fails, return '...'.
 * Logs every trigger at info level.
 */
export async function sentinelCheck(
  text: string,
  context: Record<string, unknown>,
  regenerate: () => Promise<string>,
): Promise<string> {
  const offender = hasForbiddenContent(text);
  if (!offender) return text;

  logger.info({ ...context, offendingPhrase: offender, firstAttempt: text }, 'sentinel: forbidden content detected — regenerating');

  let second: string;
  try {
    second = await regenerate();
  } catch {
    logger.info({ ...context }, 'sentinel: regeneration threw — falling back to "..."');
    return '...';
  }

  const offender2 = hasForbiddenContent(second);
  if (offender2) {
    logger.info({ ...context, offendingPhrase: offender2, secondAttempt: second }, 'sentinel: second attempt still forbidden — falling back to "..."');
    return '...';
  }

  return second;
}
