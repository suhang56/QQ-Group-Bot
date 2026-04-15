import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelRouter } from '../src/ai/model-router.js';
import type { IClaudeClient, ClaudeRequest, ClaudeResponse } from '../src/ai/claude.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

function makeStubClient(name: string, response = 'stub-reply'): IClaudeClient & {
  completeSpy: ReturnType<typeof vi.fn>;
} {
  const completeSpy = vi.fn().mockResolvedValue({
    text: `${name}:${response}`,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  } satisfies ClaudeResponse);
  return {
    complete: completeSpy,
    describeImage: vi.fn().mockResolvedValue(`${name}-img`),
    visionWithPrompt: vi.fn().mockResolvedValue(`${name}-vis`),
    completeSpy,
  };
}

function makeRequest(model: string): ClaudeRequest {
  return {
    model: model as ClaudeRequest['model'],
    maxTokens: 10,
    system: [],
    messages: [{ role: 'user', content: 'hi' }],
  };
}

describe('ModelRouter', () => {
  let claude: ReturnType<typeof makeStubClient>;
  let ollama: ReturnType<typeof makeStubClient>;
  let gemini: ReturnType<typeof makeStubClient>;
  let deepseek: ReturnType<typeof makeStubClient>;

  beforeEach(() => {
    claude = makeStubClient('claude');
    ollama = makeStubClient('ollama');
    gemini = makeStubClient('gemini');
    deepseek = makeStubClient('deepseek');
  });

  describe('routing by model-name prefix', () => {
    it('routes qwen* → ollama', async () => {
      const router = new ModelRouter({ claude, ollama });
      const resp = await router.complete(makeRequest('qwen3:8b'));
      expect(resp.text).toBe('ollama:stub-reply');
      expect(ollama.completeSpy).toHaveBeenCalledOnce();
      expect(claude.completeSpy).not.toHaveBeenCalled();
    });

    it('routes ollama: prefix → ollama', async () => {
      const router = new ModelRouter({ claude, ollama });
      await router.complete(makeRequest('ollama:qwen3:8b'));
      expect(ollama.completeSpy).toHaveBeenCalledOnce();
    });

    it('routes local: prefix → ollama', async () => {
      const router = new ModelRouter({ claude, ollama });
      await router.complete(makeRequest('local:qwen3:8b'));
      expect(ollama.completeSpy).toHaveBeenCalledOnce();
    });

    it('routes gemini* → gemini', async () => {
      const router = new ModelRouter({ claude, gemini });
      await router.complete(makeRequest('gemini-2.0-flash-exp'));
      expect(gemini.completeSpy).toHaveBeenCalledOnce();
      expect(claude.completeSpy).not.toHaveBeenCalled();
    });

    it('routes deepseek-chat → deepseek when registered', async () => {
      const router = new ModelRouter({ claude, deepseek });
      await router.complete(makeRequest('deepseek-chat'));
      expect(deepseek.completeSpy).toHaveBeenCalledOnce();
      expect(claude.completeSpy).not.toHaveBeenCalled();
    });

    it('routes deepseek-chat → claude-fallback when deepseek not registered', async () => {
      const router = new ModelRouter({ claude });
      await router.complete(makeRequest('deepseek-chat'));
      expect(claude.completeSpy).toHaveBeenCalledOnce();
    });

    it('routes claude-sonnet-4-6 → claude', async () => {
      const router = new ModelRouter({ claude, ollama, gemini });
      await router.complete(makeRequest('claude-sonnet-4-6'));
      expect(claude.completeSpy).toHaveBeenCalledOnce();
      expect(ollama.completeSpy).not.toHaveBeenCalled();
      expect(gemini.completeSpy).not.toHaveBeenCalled();
    });

    it('routes unknown prefix → claude (default)', async () => {
      const router = new ModelRouter({ claude, ollama });
      await router.complete(makeRequest('unknown-model-xyz'));
      expect(claude.completeSpy).toHaveBeenCalledOnce();
    });
  });

  describe('fallback when provider unavailable', () => {
    it('falls back to claude when qwen model requested but ollama not registered', async () => {
      const router = new ModelRouter({ claude }); // no ollama
      await router.complete(makeRequest('qwen3:8b'));
      expect(claude.completeSpy).toHaveBeenCalledOnce();
    });

    it('falls back to claude when gemini not registered', async () => {
      const router = new ModelRouter({ claude }); // no gemini
      await router.complete(makeRequest('gemini-2.0-flash-exp'));
      expect(claude.completeSpy).toHaveBeenCalledOnce();
    });
  });

  describe('fallback on provider error', () => {
    it('retries via claude when ollama throws', async () => {
      ollama.completeSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const router = new ModelRouter({ claude, ollama });
      const resp = await router.complete(makeRequest('qwen3:8b'));
      expect(ollama.completeSpy).toHaveBeenCalledOnce();
      expect(claude.completeSpy).toHaveBeenCalledOnce();
      // Claude was called with the fallbackModel, not the original
      const claudeReq = claude.completeSpy.mock.calls[0]![0] as ClaudeRequest;
      expect(claudeReq.model).toBe('claude-haiku-4-5-20251001');
      expect(resp.text).toBe('claude:stub-reply');
    });

    it('respects custom fallbackModel', async () => {
      ollama.completeSpy.mockRejectedValueOnce(new Error('timeout'));
      const router = new ModelRouter({
        claude,
        ollama,
        fallbackModel: 'claude-sonnet-4-6',
      });
      await router.complete(makeRequest('qwen3:8b'));
      const claudeReq = claude.completeSpy.mock.calls[0]![0] as ClaudeRequest;
      expect(claudeReq.model).toBe('claude-sonnet-4-6');
    });

    it('does NOT fallback when claude itself errors', async () => {
      claude.completeSpy.mockRejectedValueOnce(new Error('claude down'));
      const router = new ModelRouter({ claude, ollama });
      await expect(router.complete(makeRequest('claude-sonnet-4-6'))).rejects.toThrow('claude down');
      // Only one call — no infinite fallback loop
      expect(claude.completeSpy).toHaveBeenCalledOnce();
    });

    it('falls back when gemini errors', async () => {
      gemini.completeSpy.mockRejectedValueOnce(new Error('rate limited'));
      const router = new ModelRouter({ claude, gemini });
      const resp = await router.complete(makeRequest('gemini-2.0-flash-exp'));
      expect(gemini.completeSpy).toHaveBeenCalledOnce();
      expect(claude.completeSpy).toHaveBeenCalledOnce();
      expect(resp.text).toBe('claude:stub-reply');
    });
  });

  describe('vision methods always delegate to claude', () => {
    it('describeImage → claude', async () => {
      const router = new ModelRouter({ claude, ollama, gemini });
      const out = await router.describeImage(Buffer.from([]), 'claude-haiku-4-5-20251001');
      expect(out).toBe('claude-img');
      expect(claude.describeImage).toHaveBeenCalledOnce();
      expect(ollama.describeImage).not.toHaveBeenCalled();
    });

    it('visionWithPrompt → claude', async () => {
      const router = new ModelRouter({ claude, ollama, gemini });
      const out = await router.visionWithPrompt(
        Buffer.from([]),
        'claude-haiku-4-5-20251001',
        'describe this',
      );
      expect(out).toBe('claude-vis');
      expect(claude.visionWithPrompt).toHaveBeenCalledOnce();
    });
  });

  describe('getRegisteredProviders', () => {
    it('returns only claude when nothing else registered', () => {
      const router = new ModelRouter({ claude });
      expect(router.getRegisteredProviders()).toEqual(['claude']);
    });

    it('returns all registered providers in order', () => {
      const router = new ModelRouter({ claude, ollama, gemini });
      expect(router.getRegisteredProviders()).toEqual(['claude', 'ollama', 'gemini']);
    });

    it('includes deepseek when registered', () => {
      const router = new ModelRouter({ claude, ollama, gemini, deepseek });
      expect(router.getRegisteredProviders()).toEqual(['claude', 'ollama', 'gemini', 'deepseek']);
    });
  });
});
