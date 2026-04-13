import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeClient, type IClaudeClient, type ClaudeRequest } from '../src/ai/claude.js';
import { ClaudeApiError, ClaudeParseError } from '../src/utils/errors.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

// Mock Anthropic SDK
const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
  Anthropic: class MockAnthropic {
    messages = { create: mockCreate };
  },
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

function makeSuccessResponse(text = 'hi there') {
  return {
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

describe('ClaudeClient', () => {
  let client: IClaudeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ClaudeClient('test-api-key');
  });

  it('returns parsed ClaudeResponse on success', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse('hello bot'));
    const result = await client.complete(makeRequest());
    expect(result.text).toBe('hello bot');
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
  });

  it('sets cache_control on system blocks with cache: true', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse());
    await client.complete(makeRequest());
    const call = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    const system = call['system'] as Array<Record<string, unknown>>;
    expect(system[0]!['cache_control']).toEqual({ type: 'ephemeral' });
  });

  it('retries once on 529 (overloaded)', async () => {
    const err529 = Object.assign(new Error('overloaded'), { status: 529 });
    mockCreate.mockRejectedValueOnce(err529);
    mockCreate.mockResolvedValueOnce(makeSuccessResponse('retry ok'));
    const result = await client.complete(makeRequest());
    expect(result.text).toBe('retry ok');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('retries once on 503 (service unavailable)', async () => {
    const err503 = Object.assign(new Error('service unavailable'), { status: 503 });
    mockCreate.mockRejectedValueOnce(err503);
    mockCreate.mockResolvedValueOnce(makeSuccessResponse('ok after 503'));
    const result = await client.complete(makeRequest());
    expect(result.text).toBe('ok after 503');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('throws ClaudeApiError on second 529 (no further retry)', async () => {
    const err529 = Object.assign(new Error('overloaded'), { status: 529 });
    mockCreate.mockRejectedValue(err529);
    await expect(client.complete(makeRequest())).rejects.toBeInstanceOf(ClaudeApiError);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('throws ClaudeApiError immediately on 401 (no retry)', async () => {
    const err401 = Object.assign(new Error('unauthorized'), { status: 401 });
    mockCreate.mockRejectedValueOnce(err401);
    await expect(client.complete(makeRequest())).rejects.toBeInstanceOf(ClaudeApiError);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('throws ClaudeApiError on 400 (no retry)', async () => {
    const err400 = Object.assign(new Error('bad request'), { status: 400 });
    mockCreate.mockRejectedValueOnce(err400);
    await expect(client.complete(makeRequest())).rejects.toBeInstanceOf(ClaudeApiError);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('throws ClaudeParseError when response has no text content', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 'x' }],
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    await expect(client.complete(makeRequest())).rejects.toBeInstanceOf(ClaudeParseError);
  });

  it('includes cacheReadTokens and cacheWriteTokens in response', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'cached reply' }],
      usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
    });
    const result = await client.complete(makeRequest());
    expect(result.cacheReadTokens).toBe(100);
    expect(result.cacheWriteTokens).toBe(50);
  });

  it('handles multiple system blocks — only cache:true gets cache_control', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse());
    await client.complete({
      model: 'claude-sonnet-4-6',
      maxTokens: 100,
      system: [
        { text: 'System A', cache: true },
        { text: 'System B', cache: false },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    });
    const call = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    const system = call['system'] as Array<Record<string, unknown>>;
    expect(system[0]!['cache_control']).toEqual({ type: 'ephemeral' });
    expect(system[1]!['cache_control']).toBeUndefined();
  });
});
