/**
 * MemeClusterer — Phase 2+3 of memes-v1 pipeline.
 *
 * Scans jargon_candidates + phrase_candidates for confirmed jargon (is_jargon=1,
 * promoted=0), clusters them into meme_graph entries via embedding cosine
 * similarity + substring matching, and extracts origin events via LLM.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { IClaudeClient, ClaudeModel } from '../ai/claude.js';
import type {
  IMemeGraphRepo,
  IPhraseCandidatesRepo,
  MemeGraphEntry,
} from '../storage/db.js';
import type { IEmbeddingService } from '../storage/embeddings.js';
import { cosineSimilarity } from '../storage/embeddings.js';
import type { Logger } from 'pino';
import { createLogger } from '../utils/logger.js';
import { extractJson } from '../utils/json-extract.js';
import { JARGON_MODEL } from '../config.js';

// ---- Constants ----

/** Cosine similarity threshold for variant merging. */
const DEFAULT_CLUSTER_THRESHOLD = 0.78;
/** Max LLM calls for origin inference per cycle. */
const MAX_ORIGIN_INFER_PER_CYCLE = 3;
/** Default confidence for new graph entries. */
const DEFAULT_NEW_CONFIDENCE = 0.4;
/** Confidence when meanings differ strongly. */
const STRONG_DIFFER_CONFIDENCE = 0.55;
/** Max confidence from variant merging formula. */
const MAX_VARIANT_CONFIDENCE = 0.6;
/** Base confidence for variant formula. */
const VARIANT_CONFIDENCE_BASE = 0.3;
/** Per-variant confidence increment. */
const VARIANT_CONFIDENCE_STEP = 0.05;

export interface MemeClustererOptions {
  db: DatabaseSync;
  memeGraphRepo: IMemeGraphRepo;
  phraseCandidatesRepo: IPhraseCandidatesRepo;
  embeddingService: IEmbeddingService;
  claude: IClaudeClient;
  activeGroups: string[];
  logger?: Logger;
  clusterThreshold?: number;
  /** Injected for testing. */
  now?: () => number;
}

interface JargonCandidateRow {
  group_id: string;
  content: string;
  count: number;
  contexts: string;
  last_inference_count: number;
  meaning: string | null;
  is_jargon: number;
  promoted: number;
  created_at: number;
  updated_at: number;
}

interface UnifiedCandidate {
  groupId: string;
  content: string;
  count: number;
  contexts: string[];
  meaning: string | null;
  source: 'jargon' | 'phrase';
  gramLen?: number;
}

export class MemeClusterer {
  private readonly db: DatabaseSync;
  private readonly memeGraph: IMemeGraphRepo;
  private readonly phraseCandidates: IPhraseCandidatesRepo;
  private readonly embedding: IEmbeddingService;
  private readonly claude: IClaudeClient;
  private readonly activeGroups: string[];
  private readonly logger: Logger;
  private readonly clusterThreshold: number;
  private readonly now: () => number;

  constructor(opts: MemeClustererOptions) {
    this.db = opts.db;
    this.memeGraph = opts.memeGraphRepo;
    this.phraseCandidates = opts.phraseCandidatesRepo;
    this.embedding = opts.embeddingService;
    this.claude = opts.claude;
    this.activeGroups = opts.activeGroups;
    this.logger = opts.logger ?? createLogger('meme-clusterer');
    this.clusterThreshold = opts.clusterThreshold ?? DEFAULT_CLUSTER_THRESHOLD;
    this.now = opts.now ?? (() => Date.now());
  }

  async runAll(): Promise<void> {
    for (const groupId of this.activeGroups) {
      try {
        await this.run(groupId);
      } catch (err) {
        this.logger.error({ err, groupId }, 'meme-clusterer run failed');
      }
    }
  }

  async run(groupId: string): Promise<void> {
    const candidates = this._gatherCandidates(groupId);
    if (candidates.length === 0) return;

    let originInferCount = 0;
    const nowSec = Math.floor(this.now() / 1000);

    for (const candidate of candidates) {
      try {
        const match = await this._findMatch(groupId, candidate);

        if (match && match.status !== 'manual_edit') {
          // Merge as variant
          this._mergeVariant(match, candidate, nowSec);
        } else if (match && match.status === 'manual_edit') {
          // manual_edit: only update total_count and add variant, don't touch meaning
          this._mergeVariantManualEdit(match, candidate, nowSec);
        } else {
          // New entry
          const embVec = await this._computeEmbedding(candidate);
          const confidence = this._computeNewConfidence(candidate);

          const entryId = this.memeGraph.insert({
            groupId,
            canonical: candidate.content,
            variants: [candidate.content],
            meaning: candidate.meaning ?? '',
            originEvent: null,
            originMsgId: null,
            originUserId: null,
            originTs: null,
            firstSeenCount: candidate.count,
            totalCount: candidate.count,
            confidence,
            status: 'active',
            embeddingVec: embVec,
            createdAt: nowSec,
            updatedAt: nowSec,
          });

          // Origin extraction (capped per cycle)
          if (originInferCount < MAX_ORIGIN_INFER_PER_CYCLE) {
            await this._extractOrigin(groupId, entryId, candidate, nowSec);
            originInferCount++;
          }
        }

        // Mark candidate promoted
        this._markPromoted(candidate, nowSec);
      } catch (err) {
        this.logger.warn(
          { err, groupId, content: candidate.content },
          'meme-clusterer candidate processing failed',
        );
      }
    }

    this.logger.info(
      { groupId, processed: candidates.length, originInfers: originInferCount },
      'meme-clusterer cycle complete',
    );
  }

  // ---- Private helpers ----

  /** Gather unpromoted jargon + phrase candidates for a group. */
  _gatherCandidates(groupId: string): UnifiedCandidate[] {
    const result: UnifiedCandidate[] = [];

    // Jargon candidates
    const jargonRows = this.db.prepare(`
      SELECT * FROM jargon_candidates
      WHERE group_id = ? AND is_jargon = 1 AND promoted = 0
      ORDER BY count DESC
    `).all(groupId) as unknown as JargonCandidateRow[];

    for (const row of jargonRows) {
      let contexts: string[] = [];
      try { contexts = JSON.parse(row.contexts); } catch { /* ignore */ }
      result.push({
        groupId: row.group_id,
        content: row.content,
        count: row.count,
        contexts,
        meaning: row.meaning,
        source: 'jargon',
      });
    }

    // Phrase candidates
    const phraseRows = this.phraseCandidates.listUnpromoted(groupId);
    for (const row of phraseRows) {
      result.push({
        groupId: row.groupId,
        content: row.content,
        count: row.count,
        contexts: row.contexts,
        meaning: row.meaning,
        source: 'phrase',
        gramLen: row.gramLen,
      });
    }

    return result;
  }

  /** Find a matching meme_graph entry by substring or embedding similarity. */
  async _findMatch(
    groupId: string,
    candidate: UnifiedCandidate,
  ): Promise<MemeGraphEntry | null> {
    // 1. Substring check: canonical includes candidate or vice versa
    const substringMatches = this.memeGraph.findByVariant(groupId, candidate.content);
    if (substringMatches.length > 0) {
      return substringMatches[0]!;
    }

    // 2. Check if any existing entry's canonical/variant is a substring of the candidate
    const activeEntries = this.memeGraph.listActive(groupId, 500);
    for (const entry of activeEntries) {
      if (candidate.content.includes(entry.canonical)) {
        return entry;
      }
      for (const variant of entry.variants) {
        if (candidate.content.includes(variant) || variant.includes(candidate.content)) {
          return entry;
        }
      }
    }

    // 3. Embedding cosine similarity
    if (!this.embedding.isReady) return null;

    let candidateVec: number[];
    try {
      const embedText = candidate.meaning
        ? `${candidate.content} ${candidate.meaning}`
        : candidate.content;
      candidateVec = await this.embedding.embed(embedText);
    } catch {
      return null;
    }

    const withEmbeddings = this.memeGraph.listActiveWithEmbeddings(groupId);
    let best: { entry: MemeGraphEntry; cosine: number } | null = null;

    for (const entry of withEmbeddings) {
      if (!entry.embeddingVec) continue;
      const sim = cosineSimilarity(candidateVec, entry.embeddingVec);
      if (sim >= this.clusterThreshold && (best === null || sim > best.cosine)) {
        best = { entry, cosine: sim };
      }
    }

    return best?.entry ?? null;
  }

  /** Merge candidate into existing meme_graph entry (non-manual_edit). */
  private _mergeVariant(
    entry: MemeGraphEntry,
    candidate: UnifiedCandidate,
    _nowSec: number,
  ): void {
    const variants = [...entry.variants];
    if (!variants.includes(candidate.content)) {
      variants.push(candidate.content);
    }

    const newTotalCount = entry.totalCount + candidate.count;
    const newConfidence = Math.max(
      entry.confidence,
      Math.min(MAX_VARIANT_CONFIDENCE, VARIANT_CONFIDENCE_BASE + VARIANT_CONFIDENCE_STEP * variants.length),
    );

    this.memeGraph.update(entry.id, {
      variants,
      totalCount: newTotalCount,
      confidence: newConfidence,
    });

    this.logger.info(
      { groupId: entry.groupId, canonical: entry.canonical, newVariant: candidate.content },
      'variant merged into meme_graph',
    );
  }

  /** Merge variant into a manual_edit entry (don't touch meaning). */
  private _mergeVariantManualEdit(
    entry: MemeGraphEntry,
    candidate: UnifiedCandidate,
    _nowSec: number,
  ): void {
    const variants = [...entry.variants];
    if (!variants.includes(candidate.content)) {
      variants.push(candidate.content);
    }

    const newTotalCount = entry.totalCount + candidate.count;

    this.memeGraph.update(entry.id, {
      variants,
      totalCount: newTotalCount,
    });

    this.logger.info(
      { groupId: entry.groupId, canonical: entry.canonical, newVariant: candidate.content },
      'variant merged into manual_edit meme_graph entry (meaning preserved)',
    );
  }

  /** Compute embedding for a candidate. */
  private async _computeEmbedding(candidate: UnifiedCandidate): Promise<number[] | null> {
    if (!this.embedding.isReady) return null;
    try {
      const embedText = candidate.meaning
        ? `${candidate.content} ${candidate.meaning}`
        : candidate.content;
      return await this.embedding.embed(embedText);
    } catch {
      return null;
    }
  }

  /** Compute initial confidence for a new graph entry. */
  _computeNewConfidence(candidate: UnifiedCandidate): number {
    // If meaning is null or empty, use default
    if (!candidate.meaning) return DEFAULT_NEW_CONFIDENCE;
    // Strong differ = higher confidence
    return STRONG_DIFFER_CONFIDENCE;
  }

  /** Extract origin event via LLM and messages table lookup. */
  private async _extractOrigin(
    groupId: string,
    entryId: number,
    candidate: UnifiedCandidate,
    _nowSec: number,
  ): Promise<void> {
    try {
      // Find earliest message containing the canonical term
      const earliestRows = this.db.prepare(`
        SELECT * FROM messages
        WHERE group_id = ? AND deleted = 0 AND content LIKE ?
        ORDER BY timestamp ASC
        LIMIT 5
      `).all(groupId, `%${candidate.content}%`) as unknown as Array<{
        id: number;
        source_message_id: string | null;
        user_id: string;
        nickname: string;
        content: string;
        timestamp: number;
      }>;

      if (earliestRows.length === 0) return;

      const earliest = earliestRows[0]!;
      const originMsgId = earliest.source_message_id ?? String(earliest.id);
      const originUserId = earliest.user_id;
      const originTs = earliest.timestamp;
      const userNickname = earliest.nickname || originUserId;
      const date = new Date(originTs * 1000).toISOString().slice(0, 10);

      const contextsBlock = earliestRows
        .map((r, i) => `${i + 1}. [${r.nickname}] ${r.content.length > 120 ? r.content.slice(0, 120) + '...' : r.content}`)
        .join('\n');

      const prompt = `这个群里"${candidate.content}"最早是 ${userNickname} 在 ${date} 说的。最早 5 次使用的上下文：
${contextsBlock}
用一句话描述这个梗的来源事件。只回 JSON {"origin_event":"..."}. 看不出明显来源返回 {"origin_event":null}。`;

      const resp = await this.claude.complete({
        model: JARGON_MODEL as ClaudeModel,
        maxTokens: 256,
        system: [{ text: '你是群聊梗来源分析助手，只输出 JSON。', cache: true }],
        messages: [{ role: 'user', content: prompt }],
      });

      const parsed = extractJson<{ origin_event: string | null }>(resp.text);
      const originEvent = parsed?.origin_event ?? null;

      this.memeGraph.update(entryId, {
        originEvent,
        originMsgId,
        originUserId,
        originTs,
      });

      this.logger.info(
        { groupId, canonical: candidate.content, originEvent, originUserId },
        'origin event extracted',
      );
    } catch (err) {
      this.logger.warn(
        { err, groupId, content: candidate.content },
        'origin extraction failed',
      );
      // Non-fatal: graph entry already inserted, just missing origin
    }
  }

  /** Mark a candidate as promoted in its source table. */
  private _markPromoted(candidate: UnifiedCandidate, nowSec: number): void {
    if (candidate.source === 'jargon') {
      this.db.prepare(`
        UPDATE jargon_candidates
        SET promoted = 1, updated_at = ?
        WHERE group_id = ? AND content = ?
      `).run(nowSec, candidate.groupId, candidate.content);
    } else {
      this.phraseCandidates.markPromoted(
        candidate.groupId,
        candidate.content,
        candidate.gramLen ?? 2,
        nowSec,
      );
    }
  }
}
