import { describe, it, expect } from 'vitest';
import { TASK_REQUEST, DEFLECT_SITUATIONS } from '../../src/modules/chat';

const isRecite = /(背|续写|恩师|接下[一]?句|继续[背念说]|(?:让你|你来|教你|你要)接龙|(?:诗词|名字|课文|长文|古诗)接龙)/i;

describe('TASK_REQUEST regex 接龙 false-positive', () => {
  it('民宿接龙 peer-chat', () => {
    expect(TASK_REQUEST.test('卧槽民宿的接龙怎么那么多人了')).toBe(false);
  });
  it('民宿接龙 passive observation', () => {
    expect(TASK_REQUEST.test('我看我们民宿也太多人接龙了')).toBe(false);
  });
  it('报名接龙 signup chain', () => {
    expect(TASK_REQUEST.test('报名接龙在哪里')).toBe(false);
  });
  it('拼车接龙 carpooling chain', () => {
    expect(TASK_REQUEST.test('拼车接龙看群文件')).toBe(false);
  });
  it('二维码接龙 QR code chain', () => {
    expect(TASK_REQUEST.test('二维码接龙发了吗')).toBe(false);
  });
  it('接龙人数已满 headcount full', () => {
    expect(TASK_REQUEST.test('接龙人数已经满了')).toBe(false);
  });
  it('群里在搞接龙 group-activity noun', () => {
    expect(TASK_REQUEST.test('群里在搞接龙')).toBe(false);
  });
  it('看你接龙没了 peer-chat about bot activity — must NOT match', () => {
    expect(TASK_REQUEST.test('看你接龙没了')).toBe(false);
  });
  it('我们看你接龙 peer-chat about bot activity — must NOT match', () => {
    expect(TASK_REQUEST.test('我们看你接龙')).toBe(false);
  });

  it('让你接龙 directed imperative', () => {
    expect(TASK_REQUEST.test('让你接龙第一个字')).toBe(true);
  });
  it('你来接龙 directed form', () => {
    expect(TASK_REQUEST.test('你来接龙这首诗')).toBe(true);
  });
  it('教你接龙 teaching form', () => {
    expect(TASK_REQUEST.test('教你接龙古诗')).toBe(true);
  });
  it('诗词接龙 creative noun qualifier', () => {
    expect(TASK_REQUEST.test('诗词接龙开始')).toBe(true);
  });
  it('名字接龙 name qualifier', () => {
    expect(TASK_REQUEST.test('名字接龙轮到你')).toBe(true);
  });
  it('课文接龙 textbook qualifier', () => {
    expect(TASK_REQUEST.test('课文接龙到这')).toBe(true);
  });

  it('你接龙下一句 — FN accepted: bare-你 dropped to prevent peer-chat FP', () => {
    expect(TASK_REQUEST.test('你接龙下一句')).toBe(false);
  });
  it('她说你接龙吧 — FN accepted: reported speech, bare-你 dropped', () => {
    expect(TASK_REQUEST.test('她说你接龙吧')).toBe(false);
  });

  it('帮我写 control: must still match', () => {
    expect(TASK_REQUEST.test('帮我写一首诗')).toBe(true);
  });
  it('接下一句 control: must still match', () => {
    expect(TASK_REQUEST.test('接下一句是什么')).toBe(true);
  });
  it('今天吃什么 control: must not match', () => {
    expect(TASK_REQUEST.test('今天吃什么')).toBe(false);
  });
});

describe('isRecite regex 接龙 false-positive', () => {
  it('民宿接龙 peer-chat', () => {
    expect(isRecite.test('卧槽民宿的接龙怎么那么多人了')).toBe(false);
  });
  it('民宿接龙 passive observation', () => {
    expect(isRecite.test('我看我们民宿也太多人接龙了')).toBe(false);
  });
  it('报名接龙 signup chain', () => {
    expect(isRecite.test('报名接龙在哪里')).toBe(false);
  });
  it('拼车接龙 carpooling chain', () => {
    expect(isRecite.test('拼车接龙看群文件')).toBe(false);
  });
  it('二维码接龙 QR code chain', () => {
    expect(isRecite.test('二维码接龙发了吗')).toBe(false);
  });
  it('接龙人数已满 headcount full', () => {
    expect(isRecite.test('接龙人数已经满了')).toBe(false);
  });
  it('群里在搞接龙 group-activity noun', () => {
    expect(isRecite.test('群里在搞接龙')).toBe(false);
  });
  it('看你接龙没了 peer-chat about bot activity — must NOT match', () => {
    expect(isRecite.test('看你接龙没了')).toBe(false);
  });
  it('我们看你接龙 peer-chat about bot activity — must NOT match', () => {
    expect(isRecite.test('我们看你接龙')).toBe(false);
  });

  it('让你接龙 directed imperative', () => {
    expect(isRecite.test('让你接龙第一个字')).toBe(true);
  });
  it('你来接龙 directed form', () => {
    expect(isRecite.test('你来接龙这首诗')).toBe(true);
  });
  it('教你接龙 teaching form', () => {
    expect(isRecite.test('教你接龙古诗')).toBe(true);
  });
  it('诗词接龙 creative noun qualifier', () => {
    expect(isRecite.test('诗词接龙开始')).toBe(true);
  });
  it('名字接龙 name qualifier', () => {
    expect(isRecite.test('名字接龙轮到你')).toBe(true);
  });
  it('课文接龙 textbook qualifier', () => {
    expect(isRecite.test('课文接龙到这')).toBe(true);
  });

  it('你接龙下一句 — FN accepted per north-star', () => {
    expect(isRecite.test('你接龙下一句')).toBe(false);
  });
  it('她说你接龙吧 — FN accepted per north-star', () => {
    expect(isRecite.test('她说你接龙吧')).toBe(false);
  });
});

describe('must-NOT-fire additional guard scenarios', () => {
  it('班级接龙游戏 third-party activity', () => {
    expect(TASK_REQUEST.test('今天我们班搞接龙游戏')).toBe(false);
  });
  it('接龙接了20个人 descriptive observation', () => {
    expect(TASK_REQUEST.test('接龙接了20个人了好厉害')).toBe(false);
  });
  it('我也参加接龙 first-person participation', () => {
    expect(TASK_REQUEST.test('我也参加接龙')).toBe(false);
  });
  it('接龙群发出来了 noun-only directive', () => {
    expect(TASK_REQUEST.test('接龙群发出来了')).toBe(false);
  });
  it('他在接龙 third-person subject', () => {
    expect(TASK_REQUEST.test('他在接龙')).toBe(false);
  });
  it('他来接龙 third-person directed form', () => {
    expect(TASK_REQUEST.test('他来接龙')).toBe(false);
  });
});

describe('DEFLECT_SITUATIONS.recite prompt', () => {
  it('recite prompt does not contain literal 接龙', () => {
    expect(DEFLECT_SITUATIONS.recite).not.toContain('接龙');
  });
});
