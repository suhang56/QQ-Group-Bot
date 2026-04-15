import type {
  IClaudeClient,
  ClaudeRequest,
  ClaudeResponse,
  ClaudeModel,
} from '../claude.js';
import { ClaudeApiError } from '../../utils/errors.js';
import { createLogger } from '../../utils/logger.js';

/**
 * OllamaClient talks to a local Ollama server via its native /api/chat
 * endpoint (not OpenAI-compat — we need the top-level `think` flag to
 * disable Qwen3's extended reasoning, which /v1/chat/completions doesn't
 * forward).
 *
 * Implements {@link IClaudeClient} so it can slot into ModelRouter with
 * zero downstream changes. Vision methods throw — vision always routes
 * through Claude (Qwen2.5-VL's Chinese OCR is weaker than Haiku vision).
 */
export class OllamaClient implements IClaudeClient {
  private readonly logger = createLogger('ollama');
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: { baseUrl?: string; timeoutMs?: number } = {}) {
    this.baseUrl = opts.baseUrl ?? process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  /** Hits GET /api/tags. Resolves with the model list on success, rejects on network error. */
  async healthCheck(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`);
    const body = (await res.json()) as { models?: Array<{ name: string }> };
    return (body.models ?? []).map(m => m.name);
  }

  async complete(req: ClaudeRequest): Promise<ClaudeResponse> {
    const start = Date.now();
    // Strip `ollama:` / `local:` prefix from model name for Ollama's own naming.
    const model = req.model.replace(/^(ollama|local):/i, '');

    // Concatenate system blocks into one system message (Ollama supports
    // multiple system messages but a single concatenated block is simpler
    // and matches how our ClaudeClient flattens them).
    const systemText = req.system.map(b => b.text).join('\n\n');

    // Build OpenAI-style messages array for /api/chat. The native endpoint
    // accepts the same {role, content} shape.
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
    if (systemText.trim().length > 0) {
      messages.push({ role: 'system', content: systemText });
    }
    for (const m of req.messages) {
      messages.push({ role: m.role, content: m.content });
    }

    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          // Disable Qwen3's extended thinking — we want short, direct replies
          // on the background distillation paths. Without this, thinking
          // tokens eat the num_predict budget and leave content empty.
          think: false,
          options: {
            num_predict: req.maxTokens,
            // Leave temperature/top_p at Ollama defaults — Qwen's defaults
            // are tuned reasonably for instruct tasks.
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Ollama /api/chat ${res.status}: ${body.slice(0, 200)}`);
      }

      interface OllamaChatResponse {
        model: string;
        message: { role: string; content: string };
        done: boolean;
        prompt_eval_count?: number;
        eval_count?: number;
      }
      const body = (await res.json()) as OllamaChatResponse;
      const text = body.message?.content ?? '';
      const inputTokens = body.prompt_eval_count ?? 0;
      const outputTokens = body.eval_count ?? 0;

      this.logger.debug(
        { model, inputTokens, outputTokens, durationMs: Date.now() - start },
        'Ollama call completed',
      );

      return {
        text,
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
    } catch (err) {
      throw new ClaudeApiError(err);
    }
  }

  // Vision never routed here — ModelRouter delegates vision to Claude.
  async describeImage(_imageBytes: Buffer, _model: ClaudeModel): Promise<string> {
    throw new Error('OllamaClient does not support describeImage — route via Claude');
  }

  async visionWithPrompt(
    _imageBytes: Buffer,
    _model: ClaudeModel,
    _prompt: string,
    _maxTokens?: number,
  ): Promise<string> {
    throw new Error('OllamaClient does not support visionWithPrompt — route via Claude');
  }
}
