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

  it('describeImage dispatches to chat.completions.create with inline image_url', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '【图里有什么】测试\n【发的人想表达】ok' } }],
    });
    const client = new GeminiClient({ apiKey: 'test-key' });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const out = await client.describeImage(png, 'gemini-2.5-flash');
    expect(out).toContain('测试');
    expect(mockCreate).toHaveBeenCalledOnce();
    const call = mockCreate.mock.calls[0]![0];
    expect(call.model).toBe('gemini-2.5-flash');
    expect(call.reasoning_effort).toBe('none');
    const content = call.messages[0].content;
    expect(content[1].type).toBe('image_url');
    expect(content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it('vision methods wrap upstream errors as ClaudeApiError', async () => {
    mockCreate.mockRejectedValue(new Error('upstream boom'));
    const client = new GeminiClient({ apiKey: 'test-key' });
    await expect(
      client.describeImage(Buffer.from([0xff, 0xd8, 0xff]), 'gemini-2.5-flash'),
    ).rejects.toThrow(ClaudeApiError);
    await expect(
      client.visionWithPrompt(Buffer.from([0xff, 0xd8, 0xff]), 'gemini-2.5-flash', 'p'),
    ).rejects.toThrow(ClaudeApiError);
  });
});
