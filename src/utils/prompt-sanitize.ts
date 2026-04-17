/**
 * prompt-sanitize.ts -- UR-A Phase A
 *
 * Helpers that sanitize untrusted strings (nicknames, group message content,
 * forwarded text, image descriptions) before they are interpolated into LLM
 * prompts. Goals:
 *   - Strip angle brackets and backticks that could confuse tag / codefence
 *     boundaries and let group content escape its wrapper.
 *   - Enforce length caps so an adversary can't push a single oversized message
 *     across a cache-boundary or past a context truncation point.
 *   - Provide a jailbreak-detector used by self-reflection sanity rails.
 */

export const MAX_NICK_LEN = 40;
export const MAX_LINE_LEN = 500;

/** Strip `<`, `>`, and codefence markers; slice to `maxLen` (default MAX_LINE_LEN). */
export function sanitizeForPrompt(s: string, maxLen?: number): string {
  if (!s) return '';
  const cap = maxLen ?? MAX_LINE_LEN;
  // Drop codefence markers outright (```lang or bare ```) so the model can't
  // be tricked into closing our surrounding fence and opening a new "system"
  // role block.
  let out = s.replace(/```+[a-zA-Z0-9_-]*/g, '');
  out = out.replace(/[<>]/g, '');
  if (out.length > cap) out = out.slice(0, cap);
  return out;
}

/** Strip angle brackets, backticks and newlines; clamp to MAX_NICK_LEN. */
export function sanitizeNickname(n: string): string {
  if (!n) return '';
  let out = n.replace(/[<>`\r\n]/g, '');
  if (out.length > MAX_NICK_LEN) out = out.slice(0, MAX_NICK_LEN);
  return out;
}

/**
 * Remove every occurrence of a closing tag, case-insensitive and tolerant of
 * internal whitespace between `</`, the name, and `>`. Replaces each match
 * with `"<...>"` so downstream bracket-stripping still collapses it to `...`.
 */
export function stripClosingTag(s: string, tag: string): string {
  if (!s) return '';
  const m = /^<\s*\/\s*([\w:-]+)\s*>$/.exec(tag.trim());
  if (!m) return s;
  const name = m[1]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<\\s*/\\s*${name}\\s*>`, 'gi');
  return s.replace(re, '<...>');
}

/**
 * Common prompt-injection / jailbreak signatures. Used as a sanity check in
 * persona-patch generation (refuse to adopt a persona whose new_text contains
 * one of these) and as a defense-in-depth hook callers can use elsewhere.
 *
 * Kept deliberately conservative — false positives are cheap (a rejected LLM
 * output regenerates) but a false negative can leak an adversarial persona.
 */
export const JAILBREAK_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+|the\s+|any\s+)?previous\s+(instructions|prompts)/i,
  /<\|\s*system\s*\|>/i,
  /<\|\s*im_(start|end)\s*\|>/i,
  /#\s*END\b/i,
  /你是一个(没有任何|不受)(限制|约束)的/,
  /^\s*system\s*[:：]/im,
  /```+\s*system\b/i,
  /```+\s*assistant\b/i,
];

export function hasJailbreakPattern(s: string): boolean {
  if (!s) return false;
  for (const re of JAILBREAK_PATTERNS) {
    if (re.test(s)) return true;
  }
  return false;
}
