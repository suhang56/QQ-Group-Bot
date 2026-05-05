import { describe, it, expect, vi } from 'vitest';
import {
  ReplyComposer,
  ReplyerContractError,
  LENGTH_TOLERANCE_MULTIPLIER,
  type ReplyContext,
} from '../../src/modules/reply-composer.js';
import type { Directive } from '../../src/modules/reply-planner.js';
import type { IClaudeClient, ClaudeResponse } from '../../src/ai/claude.js';
import { initLogger } from '../../src/utils/logger.js';
import { ClaudeApiError } from '../../src/utils/errors.js';

initLogger({ level: 'silent' });

// Test helpers.

function makeClaudeStub(behavior: 'resolve' | 'reject', payload?: ClaudeResponse | Error): IClaudeClient {
  return {
    complete: vi.fn().mockImplementation(() => {
      if (behavior === 'resolve') return Promise.resolve(payload as ClaudeResponse);
      return Promise.reject(payload ?? new Error('reject'));
    }),
    describeImage: vi.fn(),
    visionWithPrompt: vi.fn(),
  };
}

function makeBaseDirective(overrides: Partial<Directive> = {}): Directive {
  return {
    mode: 'reply',
    lengthBudget: 'normal',
    requiredFactIds: [],
    forbiddenTokens: [],
    toneHint: '',
    useStickerToken: null,
    source: 'llm-planner',
    latencyMs: 100,
    ...overrides,
  };
}

function makeBaseCtx(overrides: Partial<ReplyContext> = {}): ReplyContext {
  return {
    groupId: 'g1',
    triggerContent: '下场live什么时候',
    triggerNickname: 'Alice',
    systemBlocks: [{ text: 'base system prompt', cache: true }],
    userContent: 'user trigger payload',
    factsByIdMap: new Map(),
    model: 'claude-sonnet-4-6',
    maxTokens: 600,
    ...overrides,
  };
}

function makeStubResp(text: string, overrides: Partial<ClaudeResponse> = {}): ClaudeResponse {
  return {
    text,
    inputTokens: 100,
    outputTokens: text.length,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
    ...overrides,
  };
}

// §4.1 Contract-violation tests (T-1..T-4).

describe('reply-composer — contract validators', () => {
  it('T-1 throws ReplyerContractError on directive.mode === silent', async () => {
    const llm = makeClaudeStub('resolve', makeStubResp('x'));
    const composer = new ReplyComposer(llm);
    const directive = makeBaseDirective({ mode: 'silent' });
    await expect(composer.compose(directive, makeBaseCtx())).rejects.toMatchObject({
      name: 'ReplyerContractError',
      code: 'silent-directive',
    });
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('T-2 throws empty-system when systemBlocks is empty', async () => {
    const llm = makeClaudeStub('resolve', makeStubResp('x'));
    const composer = new ReplyComposer(llm);
    const ctx = makeBaseCtx({ systemBlocks: [] });
    await expect(composer.compose(makeBaseDirective(), ctx)).rejects.toMatchObject({
      name: 'ReplyerContractError',
      code: 'empty-system',
    });
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('T-3 throws empty-user when userContent is empty/whitespace', async () => {
    const llm = makeClaudeStub('resolve', makeStubResp('x'));
    const composer = new ReplyComposer(llm);
    const ctx = makeBaseCtx({ userContent: '   \n\t' });
    await expect(composer.compose(makeBaseDirective(), ctx)).rejects.toMatchObject({
      name: 'ReplyerContractError',
      code: 'empty-user',
    });
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('T-4 throws empty-model when model is empty/whitespace', async () => {
    const llm = makeClaudeStub('resolve', makeStubResp('x'));
    const composer = new ReplyComposer(llm);
    const ctx = makeBaseCtx({ model: '   ' });
    await expect(composer.compose(makeBaseDirective(), ctx)).rejects.toMatchObject({
      name: 'ReplyerContractError',
      code: 'empty-model',
    });
    expect(llm.complete).not.toHaveBeenCalled();
  });
});

// §4.2 Prompt-assembly tests (T-5..T-7).

describe('reply-composer — directive block in system array', () => {
  it('T-5 fact_answer with requiredFactIds renders must_use_facts via factsByIdMap', async () => {
    const llm = makeClaudeStub('resolve', makeStubResp('11/15福冈那场'));
    const composer = new ReplyComposer(llm);
    const directive = makeBaseDirective({
      mode: 'fact_answer',
      lengthBudget: 'short',
      requiredFactIds: ['42'],
    });
    const factsByIdMap = new Map<number, { term: string; meaning: string }>([
      [42, { term: 'ras live', meaning: '11/15福冈' }],
    ]);
    const ctx = makeBaseCtx({ factsByIdMap });
    await composer.compose(directive, ctx);
    expect(llm.complete).toHaveBeenCalledTimes(1);
    const req = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const directiveText = req.system[0].text;
    expect(directiveText).toContain('mode: fact_answer');
    expect(directiveText).toContain('must_use_facts:');
    expect(directiveText).toContain('- ras live: 11/15福冈');
    expect(req.system[0].cache).toBe(false);
  });

  it('T-6 forbiddenTokens render as avoid_repeating list (DATA, not imperative)', async () => {
    const llm = makeClaudeStub('resolve', makeStubResp('回复'));
    const composer = new ReplyComposer(llm);
    const directive = makeBaseDirective({ forbiddenTokens: ['哈哈哈', '确实'] });
    await composer.compose(directive, makeBaseCtx());
    const req = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const directiveText = req.system[0].text;
    expect(directiveText).toContain('avoid_repeating:');
    expect(directiveText).toContain('- 哈哈哈');
    expect(directiveText).toContain('- 确实');
    expect(directiveText).not.toContain('不要说');
  });

  it('T-7 useStickerToken false/null render correct sticker_hint label', async () => {
    const llm = makeClaudeStub('resolve', makeStubResp('回复'));
    const composer = new ReplyComposer(llm);
    await composer.compose(makeBaseDirective({ useStickerToken: false }), makeBaseCtx());
    let req = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req.system[0].text).toContain('sticker_hint: 建议不出贴');
    (llm.complete as ReturnType<typeof vi.fn>).mockClear();
    await composer.compose(makeBaseDirective({ useStickerToken: null }), makeBaseCtx());
    req = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req.system[0].text).toContain('sticker_hint: 随意');
  });
});

// §4.3 Sticker-positive happy path (T-13).

describe('reply-composer — sticker hint positive', () => {
  it('T-13 useStickerToken true renders sticker_hint: 建议出贴', async () => {
    const llm = makeClaudeStub('resolve', makeStubResp('回复'));
    const composer = new ReplyComposer(llm);
    await composer.compose(makeBaseDirective({ useStickerToken: true }), makeBaseCtx());
    const req = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req.system[0].text).toContain('sticker_hint: 建议出贴');
  });
});

// §4.4 Soft-violation tests (T-8, T-9).

describe('reply-composer — soft violations (observe-only)', () => {
  it('T-8 length-exceeded fires when output > Math.floor(cap * 1.3)', async () => {
    // tiny cap = 30; 1.3 * 30 = 39 (Math.floor) → threshold 39; 50 > 39 → violation
    const fiftyChar = 'a'.repeat(50);
    const llm = makeClaudeStub('resolve', makeStubResp(fiftyChar));
    const composer = new ReplyComposer(llm);
    const directive = makeBaseDirective({ lengthBudget: 'tiny' });
    const result = await composer.compose(directive, makeBaseCtx());
    expect(result.violations).toContainEqual({
      kind: 'length-exceeded', cap: 30, actual: 50,
    });
    // sanity: tolerance multiplier export available for downstream tests
    expect(LENGTH_TOLERANCE_MULTIPLIER).toBe(1.3);
  });

  it('T-9 forbidden-token fires after CJK compact-whitespace match', async () => {
    // forbidden '哈哈哈'; output '这事 哈 哈 哈 真的' compact-WS → '这事哈哈哈真的'
    const llm = makeClaudeStub('resolve', makeStubResp('这事 哈 哈 哈 真的'));
    const composer = new ReplyComposer(llm);
    const directive = makeBaseDirective({ forbiddenTokens: ['哈哈哈'] });
    const result = await composer.compose(directive, makeBaseCtx());
    expect(result.violations).toContainEqual({
      kind: 'forbidden-token', token: '哈哈哈',
    });
  });
});

// §4.5 Pass-through + immutability (T-10, T-11).

describe('reply-composer — pass-through + immutability', () => {
  it('T-10 returns LLM tokens + directive snapshot identity, empty violations on happy path', async () => {
    const resp = makeStubResp('就那场', {
      inputTokens: 100, outputTokens: 5, cacheReadTokens: 80, cacheWriteTokens: 0,
    });
    const llm = makeClaudeStub('resolve', resp);
    const composer = new ReplyComposer(llm);
    const directive = makeBaseDirective();
    const result = await composer.compose(directive, makeBaseCtx());
    expect(result.text).toBe('就那场');
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(5);
    expect(result.cacheReadTokens).toBe(80);
    expect(result.cacheWriteTokens).toBe(0);
    expect(result.violations).toEqual([]);
    expect(result.directiveSnapshot).toBe(directive);
  });

  it('T-11 does not mutate ctx.systemBlocks or directive; LLM receives prepended array', async () => {
    const llm = makeClaudeStub('resolve', makeStubResp('x'));
    const composer = new ReplyComposer(llm);
    const directive = makeBaseDirective({ forbiddenTokens: ['x'] });
    const directiveSnap = JSON.stringify(directive);
    const baseSystemBlocks = [
      { text: 'a', cache: true } as const,
      { text: 'b', cache: true } as const,
    ];
    const systemBlocksSnap = JSON.stringify(baseSystemBlocks);
    const ctx = makeBaseCtx({ systemBlocks: baseSystemBlocks });
    await composer.compose(directive, ctx);
    expect(JSON.stringify(directive)).toBe(directiveSnap);
    expect(JSON.stringify(baseSystemBlocks)).toBe(systemBlocksSnap);
    const req = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req.system).toHaveLength(3);
    expect(req.system[0].cache).toBe(false);
    expect(req.system[1].text).toBe('a');
    expect(req.system[2].text).toBe('b');
  });
});

// §4.6 Error propagation (T-12).

describe('reply-composer — error propagation', () => {
  it('T-12 propagates ClaudeApiError unchanged (no swallow, no replacement)', async () => {
    const apiError = new ClaudeApiError(new Error('rate-limited'));
    const llm = makeClaudeStub('reject', apiError);
    const composer = new ReplyComposer(llm);
    await expect(composer.compose(makeBaseDirective(), makeBaseCtx())).rejects.toBe(apiError);
  });
});
