import type { Logger } from 'pino';
import type { IClaudeClient, ClaudeModel } from '../ai/claude.js';
import type { Database } from '../storage/db.js';
import { createLogger } from '../utils/logger.js';

/**
 * Configuration for {@link SelfLearningModule}.
 *
 * Rate-limit thresholds and the distillation model are injectable so tests can
 * drive the limiter deterministically and stub the Claude client.
 */
export interface SelfLearningOptions {
  db: Database;
  claude: IClaudeClient;
  logger?: Logger;
  /** QQ id of the bot itself — used to reject self-corrections. */
  botUserId?: string;
  /** Max correction-distillations per group inside {@link correctionWindowMs}. Default 5. */
  correctionMaxPer10Min?: number;
  /** Window for correction rate-limiter, in ms. Default 600_000 (10 min). */
  correctionWindowMs?: number;
  /** Max passive-harvest distillations per group inside {@link harvestWindowMs}. Default 2. */
  harvestMaxPerMinute?: number;
  /** Window for harvest rate-limiter, in ms. Default 60_000 (1 min). */
  harvestWindowMs?: number;
  /** Claude model used for both distillation paths. Default `claude-sonnet-4-6`. */
  model?: ClaudeModel;
  /** Override clock for tests. */
  now?: () => number;
}

/**
 * Result returned when a fact is successfully distilled and persisted.
 */
export interface DistilledFact {
  factId: number;
  fact: string;
}

/** Patterns that indicate a group member is correcting a previous statement. */
const CORRECTION_PATTERNS: ReadonlyArray<RegExp> = [
  /不是.*[是叫]/,
  /应该是/,
  /错了/,
  /搞错/,
  /这(是|叫).*的/,
  /是.*不是.*/,
  /根本(不是|没)/,
];

/** Minimum length of a candidate correction message — anything shorter is noise. */
const MIN_CORRECTION_LENGTH = 3;

/**
 * Captures factual corrections from group members and turns them into
 * `learned_facts` rows. Two paths:
 *
 * 1. **Active correction** ({@link detectCorrection}) — a member reply-quotes
 *    a recent bot reply and the message matches a correction pattern.
 * 2. **Passive harvest** ({@link harvestPassiveKnowledge}) — after the bot
 *    emits an evasive reply ("忘了" / "考我呢"), a router-side timer collects
 *    follow-up messages and asks Claude to extract any answer the group
 *    provided.
 *
 * The chat module reads `formatFactsForPrompt` to inject learned facts into
 * the system prompt so the bot does not repeat the same mistake.
 */
export class SelfLearningModule {
  private readonly db: Database;
  private readonly claude: IClaudeClient;
  private readonly logger: Logger;
  private readonly botUserId: string | undefined;
  private readonly correctionMaxPer10Min: number;
  private readonly correctionWindowMs: number;
  private readonly harvestMaxPerMinute: number;
  private readonly harvestWindowMs: number;
  private readonly model: ClaudeModel;
  private readonly now: () => number;

  private readonly correctionStamps: Map<string, number[]> = new Map();
  private readonly harvestStamps: Map<string, number[]> = new Map();

  constructor(opts: SelfLearningOptions) {
    this.db = opts.db;
    this.claude = opts.claude;
    this.logger = opts.logger ?? createLogger('self-learning');
    this.botUserId = opts.botUserId;
    this.correctionMaxPer10Min = opts.correctionMaxPer10Min ?? 5;
    this.correctionWindowMs = opts.correctionWindowMs ?? 600_000;
    this.harvestMaxPerMinute = opts.harvestMaxPerMinute ?? 2;
    this.harvestWindowMs = opts.harvestWindowMs ?? 60_000;
    this.model = opts.model ?? 'claude-sonnet-4-6';
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Detect whether `correctionMsg` is a factual correction of `botReplyId`.
   *
   * The caller (router integration layer in Batch C wire-up) is responsible
   * for confirming the group message reply-quotes a known bot reply id. This
   * method handles content matching, rate limiting, Claude distillation, and
   * row insertion.
   *
   * @returns the freshly-inserted {@link DistilledFact}, or `null` if the
   * message did not qualify as a correction (rate-limited, sentinel skip,
   * Claude said no, malformed JSON, etc.).
   */
  async detectCorrection(params: {
    groupId: string;
    botReplyId: number;
    correctionMsg: { content: string; userId: string; nickname: string; messageId: string };
  }): Promise<DistilledFact | null> {
    const { groupId, botReplyId, correctionMsg } = params;
    const content = correctionMsg.content.trim();

    if (this.botUserId !== undefined && correctionMsg.userId === this.botUserId) {
      this.logger.debug({ groupId }, 'self-correction skipped');
      return null;
    }
    if (content.length < MIN_CORRECTION_LENGTH) {
      this.logger.debug({ groupId }, 'correction too short');
      return null;
    }
    if (!CORRECTION_PATTERNS.some(re => re.test(content))) {
      return null;
    }
    if (!this._allowCorrection(groupId)) {
      this.logger.warn({ groupId }, 'correction rate-limit hit');
      return null;
    }

    const botReply = this.db.botReplies.getById(botReplyId);
    if (!botReply) {
      this.logger.debug({ groupId, botReplyId }, 'bot reply not found for correction target');
      return null;
    }

    const distilled = await this._distillCorrection(botReply.triggerContent, botReply.botReply, content);
    if (!distilled || !distilled.isCorrection) {
      return null;
    }

    const factId = this.db.learnedFacts.insert({
      groupId,
      topic: distilled.topic ?? null,
      fact: distilled.correctFact,
      sourceUserId: correctionMsg.userId,
      sourceUserNickname: correctionMsg.nickname,
      sourceMsgId: correctionMsg.messageId,
      botReplyId,
    });
    this.logger.info({ groupId, factId, fact: distilled.correctFact }, 'learned fact (correction)');
    return { factId, fact: distilled.correctFact };
  }

  /**
   * Distill a factual answer from `followups` after the bot punted on
   * `originalTrigger` with an evasive reply.
   *
   * The 60-second collection window and the choice of which messages count as
   * "follow-ups on the same topic" live outside this class; the router schedules
   * the timer and supplies the collected messages here. This method enforces
   * its own per-group rate limit (default 2 calls per 60 seconds).
   */
  async harvestPassiveKnowledge(params: {
    groupId: string;
    evasiveBotReplyId: number;
    originalTrigger: string;
    followups: Array<{ nickname: string; content: string; userId: string; messageId: string }>;
  }): Promise<DistilledFact | null> {
    const { groupId, evasiveBotReplyId, originalTrigger, followups } = params;

    if (followups.length === 0) {
      return null;
    }
    if (!this._allowHarvest(groupId)) {
      this.logger.warn({ groupId }, 'passive-harvest rate-limit hit');
      return null;
    }

    const distilled = await this._distillHarvest(originalTrigger, followups);
    if (!distilled || !distilled.hasAnswer) {
      return null;
    }

    const sourceNicks = followups.map(f => f.nickname).join(',');
    const factId = this.db.learnedFacts.insert({
      groupId,
      topic: distilled.topic ?? null,
      fact: distilled.answer,
      sourceUserId: null,
      sourceUserNickname: sourceNicks,
      sourceMsgId: null,
      botReplyId: evasiveBotReplyId,
    });
    this.logger.info({ groupId, factId, fact: distilled.answer }, 'learned fact (passive)');
    return { factId, fact: distilled.answer };
  }

  /**
   * Format the active learned facts for a group as a markdown block to be
   * appended to the chat module's system prompt. Returns the empty string when
   * the group has no active facts (so callers can append unconditionally).
   */
  formatFactsForPrompt(groupId: string, limit: number): string {
    const facts = this.db.learnedFacts.listActive(groupId, limit);
    if (facts.length === 0) {
      return '';
    }
    const lines = facts.map(f => {
      const src = f.sourceUserNickname ? `（被 ${f.sourceUserNickname} 纠正过）` : '';
      return `- ${f.fact}${src}`;
    });
    return `## 群里学到的事实（群友教过你的，别再错同一件）\n${lines.join('\n')}`;
  }

  /** Test/router hook — exposes the configured Claude model. */
  getModel(): ClaudeModel {
    return this.model;
  }

  // ---- internals ----

  private _allowCorrection(groupId: string): boolean {
    return this._allow(this.correctionStamps, groupId, this.correctionWindowMs, this.correctionMaxPer10Min);
  }

  private _allowHarvest(groupId: string): boolean {
    return this._allow(this.harvestStamps, groupId, this.harvestWindowMs, this.harvestMaxPerMinute);
  }

  private _allow(map: Map<string, number[]>, groupId: string, windowMs: number, max: number): boolean {
    const now = this.now();
    const cutoff = now - windowMs;
    const stamps = (map.get(groupId) ?? []).filter(t => t >= cutoff);
    if (stamps.length >= max) {
      map.set(groupId, stamps);
      return false;
    }
    stamps.push(now);
    map.set(groupId, stamps);
    return true;
  }

  private async _distillCorrection(
    triggerContent: string,
    botReply: string,
    correctionContent: string,
  ): Promise<{ isCorrection: boolean; wrongFact?: string; correctFact: string; topic?: string } | null> {
    const prompt =
      `The bot replied: "${botReply}" to trigger "${triggerContent}". ` +
      `A group member replied: "${correctionContent}". ` +
      `Is this a factual correction? If yes, return JSON: ` +
      `{"isCorrection": true, "wrongFact": "...", "correctFact": "...", "topic": "..."}. ` +
      `If no, return {"isCorrection": false}. Only output JSON.`;

    const raw = await this._safeComplete(prompt);
    if (raw === null) return null;

    const parsed = this._parseJson(raw);
    if (!parsed) {
      this.logger.warn({ raw }, 'distillCorrection: malformed JSON');
      return null;
    }
    if (parsed.isCorrection !== true) {
      return { isCorrection: false, correctFact: '' };
    }
    if (typeof parsed.correctFact !== 'string' || parsed.correctFact.length === 0) {
      this.logger.warn({ parsed }, 'distillCorrection: missing correctFact');
      return null;
    }
    return {
      isCorrection: true,
      wrongFact: typeof parsed.wrongFact === 'string' ? parsed.wrongFact : undefined,
      correctFact: parsed.correctFact,
      topic: typeof parsed.topic === 'string' ? parsed.topic : undefined,
    };
  }

  private async _distillHarvest(
    originalTrigger: string,
    followups: Array<{ nickname: string; content: string }>,
  ): Promise<{ hasAnswer: boolean; answer: string; topic?: string } | null> {
    const followupBlock = followups.map(f => `- ${f.nickname}: ${f.content}`).join('\n');
    const prompt =
      `The bot was asked "${originalTrigger}" and punted ("forgot/dunno"). ` +
      `Group members then said:\n${followupBlock}\n` +
      `Did anyone provide a clear factual answer to the original question? ` +
      `If yes, return JSON: {"hasAnswer": true, "answer": "...", "topic": "..."}. ` +
      `If no, return {"hasAnswer": false}. Only output JSON.`;

    const raw = await this._safeComplete(prompt);
    if (raw === null) return null;

    const parsed = this._parseJson(raw);
    if (!parsed) {
      this.logger.warn({ raw }, 'distillHarvest: malformed JSON');
      return null;
    }
    if (parsed.hasAnswer !== true) {
      return { hasAnswer: false, answer: '' };
    }
    if (typeof parsed.answer !== 'string' || parsed.answer.length === 0) {
      this.logger.warn({ parsed }, 'distillHarvest: missing answer');
      return null;
    }
    return {
      hasAnswer: true,
      answer: parsed.answer,
      topic: typeof parsed.topic === 'string' ? parsed.topic : undefined,
    };
  }

  private async _safeComplete(prompt: string): Promise<string | null> {
    try {
      const res = await this.claude.complete({
        model: this.model,
        maxTokens: 256,
        system: [{ text: 'You are a careful fact extractor. Only output JSON, no prose.', cache: true }],
        messages: [{ role: 'user', content: prompt }],
      });
      return res.text;
    } catch (err) {
      this.logger.warn({ err }, 'self-learning: Claude call failed');
      return null;
    }
  }

  private _parseJson(raw: string): Record<string, unknown> | null {
    const trimmed = raw.trim();
    // Some models wrap JSON in ```json fences — strip a single layer if present.
    const stripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      const obj = JSON.parse(stripped) as unknown;
      if (obj && typeof obj === 'object') {
        return obj as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }
}
