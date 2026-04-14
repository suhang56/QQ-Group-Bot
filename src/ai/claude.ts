import { query } from '@anthropic-ai/claude-agent-sdk';
import sharp from 'sharp';
import { ClaudeApiError, ClaudeParseError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

export type ClaudeModel = 'claude-haiku-4-5-20251001' | 'claude-sonnet-4-6' | 'claude-opus-4-6';

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
  /**
   * Built-in Claude Code tool names to allow during this query (e.g. `['WebSearch']`).
   * Forwarded to the Agent SDK's `allowedTools` option. Omit to run text-only.
   */
  allowedTools?: string[];
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
  /** Describe an image via Claude vision. Returns a short Chinese description. */
  describeImage(imageBytes: Buffer, model: ClaudeModel): Promise<string>;
  /** Call Claude vision with a custom text prompt. Returns raw model output. */
  visionWithPrompt(imageBytes: Buffer, model: ClaudeModel, prompt: string, maxTokens?: number): Promise<string>;
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
          ...(req.allowedTools ? { allowedTools: req.allowedTools } : {}),
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

  async describeImage(imageBytes: Buffer, model: ClaudeModel): Promise<string> {
    const downscaled = await ClaudeClient.downscale(imageBytes);
    const text = await this.visionWithPrompt(
      downscaled,
      model,
      '仔细描述这张图：人物 / 物品 / 场景 / 可见文字 / 表情 / 动作 / 颜色 / 风格 / 整体氛围。30-100 字。如果是聊天截图把可见文字内容读出来。如果是 emoji / 贴纸 / 梗图说明梗内容。如果是动画/游戏角色尽量识别角色名。只输出描述本身。',
      300,
    );
    if (!text) throw new ClaudeParseError('No text in vision response');
    return text;
  }

  /** Downscale image to 768px max dimension, JPEG 80. Falls back to original on error. */
  static async downscale(bytes: Buffer): Promise<Buffer> {
    try {
      return await sharp(bytes)
        .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
    } catch {
      return bytes;
    }
  }

  async visionWithPrompt(imageBytes: Buffer, model: ClaudeModel, prompt: string, maxTokens = 300): Promise<string> {
    const base64 = imageBytes.toString('base64');
    const mediaType = this._detectMediaType(imageBytes);

    async function* input() {
      yield {
        type: 'user' as const,
        message: {
          role: 'user' as const,
          content: [
            { type: 'image' as const, source: { type: 'base64' as const, media_type: mediaType, data: base64 } },
            { type: 'text' as const, text: prompt },
          ],
        },
        parent_tool_use_id: null as null,
      };
    }

    try {
      const result = query({
        prompt: input(),
        options: {
          model,
          settingSources: [],
          persistSession: false,
          hooks: {},
        },
      });

      let text = '';
      for await (const msg of result) {
        if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'text') text += block.text;
          }
        }
      }
      return text.trim();
    } catch (err) {
      throw new ClaudeApiError(err);
    }
  }

  private _detectMediaType(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
    if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
    // Default to jpeg for QQ images (most are JPEG)
    return 'image/jpeg';
  }
}
