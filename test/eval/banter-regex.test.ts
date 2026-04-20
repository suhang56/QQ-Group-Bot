import { describe, it, expect } from 'vitest';
import { BANTER_REGEXES, matchesBanterRegex } from '../../scripts/eval/banter-regex.js';

describe('banter-regex — positive per pattern', () => {
  it('matches 哈哈', () => expect(matchesBanterRegex('哈哈')).toBe(true));
  it('matches 嘿嘿', () => expect(matchesBanterRegex('嘿嘿')).toBe(true));
  it('matches 嘻嘻', () => expect(matchesBanterRegex('嘻嘻')).toBe(true));
  it('matches 呵呵', () => expect(matchesBanterRegex('呵呵')).toBe(true));
  it('matches 笑死', () => expect(matchesBanterRegex('笑死')).toBe(true));
  it('matches 草 alone', () => expect(matchesBanterRegex('草')).toBe(true));
  it('matches 草草草', () => expect(matchesBanterRegex('草草草')).toBe(true));
  it('matches 233', () => expect(matchesBanterRegex('233')).toBe(true));
  it('matches 2333', () => expect(matchesBanterRegex('2333')).toBe(true));
  it('matches !!!', () => expect(matchesBanterRegex('你好!!!')).toBe(true));
  it('matches 啊啊啊啊 (vowel stretch)', () => expect(matchesBanterRegex('啊啊啊啊')).toBe(true));
  it('matches 哈哈哈哈哈哈', () => expect(matchesBanterRegex('哈哈哈哈哈哈')).toBe(true));
  it('matches particle-stack 啊 呀', () => expect(matchesBanterRegex('啊 呀')).toBe(true));
  it('matches yyds (case insensitive)', () => expect(matchesBanterRegex('真的YYDS')).toBe(true));
  it('matches 绝绝子', () => expect(matchesBanterRegex('这个绝绝子')).toBe(true));
  it('matches nb啊', () => expect(matchesBanterRegex('NB啊')).toBe(true));
  it('matches 绝了', () => expect(matchesBanterRegex('绝了')).toBe(true));
  it('matches 芜湖', () => expect(matchesBanterRegex('芜湖起飞')).toBe(true));
  it('matches 奥利给', () => expect(matchesBanterRegex('奥利给')).toBe(true));
  it('matches bare 哈', () => expect(matchesBanterRegex('哈')).toBe(true));
  it('matches emoji burst', () => expect(matchesBanterRegex('😀😀😀')).toBe(true));
  it('matches port-233 (accepted FP per DESIGN §6.2)', () =>
    expect(matchesBanterRegex(':233/tcp')).toBe(true));
});

describe('banter-regex — negative (non-banter substance)', () => {
  it('does not match 单个 哈 in substantive reply', () => {
    expect(matchesBanterRegex('好的, 我知道了')).toBe(false);
  });
  it('does not match 啊 alone', () =>
    expect(matchesBanterRegex('啊')).toBe(false));
  it('does not match single exclamation', () =>
    expect(matchesBanterRegex('好!')).toBe(false));
  it('does not match double exclamation', () =>
    expect(matchesBanterRegex('好!!')).toBe(false));
  it('does not match 草泥马 (insult, not banter)', () =>
    expect(matchesBanterRegex('草泥马')).toBe(false));
  it('empty string returns false', () =>
    expect(matchesBanterRegex('')).toBe(false));
  it('null-ish input returns false', () =>
    expect(matchesBanterRegex(undefined as unknown as string)).toBe(false));
  it('单个 emoji does not trigger burst', () =>
    expect(matchesBanterRegex('👍')).toBe(false));
  it('正常 Chinese sentence no match', () =>
    expect(matchesBanterRegex('今天的天气不错')).toBe(false));
});

describe('BANTER_REGEXES export stability', () => {
  it('exposes 18 patterns frozen', () => {
    expect(BANTER_REGEXES.length).toBe(18);
  });
});
