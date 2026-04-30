import { describe, it, expect } from 'vitest';
import { TASK_REQUEST, DEFLECT_SITUATIONS } from '../../src/modules/chat.js';

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

describe('PR third-person — third-person prefix exclusion', () => {
  it.each([
    // --- NEGATIVE: third-person prefix must NOT match (new coverage) ---
    ['他写一个',                false, '他 + bare 写'],
    ['她生成一个',              false, '她 + 生成'],
    ['他生成一段',              false, '他 + 生成 (live evidence family)'],
    ['它画一张',                false, '它 + 画'],
    ['他们让我',                false, '他们 — no verb match anyway, regression guard'],
    ['他要写',                  false, '他 + modal 要 + 写'],
    ['他们生成代码',            false, '他们 + 生成'],
    ['让他写',                  false, 'third-person target via 让, not direct bot-directive'],
    ['他写代码',                false, 'bare 他 + 写 no modal'],
    ['他想写个东西',            false, '他 + modal 想 + 写'],
    ['帮他写',                  false, 'conservative: NO [帮给替让教] carve-out for third-person; "帮他" rare, FP cost on narration is higher'],
    ['帮他们写代码',            false, '帮他们 third-person plural — same conservative bias'],

    // --- POSITIVE: must still match (regression guards for prefix clauses + bare-verb-without-pronoun) ---
    ['帮我写代码',              true,  '帮我 prefix unchanged'],
    ['给我生成一个图',          true,  '给我 prefix unchanged'],
    ['写一个故事',              true,  'bare 写, no preceding pronoun'],
    ['让你生成一段',            true,  '让你 prefix unchanged'],
    ['让我画个',                true,  '让我 prefix unchanged'],
    ['你写个脚本',              true,  '你 second-person — must still match'],
    ['先生成一个',              true,  '先 = adverb, not pronoun (out of scope: adverb-context FP — see scope boundary)'],

    // --- REGRESSION: PR #117/#118 first-person exclusions still hold ---
    ['我要写',                  false, 'PR #117 modal 要'],
    ['我得生成',                false, 'PR #117 modal 得'],
    ['我想画一张',              false, 'PR #117 modal 想'],
    ['我打算翻译',              false, 'PR #117 modal 打算'],
    ['我搞个',                  false, 'PR #118 bare 我+搞'],

    // --- SCOPE BOUNDARY (documented limitations — must remain `true`, not blockers) ---
    // Row 4412 full incident sentence: STILL matches via 先生成一个 adverb-context
    // clause. Adverb-context FP is out of scope this PR; PR #128 send-side
    // hard-gate is the deployed safety net for this exact case. Future R9
    // (replyer-lite / input classifier) will address adverb-context narration.
    ['所以我一般让他写的时候会先生成一个很神秘的propmt然后再给他讲讲code的风格', true, 'SCOPE BOUNDARY: row 4412 still matches via 先生成 adverb-context — out of scope this PR; PR #128 send-side guard is the safety net'],

    // 他想帮你生成个: position-anchored LB before 生成 sees `帮你` (not `他想`).
    // Same class as PR #118 row 87 (`我帮你搞个`) which is also documented as
    // out of scope (test file line 87). Widening LB to span 帮你 would
    // reintroduce FP risk on stray negation patterns. Out of scope.
    ['他想帮你生成个',          true,  'SCOPE BOUNDARY: same class as PR #118 row 87 — position-anchored LB cannot see 他想 through intervening 帮你'],
  ])('%s → match=%s (%s)', (input, expected) => {
    expect(TASK_REQUEST.test(input)).toBe(expected);
  });
});

describe('Cleanup — Item 2 verb-led sub-clause LB + Item 3 我们 plural', () => {
  it.each([
    // --- Item 2 — third-person verb-led NEGATIVE (NEW) ---
    ['他推荐一下',         false, '他 + 推荐 verb-led (NEW LB)'],
    ['她推荐个',           false, '她 + 推荐 verb-led (NEW LB)'],
    ['他念一段',           false, '他 + 念一段 verb-led (NEW LB)'],
    ['她念段',             false, '她 + 念段 verb-led (念一?段 with optional 一)'],
    ['他背一段',           false, '他 + 背一段 verb-led (NEW LB)'],
    ['它背一段',           false, '它 + 背一段 verb-led (NEW LB)'],
    ['他教编程',           false, '他 + 教.{0,5}编程 verb-led (NEW LB)'],
    ['她教教我写',         false, '她 + 教教.{0,5}写 verb-led (NEW LB)'],
    ['他继续背',           false, '他 + 继续[背念说] verb-led (NEW LB)'],
    ['她继续念',           false, '她 + 继续[背念说] verb-led (NEW LB)'],

    // --- Item 2 — first-person 我 verb-led NEGATIVE (NEW) ---
    ['我推荐一下',         false, '我 + 推荐 verb-led (NEW LB)'],
    ['我念一段',           false, '我 + 念一段 verb-led (NEW LB)'],
    ['我背一段',           false, '我 + 背一段 verb-led (NEW LB)'],
    ['我教编程',           false, '我 + 教编程 verb-led (NEW LB)'],
    ['我继续背',           false, '我 + 继续背 verb-led (NEW LB)'],

    // --- Item 3 — 我们 1st-plural NEGATIVE (NEW) ---
    ['我们要写代码',       false, '我们 + 要 + 写 (Item 3)'],
    ['我们生成一个',       false, '我们 + 生成 (Item 3)'],
    ['我们打算翻译',       false, '我们 + 打算 + 翻译 (Item 3)'],
    ['我们得画一张',       false, '我们 + 得 + 画 (Item 3)'],
    ['我们想编一个',       false, '我们 + 想 + 编 (Item 3)'],
    ['我们需要总结一下',   false, '我们 + 需要 + 总结 (Item 3)'],
    ['我们应该算一下',     false, '我们 + 应该 + 算 (Item 3)'],
    ['我们写一下',         false, '我们 + 写一下 bare-verb modal optional (Item 3)'],
    ['我们推荐个',         false, '我们 + 推荐 (Items 2+3 cross)'],
    ['我们继续念',         false, '我们 + 继续念 (Items 2+3 cross)'],

    // --- POSITIVE: bare verb-led must STILL match (no pronoun) ---
    ['推荐一下',           true,  '推荐 — bare verb-led, no pronoun'],
    ['念一段',             true,  '念一段 — bare verb-led, no pronoun'],
    ['念段',               true,  '念段 — 念一?段 with optional 一'],
    ['背一段',             true,  '背一段 — bare verb-led, no pronoun'],
    ['继续背',             true,  '继续[背念说] — bare verb-led, no pronoun'],
    ['教教我怎么写',       true,  '教教 — bare, 教 in carve-out class for 教我'],
    ['教编程',             true,  '教.{0,5}编程 — bare verb-led, no pronoun'],

    // --- POSITIVE: noun-led / abstract — MUST keep matching (LB SKIPPED per spec) ---
    ['transformer怎么用的', true, 'noun-led transformer.{0,10}怎么 — LB skipped'],
    ['代码怎么写',          true, 'noun-led 代码怎么 — LB skipped'],
    ['接龙',                false, 'bare 接龙 — peer-chat FP, must NOT match (jielong-fp PR)'],

    // --- REGRESSIONS: PR #117/#118 must still hold ---
    ['我得写个monitor系统了', false, '#117 modal 得 regression'],
    ['我要写一段代码',        false, '#117 modal 要 regression'],
    ['我搞个自动重连吧',      false, '#118 bare 我+搞 regression'],
    ['我写个代码',            false, '#118 bare 我+写 regression'],

    // --- REGRESSIONS: prefix clauses untouched ---
    ['你写个脚本',         true, 'no first-person, plain 2nd-person imperative'],
    ['帮我写个脚本',       true, '帮我 prefixed clause unchanged'],
    ['给我写个代码',       true, '给我 prefixed clause unchanged'],
    ['让我画个',           true, '让我 prefixed clause unchanged'],
  ])('%s → match=%s (%s)', (input, expected) => {
    expect(TASK_REQUEST.test(input)).toBe(expected);
  });
});

describe('Cleanup — Item 1 DEFLECT_SITUATIONS.curse no blocked terms', () => {
  it('does not contain hard-gate-blocked example terms', () => {
    const text = DEFLECT_SITUATIONS.curse;
    expect(text).not.toContain('傻逼');
    expect(text).not.toContain('神经病');
    expect(text).not.toContain('你有病吧');
  });

  it('contains at least 3 non-blocked example terms', () => {
    const text = DEFLECT_SITUATIONS.curse;
    const candidates = ['烦死了', '滚', '真烦', '别闹了', '懒得'];
    const present = candidates.filter(c => text.includes(c));
    expect(present.length).toBeGreaterThanOrEqual(3);
  });
});
