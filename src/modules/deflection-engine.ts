/**
 * Deflection Engine: handles generation and caching of deflection phrases.
 * Extracted from ChatModule to isolate the deflection cache, refill timer,
 * and live generation logic.
 */

import type { IClaudeClient } from '../ai/claude.js';
import { RUNTIME_CHAT_MODEL, CHAT_QWEN_MODEL, CHAT_QWEN_DISABLED } from '../config.js';
import { createLogger } from '../utils/logger.js';
import {
  type DeflectCategory,
  DEFLECT_SITUATIONS,
  DEFLECT_FALLBACKS,
  BANGDREAM_PERSONA,
  pickDeflection,
} from './chat.js';
import { sanitizeForPrompt } from '../utils/prompt-sanitize.js';

const LIVE_DEFLECT_RULES = `<rules>
请以你的人格、态度自然回复一句极短（3-15字）。不要解释/道歉/"作为AI"/合作/接话题。只输出那句话。
现在不是水群，不能输出 <skip>。
</rules>`;

const BATCH_DEFLECT_RULES = `<rules>
必须全部不同，不要有任何两条语气相近。尽可能广地覆盖：惊讶/不屑/反问/敷衍/装傻/直接不理/幽默转移 各种风格。禁止在同一批里重复使用"啥"字或任何一个词超过 2 次。3-15 字。只输出行内容，不要编号/解释。
不能有任何一条是 <skip> 或带尖括号的内容。每条必须是真实的中文短语或emoji。
</rules>`;

function buildLiveDeflectSystem(category: DeflectCategory): string {
  const situation = DEFLECT_SITUATIONS[category];
  return `${BANGDREAM_PERSONA}\n\n# 现在的情况\n${situation}\n\n${LIVE_DEFLECT_RULES}`;
}

function buildBatchDeflectSystem(category: DeflectCategory): string {
  const situation = DEFLECT_SITUATIONS[category];
  return `${BANGDREAM_PERSONA}\n\n# 现在的情况\n${situation}\n\n${BATCH_DEFLECT_RULES}`;
}

const logger = createLogger('deflection-engine');

export interface IDeflectionEngine {
  /** Get a deflection phrase. Tries cache, then live gen, then static pool. */
  generateDeflection(
    category: DeflectCategory,
    triggerMsg: { content: string },
  ): Promise<string>;

  /** Start the cache prefill timer. */
  start(): void;
  /** Stop the cache prefill timer. */
  stop(): void;
}

export class DeflectionEngine implements IDeflectionEngine {
  private readonly cache = new Map<DeflectCategory, string[]>();
  private readonly refilling = new Set<DeflectCategory>();
  private refillTimer: ReturnType<typeof setInterval> | null = null;
  private readonly cacheEnabled: boolean;
  private readonly cacheSize: number;
  private readonly refreshIntervalMs: number;
  private readonly refreshMinThreshold: number;

  constructor(
    private readonly claude: IClaudeClient,
    options?: {
      cacheEnabled?: boolean;
      cacheSize?: number;
      refreshIntervalMs?: number;
      refreshMinThreshold?: number;
    },
  ) {
    this.cacheEnabled = options?.cacheEnabled ?? true;
    this.cacheSize = options?.cacheSize ?? 10;
    this.refreshIntervalMs = options?.refreshIntervalMs ?? 1_800_000;
    this.refreshMinThreshold = options?.refreshMinThreshold ?? 3;
  }

  start(): void {
    if (!this.cacheEnabled || this.refillTimer) return;
    void this._refillAll();
    this.refillTimer = setInterval(
      () => void this._refillAll(),
      this.refreshIntervalMs,
    );
    this.refillTimer.unref?.();
  }

  stop(): void {
    if (this.refillTimer) {
      clearInterval(this.refillTimer);
      this.refillTimer = null;
    }
  }

  async generateDeflection(
    category: DeflectCategory,
    triggerMsg: { content: string },
  ): Promise<string> {
    const cached = this.cache.get(category) ?? [];

    if (this.cacheEnabled) {
      if (cached.length <= this.refreshMinThreshold && !this.refilling.has(category)) {
        void this._refillCategory(category);
      }
      if (cached.length > 0) {
        const phrase = cached.pop()!;
        this.cache.set(category, cached);
        return phrase;
      }
      try {
        const phrase = await this._generateLive(category, triggerMsg);
        if (phrase) return phrase;
      } catch {
        // fall through to static pool
      }
    }
    return pickDeflection(DEFLECT_FALLBACKS[category]);
  }

  /** Expose cache for proactive engine to draw from (mood/silence phrases). */
  getCacheForCategory(category: DeflectCategory): string[] {
    return this.cache.get(category) ?? [];
  }

  /** Consume one phrase from cache. Returns null if empty. */
  popFromCache(category: DeflectCategory): string | null {
    const cached = this.cache.get(category) ?? [];
    if (cached.length === 0) return null;
    const phrase = cached.pop()!;
    this.cache.set(category, cached);
    if (cached.length <= this.refreshMinThreshold && !this.refilling.has(category)) {
      void this._refillCategory(category);
    }
    return phrase;
  }

  private async _generateLive(
    category: DeflectCategory,
    triggerMsg: { content: string },
  ): Promise<string | null> {
    const staticSystem = buildLiveDeflectSystem(category);
    const userMsg = `触发消息: "${sanitizeForPrompt(triggerMsg.content, 200)}"\n(生成那一句)`;
    const response = await this.claude.complete({
      model: RUNTIME_CHAT_MODEL,
      maxTokens: 50,
      system: [{ text: staticSystem, cache: true }],
      messages: [{ role: 'user', content: userMsg }],
    });
    return this._validate(response.text);
  }

  private _validate(raw: string): string | null {
    const text = raw.trim();
    if (!text) return null;
    if (text.length > 30) return null;
    if (/[<>]/.test(text)) return null;
    if (/[:：——]/.test(text)) return null;
    if (/作为ai|作为机器|我是ai|我是一个|无法|帮您|好的，|当然，/i.test(text)) return null;
    // UR-A #15: over-denial rejection
    if (/我是真人|我不是\s*(bot|ai|机器人)|你说什么呢我是人/i.test(text)) return null;
    return text;
  }

  private async _refillCategory(category: DeflectCategory): Promise<void> {
    if (this.refilling.has(category)) return;
    this.refilling.add(category);
    try {
      const staticSystem = buildBatchDeflectSystem(category);
      const seed = Math.random().toString(36).slice(2, 6);
      const userMsg = `生成 ${this.cacheSize} 条短回复（随机种子：${seed}），每条一行，共 ${this.cacheSize} 行。`;
      const refillModel = CHAT_QWEN_DISABLED ? RUNTIME_CHAT_MODEL : CHAT_QWEN_MODEL;
      const response = await this.claude.complete({
        model: refillModel,
        maxTokens: 200,
        system: [{ text: staticSystem, cache: true }],
        messages: [{ role: 'user', content: userMsg }],
      });
      const lines = response.text.split('\n');
      const valid = lines.map(l => this._validate(l)).filter((l): l is string => l !== null);
      if (valid.length > 0) {
        const existing = this.cache.get(category) ?? [];
        this.cache.set(category, [...existing, ...valid]);
        logger.debug({ category, model: refillModel, count: valid.length }, 'deflect cache refilled');
      }
    } catch (err) {
      logger.warn({ err, category }, 'deflect cache refill failed');
    } finally {
      this.refilling.delete(category);
    }
  }

  private async _refillAll(): Promise<void> {
    const allCategories: DeflectCategory[] = [
      'identity', 'task', 'memory', 'recite',
      'curse', 'silence', 'mood_happy', 'mood_bored', 'mood_annoyed', 'at_only', 'confused',
    ];
    await Promise.allSettled(allCategories.map(c => this._refillCategory(c)));
  }
}
