import { describe, it, expect } from 'vitest';
import { pickVariant, buildVariantSystemPrompt, type VariantContext } from '../../src/modules/prompt-variants.js';

const BASE_CTX: VariantContext = {
  activeJokeHit: false,
  sensitiveEntityHit: false,
  personaRoleCard: '冷淡但有脾气的 Roselia 主推',
  groupName: '北美炸梦同好会',
};

describe('pickVariant', () => {
  it('returns default when no signals', () => {
    expect(pickVariant(BASE_CTX)).toBe('default');
  });

  it('returns banter when activeJokeHit is true', () => {
    expect(pickVariant({ ...BASE_CTX, activeJokeHit: true })).toBe('banter');
  });

  it('returns careful when sensitiveEntityHit is true', () => {
    expect(pickVariant({ ...BASE_CTX, sensitiveEntityHit: true })).toBe('careful');
  });

  it('careful takes priority over banter when both are true', () => {
    expect(pickVariant({
      ...BASE_CTX,
      activeJokeHit: true,
      sensitiveEntityHit: true,
    })).toBe('careful');
  });

  it('handles empty personaRoleCard gracefully', () => {
    expect(pickVariant({ ...BASE_CTX, personaRoleCard: '' })).toBe('default');
  });
});

describe('buildVariantSystemPrompt', () => {
  it('always includes identity grounding with group name', () => {
    for (const variant of ['default', 'banter', 'careful'] as const) {
      const ctx: VariantContext = {
        ...BASE_CTX,
        activeJokeHit: variant === 'banter',
        sensitiveEntityHit: variant === 'careful',
      };
      const result = buildVariantSystemPrompt(ctx);
      expect(result.variant).toBe(variant);
      expect(result.systemPrompt).toContain('身份锚定');
      expect(result.systemPrompt).toContain('你 = bot = 小号');
      expect(result.systemPrompt).toContain('北美炸梦同好会');
    }
  });

  it('uses fallback group name when groupName is undefined', () => {
    const ctx: VariantContext = {
      ...BASE_CTX,
      groupName: undefined,
    };
    const result = buildVariantSystemPrompt(ctx);
    expect(result.systemPrompt).toContain('北美炸梦同好会');
  });

  it('uses custom group name when provided', () => {
    const ctx: VariantContext = {
      ...BASE_CTX,
      groupName: '测试群',
    };
    const result = buildVariantSystemPrompt(ctx);
    expect(result.systemPrompt).toContain('测试群');
    expect(result.systemPrompt).not.toContain('北美炸梦同好会');
  });

  it('includes persona role card in output', () => {
    const result = buildVariantSystemPrompt(BASE_CTX);
    expect(result.systemPrompt).toContain('冷淡但有脾气的 Roselia 主推');
  });

  it('banter variant includes banter-specific rules', () => {
    const result = buildVariantSystemPrompt({
      ...BASE_CTX,
      activeJokeHit: true,
    });
    expect(result.variant).toBe('banter');
    expect(result.systemPrompt).toContain('接梗/活跃');
    expect(result.systemPrompt).toContain('跟梗为主');
    // Must NOT contain careful rules
    expect(result.systemPrompt).not.toContain('不贬低任何 band');
  });

  it('careful variant includes careful-specific rules', () => {
    const result = buildVariantSystemPrompt({
      ...BASE_CTX,
      sensitiveEntityHit: true,
    });
    expect(result.variant).toBe('careful');
    expect(result.systemPrompt).toContain('谨慎');
    expect(result.systemPrompt).toContain('不贬低任何 band');
    // Must NOT contain banter rules
    expect(result.systemPrompt).not.toContain('接梗/活跃');
  });

  it('default variant includes default-specific rules', () => {
    const result = buildVariantSystemPrompt(BASE_CTX);
    expect(result.variant).toBe('default');
    expect(result.systemPrompt).toContain('日常');
    expect(result.systemPrompt).not.toContain('接梗/活跃');
    expect(result.systemPrompt).not.toContain('谨慎');
  });

  it('variants are replacement-based -- only one rule block present', () => {
    const markers = ['接梗/活跃', '谨慎', '日常'];
    for (const variant of ['default', 'banter', 'careful'] as const) {
      const ctx: VariantContext = {
        ...BASE_CTX,
        activeJokeHit: variant === 'banter',
        sensitiveEntityHit: variant === 'careful',
      };
      const prompt = buildVariantSystemPrompt(ctx).systemPrompt;
      const hits = markers.filter(m => prompt.includes(m));
      expect(hits).toHaveLength(1);
    }
  });

  it('never contains smart quotes', () => {
    for (const variant of ['default', 'banter', 'careful'] as const) {
      const ctx: VariantContext = {
        ...BASE_CTX,
        activeJokeHit: variant === 'banter',
        sensitiveEntityHit: variant === 'careful',
      };
      const prompt = buildVariantSystemPrompt(ctx).systemPrompt;
      expect(prompt).not.toMatch(/[\u201C\u201D\u2018\u2019]/);
    }
  });

  it('bot-identity grounding mentions bot role explicitly', () => {
    const result = buildVariantSystemPrompt(BASE_CTX);
    // Must contain "bot" reference for grounding
    expect(result.systemPrompt).toContain('bot');
    expect(result.systemPrompt).toContain('小号');
    // Must NOT use forbidden AI terms
    expect(result.systemPrompt).not.toContain('AI助手');
    // "机器人" appears in "不用...机器人" context (telling bot what NOT to say)
    // which is correct. Check it doesn't claim to BE a 机器人:
    expect(result.systemPrompt).not.toContain('我是机器人');
    expect(result.systemPrompt).not.toContain('我是一个机器人');
  });

  it('handles empty personaRoleCard without breaking structure', () => {
    const result = buildVariantSystemPrompt({
      ...BASE_CTX,
      personaRoleCard: '',
    });
    expect(result.systemPrompt).toContain('身份锚定');
    expect(result.systemPrompt).toContain('日常');
  });

  it('handles very long personaRoleCard', () => {
    const longCard = '测试'.repeat(5000);
    const result = buildVariantSystemPrompt({
      ...BASE_CTX,
      personaRoleCard: longCard,
    });
    expect(result.systemPrompt).toContain(longCard);
    expect(result.systemPrompt).toContain('身份锚定');
  });

  // UR-A #4: CAREFUL must NOT forbid admitting bot status — only claude / model.
  it('CAREFUL variant does not contain "绝不承认是 AI"', () => {
    const result = buildVariantSystemPrompt({ ...BASE_CTX, sensitiveEntityHit: true });
    expect(result.variant).toBe('careful');
    expect(result.systemPrompt).not.toContain('绝不承认是 AI');
    expect(result.systemPrompt).toContain('坦然承认');
    expect(result.systemPrompt).toContain('不承认是 claude');
  });

  // UR-A #8: SHARED_VOICE_RULES carries sparse-跟梗 rule for all variants.
  it('every variant gets sparse 跟梗 rule appended', () => {
    for (const variant of ['default', 'banter', 'careful'] as const) {
      const result = buildVariantSystemPrompt({
        ...BASE_CTX,
        activeJokeHit: variant === 'banter',
        sensitiveEntityHit: variant === 'careful',
      });
      expect(result.systemPrompt).toContain('跟梗要稀疏');
    }
  });
});
