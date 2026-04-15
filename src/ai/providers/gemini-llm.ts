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
 * GeminiClient talks to Google AI Studio's OpenAI-compatible endpoint.
 *
 *   baseURL: https://generativelanguage.googleapis.com/v1beta/openai/
 *   apiKey:  GEMINI_API_KEY env var
 *
 * Gemini 2.0 Flash has a generous free tier (1,500 requests/day) which makes
 * it perfect for background distillation loops on machines without a GPU.
 *
 * Implements {@link IClaudeClient}. Vision methods throw for now — can be
 * added later via Gemini's multimodal content blocks without breaking
 * existing callers.
 */
export class GeminiClient implements IClaudeClient {
  private readonly logger = createLogger('gemini');
  private readonly client: OpenAI;
  private readonly timeoutMs: number;

  constructor(opts: { apiKey?: string; baseUrl?: string; timeoutMs?: number } = {}) {
    const apiKey = opts.apiKey ?? process.env['GEMINI_API_KEY'];
    if (!apiKey) {
      throw new Error('GeminiClient requires GEMINI_API_KEY env var');
    }
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.client = new OpenAI({
      apiKey,
      baseURL: opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta/openai/',
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
      const inputTokens = resp.usage?.prompt_tokens ?? 0;
      const outputTokens = resp.usage?.completion_tokens ?? 0;

      this.logger.debug(
        { model: req.model, inputTokens, outputTokens, durationMs: Date.now() - start },
        'Gemini call completed',
      );

      if (!text) {
        throw new Error('Gemini returned empty content');
      }

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

  async describeImage(_imageBytes: Buffer, _model: ClaudeModel): Promise<string> {
    throw new Error('GeminiClient does not support describeImage — route via Claude');
  }

  async visionWithPrompt(
    _imageBytes: Buffer,
    _model: ClaudeModel,
    _prompt: string,
    _maxTokens?: number,
  ): Promise<string> {
    throw new Error('GeminiClient does not support visionWithPrompt — route via Claude');
  }
}
