import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeepSeekClient } from '../src/ai/providers/deepseek-llm.js';
import { ClaudeApiError } from '../src/utils/errors.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const mockCreate = vi.hoisted(() => vi.fn());
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}));

describe('DeepSeekClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when DEEPSEEK_API_KEY is not set and none passed', () => {
    const saved = process.env['DEEPSEEK_API_KEY'];
    delete process.env['DEEPSEEK_API_KEY'];
    expect(() => new DeepSeekClient()).toThrow(/DEEPSEEK_API_KEY/);
    if (saved) process.env['DEEPSEEK_API_KEY'] = saved;
  });

  it('constructs successfully with custom baseUrl and timeoutMs', () => {
    expect(
      () => new DeepSeekClient({ apiKey: 'k', baseUrl: 'https://example.test', timeoutMs: 5_000 }),
    ).not.toThrow();
  });

  it('maps prompt_cache_hit_tokens → cacheReadTokens', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 80 },
    });

    const client = new DeepSeekClient({ apiKey: 'k' });
    const resp = await client.complete({
      model: 'deepseek-chat',
      maxTokens: 50,
      system: [{ text: 'be short', cache: true }],
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(resp.text).toBe('hi');
    expect(resp.inputTokens).toBe(100);
    expect(resp.outputTokens).toBe(5);
    expect(resp.cacheReadTokens).toBe(80);
    expect(resp.cacheWriteTokens).toBe(0);
  });

  it('cacheReadTokens is 0 when prompt_cache_hit_tokens missing', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 10, completion_tokens: 1 },
    });

    const client = new DeepSeekClient({ apiKey: 'k' });
    const resp = await client.complete({
      model: 'deepseek-chat',
      maxTokens: 10,
      system: [],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(resp.cacheReadTokens).toBe(0);
  });

  it('throws ClaudeApiError on API 500', async () => {
    mockCreate.mockRejectedValueOnce(new Error('500 internal'));
    const client = new DeepSeekClient({ apiKey: 'k' });
    await expect(
      client.complete({
        model: 'deepseek-chat',
        maxTokens: 10,
        system: [],
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(ClaudeApiError);
  });

  it('throws ClaudeApiError on empty content response', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '' } }],
      usage: { prompt_tokens: 2, completion_tokens: 0 },
    });
    const client = new DeepSeekClient({ apiKey: 'k' });
    await expect(
      client.complete({
        model: 'deepseek-chat',
        maxTokens: 10,
        system: [],
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(ClaudeApiError);
  });

  it('describeImage throws with expected message', async () => {
    const client = new DeepSeekClient({ apiKey: 'k' });
    await expect(
      client.describeImage(Buffer.from([]), 'claude-haiku-4-5-20251001'),
    ).rejects.toThrow(/does not support describeImage/);
  });

  it('visionWithPrompt throws with expected message', async () => {
    const client = new DeepSeekClient({ apiKey: 'k' });
    await expect(
      client.visionWithPrompt(Buffer.from([]), 'claude-haiku-4-5-20251001', 'p'),
    ).rejects.toThrow(/does not support visionWithPrompt/);
  });

  it('request body shape: model, messages (system + user), max_tokens', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const client = new DeepSeekClient({ apiKey: 'k' });
    await client.complete({
      model: 'deepseek-chat',
      maxTokens: 77,
      system: [{ text: 'sysblk', cache: true }],
      messages: [{ role: 'user', content: 'hi' }],
    });

    const call = mockCreate.mock.calls[0]![0] as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      max_tokens: number;
    };
    expect(call.model).toBe('deepseek-chat');
    expect(call.max_tokens).toBe(77);
    expect(call.messages).toEqual([
      { role: 'system', content: 'sysblk' },
      { role: 'user', content: 'hi' },
    ]);
  });
});
