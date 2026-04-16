import { describe, it, expect } from 'vitest';
import { BANGDREAM_PERSONA, detectMoodSignal, buildMoodHint } from '../src/modules/chat.js';

// ── T0: Persona 词池/例子改写验证 ─────────────────────────────────────────

describe('T0 — persona playful/接梗 词池', () => {
  it('BANGDREAM_PERSONA 包含接梗/playful 示例词', () => {
    // 至少包含这些 playful 词池中的若干关键词
    const playfulTerms = ['接梗', '跟着玩', '我也要', '懂了懂了'];
    const matches = playfulTerms.filter(t => BANGDREAM_PERSONA.includes(t));
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('集体称呼例子不再包含居高临下旁观语气', () => {
    // 旧的 dismissive 集体称呼例子应该被替换
    expect(BANGDREAM_PERSONA).not.toContain('看你们唐的');
    expect(BANGDREAM_PERSONA).not.toContain('你们这群人聊得真起劲');
    expect(BANGDREAM_PERSONA).not.toContain('你们都疯了吧');
  });

  it('集体称呼例子包含中性/跟着玩语气', () => {
    const neutralExamples = ['你们玩什么呢', '突然好热闹', '我也要'];
    const matches = neutralExamples.filter(t => BANGDREAM_PERSONA.includes(t));
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('仍然保留 dismissive 拒绝词池（边界感没被删）', () => {
    expect(BANGDREAM_PERSONA).toContain('烦');
    expect(BANGDREAM_PERSONA).toContain('关我屁事');
    expect(BANGDREAM_PERSONA).toContain('想屁吃');
  });

  it('圈内底线段未被改动', () => {
    expect(BANGDREAM_PERSONA).toContain('圈内底线');
    expect(BANGDREAM_PERSONA).toContain('Roselia');
    expect(BANGDREAM_PERSONA).toContain('恶意攻击声优');
  });
});

// ── T1: 情绪信号注入验证 ──────────────────────────────────────────────────

describe('T1 — detectMoodSignal', () => {
  it('playful: 2+ 条含梗词时返回 playful', () => {
    const msgs = [
      { content: '咕咕嘎嘎' },
      { content: '哈哈哈笑死' },
      { content: '这个梗太好了' },
    ];
    expect(detectMoodSignal(msgs)).toBe('playful');
  });

  it('tense: 2+ 条含负向词时返回 tense', () => {
    const msgs = [
      { content: '你滚吧' },
      { content: '操你妈的' },
      { content: '别闹了' },
    ];
    expect(detectMoodSignal(msgs)).toBe('tense');
  });

  it('无明显信号时返回 null', () => {
    const msgs = [
      { content: '今天天气不错' },
      { content: '刚吃完饭' },
      { content: '准备睡了' },
    ];
    expect(detectMoodSignal(msgs)).toBeNull();
  });

  it('单条梗词不触发（阈值 >= 2）', () => {
    const msgs = [
      { content: '哈哈' },
      { content: '今天好无聊' },
      { content: '吃啥' },
    ];
    expect(detectMoodSignal(msgs)).toBeNull();
  });

  it('空消息列表返回 null', () => {
    expect(detectMoodSignal([])).toBeNull();
  });

  it('只看最近 windowSize 条（默认 5）', () => {
    // 前 3 条 playful，但超出窗口
    const msgs = [
      { content: '哈哈哈' },
      { content: '笑死' },
      { content: '草' },
      { content: '今天上班' },
      { content: '好累' },
      { content: '吃饭了' },
      { content: '准备开会' },
      { content: '下班了' },
    ];
    expect(detectMoodSignal(msgs)).toBeNull();
  });

  it('tense 优先于 playful（混合场景）', () => {
    const msgs = [
      { content: '哈哈哈' },
      { content: '笑死' },
      { content: '你滚' },
      { content: '傻逼' },
    ];
    // Both >= 2, tense checked first
    expect(detectMoodSignal(msgs)).toBe('tense');
  });
});

describe('T1 — buildMoodHint', () => {
  it('playful mood 返回玩梗提示', () => {
    const hint = buildMoodHint('playful');
    expect(hint).toContain('玩梗');
    expect(hint).toContain('跟着玩');
  });

  it('tense mood 返回谨慎提示', () => {
    const hint = buildMoodHint('tense');
    expect(hint).toContain('紧张');
  });

  it('null mood 返回空字符串', () => {
    expect(buildMoodHint(null)).toBe('');
  });

  it('hint 不包含 <skip> 控制 token', () => {
    expect(buildMoodHint('playful')).not.toContain('<skip>');
    expect(buildMoodHint('tense')).not.toContain('<skip>');
  });
});
