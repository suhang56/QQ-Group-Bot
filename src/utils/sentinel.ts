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
  '尝试模仿',
  '根据您', '历史发言', '不当内容', '无法提供',
  '请问您', '您可以提供', '我来模仿', '风格生成', '您希望', '我可以', '需要我帮', '需要我',
  '我是ai', '我是bot', '一个ai', '一个bot',
  // slurs / group-banned terms — 0 tolerance
  '药娘',
  // image marker leak phrases — bot telling user it has a text description
  '描述太模糊',
  '图描述',
  '图没描述',
  '描述呢',
  '描述不出来',
  // meta-reasoning / chain-of-thought leaks — bot narrating its decision
  // process instead of just replying. All of these are third-person analysis.
  '这是在纠正',
  '这是在确认',
  '这个梗我懂',
  '这个话题我熟',
  '接话会显得',
  '不能重复类似',
  '我刚刚已经说过',
  '刚说过相关内容',
  '但刚说过',
  // selecting-which-message-to-reply-to leaks (bot pointing at context)
  '要接的这条',
  '要接这条',
  '要回这条',
  '回这条',
  '应该接',
  '应该回',
  '选这条',
  '回复这条',
  '这条要接',
  '这条我接',
  // bot's own internal error-message format leaking as chat output
  '图片下载失败',
  '请稍后再试',
  // raw model padding / special tokens leaking due to safety intervention
  // or agent-SDK content filter. Seen on PII-adjacent triggers where Claude
  // emits e.g. '[PAD151903' mid-generation instead of a normal refusal.
  '[pad',
  '[unk',
  '[mask',
  '<|endoftext|>',
  '<|im_start|>',
  '<|im_end|>',
  // leaked context-marker prefix — model dumping its own context window
  // verbatim. postProcess strips lone prefixes but if "[你]:" appears in
  // the MIDDLE of a reply it means the model is emitting multiple
  // [nickname]: blocks which is always wrong.
  '[你]:',
  '[你(',
];

// Soft-forbidden: reply STARTS with these → assistant meta-framing
const SOFT_FORBIDDEN_STARTS = [
  '好的，', '当然，', '我来', '让我', '这是一个', '这是为了', '这是因为', '以下是',
  // arrow prefixes — bot pointing at a context message ("← 要接的这条")
  '←', '⬅', '→', '➡',
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
const SKIP_LINE_RE = /^\s*<\s*skip\s*>\s*$/i;

// Matches leaked context-marker prefixes from the prompt's `[你(昵称)]:` /
// `[昵称]:` format appearing at the start of a line. Model sometimes emits
// these verbatim when it's dumping its context window as output. Capture the
// whole prefix (the bracketed name + colon + any following whitespace) so we
// can strip it and keep the actual content that followed.
const LEAKED_CONTEXT_PREFIX_RE = /^\s*\[[^\]\n]{1,40}\]\s*[:：]\s*/;

// Degenerate angle-bracket wrapping — model sometimes emits the trigger or an
// abbreviation wrapped in <...> when it has no real answer and falls back to
// "tag-style" output. Strip the outer wrapper, keep the inner text so a sane
// reply remains (or the whole line gets dropped if that leaves nothing).
// Matches any single-line `<xxx>` where xxx doesn't contain `<` `>` `/` — this
// catches `<i83是谁>` / `<什么意思>` while preserving legitimate skip markers
// (handled above) and anything with angle brackets inside a longer sentence.
const ANGLE_WRAP_RE = /^\s*<([^<>\/\n]{1,80})>\s*$/;

export function postProcess(text: string): string {
  return text
    .replace(/\[CQ:face,[^\]]*\]/g, '')    // strip [CQ:face,id=N] — user banned QQ built-in faces
    .replace(/\[CQ:mface,[^\]]*\]/g, '')   // strip [CQ:mface,...] — user banned QQ market stickers
    .split('\n')
    .filter(line => !SKIP_LINE_RE.test(line))
    // Degenerate angle-bracket wrap: unwrap or drop
    .map(l => {
      const m = ANGLE_WRAP_RE.exec(l);
      return m ? m[1]! : l;
    })
    // Strip leaked context-marker prefixes like "[你]: " / "[你(小号)]: " / "[Alice]:"
    .map(l => l.replace(LEAKED_CONTEXT_PREFIX_RE, ''))
    .map(l => {
      // Strip orphan trailing brackets that survived CQ stripping (e.g. from
      // malformed [CQ:mface,summary=[笑]] where inner ] confuses the regex).
      // Only strip if the line doesn't contain a balanced [CQ:...] code.
      const trimmed = l.trim();
      if (/\[CQ:/.test(trimmed)) return trimmed;
      return trimmed.replace(/[\[\]]+\s*$/, '').trim();
    })
    .filter(l => l.length > 0)
    .join('\n')
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
 *
 * Normalizes both sides aggressively before comparison: strips all ASCII+CJK
 * punctuation, whitespace, full-width chars, and CQ codes (so a reply like
 * "影色舞是什么啊?" still matches trigger "[CQ:at,qq=X] mygo的 影色舞是什么啊").
 * Falls back to character-bigram Jaccard similarity > 0.7 for cases where
 * the reply is a substantial subset of the trigger but not exact substring.
 */
function _normForEcho(s: string): string {
  return s
    .replace(/\[CQ:[^\]]*\]/g, '')           // strip CQ codes
    .replace(/[\s\p{P}\p{S}]/gu, '')         // strip all punctuation + whitespace + symbols (unicode-aware)
    .toLowerCase();
}

function _bigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length < 2) { if (s) out.add(s); return out; }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function _jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function isEcho(reply: string, trigger: string): boolean {
  const t = _normForEcho(trigger);
  const r = _normForEcho(reply);
  if (!t || !r) return false;
  if (r === t) return true;
  if (r.includes(t) && r.length < t.length * 1.5) return true;
  if (t.includes(r) && t.length > r.length) return true;
  // Fallback: character-bigram similarity. Catches near-echo cases where
  // the reply added/dropped a few chars (e.g. trailing "?", "啊", "嘛")
  // or swapped order slightly. Threshold 0.7 is conservative for Chinese.
  const sim = _jaccard(_bigrams(r), _bigrams(t));
  if (sim >= 0.7) return true;
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
