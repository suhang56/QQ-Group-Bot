import Anthropic from '@anthropic-ai/sdk';
import { ClaudeApiError, ClaudeParseError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

export type ClaudeModel = 'claude-sonnet-4-6' | 'claude-opus-4-6';

export interface CachedSystemBlock {
  text: string;
  cache: true;
}

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ClaudeRequest {
  model: ClaudeModel;
  maxTokens: number;
  system: CachedSystemBlock[];
  messages: ClaudeMessage[];
}

export interface ClaudeResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface IClaudeClient {
  complete(req: ClaudeRequest): Promise<ClaudeResponse>;
}

const RETRYABLE_STATUSES = new Set([429, 503, 529]);

export class ClaudeClient implements IClaudeClient {
  private readonly anthropic: Anthropic;
  private readonly logger = createLogger('claude');

  constructor(apiKey: string) {
    this.anthropic = new Anthropic({ apiKey });
  }

  async complete(req: ClaudeRequest): Promise<ClaudeResponse> {
    return this._callWithRetry(req, false);
  }

  private async _callWithRetry(req: ClaudeRequest, isRetry: boolean): Promise<ClaudeResponse> {
    const start = Date.now();
    try {
      const systemBlocks = req.system.map(block => {
        const base: Record<string, unknown> = { type: 'text', text: block.text };
        if (block.cache) base['cache_control'] = { type: 'ephemeral' };
        return base;
      });

      const response = await this.anthropic.messages.create({
        model: req.model,
        max_tokens: req.maxTokens,
        system: systemBlocks as unknown as Anthropic.TextBlockParam[],
        messages: req.messages.map(m => ({ role: m.role, content: m.content })),
      });

      const textBlock = response.content.find(b => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new ClaudeParseError(JSON.stringify(response.content));
      }

      const usage = response.usage as Anthropic.Usage & {
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };

      const result: ClaudeResponse = {
        text: textBlock.text,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      };

      this.logger.debug({
        model: req.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheWriteTokens: result.cacheWriteTokens,
        durationMs: Date.now() - start,
      }, 'Claude API call completed');

      return result;
    } catch (err) {
      if (err instanceof ClaudeParseError) throw err;

      const status = (err as { status?: number }).status;

      if (!isRetry && status !== undefined && RETRYABLE_STATUSES.has(status)) {
        this.logger.warn({ status, model: req.model }, 'Claude API retryable error — retrying after 2s');
        await new Promise(r => setTimeout(r, 2000));
        return this._callWithRetry(req, true);
      }

      throw new ClaudeApiError(err);
    }
  }
}
