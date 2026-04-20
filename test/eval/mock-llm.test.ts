import { describe, it, expect } from 'vitest';
import { MockClaudeClient } from '../../scripts/eval/mock-llm.js';
import type { ClaudeRequest } from '../../src/ai/claude.js';

function makeReq(userText: string): ClaudeRequest {
  return {
    model: 'claude-sonnet-4-6',
    maxTokens: 512,
    system: [{ text: 'you are a test', cache: false }],
    messages: [{ role: 'user', content: userText }],
  };
}

describe('MockClaudeClient', () => {
  it('same request → same text (determinism)', async () => {
    const c = new MockClaudeClient();
    const a = await c.complete(makeReq('hello'));
    const b = await c.complete(makeReq('hello'));
    expect(a.text).toBe(b.text);
  });

  it('hex8 is 8 lowercase hex chars', async () => {
    const c = new MockClaudeClient();
    const r = await c.complete(makeReq('hello'));
    const m = /^\[mock:([0-9a-f]{8})\] 好的$/.exec(r.text);
    expect(m).not.toBeNull();
    expect(m?.[1]?.length).toBe(8);
  });

  it('different prompts → different hex8', async () => {
    const c = new MockClaudeClient();
    const a = await c.complete(makeReq('hello'));
    const b = await c.complete(makeReq('world'));
    expect(a.text).not.toBe(b.text);
  });

  it('callCount increments', async () => {
    const c = new MockClaudeClient();
    expect(c.callCount).toBe(0);
    await c.complete(makeReq('a'));
    await c.complete(makeReq('b'));
    expect(c.callCount).toBe(2);
  });

  it('realNetworkCalls is constant zero', () => {
    const c = new MockClaudeClient();
    expect(c.realNetworkCalls).toBe(0);
  });

  it('returns zero token usage', async () => {
    const c = new MockClaudeClient();
    const r = await c.complete(makeReq('anything'));
    expect(r.inputTokens).toBe(0);
    expect(r.outputTokens).toBe(0);
    expect(r.cacheReadTokens).toBe(0);
    expect(r.cacheWriteTokens).toBe(0);
  });

  it('describeImage returns sentinel string', async () => {
    const c = new MockClaudeClient();
    const s = await c.describeImage(Buffer.from([1, 2, 3]), 'claude-sonnet-4-6');
    expect(s.startsWith('[mock-image]')).toBe(true);
  });

  it('visionWithPrompt returns sentinel with hex8', async () => {
    const c = new MockClaudeClient();
    const s1 = await c.visionWithPrompt(Buffer.from([1]), 'claude-sonnet-4-6', 'p1');
    const s2 = await c.visionWithPrompt(Buffer.from([1]), 'claude-sonnet-4-6', 'p2');
    expect(s1).not.toBe(s2);
    expect(/^\[mock-vision:[0-9a-f]{8}\]/.test(s1)).toBe(true);
  });

  it('tracks per-call metadata', async () => {
    const c = new MockClaudeClient();
    await c.complete(makeReq('x'));
    expect(c.calls.length).toBe(1);
    expect(c.calls[0]?.model).toBe('claude-sonnet-4-6');
  });
});
