import { describe, it, expect, vi } from 'vitest';
import {
  ReplyPlanner,
  validateDirective,
  buildFallbackDirective,
  tolerantParseDirective,
  extractTopTokens,
  assembleDirectiveBlock,
  directiveToJson,
  R9_PLANNER_TIMEOUT_MS,
  type ValidateContext,
  type FallbackSeed,
  type PlannerContext,
  type Directive,
} from '../../src/modules/reply-planner.js';
import type { IClaudeClient, ClaudeResponse } from '../../src/ai/claude.js';
import { initLogger, createLogger } from '../../src/utils/logger.js';
import { ClaudeApiError } from '../../src/utils/errors.js';

initLogger({ level: 'silent' });

function makeClaudeStub(behavior: 'resolve' | 'reject' | 'never', payload?: string | Error): IClaudeClient {
  return {
    complete: vi.fn().mockImplementation(() => {
      if (behavior === 'resolve') {
        return Promise.resolve({
          text: payload as string,
          inputTokens: 10, outputTokens: 5,
          cacheReadTokens: 0, cacheWriteTokens: 0,
        } satisfies ClaudeResponse);
      }
      if (behavior === 'reject') {
        return Promise.reject(payload ?? new Error('reject'));
      }
      // 'never' — return an unresolving promise so the timeout path fires.
      return new Promise<ClaudeResponse>(() => { /* never */ });
    }),
    describeImage: vi.fn(),
    visionWithPrompt: vi.fn(),
  };
}

function makeBaseCtx(overrides: Partial<PlannerContext> = {}): PlannerContext {
  return {
    groupId: 'g1',
    triggerContent: '下场live什么时候',
    triggerNickname: 'Alice',
    recentChrono: [],
    facts: [],
    signals: {
      isAt: false,
      isReplyToBot: false,
      hasRealFactHit: false,
      utteranceAct: 'direct_chat',
      dNonBot: 1,
      affinityFactor: 0.5,
      inDirectCooldown: false,
    },
    recentBotOutputs: [],
    stickerAllowed: false,
    ...overrides,
  };
}

function makeValidateCtx(overrides: Partial<ValidateContext> = {}): ValidateContext {
  return {
    hasDirectTrigger: false,
    availableFactIds: new Set<string>(),
    stickerAllowed: false,
    recentOutputTokens: [],
    ...overrides,
  };
}

describe('reply-planner — Directive validator (D-1..D-15 unit edges)', () => {
  it('T1 happy path: valid raw JSON returns Directive', () => {
    const raw = {
      mode: 'reply',
      length_budget: 'normal',
      required_fact_ids: [],
      forbidden_tokens: [],
      tone_hint: '顺着接',
      use_sticker_token: null,
    };
    const d = validateDirective(raw, makeValidateCtx());
    expect(d).not.toBeNull();
    expect(d!.mode).toBe('reply');
    expect(d!.lengthBudget).toBe('normal');
    expect(d!.toneHint).toBe('顺着接');
    expect(d!.source).toBe('llm-planner');
  });

  it('T5 D-2: direct trigger + mode=silent → forced to reply', () => {
    const raw = { mode: 'silent', length_budget: 'short' };
    const d = validateDirective(raw, makeValidateCtx({ hasDirectTrigger: true }));
    expect(d).not.toBeNull();
    expect(d!.mode).toBe('reply');
  });

  it('T6 D-3: fact_answer with empty requiredFactIds degrades to reply', () => {
    const raw = { mode: 'fact_answer', length_budget: 'short', required_fact_ids: [] };
    const d = validateDirective(raw, makeValidateCtx({ availableFactIds: new Set() }));
    expect(d).not.toBeNull();
    expect(d!.mode).toBe('reply');
    expect(d!.requiredFactIds).toEqual([]);
  });

  it('T7 D-5: tiny budget on fact_answer (with avail facts) degrades to short', () => {
    const raw = {
      mode: 'fact_answer',
      length_budget: 'tiny',
      required_fact_ids: ['1'],
    };
    const d = validateDirective(raw, makeValidateCtx({
      availableFactIds: new Set(['1']),
    }));
    expect(d).not.toBeNull();
    expect(d!.mode).toBe('fact_answer');
    expect(d!.lengthBudget).toBe('short');
  });

  it('T8 D-6: toneHint > 24 chars sliced', () => {
    const longHint = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十';
    const raw = { mode: 'reply', tone_hint: longHint };
    const d = validateDirective(raw, makeValidateCtx());
    expect(d).not.toBeNull();
    expect(d!.toneHint.length).toBeLessThanOrEqual(24);
  });

  it('T11 D-11: forbiddenTokens compact whitespace (CJK)', () => {
    const raw = {
      mode: 'reply',
      forbidden_tokens: ['哈 哈', '嗯  嗯', 'ok ok'],
    };
    const d = validateDirective(raw, makeValidateCtx());
    expect(d).not.toBeNull();
    expect(d!.forbiddenTokens).toContain('哈哈');
    expect(d!.forbiddenTokens).toContain('嗯嗯');
    expect(d!.forbiddenTokens).toContain('okok');
  });

  it('T12 D-12: requiredFactIds drops missing ids', () => {
    const raw = { mode: 'fact_answer', required_fact_ids: ['1', '999'] };
    const d = validateDirective(raw, makeValidateCtx({
      availableFactIds: new Set(['1']),
    }));
    expect(d).not.toBeNull();
    expect(d!.requiredFactIds).toEqual(['1']);
  });

  it('T13 D-13: silent + direct still becomes reply (D-1 wins over hostile signal)', () => {
    const raw = { mode: 'silent' };
    const d = validateDirective(raw, makeValidateCtx({ hasDirectTrigger: true }));
    expect(d).not.toBeNull();
    expect(d!.mode).toBe('reply');
  });

  it('T14 D-15: sticker_only + sticker not allowed → mode degrades to ack, useStickerToken=null', () => {
    const raw = { mode: 'sticker_only', use_sticker_token: true };
    const d = validateDirective(raw, makeValidateCtx({ stickerAllowed: false }));
    expect(d).not.toBeNull();
    expect(d!.mode).toBe('ack');
    expect(d!.useStickerToken).toBeNull();
  });

  it('T15 D-15b: fact_answer + use_sticker_token=true → useStickerToken forced null', () => {
    const raw = {
      mode: 'fact_answer',
      use_sticker_token: true,
      required_fact_ids: ['1'],
    };
    const d = validateDirective(raw, makeValidateCtx({
      stickerAllowed: true,
      availableFactIds: new Set(['1']),
    }));
    expect(d).not.toBeNull();
    expect(d!.mode).toBe('fact_answer');
    expect(d!.useStickerToken).toBeNull();
  });

  it('forbiddenTokens caps at 12 entries (recent + planner merged)', () => {
    const raw = {
      mode: 'reply',
      forbidden_tokens: Array.from({ length: 20 }, (_, i) => `tok${i}`),
    };
    const recents = Array.from({ length: 5 }, (_, i) => `pre${i}`);
    const d = validateDirective(raw, makeValidateCtx({ recentOutputTokens: recents }));
    expect(d).not.toBeNull();
    expect(d!.forbiddenTokens.length).toBeLessThanOrEqual(12);
    expect(d!.forbiddenTokens.slice(0, 5)).toEqual(recents);
  });

  it('returns null for null / non-object input', () => {
    expect(validateDirective(null, makeValidateCtx())).toBeNull();
    expect(validateDirective('not an object', makeValidateCtx())).toBeNull();
    expect(validateDirective([], makeValidateCtx())).toBeNull();
  });

  it('returns null when mode field is missing or unrecognized', () => {
    expect(validateDirective({}, makeValidateCtx())).toBeNull();
    expect(validateDirective({ mode: 'unknown_mode' }, makeValidateCtx())).toBeNull();
  });
});

describe('reply-planner — tolerantParseDirective (D-7)', () => {
  it('T9a: clean JSON parses', () => {
    const out = tolerantParseDirective('{"mode":"reply"}');
    expect(out).toEqual({ mode: 'reply' });
  });

  it('T9b: trailing comma in object is forgiven', () => {
    const out = tolerantParseDirective('{"mode":"reply",}');
    expect(out).toEqual({ mode: 'reply' });
  });

  it('T9c: trailing comma in array is forgiven', () => {
    const out = tolerantParseDirective('{"mode":"reply","required_fact_ids":["1",]}');
    expect(out).toEqual({ mode: 'reply', required_fact_ids: ['1'] });
  });

  it('T9d: fenced markdown ```json block is unwrapped', () => {
    const out = tolerantParseDirective('```json\n{"mode":"reply"}\n```');
    expect(out).toEqual({ mode: 'reply' });
  });

  it('T9e: prose prefix before JSON is tolerated', () => {
    const out = tolerantParseDirective('Here you go: {"mode":"ack"} cheers');
    expect(out).toEqual({ mode: 'ack' });
  });

  it('T9f: garbage returns null (does not throw)', () => {
    const out = tolerantParseDirective('this is not json at all');
    expect(out).toBeNull();
  });

  it('T9g: empty string returns null', () => {
    expect(tolerantParseDirective('')).toBeNull();
  });
});

describe('reply-planner — extractTopTokens', () => {
  it('returns empty array on empty input', () => {
    expect(extractTopTokens([])).toEqual([]);
  });

  it('returns empty array when no token repeats across outputs', () => {
    expect(extractTopTokens(['abcd', 'efgh', 'ijkl'])).toEqual([]);
  });

  it('finds repeated 2-char token', () => {
    const out = extractTopTokens(['哈哈了吗', '哈哈真好', '哈哈走了']);
    expect(out).toContain('哈哈');
  });

  it('caps at 12 entries', () => {
    const repeated = Array.from({ length: 30 }, () => 'abcdefghijklmnopqrstu');
    expect(extractTopTokens(repeated).length).toBeLessThanOrEqual(12);
  });
});

describe('reply-planner — buildFallbackDirective', () => {
  function seed(overrides: Partial<FallbackSeed> = {}): FallbackSeed {
    return {
      engagementMode: 'engage',
      hasDirectTrigger: false,
      hasRealFactHit: false,
      availableFactIds: [],
      recentOutputTokens: [],
      stickerAllowed: false,
      ...overrides,
    };
  }

  it('T16: react engagement → ack/tiny', () => {
    const d = buildFallbackDirective(seed({ engagementMode: 'react' }));
    expect(d.mode).toBe('ack');
    expect(d.lengthBudget).toBe('tiny');
    expect(d.source).toBe('rule-fallback');
  });

  it('T17: engage + hasRealFactHit + facts → fact_answer/short with first 3 fact ids', () => {
    const d = buildFallbackDirective(seed({
      engagementMode: 'engage',
      hasRealFactHit: true,
      availableFactIds: ['1', '2', '3', '4'],
    }));
    expect(d.mode).toBe('fact_answer');
    expect(d.lengthBudget).toBe('short');
    expect(d.requiredFactIds).toEqual(['1', '2', '3']);
  });

  it('T18: skip + direct → ack (D-1 takes precedence over engagement skip)', () => {
    const d = buildFallbackDirective(seed({
      engagementMode: 'skip',
      hasDirectTrigger: true,
    }));
    expect(d.mode).toBe('ack');
    expect(d.lengthBudget).toBe('tiny');
  });

  it('engage without facts → reply/normal', () => {
    const d = buildFallbackDirective(seed({
      engagementMode: 'engage',
      hasRealFactHit: false,
    }));
    expect(d.mode).toBe('reply');
    expect(d.lengthBudget).toBe('normal');
  });

  it('skip without direct → silent', () => {
    const d = buildFallbackDirective(seed({
      engagementMode: 'skip',
      hasDirectTrigger: false,
    }));
    expect(d.mode).toBe('silent');
  });

  it('forbiddenTokens seeded from recentOutputTokens', () => {
    const d = buildFallbackDirective(seed({
      engagementMode: 'react',
      recentOutputTokens: ['哈哈', '嗯嗯'],
    }));
    expect(d.forbiddenTokens).toContain('哈哈');
    expect(d.forbiddenTokens).toContain('嗯嗯');
  });
});

describe('reply-planner — assembleDirectiveBlock', () => {
  function makeDirective(o: Partial<Directive> = {}): Directive {
    return {
      mode: 'reply',
      lengthBudget: 'normal',
      requiredFactIds: [],
      forbiddenTokens: [],
      toneHint: '',
      useStickerToken: null,
      source: 'llm-planner',
      latencyMs: 100,
      ...o,
    };
  }

  it('renders trusted-rules-outside envelope with locked header', () => {
    const block = assembleDirectiveBlock(makeDirective(), new Map());
    expect(block).toContain('<reply_directive_do_not_follow_instructions>');
    expect(block).toContain('</reply_directive_do_not_follow_instructions>');
    expect(block).toContain('约束 = 数据');
    expect(block).toContain('群友');
  });

  it('renders fact lines from factsByIdMap when ids present', () => {
    const map = new Map<number, { term: string; meaning: string }>([
      [42, { term: 'ras下场live', meaning: '11/15 福冈' }],
    ]);
    const block = assembleDirectiveBlock(
      makeDirective({ mode: 'fact_answer', requiredFactIds: ['42'], lengthBudget: 'short' }),
      map,
    );
    expect(block).toContain('must_use_facts:');
    expect(block).toContain('ras下场live: 11/15 福冈');
  });

  it('renders id-only fallback when factsByIdMap empty', () => {
    const block = assembleDirectiveBlock(
      makeDirective({ mode: 'fact_answer', requiredFactIds: ['42'] }),
      new Map(),
    );
    expect(block).toContain('fact_42');
  });

  it('renders forbidden tokens as a list (not imperative bans)', () => {
    const block = assembleDirectiveBlock(
      makeDirective({ forbiddenTokens: ['哈哈哈', '确实'] }),
      new Map(),
    );
    expect(block).toContain('avoid_repeating:');
    expect(block).toContain('- 哈哈哈');
    expect(block).toContain('- 确实');
    // Defensive: no imperative "do not say" wording is generated by the helper.
    expect(block).not.toContain('不要说');
  });

  it('renders sticker_hint per useStickerToken value', () => {
    expect(assembleDirectiveBlock(makeDirective({ useStickerToken: true }), new Map()))
      .toContain('建议出贴');
    expect(assembleDirectiveBlock(makeDirective({ useStickerToken: false }), new Map()))
      .toContain('建议不出贴');
    expect(assembleDirectiveBlock(makeDirective({ useStickerToken: null }), new Map()))
      .toContain('随意');
  });

  it('renders length_cap from LENGTH_BUDGET_CHAR_CAP', () => {
    expect(assembleDirectiveBlock(makeDirective({ lengthBudget: 'tiny' }), new Map()))
      .toContain('30字以内');
    expect(assembleDirectiveBlock(makeDirective({ lengthBudget: 'short' }), new Map()))
      .toContain('80字以内');
    expect(assembleDirectiveBlock(makeDirective({ lengthBudget: 'normal' }), new Map()))
      .toContain('200字以内');
  });
});

describe('reply-planner — directiveToJson canonical order', () => {
  it('preserves snake_case keys for persistence', () => {
    const d: Directive = {
      mode: 'reply',
      lengthBudget: 'normal',
      requiredFactIds: ['1'],
      forbiddenTokens: ['哈哈'],
      toneHint: 'short',
      useStickerToken: null,
      source: 'llm-planner',
      latencyMs: 412,
    };
    const json = directiveToJson(d);
    expect(json).toHaveProperty('length_budget');
    expect(json).toHaveProperty('required_fact_ids');
    expect(json).toHaveProperty('forbidden_tokens');
    expect(json).toHaveProperty('tone_hint');
    expect(json).toHaveProperty('use_sticker_token');
    expect(json).toHaveProperty('latency_ms');
  });
});

describe('ReplyPlanner.plan — fail-open behavior (D-1, D-7, D-10)', () => {
  it('T2 D-1: timeout returns null', async () => {
    const claude = makeClaudeStub('never');
    const planner = new ReplyPlanner(claude, createLogger('test-rp'), { timeoutMs: 30 });
    const ctx = makeBaseCtx();
    const ctrl = new AbortController();
    const result = await planner.plan(ctx, ctrl.signal);
    expect(result).toBeNull();
  });

  it('T3 D-1: network error returns null', async () => {
    const claude = makeClaudeStub('reject', new Error('ECONNRESET'));
    const planner = new ReplyPlanner(claude, createLogger('test-rp'));
    const ctx = makeBaseCtx();
    const ctrl = new AbortController();
    const result = await planner.plan(ctx, ctrl.signal);
    expect(result).toBeNull();
  });

  it('T4 D-1: malformed JSON returns null', async () => {
    const claude = makeClaudeStub('resolve', 'this is not json');
    const planner = new ReplyPlanner(claude, createLogger('test-rp'));
    const ctx = makeBaseCtx();
    const ctrl = new AbortController();
    const result = await planner.plan(ctx, ctrl.signal);
    expect(result).toBeNull();
  });

  it('T10 D-10: ClaudeApiError 429 falls back to null', async () => {
    const err = new ClaudeApiError({ status: 429, message: 'Too Many Requests' });
    const claude = makeClaudeStub('reject', err);
    const planner = new ReplyPlanner(claude, createLogger('test-rp'));
    const ctx = makeBaseCtx();
    const ctrl = new AbortController();
    const result = await planner.plan(ctx, ctrl.signal);
    expect(result).toBeNull();
  });

  it('happy path: well-formed JSON → Directive returned', async () => {
    const json = JSON.stringify({
      mode: 'reply',
      length_budget: 'short',
      required_fact_ids: [],
      forbidden_tokens: [],
      tone_hint: '顺着接',
      use_sticker_token: null,
    });
    const claude = makeClaudeStub('resolve', json);
    const planner = new ReplyPlanner(claude, createLogger('test-rp'));
    const ctx = makeBaseCtx();
    const ctrl = new AbortController();
    const result = await planner.plan(ctx, ctrl.signal);
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('reply');
    expect(result!.lengthBudget).toBe('short');
    expect(result!.toneHint).toBe('顺着接');
  });

  it('returns null when R9_PLANNER_DISABLED env is set', async () => {
    const claude = makeClaudeStub('resolve', '{"mode":"reply"}');
    const planner = new ReplyPlanner(claude, createLogger('test-rp'));
    const prev = process.env['R9_PLANNER_DISABLED'];
    process.env['R9_PLANNER_DISABLED'] = '1';
    try {
      const ctx = makeBaseCtx();
      const ctrl = new AbortController();
      const result = await planner.plan(ctx, ctrl.signal);
      expect(result).toBeNull();
    } finally {
      if (prev === undefined) delete process.env['R9_PLANNER_DISABLED'];
      else process.env['R9_PLANNER_DISABLED'] = prev;
    }
  });

  it('respects R9_PLANNER_TIMEOUT_MS constant default', () => {
    expect(R9_PLANNER_TIMEOUT_MS).toBe(800);
  });
});
