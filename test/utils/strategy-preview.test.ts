import { describe, it, expect, vi } from 'vitest';
import { classifyUtteranceAct } from '../../src/utils/strategy-preview.js';
import type { StrategyPreviewContext } from '../../src/utils/utterance-act.js';

const blank5: StrategyPreviewContext['recent5Msgs'] = [];

function ctx(opts: Partial<{
  content: string;
  isDirect: boolean;
  isAtMention: boolean;
  shouldReply: boolean;
  recent5: StrategyPreviewContext['recent5Msgs'];
  hasKnownFactTerm: boolean;
  hasRealFactHit: boolean | undefined;
  relayHit: boolean;
  rawContent: string;
}> = {}): StrategyPreviewContext {
  return {
    msg: {
      content: opts.content ?? '',
      rawContent: opts.rawContent,
      isDirect: opts.isDirect ?? false,
      isAtMention: opts.isAtMention ?? false,
      shouldReply: opts.shouldReply ?? true,
    },
    recent5Msgs: opts.recent5 ?? blank5,
    hasKnownFactTerm: opts.hasKnownFactTerm ?? false,
    hasRealFactHit: opts.hasRealFactHit,
    relayHit: opts.relayHit ?? false,
  };
}

describe('classifyUtteranceAct — Designer rows 1–23', () => {
  it('row 1: relay forwarded chain', () => {
    expect(classifyUtteranceAct(ctx({ content: '哈哈', relayHit: true }))).toBe('relay');
  });
  it('row 2: relay repeat echo', () => {
    expect(classifyUtteranceAct(ctx({ content: '+1', relayHit: true }))).toBe('relay');
  });
  it('row 3: relay false → not relay', () => {
    expect(classifyUtteranceAct(ctx({ content: '你好', relayHit: false }))).not.toBe('relay');
  });
  it('row 4: conflict 干架', () => {
    expect(classifyUtteranceAct(ctx({ content: '你俩别再干架了' }))).toBe('conflict_handle');
  });
  it('row 5: conflict 冲突', () => {
    expect(classifyUtteranceAct(ctx({ content: '现在冲突很激烈' }))).toBe('conflict_handle');
  });
  it('row 6: no conflict in normal msg', () => {
    expect(classifyUtteranceAct(ctx({ content: '今天天气不错' }))).not.toBe('conflict_handle');
  });
  it('row 7: summarize direct', () => {
    expect(classifyUtteranceAct(ctx({ content: '总结一下', isDirect: true, isAtMention: true }))).toBe('summarize');
  });
  it('row 8: summarize keyword non-direct', () => {
    expect(classifyUtteranceAct(ctx({ content: '帮我总结一下' }))).toBe('summarize');
  });
  it('row 9: 啥情况 alone NOT summarize', () => {
    expect(classifyUtteranceAct(ctx({ content: '啥情况' }))).not.toBe('summarize');
  });
  it('row 10: bot_status_query @bot + 停机', () => {
    expect(classifyUtteranceAct(ctx({ content: '@bot 你停机了吗', isAtMention: true }))).toBe('bot_status_query');
  });
  it('row 11: bot_status_query direct + recent5 has bot', () => {
    expect(classifyUtteranceAct(ctx({
      content: '现在策略是什么', isDirect: true,
      recent5: [{ content: '这bot有点问题', userId: 'u1' }],
    }))).toBe('bot_status_query');
  });
  it('row 12: meta_admin_status 群聊 + recent5 被禁', () => {
    expect(classifyUtteranceAct(ctx({
      content: '哎刚才那条',
      recent5: [{ content: 'bot被禁言了', userId: 'u1' }],
    }))).toBe('meta_admin_status');
  });
  it('row 13: meta_admin_status 现在策略 + 被管', () => {
    expect(classifyUtteranceAct(ctx({
      content: '现在策略是什么',
      recent5: [{ content: 'bot又被管了', userId: 'u1' }],
    }))).toBe('meta_admin_status');
  });
  it('row 14: no bot referent → fall through', () => {
    const got = classifyUtteranceAct(ctx({
      content: '现在天气怎么样',
      recent5: [{ content: '我刚下班', userId: 'u1' }],
    }));
    expect(got).not.toBe('bot_status_query');
    expect(got).not.toBe('meta_admin_status');
  });
  it('row 15: object_react pure image', () => {
    expect(classifyUtteranceAct(ctx({ content: '[CQ:image,file=abc.jpg,url=...]' }))).toBe('object_react');
  });
  it('row 16: object_react mface + 哈哈哈', () => {
    expect(classifyUtteranceAct(ctx({ content: '[CQ:mface,id=1234]哈哈哈' }))).toBe('object_react');
  });
  it('row 17: image + question NOT object_react', () => {
    expect(classifyUtteranceAct(ctx({ content: '[CQ:image,file=x.jpg]这是谁?' }))).not.toBe('object_react');
  });
  it('row 18: long caption (13 chars) NOT object_react', () => {
    expect(classifyUtteranceAct(ctx({ content: '[CQ:image,file=x.jpg]这是十三个字啊真的有十三呢' }))).not.toBe('object_react');
  });
  it('row 19: hasKnownFactTerm=true NOT object_react', () => {
    expect(classifyUtteranceAct(ctx({ content: '[CQ:image,file=x.jpg]凉凉', hasKnownFactTerm: true }))).not.toBe('object_react');
  });
  it('row 20: hasRealFactHit=undefined → uses hasKnownFactTerm only', () => {
    expect(classifyUtteranceAct(ctx({
      content: '[CQ:image,file=x.jpg]哈哈',
      hasKnownFactTerm: false, hasRealFactHit: undefined,
    }))).toBe('object_react');
  });
  it('row 21: direct_chat plain text (no bot terms)', () => {
    expect(classifyUtteranceAct(ctx({ content: '你好啊', isDirect: true }))).toBe('direct_chat');
  });
  it('row 22: chime_in shouldReply=true non-direct', () => {
    expect(classifyUtteranceAct(ctx({ content: '我也觉得' }))).toBe('chime_in');
  });
  it('row 23: chime_in shouldReply=true no image', () => {
    expect(classifyUtteranceAct(ctx({ content: '哎随便聊聊' }))).toBe('chime_in');
  });
});

describe('classifyUtteranceAct — boundary edges', () => {
  it('CQ-strip length exactly 12 → object_react', () => {
    expect(classifyUtteranceAct(ctx({ content: '[CQ:image,file=a]这是十二个字啊真的有十二' }))).toBe('object_react');
  });
  it('CQ-strip length exactly 1 → object_react', () => {
    expect(classifyUtteranceAct(ctx({ content: '[CQ:image,file=a]啊' }))).toBe('object_react');
  });
  it('hasRealFactHit=true blocks object_react', () => {
    expect(classifyUtteranceAct(ctx({ content: '[CQ:image,file=a]哈', hasRealFactHit: true }))).not.toBe('object_react');
  });
  it('hasRealFactHit=false (defined) allows object_react', () => {
    expect(classifyUtteranceAct(ctx({ content: '[CQ:image,file=a]哈', hasRealFactHit: false }))).toBe('object_react');
  });
  it('relay precedes conflict', () => {
    expect(classifyUtteranceAct(ctx({ content: '干架', relayHit: true }))).toBe('relay');
  });
  it('conflict precedes object_react', () => {
    expect(classifyUtteranceAct(ctx({ content: '[CQ:image,file=a]干架' }))).toBe('conflict_handle');
  });
  it('bot-referent window precedes object_react: 啥情况+bot referent', () => {
    expect(classifyUtteranceAct(ctx({
      content: '啥情况',
      recent5: [{ content: 'bot又被禁', userId: 'u1' }],
    }))).toBe('meta_admin_status');
  });
  it('TLDR uppercase → summarize (case-insensitive)', () => {
    expect(classifyUtteranceAct(ctx({ content: 'TLDR一下' }))).toBe('summarize');
  });
  it('multi-CQ content strips both, retains text for length check', () => {
    expect(classifyUtteranceAct(ctx({ content: '[CQ:image,file=a][CQ:at,qq=123]哈哈' }))).toBe('object_react');
  });
});

describe('classifyUtteranceAct — static constraint (row 28)', () => {
  it('makes no async/Promise/IO/db calls', () => {
    // Spy on the only candidates that could leak: global Promise + setTimeout + fetch.
    const promiseSpy = vi.spyOn(Promise, 'resolve');
    const promiseAllSpy = vi.spyOn(Promise, 'all');
    classifyUtteranceAct(ctx({ content: '帮我总结', isDirect: false }));
    classifyUtteranceAct(ctx({ content: '[CQ:image,file=a]哈哈' }));
    classifyUtteranceAct(ctx({ content: 'bot又被禁', recent5: blank5 }));
    expect(promiseSpy).not.toHaveBeenCalled();
    expect(promiseAllSpy).not.toHaveBeenCalled();
    promiseSpy.mockRestore();
    promiseAllSpy.mockRestore();
  });

  it('source contains no async/await/Promise./fetch/import(', () => {
    const src = classifyUtteranceAct.toString();
    expect(src).not.toMatch(/\basync\s/);
    expect(src).not.toMatch(/\bawait\s/);
    expect(src).not.toMatch(/\bPromise\./);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/\bimport\s*\(/);
  });
});
