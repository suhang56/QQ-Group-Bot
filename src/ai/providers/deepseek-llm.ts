import OpenAI from 'openai';
import type {
  IClaudeClient,
  ClaudeRequest,
  ClaudeResponse,
  ClaudeModel,
} from '../claude.js';
import { ClaudeApiError } from '../../utils/errors.js';
import { createLogger } from '../../utils/logger.js';

/**
 * DeepSeekClient talks to DeepSeek's OpenAI-compatible endpoint.
 *
 *   baseURL: https://api.deepseek.com
 *   apiKey:  DEEPSEEK_API_KEY env var
 *
 * DeepSeek V3.2 (`deepseek-chat`) is the cost-optimized primary chat model.
 * Server-side prompt caching reports hit tokens via `prompt_cache_hit_tokens`
 * — there is no explicit cache write signal, so cacheWriteTokens stays 0.
 *
 * Implements {@link IClaudeClient}. Vision methods throw — route via Claude.
 */
export class DeepSeekClient implements IClaudeClient {
  private readonly logger = createLogger('deepseek');
  private readonly client: OpenAI;
  private readonly timeoutMs: number;

  constructor(opts: { apiKey?: string; baseUrl?: string; timeoutMs?: number } = {}) {
    const apiKey = opts.apiKey ?? process.env['DEEPSEEK_API_KEY'];
    if (!apiKey) {
      throw new Error('DeepSeekClient requires DEEPSEEK_API_KEY env var');
    }
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.client = new OpenAI({
      apiKey,
      baseURL: opts.baseUrl ?? 'https://api.deepseek.com',
      timeout: this.timeoutMs,
    });
  }

  async complete(req: ClaudeRequest): Promise<ClaudeResponse> {
    const start = Date.now();
    const systemText = req.system.map(b => b.text).join('\n\n');

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (systemText.trim().length > 0) {
      messages.push({ role: 'system', content: systemText });
    }
    for (const m of req.messages) {
      messages.push({ role: m.role, content: m.content });
    }

    try {
      const resp = await this.client.chat.completions.create({
        model: req.model,
        messages,
        max_tokens: req.maxTokens,
      });

      const text = resp.choices[0]?.message?.content ?? '';
      const usage = resp.usage as unknown as {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_cache_hit_tokens?: number;
      } | undefined;
      const inputTokens = usage?.prompt_tokens ?? 0;
      const outputTokens = usage?.completion_tokens ?? 0;
      const cacheReadTokens = usage?.prompt_cache_hit_tokens ?? 0;

      this.logger.debug(
        { model: req.model, inputTokens, outputTokens, cacheReadTokens, durationMs: Date.now() - start },
        'DeepSeek call completed',
      );

      if (!text) {
        throw new Error('DeepSeek returned empty content');
      }

      return {
        text,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens: 0,
      };
    } catch (err) {
      throw new ClaudeApiError(err);
    }
  }

  async describeImage(_imageBytes: Buffer, _model: ClaudeModel): Promise<string> {
    throw new Error('DeepSeekClient does not support describeImage — route via Claude');
  }

  async visionWithPrompt(
    _imageBytes: Buffer,
    _model: ClaudeModel,
    _prompt: string,
    _maxTokens?: number,
  ): Promise<string> {
    throw new Error('DeepSeekClient does not support visionWithPrompt — route via Claude');
  }
}
