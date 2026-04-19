// Subject pronouns/greetings that disqualify a preceding candidate as an entity.
const PRONOUN_SUBJECTS = new Set(['你', '你们', '大家', '今天', '最近', '这']);

function hasEntityCandidate(candidate: string): boolean {
  return candidate.length >= 2 && !PRONOUN_SUBJECTS.has(candidate.trim());
}

// Suffix-form direct-question: "X 是啥 / X 啥梗 / X 咋回事" etc.
// Entity is content BEFORE the interrogative stem.
const DIRECT_SUFFIX_STEMS: readonly RegExp[] = [
  /^(.+?)\s*是啥$/,
  /^(.+?)\s*是什么$/,
  /^(.+?)\s*是干啥的$/,
  /^(.+?)\s*啥梗$/,
  /^(.+?)\s*什么梗$/,
  /^(.+?)\s*啥来头$/,
  /^(.+?)\s*什么来头$/,
  /^(.+?)\s*咋回事$/,
  /^(.+?)\s*是谁$/,
  /^(.+?)\s*(的)?意思(是啥|什么|是什么)?$/,
];

// Prefix-form direct-question: "什么是 X" / "啥是 X"
const DIRECT_PREFIX_STEMS: readonly RegExp[] = [
  /^什么是\s*(.+)$/,
  /^啥是\s*(.+)$/,
  /^啥意思$/,
];

export const DIRECT_QUESTION_PATTERNS: readonly RegExp[] = [
  /\S{1,10}\s*是啥/,
  /\S{1,10}\s*是什么/,
  /什么是\s*\S{1,10}/,
  /\S{1,10}\s*是谁/,
  /\S{1,10}\s*(的)?意思(是啥|什么|是什么)?/,
  /啥是\s*\S{1,10}/,
  /啥意思/,
  /\S{1,15}\s*是干啥的/,
  /\S{1,15}\s*啥梗/,
  /\S{1,15}\s*什么梗/,
  /\S{1,15}\s*啥来头/,
  /\S{1,15}\s*什么来头/,
  /\S{1,15}\s*咋回事/,
];

export function isDirectQuestion(content: string): boolean {
  const stripped = content.replace(/\[CQ:[^\]]+\]/g, '').trim()
    .replace(/[？?！!。，,、…]+$/, '');
  for (const re of DIRECT_SUFFIX_STEMS) {
    const m = re.exec(stripped);
    if (m) {
      const candidate = (m[1] ?? '').trim();
      if (hasEntityCandidate(candidate)) return true;
    }
  }
  for (const re of DIRECT_PREFIX_STEMS) {
    if (re.test(stripped)) return true;
  }
  return false;
}

/**
 * Evaluation / opinion queries about a specific target.
 * Distinct from isDirectQuestion — no double-match allowed.
 * "X 怎么样 / X 咋样 / X 如何 / X 怎么说 / 如何评价 X"
 */
const OPINION_SUFFIX_STEMS: readonly RegExp[] = [
  /^(.+?)\s*怎么样$/,
  /^(.+?)\s*咋样$/,
  /^(.+?)\s*如何$/,
  /^(.+?)\s*怎么说$/,
];

const OPINION_PREFIX_STEMS: readonly RegExp[] = [
  /^如何评价\s*(.+)$/,
  /^如何看待\s*(.+)$/,
  /^怎么(?:看|评价|看待)\s*(.+)$/,
  /^你觉得\s*(.+)$/,
  /^评价一下\s*(.+)$/,
  /^点评\s*(.+)$/,
];

export const GROUNDED_OPINION_PATTERNS: readonly RegExp[] = [
  /如何评价\s*\S{1,15}/,
  /如何看待\s*\S{1,15}/,
  /怎么(看|评价|看待)\s*\S{1,15}/,
  /你觉得\s*\S{1,15}/,
  /评价一下\s*\S{1,15}/,
  /点评\s*\S{1,15}/,
  /\S{1,15}\s*怎么样/,
  /\S{1,15}\s*咋样/,
  /\S{1,15}\s*如何/,
  /\S{1,15}\s*怎么说/,
];

export function isGroundedOpinionQuestion(content: string): boolean {
  const stripped = content.replace(/\[CQ:[^\]]+\]/g, '').trim()
    .replace(/[？?！!。，,、…]+$/, '');
  for (const re of OPINION_SUFFIX_STEMS) {
    const m = re.exec(stripped);
    if (m) {
      const candidate = (m[1] ?? '').trim();
      if (hasEntityCandidate(candidate)) return true;
    }
  }
  for (const re of OPINION_PREFIX_STEMS) {
    const m = re.exec(stripped);
    if (m) {
      const candidate = (m[1] ?? '').trim();
      if (hasEntityCandidate(candidate)) return true;
    }
  }
  return false;
}
