import { describe, it, expect, vi } from 'vitest';
import { LlmShadowClassifier } from '../src/modules/llm-shadow-classifier.js';
import type { ShadowClassifierResult } from '../src/modules/llm-shadow-classifier.js';
import type { IClaudeClient, ClaudeRequest, ClaudeResponse } from '../src/ai/claude.js';
import type { Logger } from 'pino';

const silentLogger: Logger = {
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  trace: () => undefined,
  child: () => silentLogger,
} as unknown as Logger;

function makeClaude(handler: (req: ClaudeRequest) => Promise<ClaudeResponse>): IClaudeClient {
  return {
    complete: vi.fn(handler),
    describeImage: vi.fn(),
    visionWithPrompt: vi.fn(),
  };
}

function makeResponse(text: string): ClaudeResponse {
  return { text, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

const baseInput = {
  triggerContent: 'hello world',
  triggerUserId: 'u1',
  recent5: [
    { userId: 'a', content: 'first' },
    { userId: 'b', content: 'second' },
  ] as ReadonlyArray<{ userId: string; content: string }>,
  botUserId: 'bot1',
};

describe('LlmShadowClassifier — happy path', () => {
  it('case 1: valid response with chime_in', async () => {
    const claude = makeClaude(async () => makeResponse('{"act":"chime_in","confidence":0.91}'));
    const c = new LlmShadowClassifier({ claude, logger: silentLogger });
    const r = await c.classify(baseInput);
    expect(r.act).toBe('chime_in');
    expect(r.conf).toBe(0.91);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('case 2: valid response with object_react', async () => {
    const claude = makeClaude(async () => makeResponse('{"act":"object_react","confidence":0.5}'));
    const c = new LlmShadowClassifier({ claude, logger: silentLogger });
    const r = await c.classify({ ...baseInput, triggerContent: '[CQ:image,file=abc]' });
    expect(r.act).toBe('object_react');
    expect(r.conf).toBe(0.5);
  });
});

describe('LlmShadowClassifier — enum drift', () => {
  it('case 3: out-of-enum unknown returns null', async () => {
    const claude = makeClaude(async () => makeResponse('{"act":"unknown","confidence":0.3}'));
    const c = new LlmShadowClassifier({ claude, logger: silentLogger });
    const r = await c.classify(baseInput);
    expect(r.act).toBeNull();
    expect(r.conf).toBeNull();
  });

  it('case 4: out-of-enum none returns null', async () => {
    const claude = makeClaude(async () => makeResponse('{"act":"none","confidence":0.5}'));
    const c = new LlmShadowClassifier({ claude, logger: silentLogger });
    const r = await c.classify(baseInput);
    expect(r.act).toBeNull();
    expect(r.conf).toBeNull();
  });
});

describe('LlmShadowClassifier — parse failure', () => {
  it('case 5: malformed JSON returns null', async () => {
    const claude = makeClaude(async () => makeResponse('{act:chime_in}'));
    const c = new LlmShadowClassifier({ claude, logger: silentLogger });
    const r = await c.classify(baseInput);
    expect(r.act).toBeNull();
    expect(r.conf).toBeNull();
  });

  it('case 6: text with no JSON returns null', async () => {
    const claude = makeClaude(async () => makeResponse('let me think about it'));
    const c = new LlmShadowClassifier({ claude, logger: silentLogger });
    const r = await c.classify(baseInput);
    expect(r.act).toBeNull();
  });

  it('case 7: JSON wrapped in markdown fences parses correctly', async () => {
    const claude = makeClaude(async () => makeResponse('```json\n{"act":"chime_in","confidence":0.8}\n```'));
    const c = new LlmShadowClassifier({ claude, logger: silentLogger });
    const r = await c.classify(baseInput);
    expect(r.act).toBe('chime_in');
    expect(r.conf).toBe(0.8);
  });
});

describe('LlmShadowClassifier — confidence variants', () => {
  it('case 8: missing confidence keeps act, conf null', async () => {
    const claude = makeClaude(async () => makeResponse('{"act":"chime_in"}'));
    const c = new LlmShadowClassifier({ claude, logger: silentLogger });
    const r = await c.classify(baseInput);
    expect(r.act).toBe('chime_in');
    expect(r.conf).toBeNull();
  });

  it('case 9: confidence as string NaN keeps act, conf null', async () => {
    const claude = makeClaude(async () => makeResponse('{"act":"chime_in","confidence":"NaN"}'));
    const c = new LlmShadowClassifier({ claude, logger: silentLogger });
    const r = await c.classify(baseInput);
    expect(r.act).toBe('chime_in');
    expect(r.conf).toBeNull();
  });

  it('case 10: confidence 1.5 (out-of-range) keeps act, conf null', async () => {
    const claude = makeClaude(async () => makeResponse('{"act":"chime_in","confidence":1.5}'));
    const c = new LlmShadowClassifier({ claude, logger: silentLogger });
    const r = await c.classify(baseInput);
    expect(r.act).toBe('chime_in');
    expect(r.conf).toBeNull();
  });

  it('case 11: confidence -0.1 (out-of-range) keeps act, conf null', async () => {
    const claude = makeClaude(async () => makeResponse('{"act":"chime_in","confidence":-0.1}'));
    const c = new LlmShadowClassifier({ claude, logger: silentLogger });
    const r = await c.classify(baseInput);
    expect(r.act).toBe('chime_in');
    expect(r.conf).toBeNull();
  });
});

describe('LlmShadowClassifier — error paths', () => {
  it('case 12: claude throws specific error returns null', async () => {
    const claude = makeClaude(async () => { throw new Error('ClaudeApiError: rate limit'); });
    const c = new LlmShadowClassifier({ claude, logger: silentLogger });
    const r = await c.classify(baseInput);
    expect(r.act).toBeNull();
    expect(r.conf).toBeNull();
  });

  it('case 13: claude throws generic error returns null', async () => {
    const claude = makeClaude(async () => { throw new Error('boom'); });
    const c = new LlmShadowClassifier({ claude, logger: silentLogger });
    const r = await c.classify(baseInput);
    expect(r.act).toBeNull();
  });

  it('case 14: client never resolves; timeout fires at configured ms', async () => {
    const claude = makeClaude(() => new Promise<ClaudeResponse>(() => undefined));
    const c = new LlmShadowClassifier({
      claude,
      logger: silentLogger,
      timeoutMs: 50,
    });
    const r = await c.classify(baseInput);
    expect(r.act).toBeNull();
    expect(r.conf).toBeNull();
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('LlmShadowClassifier — sentinel + edges', () => {
  it('case 15: mock sentinel prefix is stripped before parsing', async () => {
    const claude = makeClaude(async () => makeResponse('[mock:abcd1234] {"act":"chime_in","confidence":0.9}'));
    const c = new LlmShadowClassifier({ claude, logger: silentLogger });
    const r = await c.classify(baseInput);
    expect(r.act).toBe('chime_in');
    expect(r.conf).toBe(0.9);
  });

  it('case 16: empty triggerContent (no CQ image) short-circuits without LLM call', async () => {
    const claude = makeClaude(async () => makeResponse('{"act":"chime_in","confidence":0.9}'));
    const c = new LlmShadowClassifier({ claude, logger: silentLogger });
    const r = await c.classify({ ...baseInput, triggerContent: '      ', recent5: [] });
    expect(r.act).toBeNull();
    expect(r.conf).toBeNull();
    expect(r.latencyMs).toBe(0);
    expect(claude.complete).not.toHaveBeenCalled();
  });

  it('case 17: empty recent5 with image still calls LLM with placeholder text', async () => {
    let captured: ClaudeRequest | undefined;
    const claude = makeClaude(async req => {
      captured = req;
      return makeResponse('{"act":"object_react","confidence":0.7}');
    });
    const c = new LlmShadowClassifier({ claude, logger: silentLogger });
    const r = await c.classify({
      ...baseInput,
      triggerContent: '[CQ:image,file=abc]',
      recent5: [],
    });
    expect(r.act).toBe('object_react');
    expect(captured?.messages[0]?.content).toContain('(no recent messages)');
  });

  it('case 18: null bytes in triggerContent are sanitized before LLM call', async () => {
    let captured: ClaudeRequest | undefined;
    const claude = makeClaude(async req => {
      captured = req;
      return makeResponse('{"act":"chime_in","confidence":0.8}');
    });
    const c = new LlmShadowClassifier({ claude, logger: silentLogger });
    const evilContent = `hello${String.fromCharCode(0)}world`;
    const r = await c.classify({ ...baseInput, triggerContent: evilContent });
    expect(r.act).toBe('chime_in');
    expect(captured?.messages[0]?.content).not.toContain(String.fromCharCode(0));
  });

  it('case 19: classify NEVER rejects across diverse failure injections', async () => {
    const failures = [
      async () => { throw new Error('e1'); },
      async () => makeResponse('not json'),
      async () => makeResponse('{}'),
      async () => makeResponse('{"act":"???"}'),
      async () => makeResponse(''),
      async () => makeResponse('{"act":"chime_in","confidence":NaN}'),
    ];
    for (const handler of failures) {
      const claude = makeClaude(handler);
      const c = new LlmShadowClassifier({ claude, logger: silentLogger });
      const probe = await c.classify(baseInput).catch(() => 'rejected_marker' as const);
      expect(probe).not.toBe('rejected_marker');
      const r = probe as ShadowClassifierResult;
      expect(typeof r.latencyMs).toBe('number');
    }
  });
});
