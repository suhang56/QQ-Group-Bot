import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaClient } from '../src/ai/providers/ollama-llm.js';
import { ClaudeApiError } from '../src/utils/errors.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

describe('OllamaClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('complete', () => {
    it('returns parsed ClaudeResponse on success', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'qwen3:8b',
          message: { role: 'assistant', content: '你好' },
          done: true,
          prompt_eval_count: 24,
          eval_count: 2,
        }),
      });

      const client = new OllamaClient({ baseUrl: 'http://localhost:11434' });
      const resp = await client.complete({
        model: 'qwen3:8b',
        maxTokens: 40,
        system: [{ text: 'be short', cache: true }],
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(resp.text).toBe('你好');
      expect(resp.inputTokens).toBe(24);
      expect(resp.outputTokens).toBe(2);
      expect(resp.cacheReadTokens).toBe(0);
      expect(resp.cacheWriteTokens).toBe(0);

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('http://localhost:11434/api/chat');
      const body = JSON.parse((init as { body: string }).body);
      expect(body.model).toBe('qwen3:8b');
      expect(body.think).toBe(false);
      expect(body.stream).toBe(false);
      expect(body.options.num_predict).toBe(40);
      expect(body.options.num_ctx).toBe(32768);
      expect(body.messages).toEqual([
        { role: 'system', content: 'be short' },
        { role: 'user', content: 'hi' },
      ]);
    });

    it('strips ollama: and local: model prefix', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'qwen3:8b',
          message: { role: 'assistant', content: 'ok' },
          done: true,
          prompt_eval_count: 5,
          eval_count: 1,
        }),
      });

      const client = new OllamaClient();
      await client.complete({
        model: 'ollama:qwen3:8b',
        maxTokens: 10,
        system: [],
        messages: [{ role: 'user', content: 'hi' }],
      });

      const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
      expect(body.model).toBe('qwen3:8b');
    });

    it('omits system message when system[] is empty', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: { content: 'ok' },
          done: true,
          prompt_eval_count: 1,
          eval_count: 1,
        }),
      });

      const client = new OllamaClient();
      await client.complete({
        model: 'qwen3:8b',
        maxTokens: 10,
        system: [],
        messages: [{ role: 'user', content: 'hi' }],
      });

      const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
      expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('concatenates multiple system blocks with double newline', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: { content: 'ok' },
          done: true,
          prompt_eval_count: 1,
          eval_count: 1,
        }),
      });

      const client = new OllamaClient();
      await client.complete({
        model: 'qwen3:8b',
        maxTokens: 10,
        system: [
          { text: 'block 1', cache: true },
          { text: 'block 2', cache: true },
        ],
        messages: [{ role: 'user', content: 'hi' }],
      });

      const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
      expect(body.messages[0]).toEqual({ role: 'system', content: 'block 1\n\nblock 2' });
    });

    it('throws ClaudeApiError on non-ok HTTP status', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'internal error',
      });

      const client = new OllamaClient();
      await expect(
        client.complete({
          model: 'qwen3:8b',
          maxTokens: 10,
          system: [],
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ).rejects.toThrow(ClaudeApiError);
    });

    it('throws ClaudeApiError on network failure', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const client = new OllamaClient();
      await expect(
        client.complete({
          model: 'qwen3:8b',
          maxTokens: 10,
          system: [],
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ).rejects.toThrow(ClaudeApiError);
    });
  });

  describe('healthCheck', () => {
    it('returns model names from /api/tags', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [{ name: 'qwen3:8b' }, { name: 'qwen2.5:14b' }] }),
      });

      const client = new OllamaClient();
      const names = await client.healthCheck();
      expect(names).toEqual(['qwen3:8b', 'qwen2.5:14b']);
    });

    it('rejects on non-ok status', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
      const client = new OllamaClient();
      await expect(client.healthCheck()).rejects.toThrow(/503/);
    });
  });

  describe('vision methods', () => {
    it('describeImage throws', async () => {
      const client = new OllamaClient();
      await expect(client.describeImage(Buffer.from([]), 'claude-haiku-4-5-20251001')).rejects.toThrow(
        /does not support describeImage/,
      );
    });

    it('visionWithPrompt throws', async () => {
      const client = new OllamaClient();
      await expect(
        client.visionWithPrompt(Buffer.from([]), 'claude-haiku-4-5-20251001', 'desc'),
      ).rejects.toThrow(/does not support visionWithPrompt/);
    });
  });
});
