import type { DatabaseSync } from 'node:sqlite';
import type { IClaudeClient, ClaudeModel } from '../ai/claude.js';
import type { IMemeGraphRepo, IPhraseCandidatesRepo, MemeGraphEntry } from '../storage/db.js';
import type { IEmbeddingService } from '../storage/embeddings.js';
import type { Logger } from 'pino';
import { createLogger } from '../utils/logger.js';
import { extractJson } from '../utils/json-extract.js';
import { JARGON_MODEL } from '../config.js';

// ---- Constants ----

/** Max origin-event LLM inferences per cycle per group. */
const MAX_ORIGIN_INFER_PER_CYCLE = 3;
/** Base confidence for newly created meme_graph entries. */
const BASE_CONFIDENCE = 0.3;
/** Confidence increment per variant. */
const CONFIDENCE_PER_VARIANT = 0.05;
/** Max confidence from variant count alone. */
const MAX_AUTO_CONFIDENCE = 0.6;

interface JargonCandidateRow {
  group_id: string;
  content: string;
  count: number;
  contexts: string;
  meaning: string | null;
  is_jargon: number;
  promoted: number;
}

export interface MemeClustererOptions {
  db: DatabaseSync;
  memeGraph: IMemeGraphRepo;
  phraseCandidates: IPhraseCandidatesRepo;
  claude: IClaudeClient;
  /** Embedding service for cosine-similarity clustering (v2 feature, currently unused). */
  embeddingService?: IEmbeddingService | null;
  logger?: Logger;
  now?: () => number;
  /** Cosine threshold for embedding-based clustering (v2, currently unused). */
  clusterThreshold?: number;
  maxOriginInferPerCycle?: number;
}

export class MemeClusterer {
  private readonly db: DatabaseSync;
  private readonly memeGraph: IMemeGraphRepo;
  private readonly phraseCandidates: IPhraseCandidatesRepo;
  private readonly claude: IClaudeClient;
  private readonly embeddingService: IEmbeddingService | null;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly maxOriginInfer: number;

  constructor(opts: MemeClustererOptions) {
    this.db = opts.db;
    this.memeGraph = opts.memeGraph;
    this.phraseCandidates = opts.phraseCandidates;
    this.claude = opts.claude;
    this.embeddingService = opts.embeddingService ?? null;
    this.logger = opts.logger ?? createLogger('meme-clusterer');
    this.now = opts.now ?? (() => Date.now());
    this.maxOriginInfer = opts.maxOriginInferPerCycle ?? MAX_ORIGIN_INFER_PER_CYCLE;
  }

  /**
   * Scan both candidate tables for unpromoted is_jargon=1 rows,
   * cluster into meme_graph, infer origin events.
   */
  async clusterAll(groupId: string): Promise<void> {
    const candidates = this._gatherUnpromoted(groupId);
    if (candidates.length === 0) return;

    // Load existing meme_graph entries for matching
    const existingEntries = this.memeGraph.listActive(groupId, 1000);

    let originInferBudget = this.maxOriginInfer;

    for (const candidate of candidates) {
      try {
        const matched = this._findMatch(candidate.content, existingEntries);

        if (matched) {
          // Add as variant to existing entry
          this._addVariant(matched, candidate);
        } else {
          // Create new meme_graph entry
          const newEntry = await this._createEntry(groupId, candidate);
          existingEntries.push(newEntry);

          // Try to infer origin if budget allows
          if (originInferBudget > 0) {
            try {
              await this._inferOrigin(newEntry.id, candidate);
              originInferBudget--;
            } catch (err) {
              this.logger.warn(
                { err, content: candidate.content },
                'origin inference failed, entry created without origin',
              );
            }
          } else {
            this.logger.debug(
              { content: candidate.content, deferred: candidates.length - candidates.indexOf(candidate) },
              'origin inference budget exhausted, candidates deferred',
            );
          }
        }

        // Mark candidate as promoted
        this._markPromoted(groupId, candidate);
      } catch (err) {
        this.logger.error(
          { err, content: candidate.content },
          'failed to cluster candidate',
        );
      }
    }
  }

  // ---- Private helpers ----

  private _gatherUnpromoted(groupId: string): Array<{
    content: string;
    meaning: string;
    count: number;
    contexts: string[];
    source: 'jargon' | 'phrase';
    gramLen?: number;
  }> {
    const results: Array<{
      content: string; meaning: string; count: number;
      contexts: string[]; source: 'jargon' | 'phrase'; gramLen?: number;
    }> = [];

    // 1. Jargon candidates (is_jargon=1, promoted=0)
    const jargonRows = this.db.prepare(`
      SELECT * FROM jargon_candidates
      WHERE group_id = ? AND is_jargon = 1 AND promoted = 0
      ORDER BY count DESC
    `).all(groupId) as unknown as JargonCandidateRow[];

    for (const row of jargonRows) {
      if (!row.meaning) continue;
      let contexts: string[] = [];
      try { contexts = JSON.parse(row.contexts); } catch { /* empty */ }
      results.push({
        content: row.content,
        meaning: row.meaning,
        count: row.count,
        contexts,
        source: 'jargon',
      });
    }

    // 2. Phrase candidates (is_jargon=1, promoted=0)
    const phraseRows = this.phraseCandidates.listUnpromoted(groupId);
    for (const row of phraseRows) {
      if (!row.meaning) continue;
      results.push({
        content: row.content,
        meaning: row.meaning,
        count: row.count,
        contexts: row.contexts,
        source: 'phrase',
        gramLen: row.gramLen,
      });
    }

    return results;
  }

  /**
   * Find an existing meme_graph entry that matches the candidate via:
   * 1. Exact canonical match
   * 2. Substring match (canonical or variant contains term, or term contains canonical)
   */
  private _findMatch(
    term: string,
    existingEntries: MemeGraphEntry[],
  ): MemeGraphEntry | null {
    // 1. Exact canonical match
    for (const entry of existingEntries) {
      if (entry.canonical === term) return entry;
    }

    // 2. Substring match
    for (const entry of existingEntries) {
      if (entry.canonical.includes(term) || term.includes(entry.canonical)) return entry;
      for (const variant of entry.variants) {
        if (variant.includes(term) || term.includes(variant)) return entry;
      }
    }

    // 3. Embedding cosine similarity deferred to v2

    return null;
  }

  private _addVariant(
    entry: MemeGraphEntry,
    candidate: { content: string; count: number },
  ): void {
    // Don't add if already in variants
    if (entry.variants.includes(candidate.content)) {
      // Still update total_count
      this.memeGraph.update(entry.id, {
        totalCount: entry.totalCount + candidate.count,
      });
      return;
    }

    const newVariants = [...entry.variants, candidate.content];
    const newConfidence = Math.max(
      entry.confidence,
      Math.min(MAX_AUTO_CONFIDENCE, BASE_CONFIDENCE + CONFIDENCE_PER_VARIANT * newVariants.length),
    );

    // manual_edit entries: update() internally skips meaning changes
    this.memeGraph.update(entry.id, {
      variants: newVariants,
      totalCount: entry.totalCount + candidate.count,
      confidence: newConfidence,
    });

    // Update the in-memory entry for subsequent iterations
    entry.variants = newVariants;
    entry.totalCount += candidate.count;
    entry.confidence = newConfidence;

    this.logger.info(
      { canonical: entry.canonical, newVariant: candidate.content, confidence: newConfidence },
      'meme variant added',
    );
  }

  private async _createEntry(
    groupId: string,
    candidate: { content: string; meaning: string; count: number },
  ): Promise<MemeGraphEntry> {
    const nowSec = Math.floor(this.now() / 1000);

    // Compute embedding at insert time if service is ready
    let embeddingVec: number[] | null = null;
    if (this.embeddingService?.isReady) {
      try {
        embeddingVec = await this.embeddingService.embed(
          candidate.content + ' ' + candidate.meaning,
        );
      } catch (err) {
        this.logger.warn(
          { err, content: candidate.content },
          'embedding at insert time failed, will be backfilled later',
        );
      }
    }

    const newEntry: Omit<MemeGraphEntry, 'id'> = {
      groupId,
      canonical: candidate.content,
      variants: [candidate.content],
      meaning: candidate.meaning,
      originEvent: null,
      originMsgId: null,
      originUserId: null,
      originTs: null,
      firstSeenCount: candidate.count,
      totalCount: candidate.count,
      confidence: BASE_CONFIDENCE,
      status: 'active',
      embeddingVec,
      createdAt: nowSec,
      updatedAt: nowSec,
    };

    const id = this.memeGraph.insert(newEntry);
    this.logger.info(
      { groupId, canonical: candidate.content, id, hasEmbedding: embeddingVec !== null },
      'new meme_graph entry created',
    );

    return { id, ...newEntry };
  }

  private async _inferOrigin(
    entryId: number,
    candidate: { content: string; contexts: string[] },
  ): Promise<void> {
    const contextBlock = candidate.contexts.slice(0, 5).map((c, i) => `${i + 1}. ${c}`).join('\n');

    const prompt = `群聊里有个梗/黑话「${candidate.content}」。以下是它被使用的一些上下文：
${contextBlock}

请推测这个梗的起源：它可能来自什么事件或对话？回答JSON:
{"origin_event": "简短描述起源事件", "origin_user": "如果能看出是谁发起的，写昵称，否则null"}`;

    const resp = await this.claude.complete({
      model: JARGON_MODEL as ClaudeModel,
      maxTokens: 256,
      system: [{ text: '你是一个群聊文化分析助手，只输出 JSON。', cache: true }],
      messages: [{ role: 'user', content: prompt }],
    });

    const parsed = extractJson<{ origin_event?: string; origin_user?: string | null }>(resp.text);
    if (parsed?.origin_event) {
      this.memeGraph.update(entryId, {
        originEvent: parsed.origin_event,
      });

      this.logger.info(
        { entryId, originEvent: parsed.origin_event },
        'meme origin inferred',
      );
    }
  }

  private _markPromoted(
    groupId: string,
    candidate: { content: string; source: 'jargon' | 'phrase'; gramLen?: number },
  ): void {
    const nowSec = Math.floor(this.now() / 1000);

    if (candidate.source === 'jargon') {
      this.db.prepare(`
        UPDATE jargon_candidates SET promoted = 1, updated_at = ?
        WHERE group_id = ? AND content = ? AND is_jargon = 1
      `).run(nowSec, groupId, candidate.content);
    } else {
      this.phraseCandidates.markPromoted(groupId, candidate.content, candidate.gramLen ?? 2, nowSec);
    }
  }
}
