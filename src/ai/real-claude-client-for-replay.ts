/**
 * R6.4 — Real-LLM client wrapper for replay-runner.
 *
 * Wraps `GeminiClient` to add the production concerns the replay tool needs but
 * the live bot does not (cost capping, retry, RPS throttling). Implements
 * `IClaudeClient` so it slots into `ChatModule` via the same DI seam the mock
 * client uses.
 *
 * Design contract: DESIGN.md §A. Architect approval: ARCHITECT_REVIEW.md (B1-B4).
 *
 * Vision methods delegate straight to the inner GeminiClient — replay eval
 * does not exercise vision; no retry / cost tracking added there.
 */

import type {
  ClaudeModel,
  ClaudeRequest,
  ClaudeResponse,
  IClaudeClient,
} from './claude.js';
import type { GeminiClient } from './providers/gemini-llm.js';
import { ClaudeApiError } from '../utils/errors.js';

/**
 * Gemini 2.5 Flash pricing — verified 2026-04-29 from Google AI pricing page
 * https://ai.google.dev/gemini-api/docs/pricing
 *   Input:  $0.075 / 1M tokens = 0.000075 / 1k
 *   Output: $0.30  / 1M tokens = 0.000300 / 1k
 * Update both constants AND the date-stamp above if pricing changes — single
 * change point per DESIGN §A.
 */
const GEMINI_25_FLASH_PRICE_INPUT_PER_1K = 0.000075;
const GEMINI_25_FLASH_PRICE_OUTPUT_PER_1K = 0.000300;

export interface RealLlmConfig {
  apiKey: string;
  maxCostUsd: number;
  perCallTimeoutMs: number;
  rateLimitRps: number;
  retryMax: number;
}

export interface RealLlmStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  errorCount: number;
}

/**
 * Thrown when a `complete()` call would push `totalCostUsd` past the cap.
 * Intentionally NOT a `ClaudeApiError` — `ChatModule`'s catch only swallows
 * `ClaudeApiError` / `ClaudeParseError`, so a raw `CostCapError` propagates up
 * to `runReplayRow` (or, more usually, the runner's pre-check halts the loop
 * before `complete()` ever gets called).
 *
 * `kind` discriminator allows callers to distinguish across module boundaries
 * without `instanceof`.
 */
export class CostCapError extends Error {
  readonly kind = 'cost-cap' as const;
  constructor(public readonly spent: number, public readonly cap: number) {
    super(`cost cap exceeded: $${spent.toFixed(4)} >= $${cap.toFixed(4)}`);
    this.name = 'CostCapError';
  }
}

/**
 * `withTimeout` clone — DESIGN §A says to reuse the runner-core helper, but
 * importing it here would create a backward dep `src/ai/ -> scripts/eval/`.
 * The implementation is 6 lines; duplicate per separation-of-concerns.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | null = null;
  const timeoutP = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms);
    t.unref?.();
  });
  return Promise.race([p, timeoutP]).finally(() => {
    if (t) clearTimeout(t);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

interface RawErrLike {
  status?: number;
  code?: string;
}

function extractRawErr(err: unknown): RawErrLike {
  // Two paths into here:
  //   prod: GeminiClient catches & wraps in ClaudeApiError; status hidden in `cause`
  //   test: vi.spyOn(GeminiClient.prototype, 'complete') bypasses GeminiClient's
  //         try/catch wrap, so the raw error reaches us directly
  // Architect B2: handle both.
  if (err instanceof ClaudeApiError) {
    const cause = (err as { cause?: unknown }).cause;
    return (cause ?? {}) as RawErrLike;
  }
  if (err && typeof err === 'object') {
    return err as RawErrLike;
  }
  return {};
}

function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

export class RealClaudeClientForReplay implements IClaudeClient {
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCostUsd = 0;
  private errorCount = 0;
  private lastRpsWindowStart: number;
  private callsInRpsWindow = 0;

  constructor(
    private readonly inner: GeminiClient,
    private readonly config: RealLlmConfig,
  ) {
    this.lastRpsWindowStart = Date.now();
  }

  getStats(): RealLlmStats {
    return {
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCostUsd: this.totalCostUsd,
      errorCount: this.errorCount,
    };
  }

  async complete(req: ClaudeRequest): Promise<ClaudeResponse> {
    // Step 1 — RPS sliding window. Throttles regen calls inside a single sample
    // (addressee-regen, self-echo-regen, hard-gate-regen) — runner-loop-level
    // throttling alone would not (M2 fix).
    const now = Date.now();
    if (now - this.lastRpsWindowStart >= 1000) {
      this.lastRpsWindowStart = now;
      this.callsInRpsWindow = 0;
    }
    if (this.callsInRpsWindow >= this.config.rateLimitRps) {
      const waitMs = Math.max(0, 1000 - (Date.now() - this.lastRpsWindowStart));
      if (waitMs > 0) await sleep(waitMs);
      this.lastRpsWindowStart = Date.now();
      this.callsInRpsWindow = 0;
    }
    this.callsInRpsWindow++;

    // Step 2 — cost cap pre-check. The runner loop also pre-checks before each
    // row (B1 primary halt); this is defense-in-depth in case `complete()` is
    // called outside the runner.
    if (this.totalCostUsd >= this.config.maxCostUsd) {
      throw new CostCapError(this.totalCostUsd, this.config.maxCostUsd);
    }

    // Step 3 — retry loop with exponential backoff on 429/5xx.
    const totalAttempts = this.config.retryMax + 1;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      try {
        const resp = await withTimeout(
          this.inner.complete(req),
          this.config.perCallTimeoutMs,
        );
        const callCostUsd =
          (resp.inputTokens / 1000) * GEMINI_25_FLASH_PRICE_INPUT_PER_1K +
          (resp.outputTokens / 1000) * GEMINI_25_FLASH_PRICE_OUTPUT_PER_1K;
        this.totalInputTokens += resp.inputTokens;
        this.totalOutputTokens += resp.outputTokens;
        this.totalCostUsd += callCostUsd;
        return resp;
      } catch (err) {
        lastErr = err;

        // CostCapError surfaces immediately, no retry, no errorCount++ — it is
        // a control-flow signal, not a transient failure.
        if (err instanceof CostCapError) {
          throw err;
        }

        // withTimeout fires a plain Error('timeout after Nms') — NOT a
        // ClaudeApiError. Per DESIGN: per-call timeout is not transient, do
        // not retry. Bookkeeping then rethrow.
        if (
          err instanceof Error &&
          !(err instanceof ClaudeApiError) &&
          err.message.startsWith('timeout after')
        ) {
          this.errorCount++;
          throw err;
        }

        const raw = extractRawErr(err);
        if (isRetryableStatus(raw.status) && attempt < totalAttempts - 1) {
          // Exponential backoff: 1s, 2s, 4s, capped at 8s.
          const backoffMs = Math.min(1000 * 2 ** attempt, 8000);
          await sleep(backoffMs);
          continue;
        }

        // Non-retryable, OR retries exhausted.
        this.errorCount++;
        throw err;
      }
    }

    // Unreachable — the retry loop either returns or throws. TS exhaustiveness.
    throw lastErr instanceof Error ? lastErr : new Error('retry loop fell through');
  }

  async describeImage(imageBytes: Buffer, model: ClaudeModel): Promise<string> {
    return this.inner.describeImage(imageBytes, model);
  }

  async visionWithPrompt(
    imageBytes: Buffer,
    model: ClaudeModel,
    prompt: string,
    maxTokens?: number,
  ): Promise<string> {
    return this.inner.visionWithPrompt(imageBytes, model, prompt, maxTokens);
  }
}
