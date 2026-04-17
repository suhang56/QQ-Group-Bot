import type { IMessageRepository, IExpressionPatternRepository, ExpressionPattern } from '../storage/db.js';
import { createLogger } from '../utils/logger.js';
import type { Logger } from 'pino';

const CQ_ONLY_RE = /^\[CQ:[^\]]+\]$/;
const COMMAND_RE = /^\//;

// M8.3: few-shot emission into cached system block.
export const FEWSHOT_DEFAULT_N = 3;
export const FEWSHOT_MAX_N = 5;

export interface ExpressionLearnerOptions {
  messages: IMessageRepository;
  expressionPatterns: IExpressionPatternRepository;
  botUserId: string;
  logger?: Logger;
  decayDays?: number;
  maxPatternsPerGroup?: number;
}

export class ExpressionLearner {
  private readonly messages: IMessageRepository;
  private readonly patterns: IExpressionPatternRepository;
  private readonly botUserId: string;
  private readonly logger: Logger;
  private readonly decayDays: number;
  private readonly maxPatternsPerGroup: number;

  constructor(opts: ExpressionLearnerOptions) {
    this.messages = opts.messages;
    this.patterns = opts.expressionPatterns;
    this.botUserId = opts.botUserId;
    this.logger = opts.logger ?? createLogger('expression-learner');
    this.decayDays = opts.decayDays ?? 15;
    this.maxPatternsPerGroup = opts.maxPatternsPerGroup ?? 300;
  }

  private _shouldSkip(content: string): boolean {
    if (content.length < 3) return true;
    if (COMMAND_RE.test(content)) return true;
    if (CQ_ONLY_RE.test(content)) return true;
    return false;
  }

  scan(groupId: string): void {
    const recent = this.messages.getRecent(groupId, 500);
    // getRecent returns DESC order — reverse to chronological
    const msgs = [...recent].reverse();

    let inserted = 0;
    for (let i = 0; i < msgs.length - 1; i++) {
      const userMsg = msgs[i]!;
      const botMsg = msgs[i + 1]!;

      // Must be: non-bot → bot consecutive pair
      if (userMsg.userId === this.botUserId) continue;
      if (botMsg.userId !== this.botUserId) continue;

      if (this._shouldSkip(userMsg.content) || this._shouldSkip(botMsg.content)) continue;

      const situation = userMsg.content.slice(0, 50);
      const expression = botMsg.content.slice(0, 100);

      this.patterns.upsert(groupId, situation, expression);
      inserted++;
    }

    this.logger.debug({ groupId, scannedPairs: inserted }, 'expression scan complete');
  }

  applyDecay(groupId: string): void {
    const now = Date.now();
    const patterns = this.patterns.listAll(groupId);

    let decayed = 0;
    let deleted = 0;

    for (const p of patterns) {
      const daysSinceUpdate = (now - p.updatedAt) / (1000 * 60 * 60 * 24);
      const newWeight = p.weight * Math.exp(-daysSinceUpdate / this.decayDays);

      if (newWeight < 0.01) {
        this.patterns.delete(groupId, p.situation, p.expression);
        deleted++;
      } else if (Math.abs(newWeight - p.weight) > 0.001) {
        this.patterns.updateWeight(groupId, p.situation, p.expression, newWeight);
        decayed++;
      }
    }

    // Enforce max patterns per group
    const remaining = this.patterns.listAll(groupId);
    if (remaining.length > this.maxPatternsPerGroup) {
      // Sort ascending by weight, delete the lowest
      const sorted = [...remaining].sort((a, b) => a.weight - b.weight);
      const toDelete = sorted.slice(0, remaining.length - this.maxPatternsPerGroup);
      for (const p of toDelete) {
        this.patterns.delete(groupId, p.situation, p.expression);
        deleted++;
      }
    }

    this.logger.info({ groupId, decayed, deleted }, 'expression decay applied');
  }

  formatForPrompt(groupId: string, limit = 5): string {
    const topPatterns = this.patterns.getTopN(groupId, limit);
    if (topPatterns.length === 0) return '';

    const lines = topPatterns.map(
      p => `- 当有人说「${p.situation}」时，你回过「${p.expression}」`,
    );
    return `## 你之前的回复风格参考\n${lines.join('\n')}`;
  }

  /**
   * Return up to `n` patterns for few-shot grounding. When `matchContent` is
   * given, patterns whose situation contains (or is contained by) it are
   * surfaced first (weight-desc). If fewer than n match, top-by-weight+recency
   * fills the rest without duplicates. n is capped at FEWSHOT_MAX_N.
   */
  getTopRecent(groupId: string, n: number, matchContent?: string): ExpressionPattern[] {
    const capped = Math.max(0, Math.min(n, FEWSHOT_MAX_N));
    if (capped === 0) return [];

    if (matchContent && matchContent.length > 0) {
      const all = this.patterns.listAll(groupId);
      const hits = all
        .filter(p => {
          const s = p.situation;
          return s.length > 0 && (matchContent.includes(s) || s.includes(matchContent));
        })
        .sort((a, b) => {
          if (b.weight !== a.weight) return b.weight - a.weight;
          return b.updatedAt - a.updatedAt;
        });

      if (hits.length >= capped) return hits.slice(0, capped);

      const seen = new Set(hits.map(p => `${p.situation}\u0000${p.expression}`));
      const fill = this.patterns.getTopRecentN(groupId, capped);
      const result: ExpressionPattern[] = [...hits];
      for (const p of fill) {
        if (result.length >= capped) break;
        const key = `${p.situation}\u0000${p.expression}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(p);
      }
      return result;
    }

    return this.patterns.getTopRecentN(groupId, capped);
  }

  /**
   * Build a system-block snippet of concrete past (situation → expression) pairs
   * for few-shot grounding. Returns '' when no patterns exist so caller can
   * conditionally append without emitting a dangling header.
   */
  formatFewShotBlock(
    groupId: string,
    n: number = FEWSHOT_DEFAULT_N,
    matchContent?: string,
  ): string {
    const patterns = this.getTopRecent(groupId, n, matchContent);
    if (patterns.length === 0) return '';

    const pairs = patterns.map(
      p => `有人说：「${p.situation}」\n你回：「${p.expression}」`,
    );
    return `## 你过去的真实回复示例\n${pairs.join('\n\n')}`;
  }
}
