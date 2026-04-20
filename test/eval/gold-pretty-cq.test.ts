/**
 * R6.2.2 — prettyPrintCq table-driven tests (DEV-READY §4a).
 * 17 mapping-table cases + 1 double-encode order case.
 */

import { describe, it, expect } from 'vitest';
import { prettyPrintCq } from '../../scripts/eval/gold/pretty-cq.js';

const cases: Array<{ in: string; botQQ: string | null; out: string }> = [
  { in: '[CQ:image,summary=&#91;动画表情&#93;,file=abc]', botQQ: null, out: '[img:动画表情]' },
  { in: '[CQ:image,file=abc]', botQQ: null, out: '[img]' },
  { in: '[CQ:mface,summary=&#91;哈哈&#93;,id=1]', botQQ: null, out: '[mface:哈哈]' },
  { in: '[CQ:mface,id=1]', botQQ: null, out: '[mface]' },
  { in: '[CQ:face,id=178]', botQQ: null, out: '[face:178]' },
  { in: '[CQ:at,qq=1705075399] 请我喝奶茶', botQQ: '1705075399', out: '[@bot] 请我喝奶茶' },
  { in: '[CQ:at,qq=1705075399]', botQQ: null, out: '[@user:1705075399]' },
  { in: '[CQ:at,qq=9999]', botQQ: '1705075399', out: '[@user:9999]' },
  { in: '[CQ:at,qq=all]', botQQ: null, out: '[@全体]' },
  { in: '[CQ:reply,id=42]', botQQ: null, out: '[reply:42]' },
  { in: '[CQ:video,file=x]', botQQ: null, out: '[video]' },
  { in: '[CQ:record,file=y]', botQQ: null, out: '[voice]' },
  { in: '[CQ:forward,id=q]', botQQ: null, out: '[cq:forward]' },
  { in: 'a&amp;b &#91;x&#93;', botQQ: null, out: 'a&b [x]' },
  { in: '[CQ:at,qq=1] hi [CQ:image,summary=&#91;pic&#93;,file=z] bye', botQQ: '1', out: '[@bot] hi [img:pic] bye' },
  { in: '', botQQ: null, out: '' },
  { in: 'hello world', botQQ: null, out: 'hello world' },
];

describe('prettyPrintCq — DEV-READY §4a mapping table', () => {
  it.each(cases)('in=$in botQQ=$botQQ → out=$out', ({ in: input, botQQ, out }) => {
    expect(prettyPrintCq(input, botQQ)).toBe(out);
  });
});

describe('prettyPrintCq — phase-2 entity decode order (double-encode guard)', () => {
  // `&amp;` runs LAST so `&amp;#91;` decodes to `&#91;` (one layer), NOT to `[`.
  it('shallow decode: &amp;#91;X&amp;#93; → &#91;X&#93;', () => {
    expect(prettyPrintCq('&amp;#91;X&amp;#93;', null)).toBe('&#91;X&#93;');
  });
});

describe('prettyPrintCq — acceptance gate assertions (DEV-READY §8)', () => {
  it('image with bracketed summary → [img:动画表情]', () => {
    expect(
      prettyPrintCq('[CQ:image,summary=&#91;动画表情&#93;,file=abc123]', null),
    ).toBe('[img:动画表情]');
  });

  it('at-bot: qq matches botQQ → [@bot]', () => {
    expect(
      prettyPrintCq('[CQ:at,qq=1705075399] 请我喝奶茶', '1705075399'),
    ).toBe('[@bot] 请我喝奶茶');
  });

  it('at-other: qq does not match botQQ → [@user:<qq>]', () => {
    expect(
      prettyPrintCq('[CQ:at,qq=999] hi', '1705075399'),
    ).toBe('[@user:999] hi');
  });

  it('entity decode: a&amp;b &#91;x&#93; → a&b [x]', () => {
    expect(prettyPrintCq('a&amp;b &#91;x&#93;', null)).toBe('a&b [x]');
  });
});
