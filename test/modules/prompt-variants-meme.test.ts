import { describe, it, expect } from 'vitest';
import { buildVariantSystemPrompt, type VariantContext, type ActiveMemeJoke } from '../../src/modules/prompt-variants.js';

const BASE_CTX: VariantContext = {
  activeJokeHit: false,
  sensitiveEntityHit: false,
  personaRoleCard: '冷淡但有脾气的 Roselia 主推',
  groupName: '北美炸梦同好会',
};

describe('buildVariantSystemPrompt meme injection', () => {
  it('banter variant with meme-backed activeJoke contains meme tag line', () => {
    const memes: ActiveMemeJoke[] = [
      { canonical: '何意味', meaning: '表示困惑或不解' },
    ];
    const result = buildVariantSystemPrompt({
      ...BASE_CTX,
      activeJokeHit: true,
      activeMemeJokes: memes,
    });
    expect(result.variant).toBe('banter');
    expect(result.systemPrompt).toContain('[当前正活跃的梗: 何意味 -- 表示困惑或不解]');
  });

  it('banter variant with multiple meme jokes lists all', () => {
    const memes: ActiveMemeJoke[] = [
      { canonical: '何意味', meaning: '表示困惑' },
      { canonical: '智械危机', meaning: 'bot 太像人' },
    ];
    const result = buildVariantSystemPrompt({
      ...BASE_CTX,
      activeJokeHit: true,
      activeMemeJokes: memes,
    });
    expect(result.systemPrompt).toContain('何意味 -- 表示困惑');
    expect(result.systemPrompt).toContain('智械危机 -- bot 太像人');
  });

  it('default variant does NOT inject meme tag even with activeMemeJokes', () => {
    const memes: ActiveMemeJoke[] = [
      { canonical: '何意味', meaning: '表示困惑' },
    ];
    const result = buildVariantSystemPrompt({
      ...BASE_CTX,
      activeJokeHit: false, // default variant
      activeMemeJokes: memes,
    });
    expect(result.variant).toBe('default');
    expect(result.systemPrompt).not.toContain('当前正活跃的梗');
  });

  it('careful variant does NOT inject meme tag even with activeMemeJokes', () => {
    const memes: ActiveMemeJoke[] = [
      { canonical: '何意味', meaning: '表示困惑' },
    ];
    const result = buildVariantSystemPrompt({
      ...BASE_CTX,
      sensitiveEntityHit: true,
      activeJokeHit: true,
      activeMemeJokes: memes,
    });
    expect(result.variant).toBe('careful');
    expect(result.systemPrompt).not.toContain('当前正活跃的梗');
  });

  it('banter variant without activeMemeJokes has no meme tag', () => {
    const result = buildVariantSystemPrompt({
      ...BASE_CTX,
      activeJokeHit: true,
    });
    expect(result.variant).toBe('banter');
    expect(result.systemPrompt).not.toContain('当前正活跃的梗');
  });

  it('banter variant with empty activeMemeJokes array has no meme tag', () => {
    const result = buildVariantSystemPrompt({
      ...BASE_CTX,
      activeJokeHit: true,
      activeMemeJokes: [],
    });
    expect(result.variant).toBe('banter');
    expect(result.systemPrompt).not.toContain('当前正活跃的梗');
  });

  it('meme tag line has no smart quotes', () => {
    const memes: ActiveMemeJoke[] = [
      { canonical: '何意味', meaning: '表示困惑' },
    ];
    const result = buildVariantSystemPrompt({
      ...BASE_CTX,
      activeJokeHit: true,
      activeMemeJokes: memes,
    });
    expect(result.systemPrompt).not.toMatch(/[\u201C\u201D\u2018\u2019]/);
  });
});
