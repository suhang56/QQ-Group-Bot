import { describe, it, expect } from 'vitest';
import { hasTopicFollowUpPhrase, FOLLOWUP_FUNCTION_WORDS } from '../../src/utils/topic-followup-phrase.js';

describe('hasTopicFollowUpPhrase', () => {
  // [input, expected, rationale]
  const positiveRows: Array<[string, true, string]> = [
    ['还有吗',     true, '还有(吗)? — optional suffix'],
    ['还有码',     true, '还有(码)? — optional suffix'],
    ['还有么',     true, '还有(么)? — optional suffix'],
    ['还有没有',   true, '还有(没有)? — optional suffix'],
    ['还有的吗',   true, '还有(的吗)? — optional suffix'],
    ['还有',       true, '还有 alone — suffix optional'],
    ['那之后呢',   true, '那\\S{0,8}呢 — bridging'],
    ['呢',         true, '\\S{0,6}呢 — 0-char prefix valid'],
    ['之后呢',     true, '之后呢 exact'],
    ['然后呢',     true, '然后呢 exact'],
    ['继续',       true, '继续 bare'],
    ['6月有啥live', true, 'N月 fact-tail (live)'],
  ];

  const negativeRows: Array<[string, false, string]> = [
    ['你之后呢准备干嘛', false, '之后呢 embedded mid-sentence — anchor fails'],
    ['然后我去吃饭',     false, '然后 leading connector, no trailing 呢'],
    ['还有一个问题',     false, '还有 leads content clause — suffix not in whitelist'],
    ['呢是什么意思',     false, '呢 as subject — anchor fails'],
    ['6月的天气好热',    false, 'N月 tail 天气好热 — not in fact-tail whitelist'],
    ['',                 false, 'empty string'],
    ['还有吗\n还有码',   false, 'multi-line — \\n breaks $ anchor'],
    ['12月31号',         false, 'N月 tail 31号 — not in whitelist'],
    ['7月想吃饭',        false, 'N月 tail 想吃饭 — not in whitelist'],
    ['继续吧',           false, '继续 pattern is `^继续[?？!！~～]*$` — 吧 not allowed'],
  ];

  it.each(positiveRows)('positive: %s → true (%s)', (input, expected, _rationale) => {
    expect(hasTopicFollowUpPhrase(input)).toBe(expected);
  });

  it.each(negativeRows)('negative: %s → false (%s)', (input, expected, _rationale) => {
    expect(hasTopicFollowUpPhrase(input)).toBe(expected);
  });

  it('FOLLOWUP_FUNCTION_WORDS contains all planner + designer additions', () => {
    // Spec-anchored presence check — don't let a rename silently drop a term.
    for (const t of ['还有', '还有吗', '还有码', '还有么', '还有什么', '呢', '然后', '继续', '之后', '那', '那呢', '接下来', '后来', '后来呢', '接着呢']) {
      expect(FOLLOWUP_FUNCTION_WORDS.has(t)).toBe(true);
    }
  });
});
