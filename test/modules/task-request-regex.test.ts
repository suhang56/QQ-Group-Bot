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

describe('PR #118 — bare-verb first-person exclusion', () => {
  it.each([
    // --- NEGATIVE: bare 我+verb (no modal) — new PR #118 coverage ---
    ['我搞个自动重连吧',        false, 'bare 我+搞 self-talk: live bug case from production'],
    ['我写个代码',              false, 'bare 我+写, no modal — new FP class'],
    ['我画个图',                false, 'bare 我+画'],
    ['我算一下',                false, 'bare 我+算一下'],
    ['我总结一下',              false, 'bare 我+总结'],
    ['我编个脚本',              false, 'bare 我+编'],
    ['我搞个东西',              false, 'bare 我+搞 (东西 also in sub-clause negative lookahead; lookbehind NOMATCH is primary guard)'],

    // --- NEGATIVE: PR #117 modal regressions (must still hold under unified lookbehind) ---
    ['我得写个',                false, 'modal 得, PR #117 regression preserved'],
    ['我要写个',                false, 'modal 要, PR #117 regression preserved'],
    ['我想写个',                false, 'modal 想, PR #117 regression preserved'],
    ['我打算写个',              false, 'modal 打算, PR #117 regression preserved'],

    // --- POSITIVE: address-prefix bypass via [帮给替让教] char class ---
    ['帮我搞个脚本',            true,  '帮 in bypass class → inner lookbehind blocks outer firing'],
    ['给我搞个',                true,  '给 in bypass class'],
    ['让我画',                  true,  '让我 is existing prefixed clause (not via bypass, via 让我 clause)'],
    ['教我写代码',              true,  '教 in bypass class; also matches 教.{0,5}代码 prefix clause'],
    ['帮我写个脚本',            true,  '帮我 prefixed clause, PR #117 regression preserved'],
    ['给我写个方案',            true,  '给我 prefixed clause'],
    ['让你写',                  true,  '让你 prefixed clause (no 我 involved)'],

    // --- POSITIVE: no 我 at all — imperative to bot ---
    ['你搞个',                  true,  'no 我, plain 2nd-person imperative'],
    ['你写个脚本',              true,  'no 我, plain 2nd-person imperative'],

    // --- EDGE CASES ---
    ['搞个东西',                false, '东西 in 搞 sub-clause negative lookahead → NOMATCH regardless of lookbehind'],
    ['跟我搞个',                false, '跟 NOT in bypass class [帮给替让教] → lookbehind fires (Designer §7: peer-coordinated action, not bot-directive)'],
    ['同我搞个',                false, '同 NOT in bypass class → lookbehind fires (Designer §7)'],

    // Row 24 — documented limitation, same class as PR #117's `我想帮你写个脚本`
    // (test file above line 39). 我 is 2 chars before 搞, outside the nested
    // lookbehind's single-char window at position before 搞. Fixing requires
    // a `.{0,3}` window that adds FP risk on stray negations. Team-lead
    // confirmed: preserve narrow scope, defer pending live frequency data.
    ['我帮你搞个',              true,  'first-person offering labor TO bot (我帮你搞); position-anchored lookbehind cannot see 我 through intervening 帮你. Same class as PR #117 `我想帮你写个脚本` (task-request-regex.test.ts line 39). Widening lookbehind to .{0,3} would add FP risk on stray negations. Out of scope for PR #118; deferred pending live frequency data.'],

    ['我要搞个',                false, 'modal 要 + bare 搞: PR #117 modal-required lookbehind covered this; Option A unified lookbehind preserves via optional modal group. Regression assertion that PR #117 coverage was NOT lost in the bare-verb widening.'],
  ])('%s → match=%s (%s)', (input, expected) => {
    expect(TASK_REQUEST.test(input)).toBe(expected);
  });
});
