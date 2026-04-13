import type { IEmbeddingService } from '../storage/embeddings.js';
import type { IRuleRepository, IModerationRepository, Rule } from '../storage/db.js';
import { BotErrorCode } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { cosineSimilarity } from '../storage/embeddings.js';

const MAX_RULE_LENGTH = 500;

export type AddRuleResult =
  | { ok: true; ruleId: number }
  | { ok: false; errorCode: BotErrorCode };

export type FalsePositiveResult =
  | { ok: true }
  | { ok: false; errorCode: BotErrorCode };

export interface ILearnerModule {
  addRule(groupId: string, text: string, type: 'positive' | 'negative'): Promise<AddRuleResult>;
  markFalsePositive(msgId: string): Promise<FalsePositiveResult>;
  retrieveExamples(groupId: string, currentMessage: string, topK?: number): Promise<Rule[]>;
}

export class LearnerModule implements ILearnerModule {
  private readonly logger = createLogger('learner');

  constructor(
    private readonly embedder: IEmbeddingService,
    private readonly rules: IRuleRepository,
    private readonly moderation: IModerationRepository,
  ) {}

  async addRule(groupId: string, text: string, type: 'positive' | 'negative'): Promise<AddRuleResult> {
    if (text.length > MAX_RULE_LENGTH) {
      return { ok: false, errorCode: BotErrorCode.RULE_TOO_LONG };
    }

    // Idempotent: check for duplicate in same group
    const existing = this.rules.getAll(groupId).find(r => r.content === text);
    if (existing) {
      this.logger.debug({ groupId, ruleId: existing.id }, 'duplicate rule — returning existing');
      return { ok: true, ruleId: existing.id };
    }

    // Embed — fail-safe: if embedder disabled, store with null embedding
    let embedding: Float32Array | null = null;
    try {
      const vec = await this.embedder.embed(text);
      embedding = new Float32Array(vec);
    } catch {
      this.logger.warn({ groupId }, 'embedder unavailable — storing rule without embedding');
    }

    const rule = this.rules.insert({ groupId, content: text, type, embedding });
    this.logger.info({ groupId, ruleId: rule.id, type }, 'rule added');
    return { ok: true, ruleId: rule.id };
  }

  async markFalsePositive(msgId: string): Promise<FalsePositiveResult> {
    const record = this.moderation.findByMsgId(msgId);
    if (!record) {
      return { ok: false, errorCode: BotErrorCode.NO_PUNISHMENT_RECORD };
    }

    const text = `[误判示例] 原因: ${record.reason}`;
    await this.addRule(record.groupId, text, 'negative');
    this.logger.info({ msgId, groupId: record.groupId }, 'false positive added as negative rule');
    return { ok: true };
  }

  async retrieveExamples(groupId: string, currentMessage: string, topK = 5): Promise<Rule[]> {
    const allRules = this.rules.getAll(groupId);
    const withEmbeddings = allRules.filter(r => r.embedding !== null);

    if (withEmbeddings.length === 0) {
      return [];
    }

    // Get query embedding — fail-safe: return [] if embedder disabled
    let queryVec: number[];
    try {
      queryVec = await this.embedder.embed(currentMessage);
    } catch {
      this.logger.warn({ groupId }, 'embedder unavailable — returning no RAG examples');
      return [];
    }

    // Score each rule
    const scored = withEmbeddings.map((rule, originalIndex) => ({
      rule,
      score: cosineSimilarity(queryVec, Array.from(rule.embedding!)),
      originalIndex,
    }));

    // Stable sort: primary by score desc, secondary by original index asc (preserves insertion order on ties)
    scored.sort((a, b) => {
      const diff = b.score - a.score;
      return diff !== 0 ? diff : a.originalIndex - b.originalIndex;
    });

    return scored.slice(0, topK).map(s => s.rule);
  }
}
