import { describe, it, expect } from 'vitest';
import { TASK_REQUEST } from '../../src/modules/chat.js';

describe('TASK_REQUEST — first-person false-positive exclusion', () => {
  it.each([
    // --- NEGATIVE: must NOT match after fix (Planner-required) ---
    ['我得写个monitor系统了',   false, '我得 + bare 写: first-person narration'],
    ['我要写一段代码',          false, '我要 + bare 写: first-person narration'],
    ['我想写个bot',             false, '我想 + bare 写: first-person narration'],
    ['我打算写个PR',            false, '我打算 + bare 写: first-person plan'],
    ['我准备写个脚本',          false, '我准备 + bare 写: first-person plan'],
    ['我需要写个工具',          false, '我需要 + bare 写: first-person need'],
    ['我必须总结一下',          false, '我必须 + bare 总结: first-person obligation'],
    ['我该画一下流程图',        false, '我该 + bare 画: first-person self-directive'],
    ['我应该算一下',            false, '我应该 + bare 算: first-person self-directive'],

    // --- POSITIVE: must STILL match (Planner-required regressions) ---
    ['你写个脚本',              true,  'bare 写 without first-person prefix'],
    ['帮我写个脚本',            true,  '帮我 prefix — prefixed clause, lookbehind not applied'],
    ['给我写个代码',            true,  '给我 prefix — prefixed clause'],
    ['能不能写个X',             true,  '能不能 prefix — prefixed clause'],
    ['帮我生成一个',            true,  '帮我 + 生成 — prefixed clause'],
    ['让你画一张',              true,  '让你 prefix — prefixed clause'],
    ['替我翻译一下',            true,  '替我 prefix — prefixed clause'],
    ['麻烦你总结一下',          true,  '麻烦你 prefix — prefixed clause'],

    // --- EDGE CASES ---
    ['我要写',                  false, 'bare 我要写 no object: lookbehind fires on 我要, and 写[个一] requires suffix anyway'],
    ['我其实一直想要写个bot',   false, '我其实+一直(2 chars ≤ 3)+想: lookbehind inner alt (?:.{0,3}想|.{0,3}要) covers 一直想'],
    ['我其实觉得需要写个工具',  false, '我需要 modal present → lookbehind fires → NOMATCH'],
    ['写个脚本给我',            true,  'bare 写 at start, no first-person prefix before position 0'],
    ['帮我实现代码',            true,  '帮我(?:...实现) prefix — prefixed clause'],

    // --- EDGE CASES: pre-existing behavior, documented for Reviewer context ---
    // These 3 rows assert the REGEX'S ACTUAL behavior, which diverges from
    // some Designer §7 semantic framing. The divergences stem from
    // pre-existing gates (lookahead window size, prefix coverage) NOT
    // touched by this PR. See DEV-READY §2 notes — out of scope.
    ['我想帮你写个脚本',        true,  'user offers labor via 帮你+写; lookbehind is position-anchored before 写 and sees 帮你 (not 我想) at tail → does not fire → bare 写个 matches. Scope: PR narrowly targets first-person self-talk FP; expanding to cover offer-to-bot pattern would require either a wider lookbehind (new FP risk) or adding 帮你 to prefix list (Designer §7 explicitly rejected). Pre-existing behavior preserved.'],
    ['写个好的程序需要什么',    true,  'existing (?!.{0,2}(?:啥|什么)) lookahead window is 2 chars; 需要什么 starts at offset 6 — outside window. This is pre-existing TASK_REQUEST behavior unrelated to first-person FP. Out of scope for this PR.'],
    ['你让我写个什么啊',        true,  'matches via 让我(?:写|...) prefixed clause, which carries no 什么 lookahead. Pre-existing behavior; fixing would require adding lookahead to every prefix clause — out of scope.'],
  ])('%s → match=%s (%s)', (input, expected) => {
    expect(TASK_REQUEST.test(input)).toBe(expected);
  });
});
