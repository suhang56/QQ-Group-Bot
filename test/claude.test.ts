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
});
