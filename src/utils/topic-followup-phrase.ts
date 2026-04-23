/**
 * Follow-up phrase predicate for conversation-latch preservation (PR6 R3.1).
 *
 * `hasTopicFollowUpPhrase(text)` returns true when `text` is a "naked" topic
 * follow-up particle that, after a recent bot reply, the user almost certainly
 * intends to aim at the prior topic (还有吗 / 那6月呢 / 6月有啥live etc).
 * Full-line anchored — embedded matches must NOT fire.
 *
 * `FOLLOWUP_FUNCTION_WORDS` is used in chat.ts engagedTopic.set to drop
 * low-info function tokens when accumulating topic vocabulary across turns,
 * so a follow-up particle itself never pollutes the topic token set.
 */

const TOPIC_FOLLOWUP_PATTERNS: readonly RegExp[] = [
  /^还有(吗|码|么|没有|的吗)?[?？!！~～]*$/u,                                          // 还有 + optional suffix
  /^那\S{0,8}呢[?？!！~～]*$/u,                                                         // 那X呢 bridging
  /^\S{0,6}呢[?？!！~～]*$/u,                                                           // X呢 short (bare 呢 = 0-char prefix)
  /^之后呢[?？!！~～]*$/u,                                                              // 之后呢 exact
  /^然后呢[?？!！~～]*$/u,                                                              // 然后呢 exact
  /^继续[?？!！~～]*$/u,                                                                // 继续 bare or punctuated
  /^\d{1,2}月(的|有|呢)?[\S]{0,8}(live|LIVE|演唱会|活动|concert|ライブ|呢|啥|有)$/u,   // N月...fact-tail
];

export const FOLLOWUP_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  '还有', '还有吗', '还有码', '还有么', '还有什么',
  '呢', '然后', '继续', '之后', '那', '那呢', '接下来',
  '后来', '后来呢', '接着呢',
]);

export function hasTopicFollowUpPhrase(text: string): boolean {
  if (!text) return false;
  for (const re of TOPIC_FOLLOWUP_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}
