import { createLogger } from './logger.js';

const logger = createLogger('sentinel');

// Terms that must match as whole ASCII words (case-insensitive)
const WORD_FORBIDDEN = [
  'claude', 'chatgpt', 'gpt', 'anthropic', 'openai', 'llm',
];

// Chinese/multi-char phrases always forbidden as substrings
const SUBSTR_FORBIDDEN = [
  '克劳德', '机器人', '助手', 'a.i.',
  'ai模型', '语言模型', '大模型',
  '我是一个', '作为一个',
  '模仿', '尝试模仿',
  '根据您', '历史发言', '不当内容', '无法提供',
  '请问您', '您可以提供', '我来模仿', '风格生成', '您希望', '我可以', '需要我帮', '需要我',
  '我是ai', '我是bot', '一个ai', '一个bot',
  // slurs / group-banned terms — 0 tolerance
  '药娘',
];

// Soft-forbidden: reply STARTS with these → assistant meta-framing
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

  if (text.includes('---')) return '---';

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
 * Strip echo prefix: if reply starts with the last user message AND contains more content
 * after it (meaning it's a quote-then-continue pattern), strip the echo prefix.
 * Short replies that happen to match the trigger (e.g. a one-word echo as a valid reply)
 * are left alone.
 */
export function stripEcho(reply: string, lastUserMessage: string): string {
  const trimmedReply = reply.trim();
  const trimmedUser = lastUserMessage.trim();
  // Only strip if the user message is substantial and the reply has additional content after it
  if (trimmedUser.length >= 5 && trimmedReply.startsWith(trimmedUser)) {
    const remainder = trimmedReply.slice(trimmedUser.length).replace(/^[\s\n\-]+/, '');
    return remainder;
  }
  return reply;
}

/**
 * Post-process a generated reply: strip QQ built-in face codes and trailing 。.
 */
export function postProcess(text: string): string {
  return text
    .replace(/\[CQ:face,[^\]]*\]/g, '')    // strip [CQ:face,id=N] — user banned QQ built-in faces
    .replace(/[\s。]*。[\s。]*$/, '')
    .trim();
}

const CONFABULATION_RE = /我刚说过了|我早就说了|我都说过了|这不是我刚说的|我不是说过了吗|两个意思我都说过/;

/**
 * Detect and warn on confabulation patterns — bot claiming it explained something it didn't.
 * Logs at warn level for tracking; does NOT drop (may be legit in rare cases).
 */
export function checkConfabulation(reply: string, trigger: string, context: Record<string, unknown>): void {
  if (CONFABULATION_RE.test(reply)) {
    logger.warn({ ...context, trigger, reply }, 'confabulation pattern detected');
  }
}

/**
 * True when the bot reply is essentially an echo of the trigger with little new content.
 * Used to silently drop echo replies rather than regenerating.
 */
export function isEcho(reply: string, trigger: string): boolean {
  const t = trigger.trim().toLowerCase();
  const r = reply.trim().toLowerCase();
  if (!t || !r) return false;
  if (r === t) return true;
  if (r.includes(t) && r.length < t.length * 1.5) return true;
  if (t.includes(r) && t.length > r.length) return true;
  return false;
}

/** Hardened system prompt used for sentinel regen calls. */
export const HARDENED_SYSTEM =
  '你是群里的一个成员。绝不说"AI"、"claude"、"模型"、"助手"、"模仿"、"风格"、"请问您"、"我来帮"。直接说一句话，不要解释，不要提示，不要格式化，就像真人在群里打字。如果你生成不出来，就输出"..."。';

/**
 * Run sentinel check:
 * 1. Strip echo prefix (reply starts with the trigger message).
 * 2. If forbidden content found → regenerate once with hardened prompt.
 * 3. If second attempt also forbidden or empty → return '...'.
 * Logs every trigger.
 */
export async function sentinelCheck(
  text: string,
  lastUserMessage: string,
  context: Record<string, unknown>,
  regenerate: () => Promise<string>,
): Promise<string> {
  // Step 1: strip echo prefix
  const deechoed = stripEcho(text, lastUserMessage);
  if (!deechoed.trim()) {
    logger.info({ ...context, firstAttempt: text }, 'sentinel: reply was pure echo — regenerating');
    return _runRegen(context, regenerate);
  }

  // Step 2: forbidden content check
  const offender = hasForbiddenContent(deechoed);
  if (!offender) return deechoed;

  logger.info({ ...context, offendingPhrase: offender, firstAttempt: deechoed }, 'sentinel: forbidden content — regenerating');
  return _runRegen(context, regenerate);
}

async function _runRegen(context: Record<string, unknown>, regenerate: () => Promise<string>): Promise<string> {
  let second: string;
  try {
    second = await regenerate();
  } catch {
    logger.info({ ...context }, 'sentinel: regeneration threw — falling back to "..."');
    return '...';
  }

  const offender2 = hasForbiddenContent(second.trim());
  if (offender2 || !second.trim()) {
    logger.info({ ...context, offendingPhrase: offender2, secondAttempt: second }, 'sentinel: second attempt still forbidden — falling back to "..."');
    return '...';
  }

  return second;
}
