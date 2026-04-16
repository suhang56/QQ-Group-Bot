import { createLogger } from './logger.js';

const logger = createLogger('sentinel');

// Terms that must match as whole ASCII words (case-insensitive)
const WORD_FORBIDDEN = [
  'claude', 'chatgpt', 'gpt', 'anthropic', 'openai', 'llm',
];

// Self-identifying "bot" leaks: any demonstrative/pronoun followed by "bot" or
// "AI" is the bot talking about itself as a bot. Examples seen in prod:
//   "哈哈哈哈你这个bot屁股歪了"   ← bot said this about itself
//   "这个bot又坏了"                ← same
//   "我这bot" / "作为bot" / "bot的意思"
// Pattern matches: 你/我/他/她/它/这(个|种|位)/那(个|种|位)/作为 + optional space + bot|ai
const BOT_SELFREF_RE = /(?:你|我|他|她|它|这个|那个|这种|那种|这位|那位|作为|身为|一个|这|那)\s*(?:bot|ai)\b/i;

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
  '药娘', '雷普', '约炮',
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

  const selfRef = BOT_SELFREF_RE.exec(text);
  if (selfRef) return selfRef[0]!;

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
// Matches a line that is entirely <skip> optionally padded with filler punct
// (dots/commas/ellipsis/etc). Catches both "<skip>" and "..<skip>" / "<skip>.."
// produced when the model leaks the control token surrounded by hesitation.
const SKIP_LINE_RE = /^[\s.。,，!！?？、;；:：~～\-_*#…]*<\s*skip\s*>[\s.。,，!！?？、;；:：~～\-_*#…]*$/i;

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

/**
 * Safety-only filter: strip hallucinated URLs, angle-bracket CQ codes,
 * degenerate patterns, leaked context markers, and QQ built-in face codes.
 * Does NOT touch mface or persona-level rules.
 */
export function sanitize(text: string): string {
  return text
    .replace(/\[CQ:face,[^\]]*\]/g, '')    // strip [CQ:face,id=N] — user banned QQ built-in faces
    // Strip [CQ:image,...] that contains url=... — the model hallucinates
    // image segments by copying from context (which has real url= params).
    // Legit learned-sticker replies use file=file:/// local paths and never
    // contain url=, so this filter is safe.
    .replace(/\[CQ:image,[^\]]*url=[^\]]*\]/gi, '')
    // Strip ANY angle-bracketed <CQ:...> — this is always hallucination; no
    // legitimate path ever emits CQ codes in angle brackets.
    .replace(/<CQ:[^>\n]*>/gi, '')
    .split('\n')
    // Drop whole-line <skip> first (including punct-padded "..<skip>" /
    // "<skip>..") so we don't leave a ".." remnant after inline strip.
    .filter(line => !SKIP_LINE_RE.test(line))
    // Then strip any remaining inline <skip>
    .map(line => line.replace(/<\s*skip\s*>/gi, ''))
    // Degenerate angle-bracket wrap: unwrap or drop
    .map(l => {
      const m = ANGLE_WRAP_RE.exec(l);
      return m ? m[1]! : l;
    })
    // Strip leaked context-marker prefixes like "[你]: " / "[你(小号)]: "
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
    .trim();
}

/**
 * Persona-level filters: strip mface codes not in the allowed whitelist,
 * and remove trailing Chinese period.
 *
 * @param text - sanitized text (output of sanitize())
 * @param allowedMfaceKeys - set of mface keys allowed for this group (null = strip all mface)
 */
export function applyPersonaFilters(
  text: string,
  allowedMfaceKeys: ReadonlySet<string> | null,
): string {
  let result = text;

  if (allowedMfaceKeys === null) {
    // No whitelist available: strip all mface (legacy behavior)
    result = result.replace(/\[CQ:mface,[^\]]*\]/g, '');
  } else {
    // Keep mface codes whose key is in the whitelist, strip the rest
    result = result.replace(/\[CQ:mface,[^\]]*\]/g, (match) => {
      const keyMatch = /key=([^,\]]+)/.exec(match);
      if (keyMatch && allowedMfaceKeys.has(keyMatch[1]!)) return match;
      return '';
    });
  }

  // Strip trailing Chinese period and clean up empty lines from mface removal
  return result
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .join('\n')
    .replace(/[\s。]*。[\s。]*$/, '')
    .trim();
}

/**
 * Post-process a generated reply (backward-compatible thin wrapper).
 * Calls sanitize() then applyPersonaFilters() with null whitelist (strip all mface).
 */
export function postProcess(text: string): string {
  return applyPersonaFilters(sanitize(text), null);
}

const CONFABULATION_RE = /我刚说过了|我早就说了|我都说过了|这不是我刚说的|我不是说过了吗|两个意思我都说过/;

/**
 * Detect confabulation patterns — bot claiming it explained something it didn't.
 * Returns a short fallback reply if confabulation is detected, null otherwise.
 * Soft-drop: replace the confabulated reply with a safe fallback instead of
 * sending the hallucinated "I already said" claim.
 */
export function checkConfabulation(reply: string, trigger: string, context: Record<string, unknown>): string | null {
  if (CONFABULATION_RE.test(reply)) {
    logger.info({ ...context, trigger, reply }, 'confabulation soft-drop — replacing with fallback');
    return '...';
  }
  return null;
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
  // Very short replies (< 4 normalized chars) are likely valid short
  // responses ("好""嗯""哈") not echoes. Skip echo detection.
  if (r.length < 4) return false;
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

// ============================================================
// P3-4 additions: entity-guard, qa-report-detector, coreference-guard
// ============================================================

// --- Entity Guard (P3-4a) ---
// Protect band characters / bands from disparagement in bot output.
// Seed: aliases.json names + nine bands + known 圈内底线 patterns.

const PROTECTED_ENTITIES: readonly string[] = [
  // Characters from aliases.json
  '凑友希那', '友希那', 'ykn', 'yukina',
  '冰川纱夜', '纱夜', 'sayo',
  '今井莉莎', '莉莎', 'risa',
  '白金燐子', '燐子', 'rinko',
  '宇田川亚子', '亚子', 'ako',
  // Nine bands (BANGDREAM_PERSONA 圈内底线)
  'Poppin\'Party', 'ppp', 'popipa',
  'Afterglow',
  'Pastel*Palettes', 'Pastel Palettes', 'pp',
  'Roselia',
  'HHW', 'Hello Happy World', 'hhw',
  'Morfonica', '蝶', '魔莉菇',
  'RAS', 'RAISE A SUILEN',
  'MyGO', 'mygo',
  'Ave Mujica', '母鸡卡',
];

// Disparagement patterns: "谁喜欢X啊" / "X真难听" / "X不行" / "不要脸" + entity
// Build a regex that matches common disparagement frames around any protected entity.
const _entityEscaped = PROTECTED_ENTITIES.map(e =>
  e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
);
const _entityGroup = _entityEscaped.join('|');

// Patterns where the entity appears as the target of disparagement
const ENTITY_DISPARAGEMENTS: RegExp[] = [
  // "谁喜欢X啊" / "谁听X啊"
  new RegExp(`谁(?:喜欢|听|看|推|要)(?:${_entityGroup})`, 'i'),
  // "X真难听" / "X真垃圾" / "X真烂" / "X不行"
  new RegExp(`(?:${_entityGroup})(?:真|太|好|超)?(?:难听|垃圾|烂|差|不行|恶心|丑|弱|废物|辣鸡|拉胯)`, 'i'),
  // "不要脸" / "丢人" + entity
  new RegExp(`(?:${_entityGroup})(?:不要脸|丢人|丢脸|可笑|搞笑)`, 'i'),
  // "讨厌X" / "X滚" (directed at entity)
  new RegExp(`(?:讨厌|烦|恨|骂|喷)(?:${_entityGroup})`, 'i'),
  // "X唱歌难听" / "X演技差"
  new RegExp(`(?:${_entityGroup})(?:唱歌|演技|表演|声音|长相)?(?:难听|差|烂|丑|恶心)`, 'i'),
];

const ENTITY_GUARD_FALLBACKS: readonly string[] = [
  '各有各的粉',
  '我不说这个',
  '嗯',
  '',  // empty = soft-skip (no reply)
];

/**
 * Entity guard: check bot output for disparagement of protected characters/bands.
 * Returns a neutral fallback string if disparagement detected, null if clean.
 * Empty string return means "soft-skip, send no reply".
 */
export function entityGuard(output: string): string | null {
  for (const re of ENTITY_DISPARAGEMENTS) {
    if (re.test(output)) {
      const fallback = ENTITY_GUARD_FALLBACKS[
        Math.floor(Math.random() * ENTITY_GUARD_FALLBACKS.length)
      ]!;
      logger.info({ output, pattern: re.source }, 'entity-guard: disparagement detected, replacing');
      return fallback;
    }
  }
  return null;
}

// --- QA-Report Detector (P3-4b) ---
// Detect bot output that reads like a QA report / encyclopedic answer.
// Soft flag: caller decides whether to regen.

/**
 * Detect QA-report tone in bot output.
 * Flags:
 *   1. >20 chars AND declarative AND contains "是" AND ends with "吗？"/"吗?"
 *   2. Starts with "我刚"/"刚才我"/"我不是说过" + 反问 pattern
 * Returns true if the output has QA-report / self-referential tone.
 */
export function isQaReportTone(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Pattern 1: declarative QA ending with 吗？/吗?
  if (
    trimmed.length > 20 &&
    trimmed.includes('是') &&
    /吗[?？]\s*$/.test(trimmed)
  ) {
    return true;
  }

  // Pattern 2: "我刚" / "刚才我" / "我不是说过" + 反问
  if (/^(?:我刚|刚才我|我不是说过)/.test(trimmed) && /[?？]/.test(trimmed)) {
    return true;
  }

  // Pattern 3: starts with declarative frame that reads like encyclopedia
  // e.g. "X 是 Y 的 Z" patterns over 20 chars
  if (
    trimmed.length > 20 &&
    /^[\u4e00-\u9fff\w]+是[\u4e00-\u9fff\w]+的/.test(trimmed) &&
    !(/[?？!！]/.test(trimmed))
  ) {
    return true;
  }

  return false;
}

/**
 * Advisory: suggest a regen hint for QA-report tone.
 * Returns a short instruction string if the output is flagged, null if clean.
 */
export function qaReportRegenHint(text: string): string | null {
  if (isQaReportTone(text)) {
    return '回复太像百科/QA了, 用更短更随意的口吻重说, 像群友打字';
  }
  return null;
}

// --- Coreference Guard (P3-4c) ---
// Detect bot output referencing the current speaker as a third-person topic.
// "在说X" / "聊X" / "讨论X" where X is the triggering user's nickname.
// This is Case 3's fallback defense (primary = engagement-decision).

/**
 * Check if bot output contains a self-referential coreference pattern
 * where it talks about the current speaker as if they were a topic.
 *
 * @param output - The bot's generated reply
 * @param currentSpeakerNicknames - Nicknames of the user who triggered this reply
 * @returns true if coreference self-reference detected
 */
export function hasCoreferenceSelfReference(
  output: string,
  currentSpeakerNicknames: string[],
): boolean {
  if (!output || currentSpeakerNicknames.length === 0) return false;

  const trimmed = output.trim();
  if (!trimmed) return false;

  for (const nick of currentSpeakerNicknames) {
    if (!nick) continue;
    const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // "在说X" / "聊X" / "讨论X" / "说的X" / "提到X"
    const coreferenceRe = new RegExp(
      `(?:在说|在聊|在讨论|说的是|提到|提的是|说的就是|不是在说)\\s*${escaped}`,
      'i',
    );
    if (coreferenceRe.test(trimmed)) {
      logger.info(
        { output: trimmed, nick },
        'coreference-guard: self-reference to current speaker detected',
      );
      return true;
    }

    // "我刚不是在说X吗" pattern (the exact Case 3 bad case)
    const exactCaseRe = new RegExp(
      `我刚(?:不是)?在说\\s*${escaped}`,
      'i',
    );
    if (exactCaseRe.test(trimmed)) {
      logger.info(
        { output: trimmed, nick },
        'coreference-guard: "我刚在说X" pattern detected',
      );
      return true;
    }
  }

  return false;
}
