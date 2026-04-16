import { describe, it, expect } from 'vitest';
import { BANGDREAM_PERSONA } from '../src/modules/chat.js';

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
