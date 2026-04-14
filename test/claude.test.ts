import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeClient, type IClaudeClient, type ClaudeRequest } from '../src/ai/claude.js';
import { ClaudeApiError, ClaudeParseError } from '../src/utils/errors.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

// Mock claude-agent-sdk query function
const mockQuery = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
}));

function makeRequest(overrides: Partial<ClaudeRequest> = {}): ClaudeRequest {
  return {
    model: 'claude-sonnet-4-6',
    maxTokens: 100,
    system: [{ text: 'You are a bot.', cache: true }],
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

// Helper: build an async generator from an array of messages
async function* makeAsyncMessages(messages: object[]) {
  for (const msg of messages) {
    yield msg;
  }
}

function makeSuccessMessages(text = 'hi there') {
  return makeAsyncMessages([
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    },
    {
      type: 'result',
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0,
    },
  ]);
}

describe('ClaudeClient', () => {
  let client: IClaudeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ClaudeClient();
  });

  it('returns parsed ClaudeResponse on success', async () => {
    mockQuery.mockReturnValueOnce(makeSuccessMessages('hello bot'));
    const result = await client.complete(makeRequest());
    expect(result.text).toBe('hello bot');
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
  });

  it('concatenates system blocks into systemPrompt option', async () => {
    mockQuery.mockReturnValueOnce(makeSuccessMessages());
    await client.complete({
      model: 'claude-sonnet-4-6',
      maxTokens: 100,
      system: [
        { text: 'System A', cache: true },
        { text: 'System B', cache: true },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    });
    const call = mockQuery.mock.calls[0]![0] as { options: { systemPrompt: string } };
    expect(call.options.systemPrompt).toBe('System A\nSystem B');
  });

  it('passes model to query options', async () => {
    mockQuery.mockReturnValueOnce(makeSuccessMessages());
    await client.complete(makeRequest({ model: 'claude-opus-4-6' }));
    const call = mockQuery.mock.calls[0]![0] as { options: { model: string } };
    expect(call.options.model).toBe('claude-opus-4-6');
  });

  it('accumulates text from multiple assistant message blocks', async () => {
    mockQuery.mockReturnValueOnce(makeAsyncMessages([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }] },
      },
      { type: 'result', usage: { input_tokens: 5, output_tokens: 3 } },
    ]));
    const result = await client.complete(makeRequest());
    expect(result.text).toBe('Hello world');
  });

  it('throws ClaudeParseError when response has no text content', async () => {
    mockQuery.mockReturnValueOnce(makeAsyncMessages([
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'x' }] },
      },
      { type: 'result', usage: { input_tokens: 1, output_tokens: 1 } },
    ]));
    await expect(client.complete(makeRequest())).rejects.toBeInstanceOf(ClaudeParseError);
  });

  it('throws ClaudeApiError on query() rejection', async () => {
    mockQuery.mockReturnValueOnce((async function* () {
      throw new Error('network failure');
    })());
    await expect(client.complete(makeRequest())).rejects.toBeInstanceOf(ClaudeApiError);
  });

  it('throws ClaudeApiError when query() throws synchronously', async () => {
    mockQuery.mockImplementationOnce(() => { throw new Error('auth failure'); });
    await expect(client.complete(makeRequest())).rejects.toBeInstanceOf(ClaudeApiError);
  });

  it('returns zero for cacheReadTokens and cacheWriteTokens (not supported by agent-sdk)', async () => {
    mockQuery.mockReturnValueOnce(makeSuccessMessages('cached reply'));
    const result = await client.complete(makeRequest());
    expect(result.cacheReadTokens).toBe(0);
    expect(result.cacheWriteTokens).toBe(0);
  });

  it('returns inputTokens=0 outputTokens=0 when result message has no usage', async () => {
    mockQuery.mockReturnValueOnce(makeAsyncMessages([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
      { type: 'result' },
    ]));
    const result = await client.complete(makeRequest());
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it('ignores non-assistant, non-result message types', async () => {
    mockQuery.mockReturnValueOnce(makeAsyncMessages([
      { type: 'system', subtype: 'init', apiKeySource: 'oauth' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
      { type: 'result', usage: { input_tokens: 2, output_tokens: 1 } },
    ]));
    const result = await client.complete(makeRequest());
    expect(result.text).toBe('ok');
  });

  it('concatenates multi-turn messages with role labels for assistant turns', async () => {
    mockQuery.mockReturnValueOnce(makeSuccessMessages());
    await client.complete(makeRequest({
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        { role: 'user', content: 'how are you?' },
      ],
    }));
    const call = mockQuery.mock.calls[0]![0] as { prompt: string };
    expect(call.prompt).toBe('hello\nAssistant: hi there\nhow are you?');
  });

  // Regression: SDK session isolation — host CLI hooks must never bleed into bot replies
  it('always passes settingSources:[] to prevent host CLI settings/hooks from loading', async () => {
    mockQuery.mockReturnValueOnce(makeSuccessMessages());
    await client.complete(makeRequest());
    const call = mockQuery.mock.calls[0]![0] as { options: Record<string, unknown> };
    expect(call.options['settingSources']).toEqual([]);
  });

  it('always passes persistSession:false to prevent writing session state to disk', async () => {
    mockQuery.mockReturnValueOnce(makeSuccessMessages());
    await client.complete(makeRequest());
    const call = mockQuery.mock.calls[0]![0] as { options: Record<string, unknown> };
    expect(call.options['persistSession']).toBe(false);
  });

  it('always passes hooks:{} to ensure no programmatic hooks are registered', async () => {
    mockQuery.mockReturnValueOnce(makeSuccessMessages());
    await client.complete(makeRequest());
    const call = mockQuery.mock.calls[0]![0] as { options: Record<string, unknown> };
    expect(call.options['hooks']).toEqual({});
  });

  // ── visionWithPrompt ──────────────────────────────────────────────────────

  it('visionWithPrompt: returns text from assistant message', async () => {
    mockQuery.mockReturnValueOnce(makeSuccessMessages('found image text'));
    const buf = Buffer.from([0xff, 0xd8, 0x00]); // JPEG magic bytes
    const result = await client.visionWithPrompt(buf, 'claude-sonnet-4-6', 'describe this');
    expect(result).toBe('found image text');
  });

  it('visionWithPrompt: passes image content block and text prompt via SDKUserMessage', async () => {
    mockQuery.mockReturnValueOnce(makeSuccessMessages('ok'));
    const buf = Buffer.from([0xff, 0xd8, 0x00]);
    await client.visionWithPrompt(buf, 'claude-sonnet-4-6', 'my prompt', 50);
    const call = mockQuery.mock.calls[0]![0] as { prompt: AsyncIterable<{ type: string; message: { content: unknown[] } }> };
    const msgs: unknown[] = [];
    for await (const m of call.prompt) msgs.push(m);
    const userMsg = msgs[0] as { type: string; message: { role: string; content: Array<{ type: string; source?: unknown; text?: string }> } };
    expect(userMsg.type).toBe('user');
    expect(userMsg.message.content[0]!.type).toBe('image');
    expect(userMsg.message.content[1]!.type).toBe('text');
    expect(userMsg.message.content[1]!.text).toBe('my prompt');
  });

  it('visionWithPrompt: uses isolation flags matching complete()', async () => {
    mockQuery.mockReturnValueOnce(makeSuccessMessages('ok'));
    const buf = Buffer.from([0xff, 0xd8, 0x00]);
    await client.visionWithPrompt(buf, 'claude-sonnet-4-6', 'test');
    const call = mockQuery.mock.calls[0]![0] as { options: Record<string, unknown> };
    expect(call.options['settingSources']).toEqual([]);
    expect(call.options['persistSession']).toBe(false);
    expect(call.options['hooks']).toEqual({});
  });

  it('visionWithPrompt: throws ClaudeApiError on query failure', async () => {
    mockQuery.mockImplementationOnce(() => { throw new Error('auth failure'); });
    const buf = Buffer.from([0xff, 0xd8, 0x00]);
    await expect(client.visionWithPrompt(buf, 'claude-sonnet-4-6', 'test')).rejects.toBeInstanceOf(ClaudeApiError);
  });

  it('describeImage: returns non-empty text on success', async () => {
    mockQuery.mockReturnValueOnce(makeSuccessMessages('一只猫在阳光下伸懒腰'));
    const buf = Buffer.from([0x89, 0x50, 0x00]); // PNG magic bytes
    const result = await client.describeImage(buf, 'claude-sonnet-4-6');
    expect(result).toBe('一只猫在阳光下伸懒腰');
  });

  it('describeImage: throws ClaudeParseError when vision returns empty text', async () => {
    mockQuery.mockReturnValueOnce(makeAsyncMessages([
      { type: 'assistant', message: { content: [{ type: 'text', text: '' }] } },
      { type: 'result', usage: { input_tokens: 1, output_tokens: 0 } },
    ]));
    const buf = Buffer.from([0xff, 0xd8, 0x00]);
    await expect(client.describeImage(buf, 'claude-sonnet-4-6')).rejects.toBeInstanceOf(ClaudeParseError);
  });

  it('describeImage: uses two-section prompt with intent inference', async () => {
    mockQuery.mockReturnValueOnce(makeSuccessMessages('挺好看的图'));
    const buf = Buffer.from([0x89, 0x50, 0x00]);
    await client.describeImage(buf, 'claude-sonnet-4-6');
    const call = mockQuery.mock.calls[0]![0] as { prompt: AsyncIterable<{ type: string; message: { content: Array<{ type: string; text?: string }> } }> };
    const msgs: Array<{ type: string; message: { content: Array<{ type: string; text?: string }> } }> = [];
    for await (const m of call.prompt) msgs.push(m as { type: string; message: { content: Array<{ type: string; text?: string }> } });
    const userMsg = msgs.find(m => m.type === 'user');
    const textBlock = userMsg?.message.content.find(b => b.type === 'text');
    expect(textBlock?.text).toContain('图里有什么');
    expect(textBlock?.text).toContain('发的人想表达');
    expect(textBlock?.text).toContain('30-80 字');
    expect(textBlock?.text).toContain('10-40 字');
    expect(textBlock?.text).toContain('角色名');
  });

  it('downscale: falls back to original bytes on invalid image data', async () => {
    const fakeBytes = Buffer.from([0x00, 0x01, 0x02]); // not a real image
    const result = await ClaudeClient.downscale(fakeBytes);
    // Sharp fails → returns original
    expect(result).toBe(fakeBytes);
  });

  it('downscale: returns a buffer for a valid JPEG (integration — real sharp)', async () => {
    // Minimal 1x1 white JPEG: https://en.wikipedia.org/wiki/JPEG#Syntax_and_structure
    // Use a known-good minimal JPEG fixture
    const minimalJpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U'
      + 'HRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgN'
      + 'DRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy'
      + 'MjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAA'
      + 'AAAAAAAAAAAAAP/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA'
      + '/9oADAMBAAIRAxEAPwCwABmX/9k=',
      'base64'
    );
    const result = await ClaudeClient.downscale(minimalJpeg);
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBeGreaterThan(0);
  });
});
