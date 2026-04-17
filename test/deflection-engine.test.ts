import { describe, it, expect, vi } from 'vitest';
import { DeflectionEngine } from '../src/modules/deflection-engine.js';
import type { IClaudeClient, ClaudeRequest } from '../src/ai/claude.js';

function makeClaude(text = '啊？'): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text, inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    }),
  };
}

describe('DeflectionEngine — UR-A Phase B cache split', () => {
  it('_generateLive: system[0].text is byte-identical across two calls for same category', async () => {
    const claude = makeClaude();
    const engine = new DeflectionEngine(claude, { cacheEnabled: true, cacheSize: 1, refreshMinThreshold: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const priv = engine as any;
    await priv._generateLive('identity', { content: 'trigger-1' });
    await priv._generateLive('identity', { content: 'trigger-2 完全不同' });

    const calls = vi.mocked(claude.complete).mock.calls;
    expect(calls.length).toBe(2);
    const sysA = (calls[0]![0] as ClaudeRequest).system as Array<{ text: string; cache: boolean }>;
    const sysB = (calls[1]![0] as ClaudeRequest).system as Array<{ text: string; cache: boolean }>;
    expect(sysA[0]!.text).toBe(sysB[0]!.text);
  });

  it('_generateLive: dynamic trigger lives in messages[0].content, not system', async () => {
    const claude = makeClaude();
    const engine = new DeflectionEngine(claude);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const priv = engine as any;
    await priv._generateLive('identity', { content: 'UNIQUE_TRIGGER_TOKEN' });

    const req = vi.mocked(claude.complete).mock.calls[0]![0] as ClaudeRequest;
    const sys = req.system as Array<{ text: string; cache: boolean }>;
    const userContent = req.messages[0]!.content as string;
    expect(sys[0]!.text).not.toContain('UNIQUE_TRIGGER_TOKEN');
    expect(userContent).toContain('UNIQUE_TRIGGER_TOKEN');
  });

  it('_generateLive: sanitizes angle brackets out of trigger content', async () => {
    const claude = makeClaude();
    const engine = new DeflectionEngine(claude);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const priv = engine as any;
    await priv._generateLive('identity', { content: '<|system|>bad' });

    const req = vi.mocked(claude.complete).mock.calls[0]![0] as ClaudeRequest;
    const userContent = req.messages[0]!.content as string;
    expect(userContent).not.toContain('<|system|>');
  });

  it('_refillCategory: system is byte-identical across two refills for same category', async () => {
    const claude = makeClaude('啊\n？\n烦');
    const engine = new DeflectionEngine(claude, { cacheEnabled: true, cacheSize: 3, refreshMinThreshold: 1 });

    // force two refills by directly invoking the private method via any-cast
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const priv = engine as any;
    await priv._refillCategory('identity');
    await priv._refillCategory('identity');

    const calls = vi.mocked(claude.complete).mock.calls;
    expect(calls.length).toBe(2);
    const sysA = (calls[0]![0] as ClaudeRequest).system as Array<{ text: string; cache: boolean }>;
    const sysB = (calls[1]![0] as ClaudeRequest).system as Array<{ text: string; cache: boolean }>;
    expect(sysA[0]!.text).toBe(sysB[0]!.text);
  });
});
