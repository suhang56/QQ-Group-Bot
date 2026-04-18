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
