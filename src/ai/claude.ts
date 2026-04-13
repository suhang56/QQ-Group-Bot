import { query } from '@anthropic-ai/claude-agent-sdk';
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

export class ClaudeClient implements IClaudeClient {
  private readonly logger = createLogger('claude');

  async complete(req: ClaudeRequest): Promise<ClaudeResponse> {
    const start = Date.now();

    // Build prompt from messages; prepend role labels for multi-turn history
    const prompt = req.messages
      .map(m => (m.role === 'user' ? m.content : `Assistant: ${m.content}`))
      .join('\n');

    // Concatenate system blocks into a single system prompt
    const systemPrompt = req.system.map(b => b.text).join('\n');

    try {
      let text = '';
      let inputTokens = 0;
      let outputTokens = 0;

      // ISOLATION: settingSources:[] prevents the SDK from reading any host CLI
      // settings (~/.claude/settings.json, project .claude/, CLAUDE.md files).
      // Without this, the host user's Stop hooks fire at the end of each query()
      // call and their output gets concatenated into the model's reply — causing
      // hook text like "No user corrections received this session" to leak into
      // QQ group messages. persistSession:false prevents writing session state to
      // disk. hooks:{} ensures no programmatic hooks are registered either.
      const result = query({
        prompt,
        options: {
          model: req.model,
          systemPrompt,
          settingSources: [],
          persistSession: false,
          hooks: {},
        },
      });

      for await (const message of result) {
        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'text') {
              text += block.text;
            }
          }
        } else if (message.type === 'result') {
          const usage = (message as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
          inputTokens = usage?.input_tokens ?? 0;
          outputTokens = usage?.output_tokens ?? 0;
        }
      }

      if (!text) {
        throw new ClaudeParseError('No text content in response');
      }

      this.logger.debug({
        model: req.model,
        inputTokens,
        outputTokens,
        durationMs: Date.now() - start,
      }, 'Claude API call completed');

      return {
        text,
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
    } catch (err) {
      if (err instanceof ClaudeParseError) throw err;
      throw new ClaudeApiError(err);
    }
  }
}
