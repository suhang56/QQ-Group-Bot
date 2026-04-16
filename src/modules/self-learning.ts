import type { Logger } from 'pino';
import type { IClaudeClient, ClaudeModel } from '../ai/claude.js';
import type { Database, LearnedFact } from '../storage/db.js';
import type { IEmbeddingService } from '../storage/embeddings.js';
import { cosineSimilarity } from '../storage/embeddings.js';
import { createLogger } from '../utils/logger.js';
import { extractJson } from '../utils/json-extract.js';
import { LEARN_MODEL, RESEARCH_MODEL, FACTS_RAG_DISABLED } from '../config.js';

/** Cosine similarity floor — facts below this are dropped unless pinned.
 * MiniLM-L6-v2 is noisier on Chinese text so we set a slightly higher
 * threshold than English RAG defaults. Tune here without touching logic. */
export const FACT_SIMILARITY_FLOOR = 0.30;

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
  /** Model used for distillation paths (corrections + passive harvest). Default `LEARN_MODEL`. */
  model?: string;
  /** Override clock for tests. */
  now?: () => number;
  /** Max online research calls per group inside a 10-minute window. Default 3. */
  researchMaxPer10MinPerGroup?: number;
  /** Max online research calls globally per 24-hour rolling window. Default 30. */
  researchMaxPerDayGlobal?: number;
  /** Kill-switch for {@link SelfLearningModule.researchOnline}. Default true. */
  researchEnabled?: boolean;
  /** Optional embedding service used for semantic fact retrieval. */
  embeddingService?: IEmbeddingService | null;
}

/**
 * Patterns that identify personal-info probes — questions about real-world
 * identity, location, contact details. These must never be sent to web search.
 */
const PERSONAL_INFO_PATTERNS: ReadonlyArray<RegExp> = [
  /你是谁/,
  /你叫(什么|啥)/,
  /你多大/,
  /你几岁/,
  /你在哪/,
  /你住(在)?哪/,
  /你家(在|住)?哪/,
  /你电话/,
  /你手机/,
  /你微信/,
  /你qq/i,
  /你的qq/i,
  /你的(电话|手机|微信|地址|住址|邮箱)/,
  /\b1[3-9]\d{9}\b/, // CN mobile number
  /[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}/, // email
];

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
 * Result of formatting learned facts for the system prompt. `factIds` lists
 * the rows actually injected so the caller can remember them against the
 * resulting bot reply (Feature C — top-level correction path).
 */
export interface FormattedFacts {
  text: string;
  factIds: number[];
}

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
  private static readonly MIN_INJECT_CONFIDENCE = 0.8;
  private static readonly HEDGE_MARKERS: ReadonlyArray<string> = [
    '可能是','可能与','可能代表','可能是某','似乎是','似乎与',
    '具体信息不明确','具体含义不明','具体含义需','不太清楚',
    '不确定','暗示','疑似','大概是','或许是','不明',
  ];
  private static readonly NEG_PATTERN = /(不是|不对|错了|搞错|没说对|胡说|瞎说|说啥呢)/;
  /** Common 2-3 char Chinese words that should not trigger referent matching. */
  private static readonly STOPWORDS = new Set([
    '是的', '不是', '可以', '什么', '一个', '这个', '那个', '没有',
    '知道', '已经', '因为', '所以', '但是', '还是', '如果', '就是',
    '可能', '应该', '需要', '怎么', '不会', '不了', '是不', '有没',
    '为什么', '这样', '那样', '这里', '那里', '大家', '自己',
    '很多', '一些', '一下', '一起', '我们', '你们', '他们', '她们',
    '真的', '其实', '当然', '虽然', '而且', '或者', '然后', '之后',
    '现在', '以前', '以后', '觉得', '好的', '对的', '没事', '没问题',
  ]);
  /** Top K newest facts that are pinned regardless of similarity score. */
  private static readonly PINNED_NEWEST_K = 5;

  private static isHedged(fact: string): boolean {
    return SelfLearningModule.HEDGE_MARKERS.some(m => fact.includes(m));
  }

  private readonly db: Database;
  private readonly claude: IClaudeClient;
  private readonly logger: Logger;
  private readonly botUserId: string | undefined;
  private readonly correctionMaxPer10Min: number;
  private readonly correctionWindowMs: number;
  private readonly harvestMaxPerMinute: number;
  private readonly harvestWindowMs: number;
  private readonly model: string;
  private readonly now: () => number;
  private readonly researchMaxPer10MinPerGroup: number;
  private readonly researchMaxPerDayGlobal: number;
  private readonly researchEnabled: boolean;
  private readonly _embeddingService: IEmbeddingService | null;

  private readonly correctionStamps: Map<string, number[]> = new Map();
  private readonly harvestStamps: Map<string, number[]> = new Map();
  private readonly researchStamps: Map<string, number[]> = new Map();
  private researchGlobalStamps: number[] = [];

  // Feature C: most recent bot reply per group paired with the fact ids that
  // were injected into its prompt. Bounded LRU (insertion-order Map).
  private readonly injectionMemory = new Map<string, { botReplyId: number; factIds: number[] }>();

  constructor(opts: SelfLearningOptions) {
    this.db = opts.db;
    this.claude = opts.claude;
    this.logger = opts.logger ?? createLogger('self-learning');
    this.botUserId = opts.botUserId;
    this.correctionMaxPer10Min = opts.correctionMaxPer10Min ?? 5;
    this.correctionWindowMs = opts.correctionWindowMs ?? 600_000;
    this.harvestMaxPerMinute = opts.harvestMaxPerMinute ?? 2;
    this.harvestWindowMs = opts.harvestWindowMs ?? 60_000;
    this.model = opts.model ?? LEARN_MODEL;
    this.now = opts.now ?? (() => Date.now());
    this.researchMaxPer10MinPerGroup = opts.researchMaxPer10MinPerGroup ?? 3;
    this.researchMaxPerDayGlobal = opts.researchMaxPerDayGlobal ?? 30;
    this.researchEnabled = opts.researchEnabled ?? true;
    this._embeddingService = opts.embeddingService ?? null;
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
   *
   * `triggerText` is the user message that prompted this chat call. When an
   * embedding service is available, facts are ranked by cosine similarity to
   * the trigger and the top-K most relevant are injected (with the newest K
   * pinned regardless of score). Falls back to recency when the embedding
   * service is unavailable, the kill switch is set, or fewer facts have
   * embeddings than the requested limit.
   */
  async formatFactsForPrompt(
    groupId: string,
    limit: number,
    triggerText: string = '',
  ): Promise<FormattedFacts> {
    const svc = this._embeddingService;
    const semanticEnabled = !FACTS_RAG_DISABLED() && svc !== null && svc.isReady && triggerText.length > 0;

    if (!semanticEnabled) {
      const reason = FACTS_RAG_DISABLED() ? 'killSwitch' : (svc === null || !svc.isReady ? 'noService' : 'noTrigger');
      return this._formatFactsRecency(groupId, limit, reason);
    }

    // Order: listActiveWithEmbeddings → Feature B (hedge+confidence) →
    // score → 0.30 cutoff → sort desc → take top (limit-pinned) → union with
    // pinned-newest → dedupe → format. Filter BEFORE scoring (cheaper +
    // semantically correct: junk facts cannot leak in regardless of similarity).
    const embedded = this.db.learnedFacts.listActiveWithEmbeddings(groupId);
    const filteredEmbedded = this._applyHedgeAndConfidenceFilter(embedded);

    let triggerEmbedding: number[];
    try {
      triggerEmbedding = await svc!.embed(triggerText);
    } catch (err) {
      this.logger.warn({ err, groupId }, 'formatFactsForPrompt: trigger embed failed — recency fallback');
      return this._formatFactsRecency(groupId, limit, 'embedError');
    }

    // listActiveWithEmbeddings returns created_at DESC, so filteredEmbedded
    // is already newest-first. Take the first K as the pinned set.
    const pinnedFacts = filteredEmbedded.slice(0, SelfLearningModule.PINNED_NEWEST_K);
    const pinnedIds = new Set(pinnedFacts.map(f => f.id));

    const scored: Array<{ fact: LearnedFact; sim: number }> = filteredEmbedded.map(f => ({
      fact: f,
      sim: f.embedding ? cosineSimilarity(triggerEmbedding, f.embedding) : 0,
    }));
    scored.sort((a, b) => b.sim - a.sim);

    // Drop below-floor facts (unless pinned). No padding from recency —
    // padding reintroduces the dilution bug we are trying to fix.
    let droppedLowSim = 0;
    const survivors = scored.filter(s => {
      if (pinnedIds.has(s.fact.id)) return true;
      if (s.sim < FACT_SIMILARITY_FLOOR) {
        droppedLowSim++;
        return false;
      }
      return true;
    });

    // Build final list: pinned first, then top-by-similarity to fill `limit`.
    const finalFacts: LearnedFact[] = [];
    const seen = new Set<number>();
    for (const f of pinnedFacts) {
      if (finalFacts.length >= limit) break;
      if (seen.has(f.id)) continue;
      finalFacts.push(f);
      seen.add(f.id);
    }
    for (const s of survivors) {
      if (finalFacts.length >= limit) break;
      if (seen.has(s.fact.id)) continue;
      finalFacts.push(s.fact);
      seen.add(s.fact.id);
    }

    const topSimilarity = scored[0]?.sim ?? 0;
    this.logger.debug(
      {
        groupId,
        embeddedTotal: embedded.length,
        kept: finalFacts.length,
        droppedLowSim,
        topSimilarity,
        pinnedCount: pinnedFacts.length,
      },
      'facts filtered for prompt (semantic)',
    );

    if (finalFacts.length === 0) return { text: '', factIds: [] };
    return this._renderFacts(finalFacts);
  }

  private _formatFactsRecency(groupId: string, limit: number, reason: string): FormattedFacts {
    const overFetch = Math.min(limit * 3, 150);
    const raw = this.db.learnedFacts.listActive(groupId, overFetch);
    let droppedLowConf = 0;
    let droppedHedge = 0;
    const kept = raw.filter(f => {
      if (f.confidence < SelfLearningModule.MIN_INJECT_CONFIDENCE) { droppedLowConf++; return false; }
      if (SelfLearningModule.isHedged(f.fact)) { droppedHedge++; return false; }
      return true;
    }).slice(0, limit);
    this.logger.debug(
      { groupId, total: raw.length, kept: kept.length, droppedLowConf, droppedHedge, reason },
      'facts filtered for prompt (recency)',
    );
    if (kept.length === 0) return { text: '', factIds: [] };
    return this._renderFacts(kept);
  }

  private _applyHedgeAndConfidenceFilter(facts: LearnedFact[]): LearnedFact[] {
    return facts.filter(f => {
      if (f.confidence < SelfLearningModule.MIN_INJECT_CONFIDENCE) return false;
      if (SelfLearningModule.isHedged(f.fact)) return false;
      return true;
    });
  }

  private _renderFacts(facts: LearnedFact[]): FormattedFacts {
    const lines = facts.map(f => {
      const src = f.sourceUserNickname ? `（被 ${f.sourceUserNickname} 纠正过）` : '';
      return `- ${f.fact}${src}`;
    });
    return {
      text: `## 群里学到的事实 — 遇到下面提到的名字/梗，直接给出事实里的答案，不要装傻反问
${lines.join('\n')}`,
      factIds: facts.map(f => f.id),
    };
  }

  /**
   * Record the fact ids injected into the system prompt for the bot reply
   * identified by `botReplyId`. Consumed by {@link handleTopLevelCorrection}
   * when a group member pushes back on that reply without reply-quoting it.
   */
  rememberInjection(groupId: string, botReplyId: number, factIds: number[]): void {
    // Refresh insertion order so recently-touched entries survive eviction.
    this.injectionMemory.delete(groupId);
    this.injectionMemory.set(groupId, { botReplyId, factIds });
    if (this.injectionMemory.size > 200) {
      const firstKey = this.injectionMemory.keys().next().value;
      if (firstKey !== undefined) this.injectionMemory.delete(firstKey);
    }
  }

  /**
   * Handle a plain (non-reply-quote) negation that arrives right after a bot
   * reply. If the negation has a token overlap with the prior bot reply we
   * treat it as a correction: reject any facts we injected into that reply's
   * prompt and fire an online research call to find the right answer.
   *
   * Silently no-ops on missing prior reply, missing negation marker, or
   * missing referent. Errors from {@link researchOnline} are swallowed by
   * that method — callers should still use `void`.
   */
  handleTopLevelCorrection(params: {
    groupId: string;
    content: string;
    priorBotReply: { id: number; content: string; trigger: string } | null;
  }): void {
    const { groupId, content, priorBotReply } = params;
    if (!priorBotReply) return;
    if (!SelfLearningModule.NEG_PATTERN.test(content)) return;
    const tokens = priorBotReply.content.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,}/g) ?? [];
    // Filter out stopwords, then require at least one substantive token (>= 4 chars)
    const substantiveTokens = tokens.filter(
      t => t.length >= 4 || (t.length >= 2 && !SelfLearningModule.STOPWORDS.has(t))
    );
    const hasReferent = substantiveTokens.some(t => t.length >= 4 && content.includes(t));
    if (!hasReferent) return;

    const injected = this.injectionMemory.get(groupId);
    if (injected && injected.botReplyId === priorBotReply.id) {
      for (const factId of injected.factIds) {
        this.db.learnedFacts.markStatus(factId, 'rejected');
      }
      this.logger.info(
        { groupId, botReplyId: priorBotReply.id, rejected: injected.factIds.length },
        'top-level correction: facts rejected',
      );
      this.injectionMemory.delete(groupId);
    }

    void this.researchOnline({
      groupId,
      evasiveBotReplyId: priorBotReply.id,
      originalTrigger: priorBotReply.trigger,
    });
  }

  /**
   * Run a Claude+WebSearch lookup for a question the bot punted on, racing
   * with the {@link harvestPassiveKnowledge} group-member path. Designed to be
   * called fire-and-forget by the router after an evasive reply.
   *
   * Hard guards (in order): kill-switch, length bounds, personal-info filter,
   * per-group rate limit, global daily rate limit. All errors are swallowed —
   * this method never throws and returns null on any failure.
   *
   * @returns the inserted {@link DistilledFact} or null when no fact was
   *   stored (filter, rate limit, low confidence, model error, etc.).
   */
  async researchOnline(params: {
    groupId: string;
    evasiveBotReplyId: number;
    originalTrigger: string;
    topic?: string;
  }): Promise<DistilledFact | null> {
    const { groupId, evasiveBotReplyId, originalTrigger, topic } = params;

    if (!this.researchEnabled) {
      this.logger.debug({ groupId }, 'researchOnline: disabled by config');
      return null;
    }

    const trigger = originalTrigger.trim();
    if (trigger.length < 3 || trigger.length > 200) {
      this.logger.debug({ groupId, len: trigger.length }, 'researchOnline: trigger length out of range');
      return null;
    }
    if (PERSONAL_INFO_PATTERNS.some(re => re.test(trigger))) {
      this.logger.info({ groupId }, 'researchOnline: personal-info probe filtered');
      return null;
    }
    if (!this._allowResearchPerGroup(groupId)) {
      this.logger.info({ groupId }, 'researchOnline: per-group rate limit hit');
      return null;
    }
    if (!this._allowResearchGlobal()) {
      this.logger.info({ groupId }, 'researchOnline: global daily rate limit hit');
      return null;
    }

    let response: { found: boolean; fact?: string; source?: string; confidence?: number } | null;
    try {
      response = await this._distillResearch(trigger);
    } catch (err) {
      this.logger.warn({ err, groupId }, 'researchOnline: unexpected error');
      return null;
    }

    if (!response || !response.found) {
      return null;
    }
    const confidence = typeof response.confidence === 'number' ? response.confidence : 0;
    if (confidence < 0.6) {
      this.logger.info({ groupId, confidence }, 'researchOnline: confidence below threshold');
      return null;
    }
    if (typeof response.fact !== 'string' || response.fact.length === 0) {
      return null;
    }

    const sourceTag = `[online:${response.source ?? 'unknown'}]`;
    const factId = this.db.learnedFacts.insert({
      groupId,
      topic: topic ?? trigger.slice(0, 10),
      fact: response.fact,
      sourceUserId: null,
      sourceUserNickname: sourceTag,
      sourceMsgId: null,
      botReplyId: evasiveBotReplyId,
      confidence,
    });
    this.logger.info({ groupId, factId, fact: response.fact, source: response.source }, 'learned fact (online)');
    return { factId, fact: response.fact };
  }

  /** Test/router hook — exposes the configured distillation model. */
  getModel(): string {
    return this.model;
  }

  // ---- internals ----

  private _allowCorrection(groupId: string): boolean {
    return this._allow(this.correctionStamps, groupId, this.correctionWindowMs, this.correctionMaxPer10Min);
  }

  private _allowHarvest(groupId: string): boolean {
    return this._allow(this.harvestStamps, groupId, this.harvestWindowMs, this.harvestMaxPerMinute);
  }

  private _allowResearchPerGroup(groupId: string): boolean {
    return this._allow(this.researchStamps, groupId, 600_000, this.researchMaxPer10MinPerGroup);
  }

  private _allowResearchGlobal(): boolean {
    const now = this.now();
    const cutoff = now - 86_400_000;
    this.researchGlobalStamps = this.researchGlobalStamps.filter(t => t >= cutoff);
    if (this.researchGlobalStamps.length >= this.researchMaxPerDayGlobal) {
      return false;
    }
    this.researchGlobalStamps.push(now);
    return true;
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

  private async _distillResearch(
    originalTrigger: string,
  ): Promise<{ found: boolean; fact?: string; source?: string; confidence?: number } | null> {
    const prompt =
      `You are helping a bot build its knowledge base. The bot failed to answer ` +
      `this question in a Chinese group chat: "${originalTrigger}"\n\n` +
      `Context: the group is 北美炸梦同好会, a fan community for BanG Dream! / ` +
      `idol/anime. Questions are usually about fandom trivia (bands, songs, ` +
      `character voice actors, anime plots, concerts), occasionally about ` +
      `tech/memes/group-specific references.\n\n` +
      `Use web_search to find a definitive answer. Prefer authoritative sources ` +
      `(official wiki, artist/label pages, MyAnimeList, VNDB, Wikipedia).\n\n` +
      `Return JSON only:\n` +
      `{\n  "found": true | false,\n  "fact": "<concise Chinese sentence, ≤50 chars, stating the fact>",\n  "source": "<domain name of primary source>",\n  "confidence": 0.0-1.0\n}\n\n` +
      `If uncertain or sources conflict, return found: false. ` +
      `If the question is about a specific person's private info, return found: false.`;

    let res;
    try {
      res = await this.claude.complete({
        model: RESEARCH_MODEL as ClaudeModel,
        maxTokens: 1024,
        system: [{ text: 'You are a careful fact extractor with web search. Only output JSON, no prose.', cache: true }],
        messages: [{ role: 'user', content: prompt }],
        allowedTools: ['WebSearch'],
      });
    } catch (err) {
      this.logger.warn({ err }, 'researchOnline: Claude call failed');
      return null;
    }

    const parsed = this._parseJson(res.text);
    if (!parsed) {
      this.logger.warn({ raw: res.text }, 'researchOnline: malformed JSON');
      return null;
    }
    if (parsed.found !== true) {
      return { found: false };
    }
    return {
      found: true,
      fact: typeof parsed.fact === 'string' ? parsed.fact : undefined,
      source: typeof parsed.source === 'string' ? parsed.source : undefined,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : undefined,
    };
  }

  private async _safeComplete(prompt: string): Promise<string | null> {
    try {
      const res = await this.claude.complete({
        model: this.model as ClaudeModel,
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
    const val = extractJson<Record<string, unknown>>(raw);
    if (val && typeof val === 'object' && !Array.isArray(val)) return val;
    return null;
  }
}
