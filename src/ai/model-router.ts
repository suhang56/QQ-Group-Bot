import type {
  IClaudeClient,
  ClaudeRequest,
  ClaudeResponse,
  ClaudeModel,
} from './claude.js';
import { createLogger } from '../utils/logger.js';

export interface ModelRouterProviders {
  /** Required — handles `claude*` models and serves as the vision path. */
  claude: IClaudeClient;
  /** Optional — handles `qwen*`, `ollama:*`, `local:*` models. */
  ollama?: IClaudeClient;
  /** Optional — handles `gemini*` models. */
  gemini?: IClaudeClient;
  /** Optional — handles `gpt*`, `o1*`, `o3*` models (future). */
  openai?: IClaudeClient;
  /**
   * Fallback client for provider failures. Defaults to `claude` if omitted.
   * When a non-Claude provider throws, the router retries with this client
   * using `fallbackModel` (default: `claude-haiku-4-5-20251001`).
   */
  fallbackClient?: IClaudeClient;
  fallbackModel?: ClaudeModel;
}

/**
 * Routes `complete()` calls to the right provider based on the `model`
 * name prefix. Implements {@link IClaudeClient} so callers get a single
 * client they can pass anywhere — they don't need to know which backend
 * will serve the call.
 *
 * Vision methods (`describeImage` / `visionWithPrompt`) always delegate
 * to `providers.claude` — no other provider is wired for vision right now.
 *
 * Fallback behavior: if a non-Claude provider throws, the router logs a
 * warning and retries once via `fallbackClient` (Claude by default) using
 * `fallbackModel`. This gives graceful degradation when Ollama is down or
 * Gemini hits its free-tier rate limit.
 */
export class ModelRouter implements IClaudeClient {
  private readonly logger = createLogger('model-router');
  private readonly claude: IClaudeClient;
  private readonly ollama: IClaudeClient | null;
  private readonly gemini: IClaudeClient | null;
  private readonly openai: IClaudeClient | null;
  private readonly fallbackClient: IClaudeClient;
  private readonly fallbackModel: ClaudeModel;

  constructor(providers: ModelRouterProviders) {
    this.claude = providers.claude;
    this.ollama = providers.ollama ?? null;
    this.gemini = providers.gemini ?? null;
    this.openai = providers.openai ?? null;
    this.fallbackClient = providers.fallbackClient ?? providers.claude;
    this.fallbackModel = providers.fallbackModel ?? 'claude-haiku-4-5-20251001';
  }

  /** Returns the set of registered providers, in priority order. */
  getRegisteredProviders(): string[] {
    const list = ['claude'];
    if (this.ollama) list.push('ollama');
    if (this.gemini) list.push('gemini');
    if (this.openai) list.push('openai');
    return list;
  }

  /**
   * Choose a provider for the given model name. Routing is pure —
   * doesn't mutate state. Exported (private) for testability.
   */
  _pickProvider(model: string): { provider: IClaudeClient; name: string } {
    const m = model.toLowerCase();

    if (/^(qwen|ollama:|local:)/.test(m)) {
      if (this.ollama) return { provider: this.ollama, name: 'ollama' };
      this.logger.warn({ model }, 'qwen/ollama model requested but ollama provider not registered — falling back to claude');
      return { provider: this.claude, name: 'claude-fallback' };
    }

    if (/^gemini/.test(m)) {
      if (this.gemini) return { provider: this.gemini, name: 'gemini' };
      this.logger.warn({ model }, 'gemini model requested but gemini provider not registered — falling back to claude');
      return { provider: this.claude, name: 'claude-fallback' };
    }

    if (/^(gpt|o1|o3)/.test(m)) {
      if (this.openai) return { provider: this.openai, name: 'openai' };
      this.logger.warn({ model }, 'openai model requested but openai provider not registered — falling back to claude');
      return { provider: this.claude, name: 'claude-fallback' };
    }

    // Default: claude* and anything else
    return { provider: this.claude, name: 'claude' };
  }

  async complete(req: ClaudeRequest): Promise<ClaudeResponse> {
    const { provider, name } = this._pickProvider(req.model);

    try {
      return await provider.complete(req);
    } catch (err) {
      // Don't fall back on Claude errors — Claude IS the fallback.
      if (name === 'claude' || name === 'claude-fallback') {
        throw err;
      }
      this.logger.warn(
        { err: String(err), model: req.model, provider: name, fallbackModel: this.fallbackModel },
        'provider failed — retrying via fallback client',
      );
      // Retry via fallbackClient with fallbackModel. Keep the same system
      // blocks + messages but swap the model.
      return this.fallbackClient.complete({ ...req, model: this.fallbackModel });
    }
  }

  // Vision always goes to claude. No fallback chain — if Claude vision
  // fails, the caller handles it.
  async describeImage(imageBytes: Buffer, model: ClaudeModel): Promise<string> {
    return this.claude.describeImage(imageBytes, model);
  }

  async visionWithPrompt(
    imageBytes: Buffer,
    model: ClaudeModel,
    prompt: string,
    maxTokens?: number,
  ): Promise<string> {
    return this.claude.visionWithPrompt(imageBytes, model, prompt, maxTokens);
  }
}
