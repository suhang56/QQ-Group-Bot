import { describe, it, expect } from 'vitest';
import { BANGDREAM_PERSONA, detectMoodSignal, buildMoodHint, extractSkeleton, skeletonSimilarity } from '../src/modules/chat.js';

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

// ── T2: 骨架级近重复检测验证 ──────────────────────────────────────────────

describe('T2 — extractSkeleton', () => {
  it('保留虚词和标点，内容词替换为 _', () => {
    const skel = extractSkeleton('你们又在咕咕嘎嘎了？');
    // 你们 + 又 + 在 should be kept; 咕咕嘎嘎 → _; 了 kept; ？ kept
    expect(skel).toContain('你们');
    expect(skel).toContain('又');
    expect(skel).toContain('在');
    expect(skel).toContain('了');
    expect(skel).toContain('？');
    expect(skel).toContain('_');
  });

  it('两条相同骨架不同内容词生成高相似度骨架', () => {
    const skel1 = extractSkeleton('你们又在咕咕嘎嘎了');
    const skel2 = extractSkeleton('你们又在搞什么东西了');
    // Both have the pattern: 你们又在_了
    // Similarity should be very high
    expect(skeletonSimilarity(skel1, skel2)).toBeGreaterThan(0.6);
  });

  it('完全不同骨架生成不同结果', () => {
    const skel1 = extractSkeleton('你们又在咕咕嘎嘎了？');
    const skel2 = extractSkeleton('今天天气真好啊');
    expect(skel1).not.toBe(skel2);
  });

  it('空字符串返回空', () => {
    expect(extractSkeleton('')).toBe('');
    expect(extractSkeleton('  ')).toBe('');
  });

  it('纯虚词句子不含 _ 槽位', () => {
    const skel = extractSkeleton('你也是吗？');
    expect(skel).not.toContain('_');
    expect(skel).toContain('你');
    expect(skel).toContain('也');
    expect(skel).toContain('是');
  });

  it('保留中文标点', () => {
    const skel = extractSkeleton('烦不烦啊！');
    expect(skel).toContain('不');
    expect(skel).toContain('啊');
    expect(skel).toContain('！');
  });
});

describe('T2 — skeletonSimilarity', () => {
  it('相同骨架返回 1.0', () => {
    const skel = extractSkeleton('你们又在咕咕嘎嘎了？');
    expect(skeletonSimilarity(skel, skel)).toBe(1);
  });

  it('同骨架不同词的两条回复相似度高 (>0.6，超过检测阈值)', () => {
    const a = extractSkeleton('你们又在咕咕嘎嘎了？');
    const b = extractSkeleton('你们又在说什么黑话了？');
    expect(skeletonSimilarity(a, b)).toBeGreaterThan(0.6);
  });

  it('完全不同骨架相似度低 (<0.5)', () => {
    const a = extractSkeleton('你们又在咕咕嘎嘎了？');
    const b = extractSkeleton('好的我知道了');
    expect(skeletonSimilarity(a, b)).toBeLessThan(0.5);
  });

  it('空字符串返回 0', () => {
    expect(skeletonSimilarity('', '你们')).toBe(0);
    expect(skeletonSimilarity('你们', '')).toBe(0);
  });

  it('核心用例：「你们又在 X 了」连发第二条被 flag', () => {
    // These two replies have different content words but same structural pattern
    const reply1 = '你们又在咕咕嘎嘎了';
    const reply2 = '你们又在搞什么东西了';
    const skel1 = extractSkeleton(reply1);
    const skel2 = extractSkeleton(reply2);
    // Skeleton similarity should exceed the 0.6 threshold
    expect(skeletonSimilarity(skel1, skel2)).toBeGreaterThan(0.6);
  });

  it('不同长度的句子（一短一长）相似度低', () => {
    const short = '你们又在咕咕嘎嘎了';
    const long = '你们又在咕咕嘎嘎了？烦不烦啊今天又是这样';
    const skelShort = extractSkeleton(short);
    const skelLong = extractSkeleton(long);
    // Short vs long with extra clauses — should NOT be flagged as dup
    expect(skeletonSimilarity(skelShort, skelLong)).toBeLessThan(0.7);
  });
});
