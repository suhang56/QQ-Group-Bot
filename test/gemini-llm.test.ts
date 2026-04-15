import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiClient } from '../src/ai/providers/gemini-llm.js';
import { ClaudeApiError } from '../src/utils/errors.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

// Mock openai package — we only need the chat.completions.create method
const mockCreate = vi.hoisted(() => vi.fn());
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}));

describe('GeminiClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when GEMINI_API_KEY is not set and none passed', () => {
    const saved = process.env['GEMINI_API_KEY'];
    delete process.env['GEMINI_API_KEY'];
    expect(() => new GeminiClient()).toThrow(/GEMINI_API_KEY/);
    if (saved) process.env['GEMINI_API_KEY'] = saved;
  });

  it('constructs successfully with explicit apiKey', () => {
    expect(() => new GeminiClient({ apiKey: 'test-key' })).not.toThrow();
  });

  it('returns parsed ClaudeResponse on success', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'hi there' } }],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    });

    const client = new GeminiClient({ apiKey: 'test-key' });
    const resp = await client.complete({
      model: 'gemini-2.0-flash-exp',
      maxTokens: 50,
      system: [{ text: 'be short', cache: true }],
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(resp.text).toBe('hi there');
    expect(resp.inputTokens).toBe(10);
    expect(resp.outputTokens).toBe(3);

    const call = mockCreate.mock.calls[0]![0] as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      max_tokens: number;
    };
    expect(call.model).toBe('gemini-2.0-flash-exp');
    expect(call.max_tokens).toBe(50);
    expect(call.messages).toEqual([
      { role: 'system', content: 'be short' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('omits system message when system[] is empty', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    });

    const client = new GeminiClient({ apiKey: 'test-key' });
    await client.complete({
      model: 'gemini-2.0-flash-exp',
      maxTokens: 10,
      system: [],
      messages: [{ role: 'user', content: 'hi' }],
    });

    const call = mockCreate.mock.calls[0]![0] as { messages: Array<{ role: string }> };
    expect(call.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('throws ClaudeApiError on API failure', async () => {
    mockCreate.mockRejectedValueOnce(new Error('rate limited'));

    const client = new GeminiClient({ apiKey: 'test-key' });
    await expect(
      client.complete({
        model: 'gemini-2.0-flash-exp',
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

    const client = new GeminiClient({ apiKey: 'test-key' });
    await expect(
      client.complete({
        model: 'gemini-2.0-flash-exp',
        maxTokens: 10,
        system: [],
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(ClaudeApiError);
  });

  it('vision methods throw', async () => {
    const client = new GeminiClient({ apiKey: 'test-key' });
    await expect(
      client.describeImage(Buffer.from([]), 'claude-haiku-4-5-20251001'),
    ).rejects.toThrow(/does not support describeImage/);
    await expect(
      client.visionWithPrompt(Buffer.from([]), 'claude-haiku-4-5-20251001', 'p'),
    ).rejects.toThrow(/does not support visionWithPrompt/);
  });
});
