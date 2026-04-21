import { describe, it, expect } from 'vitest';
import type { GroupMessage } from '../../src/adapter/napcat.js';
import {
  personaFabricationGuard,
  hasSelfPersonaFabrication,
  pickPersonaDeflection,
  BLOCKED_SELF_ATTR_PATTERNS,
} from '../../src/utils/persona-fabrication-guard.js';
import { IDENTITY_DEFLECTIONS } from '../../src/utils/identity-deflections.js';
import type { SendGuardCtx } from '../../src/utils/send-guard-chain.js';

const ctx: SendGuardCtx = {
  groupId: 'g1',
  triggerMessage: {
    groupId: 'g1',
    userId: 'u1',
    nickname: 'u',
    content: '',
    rawContent: '',
    messageId: 'm',
    timestamp: 0,
  } as unknown as GroupMessage,
  isDirect: false,
  resultKind: 'reply',
};

describe('personaFabricationGuard — must-fire (self-attributed hard attrs)', () => {
  it('fires on 我22岁', () => {
    const r = personaFabricationGuard('我22岁', ctx);
    expect(r.passed).toBe(false);
    if (!r.passed) {
      expect(r.reason).toBe('persona-fabricated');
      expect(r.replacement).toBe('deflection');
    }
  });

  it('fires on 我 22 岁 (spaced)', () => {
    const r = personaFabricationGuard('我 22 岁', ctx);
    expect(r.passed).toBe(false);
  });

  it('fires on 我是女的', () => {
    const r = personaFabricationGuard('我是女的', ctx);
    expect(r.passed).toBe(false);
  });

  it('fires on 我是男生', () => {
    const r = personaFabricationGuard('我是男生', ctx);
    expect(r.passed).toBe(false);
  });

  it('fires on 我女的', () => {
    const r = personaFabricationGuard('我女的', ctx);
    expect(r.passed).toBe(false);
  });

  it('fires on 我身高170', () => {
    const r = personaFabricationGuard('我身高170', ctx);
    expect(r.passed).toBe(false);
  });

  it('fires on 我体重55', () => {
    const r = personaFabricationGuard('我体重55', ctx);
    expect(r.passed).toBe(false);
  });

  it('fires on 我住北京朝阳区 (specific address)', () => {
    const r = personaFabricationGuard('我住北京朝阳区', ctx);
    expect(r.passed).toBe(false);
  });

  it('fires on 我自己是女的 (自己 anchor)', () => {
    const r = personaFabricationGuard('我自己是女的', ctx);
    expect(r.passed).toBe(false);
  });

  it('fires on standalone 女的22岁 (no 我, len ≤ 15)', () => {
    const r = personaFabricationGuard('女的22岁', ctx);
    expect(r.passed).toBe(false);
  });

  it('fires on standalone 男的 (len ≤ 15)', () => {
    const r = personaFabricationGuard('男的', ctx);
    expect(r.passed).toBe(false);
  });

  it('fires post-CQ-strip (我22岁 with CQ prefix)', () => {
    const r = personaFabricationGuard('[CQ:reply,id=1] 我22岁', ctx);
    expect(r.passed).toBe(false);
  });
});

describe('personaFabricationGuard — must-NOT-fire (third-person / tsundere / honest / compound)', () => {
  it('does NOT fire on 她22岁 (3rd-person)', () => {
    const r = personaFabricationGuard('她22岁', ctx);
    expect(r.passed).toBe(true);
  });

  it('does NOT fire on 他是男的 (3rd-person)', () => {
    const r = personaFabricationGuard('他是男的', ctx);
    expect(r.passed).toBe(true);
  });

  it('does NOT fire on 拉普兰德身高170 (3rd-person named)', () => {
    const r = personaFabricationGuard('拉普兰德身高170', ctx);
    expect(r.passed).toBe(true);
  });

  it('does NOT fire on 去女生厕所 (compound word)', () => {
    const r = personaFabricationGuard('去女生厕所', ctx);
    expect(r.passed).toBe(true);
  });

  it('does NOT fire on 进男生宿舍 (compound)', () => {
    const r = personaFabricationGuard('进男生宿舍', ctx);
    expect(r.passed).toBe(true);
  });

  it('does NOT fire on 我女朋友 (compound 女朋友)', () => {
    const r = personaFabricationGuard('我女朋友今天生日', ctx);
    expect(r.passed).toBe(true);
  });

  it('does NOT fire on 自己猜 (tsundere deflection)', () => {
    const r = personaFabricationGuard('自己猜', ctx);
    expect(r.passed).toBe(true);
  });

  it('does NOT fire on 不告诉你 (tsundere deflection)', () => {
    const r = personaFabricationGuard('不告诉你', ctx);
    expect(r.passed).toBe(true);
  });

  it('does NOT fire on 问这个干嘛 (tsundere deflection)', () => {
    const r = personaFabricationGuard('问这个干嘛', ctx);
    expect(r.passed).toBe(true);
  });

  it('does NOT fire on 别研究这个 (tsundere deflection)', () => {
    const r = personaFabricationGuard('别研究这个', ctx);
    expect(r.passed).toBe(true);
  });

  it('does NOT fire on 我不知道 (honest gap)', () => {
    const r = personaFabricationGuard('我不知道', ctx);
    expect(r.passed).toBe(true);
  });

  it('does NOT fire on 我忘了 (honest gap)', () => {
    const r = personaFabricationGuard('我忘了', ctx);
    expect(r.passed).toBe(true);
  });

  it('does NOT fire on 我住在这附近 (vague chatter, 这-prefixed address)', () => {
    const r = personaFabricationGuard('我住在这附近', ctx);
    expect(r.passed).toBe(true);
  });

  it('does NOT fire on 她说她22岁了 (3rd-person embedded)', () => {
    const r = personaFabricationGuard('她说她22岁了', ctx);
    expect(r.passed).toBe(true);
  });

  it('does NOT fire on empty / whitespace', () => {
    expect(personaFabricationGuard('', ctx).passed).toBe(true);
    expect(personaFabricationGuard('   ', ctx).passed).toBe(true);
  });

  it('does NOT fire on 我22号去看演出 (date, not age)', () => {
    const r = personaFabricationGuard('我22号去看演出', ctx);
    expect(r.passed).toBe(true);
  });
});

describe('hasSelfPersonaFabrication (predicate helper)', () => {
  it('returns true for self-attributed hard attr', () => {
    expect(hasSelfPersonaFabrication('我22岁')).toBe(true);
    expect(hasSelfPersonaFabrication('我是女的')).toBe(true);
    expect(hasSelfPersonaFabrication('女的22岁')).toBe(true);
  });

  it('returns false for empty / 3rd-person / tsundere / compound', () => {
    expect(hasSelfPersonaFabrication('')).toBe(false);
    expect(hasSelfPersonaFabrication('她22岁')).toBe(false);
    expect(hasSelfPersonaFabrication('自己猜')).toBe(false);
    expect(hasSelfPersonaFabrication('去男生宿舍')).toBe(false);
  });

  it('strips CQ before match', () => {
    expect(hasSelfPersonaFabrication('[CQ:reply,id=1] 我22岁')).toBe(true);
    expect(hasSelfPersonaFabrication('[CQ:reply,id=1] 自己猜')).toBe(false);
  });
});

describe('pickPersonaDeflection', () => {
  it('returns an item from IDENTITY_DEFLECTIONS pool', () => {
    for (let i = 0; i < 50; i++) {
      const pick = pickPersonaDeflection();
      expect(IDENTITY_DEFLECTIONS).toContain(pick);
    }
  });
});

describe('BLOCKED_SELF_ATTR_PATTERNS shape', () => {
  it('has 5 patterns (gender / age / metric / address / 自己-gender)', () => {
    expect(BLOCKED_SELF_ATTR_PATTERNS.length).toBe(5);
  });

  it('no pattern fires on 3rd-person 她/他', () => {
    for (const re of BLOCKED_SELF_ATTR_PATTERNS) {
      expect(re.test('她22岁')).toBe(false);
      expect(re.test('他是男的')).toBe(false);
    }
  });
});
