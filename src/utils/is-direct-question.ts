export const DIRECT_QUESTION_PATTERNS: readonly RegExp[] = [
  /\S{1,10}\s*是啥/,
  /\S{1,10}\s*是什么/,
  /什么是\s*\S{1,10}/,
  /\S{1,10}\s*是谁/,
  /\S{1,10}\s*(的)?意思(是啥|什么|是什么)?/,
  /啥是\s*\S{1,10}/,
  /啥意思/,
];

export function isDirectQuestion(content: string): boolean {
  const stripped = content.replace(/\[CQ:[^\]]+\]/g, '');
  return DIRECT_QUESTION_PATTERNS.some(p => p.test(stripped));
}

/**
 * Evaluation / opinion queries about a specific target: "如何评价 X" / "怎么看 X"
 * / "你觉得 X". Distinct from isDirectQuestion (definition-seeking). When paired
 * with a known fact for X, prompt-builder should emit a separate SYSTEM-tier
 * rule telling the model to identify X first, then give a short opinion —
 * without collapsing into 装傻/反问.
 *
 * Intentionally strict: requires an explicit opinion verb (评价 / 看 / 觉得)
 * to avoid overlap with status questions like "你最近怎么样".
 */
export const GROUNDED_OPINION_PATTERNS: readonly RegExp[] = [
  /如何评价\s*\S{1,15}/,
  /怎么(看|评价)\s*\S{1,15}/,
  /你觉得\s*\S{1,15}/,
];

export function isGroundedOpinionQuestion(content: string): boolean {
  const stripped = content.replace(/\[CQ:[^\]]+\]/g, '');
  return GROUNDED_OPINION_PATTERNS.some(p => p.test(stripped));
}
