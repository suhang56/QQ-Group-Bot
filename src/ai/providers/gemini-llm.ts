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
      // Disable Gemini 2.5 Flash's default thinking — thinking tokens
      // count against max_tokens, so with max_tokens=300 the reasoning
      // budget leaves almost nothing for actual content. Chat path wants
      // short direct replies, not reasoning. `reasoning_effort: "none"`
      // is the OpenAI-compat parameter Google honors for this.
      const resp = await this.client.chat.completions.create({
        model: req.model,
        messages,
        max_tokens: req.maxTokens,
        reasoning_effort: 'none',
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
      const e = err as { status?: number; message?: string; code?: string; response?: { data?: unknown } };
      this.logger.warn(
        { status: e?.status, code: e?.code, message: e?.message, body: e?.response?.data },
        'Gemini API call failed',
      );
      throw new ClaudeApiError(err);
    }
  }

  async describeImage(imageBytes: Buffer, model: ClaudeModel): Promise<string> {
    const prompt = '仔细看这张图，输出两段：\n\n【图里有什么】（30-80 字）：人物 / 物品 / 场景 / 可见文字 / 表情 / 动作 / 颜色 / 风格 / 整体氛围。如果是聊天截图请把可见的文字内容尽量完整地读出来（包括用户名、时间、消息内容）。如果是 emoji / 贴纸 / 梗图请说明梗的内容和情绪。如果是动画/游戏/二次元角色请尽量识别角色名或团体。\n\n【发的人想表达】（10-40 字）：基于图的内容和上下文（吐槽 / 炫耀 / 求安慰 / 共鸣 / 嘲讽 / 反讽 / 夸奖 / 抱怨 / 自嘲 / 求互动 等），猜测发图的人想用这张图说什么。直接说"想表达"什么，不要说"可能想表达"。\n\n只输出这两段，不要前缀。格式：\n【图里有什么】xxx\n【发的人想表达】yyy';
    return this.visionWithPrompt(imageBytes, model, prompt, 400);
  }

  async visionWithPrompt(
    imageBytes: Buffer,
    model: ClaudeModel,
    prompt: string,
    maxTokens = 400,
  ): Promise<string> {
    const start = Date.now();
    // Detect mime from magic bytes (best-effort); default to jpeg.
    const mime = detectMime(imageBytes);
    const dataUrl = `data:${mime};base64,${imageBytes.toString('base64')}`;

    try {
      const resp = await this.client.chat.completions.create({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              // OpenAI-compat multimodal image_url with inline data URL.
              // Google AI Studio honors this for Gemini 1.5 / 2.5 models.
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        max_tokens: maxTokens,
        // Same thinking-disable as text chat — keep vision response short and
        // avoid reasoning-token budget exhaustion.
        reasoning_effort: 'none',
      });

      const text = resp.choices[0]?.message?.content ?? '';
      this.logger.debug(
        { model, outputLen: text.length, durationMs: Date.now() - start },
        'Gemini vision call completed',
      );
      if (!text) throw new Error('Gemini vision returned empty content');
      return text;
    } catch (err) {
      const e = err as { status?: number; message?: string; code?: string; response?: { data?: unknown } };
      this.logger.warn(
        { status: e?.status, code: e?.code, message: e?.message, body: e?.response?.data },
        'Gemini vision API call failed',
      );
      throw new ClaudeApiError(err);
    }
  }
}

function detectMime(bytes: Buffer): string {
  if (bytes.length >= 4) {
    // JPEG: FF D8 FF
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    // PNG: 89 50 4E 47
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    // GIF: 47 49 46 38
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
    // WebP: 52 49 46 46 ... 57 45 42 50
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  }
  return 'image/jpeg';
}
