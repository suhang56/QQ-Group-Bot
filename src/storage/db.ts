import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ClaudeModel } from '../ai/claude.js';
import type { IEmbeddingService } from './embeddings.js';
import { cosineSimilarity } from './embeddings.js';
import { MemeGraphRepository, PhraseCandidatesRepository } from './meme-repos.js';
import { sanitizeFtsQuery } from '../utils/text-tokenize.js';
import { createLogger } from '../utils/logger.js';

const bm25Logger = createLogger('learned-facts-bm25');

// ---- Domain types ----

export interface Message {
  id: number;
  groupId: string;
  userId: string;
  nickname: string;
  content: string;
  rawContent: string;
  timestamp: number;
  deleted: boolean;
}

export interface User {
  userId: string;
  groupId: string;
  nickname: string;
  styleSummary: string | null;
  lastSeen: number;
  role: 'owner' | 'admin' | 'member';
}

export interface ModerationRecord {
  id: number;
  msgId: string;
  groupId: string;
  userId: string;
  violation: boolean;
  severity: number | null;
  action: 'warn' | 'delete' | 'ban' | 'kick' | 'none';
  reason: string;
  appealed: 0 | 1 | 2;
  reversed: boolean;
  timestamp: number;
  /** Original message content captured at assessment time. Null for legacy records. */
  originalContent: string | null;
  // --- review fields (§13) ---
  reviewed: 0 | 1 | 2;    // 0=unreviewed, 1=approved, 2=rejected
  reviewedBy: string | null;
  reviewedAt: number | null;
}

export interface ModerationReviewFilters {
  groupId?: string;
  reviewed?: 0 | 1 | 2;
  severityMin?: number;
  severityMax?: number;
  /** 'punished' = exclude action=none (default), 'all' = include everything, 'none' = only action=none */
  actionFilter?: 'punished' | 'all' | 'none';
}

export interface ModerationStats {
  total: number;
  unreviewed: number;
  approved: number;
  rejected: number;
  byGroup: Record<string, {
    total: number;
    unreviewed: number;
    approved: number;
    rejected: number;
  }>;
}

export interface GroupConfig {
  groupId: string;
  enabledModules: string[];
  autoMod: boolean;
  dailyPunishmentLimit: number;
  punishmentsToday: number;
  punishmentsResetDate: string;
  mimicActiveUserId: string | null;
  mimicStartedBy: string | null;
  chatTriggerKeywords: string[];
  chatTriggerAtOnly: boolean;
  chatDebounceMs: number;
  modConfidenceThreshold: number;
  modWhitelist: string[];
  appealWindowHours: number;
  kickConfirmModel: ClaudeModel;
  chatLoreEnabled: boolean;
  nameImagesEnabled: boolean;
  nameImagesCollectionTimeoutMs: number;
  nameImagesCollectionMax: number;
  nameImagesCooldownMs: number;
  nameImagesMaxPerName: number;
  chatAtMentionQueueMax: number;
  chatAtMentionBurstWindowMs: number;
  chatAtMentionBurstThreshold: number;
  repeaterEnabled: boolean;
  repeaterMinCount: number;
  repeaterCooldownMs: number;
  repeaterMinContentLength: number;
  repeaterMaxContentLength: number;
  nameImagesBlocklist: string[];
  loreUpdateEnabled: boolean;
  loreUpdateThreshold: number;
  loreUpdateCooldownMs: number;
  liveStickerCaptureEnabled: boolean;
  stickerLegendRefreshEveryMsgs: number;
  chatPersonaText: string | null;
  activeCharacterId: string | null;
  charStartedBy: string | null;
  welcomeEnabled: boolean;
  idGuardEnabled: boolean;
  stickerFirstEnabled: boolean;
  stickerFirstThreshold: number;
  /**
   * Interest categories that gate proactive chat engagement. Non-direct
   * messages must hit at least `chatInterestMinHits` of these patterns (by
   * regex match) before engagement scoring considers them worth replying to.
   */
  chatInterestCategories: ReadonlyArray<{
    readonly name: string;
    readonly pattern: string;
    readonly weight: number;
  }>;
  /** Minimum number of interest-category matches required (default 1). */
  chatInterestMinHits: number;
  /** M7.4: enable air-reading (awkward-moment veto) in the pre-chat judge. */
  airReadingEnabled: boolean;
  /** M7.3: enable speaker/addressee graph (addressee-is-other skip) in judge. */
  addresseeGraphEnabled: boolean;
  /** M9.3: enable cross-group user recognition. Bilateral opt-in — both the
   * requester's group AND each source group must have this flag true before
   * a user's affinity from that source group counts in the aggregate. */
  linkAcrossGroups: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NameImage {
  id: number;
  groupId: string;
  name: string;
  filePath: string;
  sourceFile: string | null;
  addedBy: string;
  addedAt: number;
}

export interface Rule {
  id: number;
  groupId: string;
  content: string;
  type: 'positive' | 'negative';
  source: 'manual' | 'announcement';
  embedding: Float32Array | null;
}

export interface GroupAnnouncement {
  id: number;
  groupId: string;
  noticeId: string;
  content: string;
  contentHash: string;
  fetchedAt: number;
  parsedRules: string[];
}

// ---- Repository interfaces ----

export interface TopUser {
  userId: string;
  nickname: string;
  count: number;
}

export interface IMessageRepository {
  insert(msg: Omit<Message, 'id'>, sourceMessageId?: string): Message;
  getRecent(groupId: string, limit: number): Message[];
  getByUser(groupId: string, userId: string, limit: number): Message[];
  sampleRandomHistorical(groupId: string, excludeNewestN: number, sampleSize: number): Message[];
  searchByKeywords(groupId: string, keywords: string[], limit: number): Message[];
  getTopUsers(groupId: string, limit: number): TopUser[];
  softDelete(msgId: string): void;
  findBySourceId(sourceMessageId: string): Message | null;
  /** Find a message near a timestamp from a specific user (±windowSec). For mod-review lookups. */
  findNearTimestamp(groupId: string, userId: string, timestamp: number, windowSec: number): Message | null;
  /** Get messages around a timestamp in a group (±windowSec, up to limit). For mod-review context. */
  getAroundTimestamp(groupId: string, timestamp: number, windowSec: number, limit: number): Message[];
  /** Messages inside [startSec, endSec] (both inclusive). Used by diary-distiller for per-day windows. */
  getByTimeRange(groupId: string, startSec: number, endSec: number): Message[];
  /** Distinct group_ids with any non-deleted message since sinceSec. Used by DiaryDistiller.runForAllGroups. */
  listActiveGroupIds(sinceSec: number): string[];
  /**
   * BM25 MATCH search over messages_fts for a group, newest-first.
   * Raw query must be pre-sanitized via sanitizeFtsQuery before calling.
   * Returns [] on FTS syntax error or missing table.
   */
  searchFts(groupId: string, ftsQuery: string, limit: number): Pick<Message, 'content' | 'timestamp'>[];
  /** Returns distinct non-empty nicknames seen in a group. Used by HonestGapsTracker nickname filter. */
  listDistinctNicknames(groupId: string, limit?: number): string[];
}

// ---- Diary types (W-B) ----

export type DiaryKind = 'daily' | 'weekly' | 'monthly';

export interface DiaryTopSpeaker {
  userId: string;
  nickname: string;
  count: number;
}

export interface DiaryEntry {
  id: number;
  groupId: string;
  periodStart: number;
  periodEnd: number;
  kind: DiaryKind;
  summary: string;
  /** JSON-encoded array of topic strings, as stored. */
  topTopics: string;
  /** JSON-encoded array of DiaryTopSpeaker entries, as stored. */
  topSpeakers: string;
  mood: string | null;
  createdAt: number;
}

export interface IGroupDiaryRepository {
  /** Returns newly-inserted row id, or 0 if the UNIQUE constraint swallowed the insert. */
  insert(entry: Omit<DiaryEntry, 'id'>): number;
  findLatestByKind(groupId: string, kind: DiaryKind): DiaryEntry | null;
  findByPeriod(groupId: string, kind: DiaryKind, periodStart: number, periodEnd: number): DiaryEntry[];
  findByGroupSince(groupId: string, sinceSec: number, limit: number): DiaryEntry[];
  deleteByIds(ids: number[]): void;
}

export interface IUserRepository {
  upsert(user: User): void;
  findById(userId: string, groupId: string): User | null;
  getAdminsByGroup(groupId: string, limit: number): User[];
}

export interface IModerationRepository {
  insert(record: Omit<ModerationRecord, 'id' | 'reviewed' | 'reviewedBy' | 'reviewedAt'>): ModerationRecord;
  findById(id: number): ModerationRecord | null;
  findByMsgId(msgId: string): ModerationRecord | null;
  findRecentByUser(userId: string, groupId: string, windowMs: number): ModerationRecord[];
  findRecentByGroup(groupId: string, windowMs: number): ModerationRecord[];
  findPendingAppeal(userId: string, groupId: string): ModerationRecord | null;
  update(id: number, patch: Partial<Pick<ModerationRecord, 'appealed' | 'reversed'>>): void;
  countWarnsByUser(userId: string, groupId: string, withinMs: number): number;

  // --- new: review panel methods (§13) ---
  getForReview(
    filters: ModerationReviewFilters,
    page: number,   // 1-based
    limit: number   // 1..100
  ): { records: ModerationRecord[]; total: number };

  markReviewed(
    id: number,
    verdict: 1 | 2,      // 1=approved, 2=rejected
    reviewedBy: string,
    reviewedAt: number   // unix seconds
  ): void;

  getStats(): ModerationStats;

  /** Update the action field of a moderation_log record identified by msgId, only if action='none'. Returns true if a row was updated. */
  updateAction(msgId: string, newAction: string): boolean;
}

export interface IGroupConfigRepository {
  get(groupId: string): GroupConfig | null;
  upsert(config: GroupConfig): void;
  incrementPunishments(groupId: string): void;
  resetDailyPunishments(groupId: string): void;
}

export interface IRuleRepository {
  insert(rule: Omit<Rule, 'id'>): Rule;
  findById(id: number): Rule | null;
  getAll(groupId: string): Rule[];
  getPage(groupId: string, offset: number, limit: number): { rules: Rule[]; total: number };
  deleteBySource(groupId: string, source: Rule['source']): number;
}

export interface ModRejection {
  id: number;
  groupId: string;
  content: string;
  reason: string;
  userNickname: string | null;
  createdAt: number;
  userId: string | null;
  severity: number | null;
  contextSnippet: string | null;
}

export interface IModRejectionRepository {
  insert(row: Omit<ModRejection, 'id'> & { userId?: string | null; severity?: number | null; contextSnippet?: string | null }): ModRejection;
  getRecent(groupId: string, limit: number): ModRejection[];
  getRecentSince(groupId: string, sinceTimestamp: number, limit: number): ModRejection[];
}

export interface IAnnouncementRepository {
  upsert(ann: Omit<GroupAnnouncement, 'id'>): GroupAnnouncement;
  getByNoticeId(groupId: string, noticeId: string): GroupAnnouncement | null;
  getLatest(groupId: string): GroupAnnouncement | null;
}

export interface INameImageRepository {
  /** Returns null on dedup (source_file conflict) or cap reached (maxPerName exceeded). */
  insert(groupId: string, name: string, filePath: string, sourceFile: string | null, addedBy: string, maxPerName: number): NameImage | null;
  listByName(groupId: string, name: string): NameImage[];
  countByName(groupId: string, name: string): number;
  pickRandom(groupId: string, name: string): NameImage | null;
  getAllNames(groupId: string): string[];
}

export interface LiveSticker {
  id: number;
  groupId: string;
  key: string;
  type: 'mface' | 'image';
  cqCode: string;
  summary: string | null;
  count: number;
  firstSeen: number;
  lastSeen: number;
}

export interface ILiveStickerRepository {
  upsert(groupId: string, key: string, type: LiveSticker['type'], cqCode: string, summary: string | null, now: number): void;
  getTopByGroup(groupId: string, limit: number): LiveSticker[];
}

export interface IImageDescriptionRepository {
  get(fileKey: string): string | null;
  set(fileKey: string, description: string, now: number): void;
  purgeOlderThan(cutoffTs: number): number;
}

export interface IForwardCacheRepository {
  get(forwardId: string): { expandedText: string; nestedImageKeys: string[] } | null;
  put(forwardId: string, expandedText: string, nestedImageKeys: string[], now: number): void;
  deleteExpired(beforeTs: number): number;
}

export interface ImageModVerdict {
  fileKey: string;
  violation: boolean;
  severity: number;
  reason: string | null;
  ruleId: number | null;
  createdAt: number;
}

export interface IImageModCacheRepository {
  get(fileKey: string): ImageModVerdict | null;
  set(verdict: ImageModVerdict): void;
  purgeOlderThan(cutoffTs: number): number;
}

export interface BotReply {
  id: number;
  groupId: string;
  triggerMsgId: string | null;
  triggerUserNickname: string | null;
  triggerContent: string;
  botReply: string;
  module: string;
  sentAt: number;
  rating: number | null;
  ratingComment: string | null;
  ratedAt: number | null;
  wasEvasive: boolean;
}

export interface IBotReplyRepository {
  insert(row: Omit<BotReply, 'id' | 'rating' | 'ratingComment' | 'ratedAt' | 'wasEvasive'>): BotReply;
  getUnrated(groupId: string, limit: number): BotReply[];
  getRecent(groupId: string, limit: number): BotReply[];
  rate(id: number, rating: number, comment: string | null, now: number): void;
  /** Mark a previously-inserted reply as evasive (bot punted with "忘了" / "考我呢" / etc.). */
  markEvasive(id: number): void;
  /** Fetch a single bot reply by primary key. */
  getById(id: number): BotReply | null;
  /** List all evasive bot replies in a group emitted since `sinceTs` (epoch seconds), newest-first. */
  listEvasiveSince(groupId: string, sinceTs: number): BotReply[];
  /** Get the N most recent bot reply texts for a group (newest-first). For botRecentOutputs restore on startup. */
  getRecentTexts(groupId: string, limit: number): string[];
}

export interface LearnedFact {
  id: number;
  groupId: string;
  topic: string | null;
  fact: string;
  canonicalForm: string | null;
  personaForm: string | null;
  sourceUserId: string | null;
  sourceUserNickname: string | null;
  sourceMsgId: string | null;
  botReplyId: number | null;
  confidence: number;
  status: 'active' | 'pending' | 'superseded' | 'rejected';
  createdAt: number;
  updatedAt: number;
  embedding: number[] | null;
}

export interface ILearnedFactsRepository {
  insert(row: {
    groupId: string;
    topic: string | null;
    fact: string;
    canonicalForm?: string | null;
    personaForm?: string | null;
    sourceUserId: string | null;
    sourceUserNickname: string | null;
    sourceMsgId: string | null;
    botReplyId: number | null;
    confidence?: number;
    status?: LearnedFact['status'];
  }): number;
  listActive(groupId: string, limit: number): LearnedFact[];
  listActiveWithEmbeddings(groupId: string): LearnedFact[];
  listNullEmbeddingActive(groupId: string, limit: number): LearnedFact[];
  listAllNullEmbeddingActive(limit: number): LearnedFact[];
  updateEmbedding(id: number, embedding: number[]): void;
  markStatus(id: number, status: LearnedFact['status']): void;
  clearGroup(groupId: string): number;
  countActive(groupId: string): number;
  setEmbeddingService(svc: IEmbeddingService | null): void;
  /**
   * Return the active fact in this group whose embedding has the highest
   * cosine similarity to `text`, if that similarity is ≥ `threshold`.
   * Returns null if embeddings are unavailable, no candidates, or below threshold.
   */
  findSimilarActive(
    groupId: string, text: string, threshold: number
  ): Promise<{ fact: LearnedFact; cosine: number } | null>;
  /**
   * BM25 keyword search over canonical_form + fact for a group, best first.
   * Raw query is sanitized via sanitizeFtsQuery. Returns [] on empty query,
   * parse error, or missing FTS table (degrades to vector-only in hybrid caller).
   */
  searchByBM25(groupId: string, query: string, limit: number): LearnedFact[];
  listPending(groupId: string, limit: number, offset: number): LearnedFact[];
  countPending(groupId: string): number;
  expirePendingOlderThan(cutoffTimestamp: number): number;
  approveAllPending(groupId: string): number;
  /** Record a backfill attempt failure. After 3 failures, marks as 'failed'. Returns true if marked failed. */
  recordEmbeddingFailure(id: number): boolean;
  /** List active facts whose topic contains '别名' for a group. Used to merge learned aliases into lore retrieval. */
  listActiveAliasFacts(groupId: string): LearnedFact[];
  /** List active + pending alias facts for alias-map merging (M6.2c: lets miner's pending rows reach lore retrieval without breaking admin /facts_pending review). */
  listAliasFactsForMap(groupId: string): LearnedFact[];
}

// Path C: web_lookup_cache repository
export interface WebLookupCacheRow {
  id: number;
  groupId: string;
  term: string;
  snippet: string;
  sourceUrl: string;
  confidence: number;
  createdAt: number;
  expiresAt: number;
}

export interface IWebLookupCacheRepository {
  get(groupId: string, term: string, nowSec: number): WebLookupCacheRow | null;
  put(row: Omit<WebLookupCacheRow, 'id'>): void;
  cleanupExpired(nowSec: number): number;
}

export type ProposedAction = 'warn' | 'delete' | 'mute_10m' | 'mute_1h' | 'kick';
export type PendingStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface PendingModeration {
  id: number;
  groupId: string;
  msgId: string;
  userId: string;
  userNickname: string | null;
  content: string;
  severity: number;
  reason: string;
  proposedAction: ProposedAction;
  status: PendingStatus;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
}

export interface IPendingModerationRepository {
  queue(row: Omit<PendingModeration, 'id' | 'status' | 'decidedAt' | 'decidedBy'>): number;
  getById(id: number): PendingModeration | null;
  markStatus(id: number, status: PendingStatus, decidedBy?: string): void;
  expireOlderThan(cutoffSec: number): number;
  listPending(limit: number): PendingModeration[];
}

export interface IWelcomeLogRepository {
  record(groupId: string, userId: string, nowSec: number): void;
  lastWelcomeAt(groupId: string, userId: string): number | null;
}

// ---- PersonaPatchProposal (M6.6 + M8.1) ----

export type PersonaPatchStatus = 'pending' | 'approved' | 'rejected' | 'superseded';
/** M8.1: proposal cadence kind. 'daily' = hourly-ish M6.6 path; 'weekly' = 7-day roll-up. */
export type PersonaPatchKind = 'daily' | 'weekly';

export interface PersonaPatchProposal {
  id: number;
  groupId: string;
  /** Snapshot of chat_persona_text at proposal time. null when no persona was set. */
  oldPersonaText: string | null;
  newPersonaText: string;
  /** LLM-written natural-language explanation of what changed and why, 1-3 sentences. */
  reasoning: string;
  /** Unified-diff summary produced at propose time (+/- lines, truncated to ~40 lines). */
  diffSummary: string;
  status: PersonaPatchStatus;
  /** M8.1 — cadence kind. Legacy rows default to 'daily'. */
  kind: PersonaPatchKind;
  createdAt: number;     // unix seconds
  decidedAt: number | null;
  decidedBy: string | null;
}

export interface IPersonaPatchRepository {
  /**
   * Insert a new proposal. `kind` defaults to 'daily' when the caller is a
   * pre-M8.1 code path that does not pass it.
   */
  insert(row: Omit<PersonaPatchProposal, 'id' | 'status' | 'decidedAt' | 'decidedBy' | 'kind'> & { kind?: PersonaPatchKind }): number;
  getById(id: number): PersonaPatchProposal | null;
  /**
   * List pending proposals (status='pending') created within `ttlSec` of `now`.
   * Rows older than ttlSec are silently filtered out (treated as expired) but
   * remain in the table — no `expires_at` column is stored.
   *
   * M8.1: weekly-first sort (weekly rows come before daily at the same timestamp).
   */
  listPending(groupId: string, now: number, ttlSec: number, limit?: number): PersonaPatchProposal[];
  /**
   * List all proposals (any status) for a group within `sinceSec .. now`.
   * Used by /persona_history. M8.1: weekly-first sort.
   */
  listHistory(groupId: string, sinceSec: number, limit?: number): PersonaPatchProposal[];
  /**
   * Count proposals inserted since `sinceSec` — used for daily-cap rate limit.
   * M8.1: optional kind filter so weekly and daily have independent daily caps.
   */
  countProposalsSince(groupId: string, sinceSec: number, kind?: PersonaPatchKind): number;
  /** Mark a proposal rejected. */
  reject(id: number, adminId: string, nowSec: number): void;
  /**
   * Transactional apply: mark proposal approved, update group_config.chat_persona_text
   * to its new_persona_text, and mark all other pending proposals for the same
   * group as superseded. Returns true on success; false if the proposal isn't
   * currently pending (lost race) or the group_config update failed.
   */
  apply(id: number, adminId: string, nowSec: number): boolean;
  /**
   * Returns true iff a proposal with this exact new_persona_text already exists
   * (any status) in the last `windowSec` — used to suppress trivial retries.
   *
   * M8.1: if `kind` is given, restrict dedup to that kind so daily + weekly have
   * independent dedup windows (a weekly can reuse wording a stale daily already
   * used, etc).
   */
  hasRecentDuplicate(groupId: string, newPersonaText: string, windowSec: number, now: number, kind?: PersonaPatchKind): boolean;
  /** M8.1 — return the most recent weekly proposal for a group (any status), or null. */
  findLastWeekly(groupId: string): PersonaPatchProposal | null;
  /**
   * M8.1 — mark all pending 'daily' proposals for a group with created_at <
   * `beforeTs` as rejected (reason: 'stale_after_weekly'). Used when a weekly
   * proposal is approved — dailies that predate it are off an older persona
   * baseline and shouldn't ship. Returns the count mutated.
   */
  rejectStaleDailiesBefore(groupId: string, beforeTs: number, adminId: string, nowSec: number): number;
}

export interface LocalSticker {
  id: number;
  groupId: string;
  key: string;
  type: 'image' | 'mface';
  localPath: string | null;
  cqCode: string;
  summary: string | null;
  contextSamples: string[];
  count: number;
  firstSeen: number;
  lastSeen: number;
  usagePositive: number;
  usageNegative: number;
}

export interface ILocalStickerRepository {
  upsert(
    groupId: string, key: string, type: LocalSticker['type'],
    localPath: string | null, cqCode: string, summary: string | null,
    contextSample: string | null, now: number, maxSamples: number,
  ): 'inserted' | 'updated';
  getTopByGroup(groupId: string, limit: number): LocalSticker[];
  recordUsage(groupId: string, key: string, positive: boolean): void;
  setSummary(groupId: string, key: string, summary: string): void;
  listMissingSummary(groupId: string, limit: number): LocalSticker[];
  /** Mark a sticker as blocked so it's excluded from top queries / sticker-first. */
  blockSticker(groupId: string, key: string): boolean;
  /** Unblock a previously blocked sticker. */
  unblockSticker(groupId: string, key: string): boolean;
  /** Return the set of mface keys known for this group (unblocked only). */
  getMfaceKeys(groupId: string): Set<string>;
  /** Return all unblocked stickers for this group (no sorting, no limit). For Thompson sampling. */
  getAllCandidates(groupId: string): LocalSticker[];
  /** Count unblocked stickers for a group (for status display). */
  countByGroup(groupId: string): number;
  /** Get the cached embedding vector for a sticker. Returns null if not cached. */
  getEmbeddingVec(groupId: string, key: string): number[] | null;
  /** Store an embedding vector for a sticker as a BLOB. */
  setEmbeddingVec(groupId: string, key: string, vec: number[]): void;
}

// ---- Expression pattern + user style types ----

export interface ExpressionPattern {
  groupId: string;
  situation: string;
  expression: string;
  weight: number;
  createdAt: number;
  updatedAt: number;
}

export interface IExpressionPatternRepository {
  upsert(groupId: string, situation: string, expression: string): void;
  listAll(groupId: string): ExpressionPattern[];
  getTopN(groupId: string, limit: number): ExpressionPattern[];
  /** Top patterns by weight with updated_at as recency tiebreak (M8.3 few-shot source). */
  getTopRecentN(groupId: string, limit: number): ExpressionPattern[];
  updateWeight(groupId: string, situation: string, expression: string, weight: number): void;
  delete(groupId: string, situation: string, expression: string): void;
}

export interface StyleJsonData {
  catchphrases: string[];
  punctuationStyle: string;
  sentencePattern: string;
  emotionalSignatures: Record<string, string>;
  topicAffinity: string[];
}

export interface IUserStyleRepository {
  upsert(groupId: string, userId: string, nickname: string, styleJson: StyleJsonData): void;
  get(groupId: string, userId: string): StyleJsonData | null;
  listAll(groupId: string): Array<{ userId: string; nickname: string; style: StyleJsonData; updatedAt: number }>;
}

// ---- Group-aggregate style (M8.2) ----

export interface GroupAggregateStyle {
  topCatchphrases: Array<{ phrase: string; userCount: number }>;
  punctuationDensity: 'minimal' | 'light' | 'normal' | 'heavy';
  emojiProneness: 'rare' | 'occasional' | 'frequent';
  commonSentenceTraits: string[];
  topTopics: Array<{ topic: string; userCount: number }>;
  userCount: number;
  updatedAt: number;
}

export interface IUserStyleAggregateRepository {
  upsert(groupId: string, agg: Omit<GroupAggregateStyle, 'updatedAt'>): void;
  get(groupId: string): GroupAggregateStyle | null;
}

// ---- Mood state (M9.2) ----

export interface MoodRow {
  groupId: string;
  valence: number;
  arousal: number;
  lastUpdate: number; // ms timestamp
}

export interface IMoodRepository {
  loadAll(): MoodRow[];
  upsert(row: MoodRow): void;
}

// ---- Honest gaps (W-A) ----

export interface HonestGapsRow {
  groupId: string;
  term: string;
  seenCount: number;
  firstSeen: number; // unix seconds
  lastSeen: number;  // unix seconds
}

export interface IHonestGapsRepository {
  /** Increment seen_count for (groupId, term); insert with seen_count=1 on first sighting. nowSec in unix seconds. */
  upsert(groupId: string, term: string, nowSec: number): void;
  /** Top terms with seen_count >= minSeen, ordered by (seen_count DESC, last_seen DESC). */
  getTopTerms(groupId: string, minSeen: number, limit: number): HonestGapsRow[];
}

// ---- Meme graph (memes-v1) ----

export interface MemeGraphEntry {
  id: number;
  groupId: string;
  canonical: string;
  variants: string[];                     // parsed from JSON
  meaning: string;
  originEvent: string | null;
  originMsgId: string | null;
  originUserId: string | null;
  originTs: number | null;
  firstSeenCount: number;
  totalCount: number;
  confidence: number;
  status: 'active' | 'demoted' | 'manual_edit';
  embeddingVec: number[] | null;          // parsed from BLOB
  createdAt: number;
  updatedAt: number;
}

export interface IMemeGraphRepo {
  insert(entry: Omit<MemeGraphEntry, 'id'>): number;
  update(id: number, fields: Partial<Pick<MemeGraphEntry,
    'variants' | 'meaning' | 'originEvent' | 'originMsgId' |
    'originUserId' | 'originTs' | 'totalCount' | 'confidence' |
    'status' | 'embeddingVec'>>): void;
  findByCanonical(groupId: string, canonical: string): MemeGraphEntry | null;
  findByVariant(groupId: string, term: string): MemeGraphEntry[];
  listActive(groupId: string, limit: number): MemeGraphEntry[];
  findSimilarActive(
    groupId: string,
    queryEmbedding: number[],
    threshold: number,
    limit: number,
  ): MemeGraphEntry[];
  listActiveWithEmbeddings(groupId: string): MemeGraphEntry[];
  listNullEmbedding(groupId: string, limit: number): MemeGraphEntry[];
  listAllNullEmbedding(limit: number): MemeGraphEntry[];
  findById(id: number): MemeGraphEntry | null;
  adminEdit(id: number, fields: Partial<Pick<MemeGraphEntry,
    'canonical' | 'variants' | 'meaning' | 'status'>>): void;
}

// ---- Phrase candidates (memes-v1) ----

export interface PhraseCandidateRow {
  groupId: string;
  content: string;
  gramLen: number;
  count: number;
  contexts: string[];                     // parsed from JSON
  lastInferenceCount: number;
  meaning: string | null;
  isJargon: number;                       // 0=unknown, 1=confirmed, 2=promoted
  promoted: number;                       // 0=unpromoted, 1=promoted
  createdAt: number;
  updatedAt: number;
}

export interface IPhraseCandidatesRepo {
  upsert(groupId: string, content: string, gramLen: number,
         context: string, nowSec: number): void;
  findAtThreshold(groupId: string, thresholds: number[],
                  limit: number): PhraseCandidateRow[];
  updateInference(groupId: string, content: string,
                  meaning: string | null, isJargon: boolean,
                  count: number, nowSec: number): void;
  listUnpromoted(groupId: string): PhraseCandidateRow[];
  markPromoted(groupId: string, content: string, gramLen: number, nowSec: number): void;
}

// ---- Raw row types from SQLite ----

interface MessageRow {
  id: number; group_id: string; user_id: string; nickname: string;
  content: string; raw_content: string | null; timestamp: number; deleted: number; source_message_id: string | null;
}

interface UserRow {
  user_id: string; group_id: string; nickname: string;
  style_summary: string | null; last_seen: number; role: string;
}

interface ModerationRow {
  id: number; msg_id: string; group_id: string; user_id: string;
  violation: number; severity: number | null; action: string;
  reason: string; appealed: number; reversed: number; timestamp: number;
  reviewed: number; reviewed_by: string | null; reviewed_at: number | null;
}

interface GroupConfigRow {
  group_id: string; enabled_modules: string; auto_mod: number;
  daily_punishment_limit: number; punishments_today: number;
  punishments_reset_date: string; mimic_active_user_id: string | null;
  mimic_started_by: string | null; chat_trigger_keywords: string;
  chat_trigger_at_only: number; chat_debounce_ms: number;
  mod_confidence_threshold: number; mod_whitelist: string;
  appeal_window_hours: number; kick_confirm_model: string;
  name_images_enabled: number; name_images_collection_timeout_ms: number;
  name_images_collection_max: number; name_images_cooldown_ms: number;
  name_images_max_per_name: number;
  chat_at_mention_queue_max: number;
  chat_at_mention_burst_window_ms: number;
  chat_at_mention_burst_threshold: number;
  repeater_enabled: number;
  repeater_min_count: number;
  repeater_cooldown_ms: number;
  repeater_min_content_length: number;
  repeater_max_content_length: number;
  name_images_blocklist: string;
  lore_update_enabled: number;
  lore_update_threshold: number;
  lore_update_cooldown_ms: number;
  live_sticker_capture_enabled: number;
  sticker_legend_refresh_every_msgs: number;
  chat_persona_text: string | null;
  active_character_id: string | null;
  char_started_by: string | null;
  welcome_enabled: number;
  id_guard_enabled: number;
  sticker_first_enabled: number;
  sticker_first_threshold: number;
  chat_interest_categories: string;
  chat_interest_min_hits: number;
  air_reading_enabled: number;
  addressee_graph_enabled: number;
  link_across_groups: number;
  created_at: string; updated_at: string;
}

interface NameImageRow {
  id: number; group_id: string; name: string; file_path: string;
  source_file: string | null; added_by: string; added_at: number;
}

interface RuleRow {
  id: number; group_id: string; content: string; type: string; source: string; embedding_vec: Buffer | null;
}

interface AnnouncementRow {
  id: number; group_id: string; notice_id: string; content: string;
  content_hash: string; fetched_at: number; parsed_rules: string;
}

interface CountRow { count: number }


// ---- Mappers ----

function msgFromRow(row: MessageRow): Message {
  return {
    id: row.id, groupId: row.group_id, userId: row.user_id,
    nickname: row.nickname, content: row.content,
    rawContent: row.raw_content ?? row.content,
    timestamp: row.timestamp, deleted: row.deleted !== 0,
  };
}

function userFromRow(row: UserRow): User {
  return {
    userId: row.user_id, groupId: row.group_id, nickname: row.nickname,
    styleSummary: row.style_summary, lastSeen: row.last_seen,
    role: (row.role as 'owner' | 'admin' | 'member') ?? 'member',
  };
}

function modFromRow(row: ModerationRow): ModerationRecord {
  return {
    id: row.id, msgId: row.msg_id, groupId: row.group_id, userId: row.user_id,
    violation: row.violation !== 0,
    severity: row.severity,
    action: row.action as ModerationRecord['action'],
    reason: row.reason,
    appealed: row.appealed as 0 | 1 | 2,
    reversed: row.reversed !== 0,
    timestamp: row.timestamp,
    originalContent: (row as unknown as Record<string, unknown>).original_content as string | null ?? null,
    reviewed: (row.reviewed ?? 0) as 0 | 1 | 2,
    reviewedBy: row.reviewed_by ?? null,
    reviewedAt: row.reviewed_at ?? null,
  };
}

function configFromRow(row: GroupConfigRow): GroupConfig {
  return {
    groupId: row.group_id,
    enabledModules: row.enabled_modules.split(',').filter(Boolean),
    autoMod: row.auto_mod !== 0,
    dailyPunishmentLimit: row.daily_punishment_limit,
    punishmentsToday: row.punishments_today,
    punishmentsResetDate: row.punishments_reset_date,
    mimicActiveUserId: row.mimic_active_user_id,
    mimicStartedBy: row.mimic_started_by,
    chatTriggerKeywords: JSON.parse(row.chat_trigger_keywords) as string[],
    chatTriggerAtOnly: row.chat_trigger_at_only !== 0,
    chatDebounceMs: row.chat_debounce_ms,
    modConfidenceThreshold: row.mod_confidence_threshold,
    modWhitelist: JSON.parse(row.mod_whitelist) as string[],
    appealWindowHours: row.appeal_window_hours,
    kickConfirmModel: row.kick_confirm_model as ClaudeModel,
    chatLoreEnabled: true, // not persisted in DB; always default to enabled
    nameImagesEnabled: (row.name_images_enabled ?? 1) !== 0,
    nameImagesCollectionTimeoutMs: row.name_images_collection_timeout_ms ?? 120_000,
    nameImagesCollectionMax: row.name_images_collection_max ?? 20,
    nameImagesCooldownMs: row.name_images_cooldown_ms ?? 300_000,
    nameImagesMaxPerName: row.name_images_max_per_name ?? 50,
    chatAtMentionQueueMax: row.chat_at_mention_queue_max ?? 5,
    chatAtMentionBurstWindowMs: row.chat_at_mention_burst_window_ms ?? 30_000,
    chatAtMentionBurstThreshold: row.chat_at_mention_burst_threshold ?? 3,
    repeaterEnabled: (row.repeater_enabled ?? 1) !== 0,
    repeaterMinCount: row.repeater_min_count ?? 3,
    repeaterCooldownMs: row.repeater_cooldown_ms ?? 600_000,
    repeaterMinContentLength: row.repeater_min_content_length ?? 2,
    repeaterMaxContentLength: row.repeater_max_content_length ?? 100,
    nameImagesBlocklist: JSON.parse(row.name_images_blocklist ?? '[]') as string[],
    loreUpdateEnabled: (row.lore_update_enabled ?? 1) !== 0,
    loreUpdateThreshold: row.lore_update_threshold ?? 200,
    loreUpdateCooldownMs: row.lore_update_cooldown_ms ?? 1_800_000,
    liveStickerCaptureEnabled: (row.live_sticker_capture_enabled ?? 1) !== 0,
    stickerLegendRefreshEveryMsgs: row.sticker_legend_refresh_every_msgs ?? 50,
    chatPersonaText: row.chat_persona_text ?? null,
    activeCharacterId: row.active_character_id ?? null,
    charStartedBy: row.char_started_by ?? null,
    welcomeEnabled: (row.welcome_enabled ?? 1) !== 0,
    idGuardEnabled: (row.id_guard_enabled ?? 1) !== 0,
    stickerFirstEnabled: (row.sticker_first_enabled ?? 0) !== 0,
    stickerFirstThreshold: row.sticker_first_threshold ?? 0.55,
    chatInterestCategories: JSON.parse(row.chat_interest_categories ?? '[]') as Array<{
      name: string; pattern: string; weight: number;
    }>,
    chatInterestMinHits: row.chat_interest_min_hits ?? 1,
    airReadingEnabled: (row.air_reading_enabled ?? 0) !== 0,
    addresseeGraphEnabled: (row.addressee_graph_enabled ?? 0) !== 0,
    linkAcrossGroups: (row.link_across_groups ?? 0) !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nameImageFromRow(row: NameImageRow): NameImage {
  return {
    id: row.id, groupId: row.group_id, name: row.name,
    filePath: row.file_path, sourceFile: row.source_file,
    addedBy: row.added_by, addedAt: row.added_at,
  };
}

function ruleFromRow(row: RuleRow): Rule {
  let embedding: Float32Array | null = null;
  if (row.embedding_vec) {
    embedding = new Float32Array(row.embedding_vec.buffer, row.embedding_vec.byteOffset, row.embedding_vec.byteLength / 4);
  }
  return {
    id: row.id, groupId: row.group_id, content: row.content,
    type: row.type as 'positive' | 'negative',
    source: (row.source ?? 'manual') as Rule['source'],
    embedding,
  };
}

function announcementFromRow(row: AnnouncementRow): GroupAnnouncement {
  return {
    id: row.id, groupId: row.group_id, noticeId: row.notice_id,
    content: row.content, contentHash: row.content_hash,
    fetchedAt: row.fetched_at,
    parsedRules: JSON.parse(row.parsed_rules) as string[],
  };
}

// ---- Repository implementations ----

class MessageRepository implements IMessageRepository {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_messages_group_nickname ON messages(group_id, nickname)'
    );
  }

  insert(msg: Omit<Message, 'id'>, sourceMessageId?: string): Message {
    const sid = sourceMessageId ?? null;
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO messages (group_id, user_id, nickname, content, raw_content, timestamp, deleted, source_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const result = stmt.run(msg.groupId, msg.userId, msg.nickname, msg.content, msg.rawContent ?? null, msg.timestamp, msg.deleted ? 1 : 0, sid);
    // id=0 signals the row was ignored (duplicate source_message_id)
    const id = (result as { changes: number }).changes > 0 ? Number(result.lastInsertRowid) : 0;
    return { ...msg, id };
  }

  getRecent(groupId: string, limit: number): Message[] {
    const rows = this.db.prepare(
      'SELECT * FROM messages WHERE group_id = ? AND deleted = 0 ORDER BY timestamp DESC LIMIT ?'
    ).all(groupId, limit) as unknown as MessageRow[];
    return rows.map(msgFromRow);
  }

  getByUser(groupId: string, userId: string, limit: number): Message[] {
    const rows = this.db.prepare(
      'SELECT * FROM messages WHERE group_id = ? AND user_id = ? AND deleted = 0 ORDER BY timestamp DESC LIMIT ?'
    ).all(groupId, userId, limit) as unknown as MessageRow[];
    return rows.map(msgFromRow);
  }

  sampleRandomHistorical(groupId: string, excludeNewestN: number, sampleSize: number): Message[] {
    if (sampleSize <= 0) return [];
    const rows = this.db.prepare(
      `SELECT * FROM messages
       WHERE group_id = ? AND deleted = 0
         AND id NOT IN (
           SELECT id FROM messages WHERE group_id = ? AND deleted = 0
           ORDER BY timestamp DESC LIMIT ?
         )
       ORDER BY RANDOM() LIMIT ?`
    ).all(groupId, groupId, excludeNewestN, sampleSize) as unknown as MessageRow[];
    return rows.map(msgFromRow);
  }

  searchByKeywords(groupId: string, keywords: string[], limit: number): Message[] {
    if (keywords.length === 0) return [];
    const capped = keywords.slice(0, 5);
    const likes = capped.map(() => 'content LIKE ?').join(' OR ');
    const params = [groupId, ...capped.map(k => `%${k}%`), limit] as Parameters<typeof this.db.prepare>[0][];
    const rows = this.db.prepare(
      `SELECT * FROM messages WHERE group_id = ? AND deleted = 0 AND (${likes}) ORDER BY timestamp DESC LIMIT ?`
    ).all(...(params as unknown as [string, ...string[]])) as unknown as MessageRow[];
    return rows.map(msgFromRow);
  }

  getTopUsers(groupId: string, limit: number): TopUser[] {
    const rows = this.db.prepare(
      `SELECT user_id, nickname, COUNT(*) as count
       FROM messages WHERE group_id = ? AND deleted = 0
       GROUP BY user_id ORDER BY count DESC LIMIT ?`
    ).all(groupId, limit) as unknown as { user_id: string; nickname: string; count: number }[];
    return rows.map(r => ({ userId: r.user_id, nickname: r.nickname, count: r.count }));
  }

  softDelete(msgId: string): void {
    this.db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run(Number(msgId));
  }

  findBySourceId(sourceMessageId: string): Message | null {
    const row = this.db.prepare(
      'SELECT * FROM messages WHERE source_message_id = ? LIMIT 1'
    ).get(sourceMessageId) as MessageRow | undefined;
    return row ? msgFromRow(row) : null;
  }

  findNearTimestamp(groupId: string, userId: string, timestamp: number, windowSec: number): Message | null {
    const row = this.db.prepare(
      `SELECT * FROM messages WHERE group_id = ? AND user_id = ? AND ABS(timestamp - ?) <= ? AND deleted = 0 ORDER BY ABS(timestamp - ?) ASC LIMIT 1`
    ).get(groupId, userId, timestamp, windowSec, timestamp) as MessageRow | undefined;
    return row ? msgFromRow(row) : null;
  }

  getAroundTimestamp(groupId: string, timestamp: number, windowSec: number, limit: number): Message[] {
    const rows = this.db.prepare(
      `SELECT * FROM messages WHERE group_id = ? AND ABS(timestamp - ?) <= ? AND deleted = 0 ORDER BY timestamp ASC LIMIT ?`
    ).all(groupId, timestamp, windowSec, limit) as unknown as MessageRow[];
    return rows.map(msgFromRow);
  }

  getByTimeRange(groupId: string, startSec: number, endSec: number): Message[] {
    const rows = this.db.prepare(
      `SELECT * FROM messages WHERE group_id = ? AND timestamp >= ? AND timestamp <= ? AND deleted = 0 ORDER BY timestamp ASC`
    ).all(groupId, startSec, endSec) as unknown as MessageRow[];
    return rows.map(msgFromRow);
  }

  listActiveGroupIds(sinceSec: number): string[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT group_id FROM messages WHERE timestamp >= ? AND deleted = 0`
    ).all(sinceSec) as Array<{ group_id: string }>;
    return rows.map(r => r.group_id);
  }

  searchFts(groupId: string, ftsQuery: string, limit: number): Pick<Message, 'content' | 'timestamp'>[] {
    if (!ftsQuery) return [];
    try {
      const rows = this.db.prepare(`
        SELECT m.content, m.timestamp
        FROM messages_fts fts
        JOIN messages m ON m.id = fts.rowid
        WHERE messages_fts MATCH ?
          AND fts.group_id = ?
          AND m.deleted = 0
        ORDER BY m.timestamp DESC
        LIMIT ?
      `).all(ftsQuery, groupId, limit) as { content: string; timestamp: number }[];
      return rows;
    } catch {
      return [];
    }
  }

  listDistinctNicknames(groupId: string, limit = 2000): string[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT nickname FROM messages
       WHERE group_id = ? AND nickname IS NOT NULL AND nickname != ''
       ORDER BY nickname LIMIT ?`
    ).all(groupId, limit) as Array<{ nickname: string }>;
    return rows.map(r => r.nickname);
  }
}

class UserRepository implements IUserRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(user: User): void {
    this.db.prepare(`
      INSERT INTO users (user_id, group_id, nickname, style_summary, last_seen, role)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, group_id) DO UPDATE SET
        nickname = excluded.nickname,
        style_summary = excluded.style_summary,
        last_seen = excluded.last_seen,
        role = excluded.role
    `).run(user.userId, user.groupId, user.nickname, user.styleSummary, user.lastSeen, user.role ?? 'member');
  }

  findById(userId: string, groupId: string): User | null {
    const row = this.db.prepare(
      'SELECT * FROM users WHERE user_id = ? AND group_id = ?'
    ).get(userId, groupId) as unknown as UserRow | undefined;
    return row ? userFromRow(row) : null;
  }

  getAdminsByGroup(groupId: string, limit: number): User[] {
    const rows = this.db.prepare(
      "SELECT * FROM users WHERE group_id = ? AND role IN ('admin','owner') LIMIT ?"
    ).all(groupId, limit) as unknown as UserRow[];
    return rows.map(userFromRow);
  }
}

class ModerationRepository implements IModerationRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(record: Omit<ModerationRecord, 'id' | 'reviewed' | 'reviewedBy' | 'reviewedAt'>): ModerationRecord {
    const stmt = this.db.prepare(`
      INSERT INTO moderation_log (msg_id, group_id, user_id, violation, severity, action, reason, appealed, reversed, timestamp, original_content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      record.msgId, record.groupId, record.userId,
      record.violation ? 1 : 0, record.severity, record.action,
      record.reason, record.appealed, record.reversed ? 1 : 0, record.timestamp,
      record.originalContent ?? null,
    );
    return { ...record, id: Number(result.lastInsertRowid), reviewed: 0, reviewedBy: null, reviewedAt: null };
  }

  findById(id: number): ModerationRecord | null {
    const row = this.db.prepare('SELECT * FROM moderation_log WHERE id = ?').get(id) as unknown as ModerationRow | undefined;
    return row ? modFromRow(row) : null;
  }

  findByMsgId(msgId: string): ModerationRecord | null {
    const row = this.db.prepare('SELECT * FROM moderation_log WHERE msg_id = ? LIMIT 1').get(msgId) as unknown as ModerationRow | undefined;
    return row ? modFromRow(row) : null;
  }

  findRecentByUser(userId: string, groupId: string, windowMs: number): ModerationRecord[] {
    const since = Math.floor(Date.now() / 1000) - Math.floor(windowMs / 1000);
    const rows = this.db.prepare(
      'SELECT * FROM moderation_log WHERE user_id = ? AND group_id = ? AND timestamp >= ? ORDER BY timestamp DESC'
    ).all(userId, groupId, since) as unknown as ModerationRow[];
    return rows.map(modFromRow);
  }

  findRecentByGroup(groupId: string, windowMs: number): ModerationRecord[] {
    const since = Math.floor(Date.now() / 1000) - Math.floor(windowMs / 1000);
    const rows = this.db.prepare(
      'SELECT * FROM moderation_log WHERE group_id = ? AND timestamp >= ? ORDER BY timestamp DESC'
    ).all(groupId, since) as unknown as ModerationRow[];
    return rows.map(modFromRow);
  }

  findPendingAppeal(userId: string, groupId: string): ModerationRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM moderation_log WHERE user_id = ? AND group_id = ? AND appealed = 0 ORDER BY timestamp DESC LIMIT 1'
    ).get(userId, groupId) as unknown as ModerationRow | undefined;
    return row ? modFromRow(row) : null;
  }

  update(id: number, patch: Partial<Pick<ModerationRecord, 'appealed' | 'reversed'>>): void {
    if (patch.appealed !== undefined) {
      this.db.prepare('UPDATE moderation_log SET appealed = ? WHERE id = ?').run(patch.appealed, id);
    }
    if (patch.reversed !== undefined) {
      this.db.prepare('UPDATE moderation_log SET reversed = ? WHERE id = ?').run(patch.reversed ? 1 : 0, id);
    }
  }

  countWarnsByUser(userId: string, groupId: string, withinMs: number): number {
    const since = Math.floor(Date.now() / 1000) - Math.floor(withinMs / 1000);
    const row = this.db.prepare(
      "SELECT COUNT(*) as count FROM moderation_log WHERE user_id = ? AND group_id = ? AND action = 'warn' AND timestamp >= ?"
    ).get(userId, groupId, since) as unknown as CountRow;
    return row.count;
  }

  getForReview(
    filters: ModerationReviewFilters,
    page: number,
    limit: number,
  ): { records: ModerationRecord[]; total: number } {
    // NOTE: OFFSET-based pagination is acceptable for v1 manual review use-case.
    // At very large row counts (tens of thousands) this will slow; migrate to
    // cursor-based pagination (WHERE id < cursor) in a future iteration.
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    // Action filter: default 'punished' excludes action=none.
    const af = filters.actionFilter ?? 'punished';
    if (af === 'punished') clauses.push("action != 'none'");
    else if (af === 'none') clauses.push("action = 'none'");

    if (filters.groupId !== undefined) {
      clauses.push('group_id = ?');
      params.push(filters.groupId);
    }
    if (filters.reviewed !== undefined) {
      clauses.push('reviewed = ?');
      params.push(filters.reviewed);
    }
    if (filters.severityMin !== undefined) {
      clauses.push('severity >= ?');
      params.push(filters.severityMin);
    }
    if (filters.severityMax !== undefined) {
      clauses.push('severity <= ?');
      params.push(filters.severityMax);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const countRow = this.db.prepare(
      `SELECT COUNT(*) as count FROM moderation_log ${where}`
    ).get(...params) as unknown as CountRow;
    const total = countRow.count;

    const rows = this.db.prepare(
      `SELECT * FROM moderation_log ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as unknown as ModerationRow[];

    return { records: rows.map(modFromRow), total };
  }

  markReviewed(id: number, verdict: 1 | 2, reviewedBy: string, reviewedAt: number): void {
    this.db.prepare(
      'UPDATE moderation_log SET reviewed = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?'
    ).run(verdict, reviewedBy, reviewedAt, id);
  }

  getStats(): ModerationStats {
    interface StatRow { group_id: string; reviewed: number; cnt: number }
    // Exclude action='none' from stats — same as getForReview.
    const rows = this.db.prepare(
      `SELECT group_id, reviewed, COUNT(*) as cnt FROM moderation_log WHERE action != 'none' GROUP BY group_id, reviewed`
    ).all() as unknown as StatRow[];

    const stats: ModerationStats = { total: 0, unreviewed: 0, approved: 0, rejected: 0, byGroup: {} };

    for (const row of rows) {
      const g = row.group_id;
      if (!stats.byGroup[g]) stats.byGroup[g] = { total: 0, unreviewed: 0, approved: 0, rejected: 0 };

      stats.byGroup[g]!.total += row.cnt;
      stats.total += row.cnt;

      if (row.reviewed === 0) {
        stats.unreviewed += row.cnt;
        stats.byGroup[g]!.unreviewed += row.cnt;
      } else if (row.reviewed === 1) {
        stats.approved += row.cnt;
        stats.byGroup[g]!.approved += row.cnt;
      } else if (row.reviewed === 2) {
        stats.rejected += row.cnt;
        stats.byGroup[g]!.rejected += row.cnt;
      }
    }

    return stats;
  }

  updateAction(msgId: string, newAction: string): boolean {
    const result = this.db.prepare(
      "UPDATE moderation_log SET action = ? WHERE msg_id = ? AND action = 'none'"
    ).run(newAction, msgId);
    return result.changes > 0;
  }
}

class GroupConfigRepository implements IGroupConfigRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(groupId: string): GroupConfig | null {
    const row = this.db.prepare('SELECT * FROM group_config WHERE group_id = ?').get(groupId) as unknown as GroupConfigRow | undefined;
    return row ? configFromRow(row) : null;
  }

  upsert(config: GroupConfig): void {
    this.db.prepare(`
      INSERT INTO group_config (
        group_id, enabled_modules, auto_mod, daily_punishment_limit, punishments_today,
        punishments_reset_date, mimic_active_user_id, mimic_started_by,
        chat_trigger_keywords, chat_trigger_at_only, chat_debounce_ms,
        mod_confidence_threshold, mod_whitelist, appeal_window_hours,
        kick_confirm_model,
        name_images_enabled, name_images_collection_timeout_ms,
        name_images_collection_max, name_images_cooldown_ms, name_images_max_per_name,
        name_images_blocklist,
        lore_update_enabled, lore_update_threshold, lore_update_cooldown_ms,
        live_sticker_capture_enabled, sticker_legend_refresh_every_msgs,
        chat_persona_text, active_character_id, char_started_by,
        welcome_enabled, id_guard_enabled,
        sticker_first_enabled, sticker_first_threshold,
        chat_interest_categories, chat_interest_min_hits,
        air_reading_enabled, addressee_graph_enabled,
        link_across_groups,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(group_id) DO UPDATE SET
        enabled_modules = excluded.enabled_modules,
        auto_mod = excluded.auto_mod,
        daily_punishment_limit = excluded.daily_punishment_limit,
        punishments_today = excluded.punishments_today,
        punishments_reset_date = excluded.punishments_reset_date,
        mimic_active_user_id = excluded.mimic_active_user_id,
        mimic_started_by = excluded.mimic_started_by,
        chat_trigger_keywords = excluded.chat_trigger_keywords,
        chat_trigger_at_only = excluded.chat_trigger_at_only,
        chat_debounce_ms = excluded.chat_debounce_ms,
        mod_confidence_threshold = excluded.mod_confidence_threshold,
        mod_whitelist = excluded.mod_whitelist,
        appeal_window_hours = excluded.appeal_window_hours,
        kick_confirm_model = excluded.kick_confirm_model,
        name_images_enabled = excluded.name_images_enabled,
        name_images_collection_timeout_ms = excluded.name_images_collection_timeout_ms,
        name_images_collection_max = excluded.name_images_collection_max,
        name_images_cooldown_ms = excluded.name_images_cooldown_ms,
        name_images_max_per_name = excluded.name_images_max_per_name,
        name_images_blocklist = excluded.name_images_blocklist,
        lore_update_enabled = excluded.lore_update_enabled,
        lore_update_threshold = excluded.lore_update_threshold,
        lore_update_cooldown_ms = excluded.lore_update_cooldown_ms,
        live_sticker_capture_enabled = excluded.live_sticker_capture_enabled,
        sticker_legend_refresh_every_msgs = excluded.sticker_legend_refresh_every_msgs,
        chat_persona_text = excluded.chat_persona_text,
        active_character_id = excluded.active_character_id,
        char_started_by = excluded.char_started_by,
        welcome_enabled = excluded.welcome_enabled,
        id_guard_enabled = excluded.id_guard_enabled,
        sticker_first_enabled = excluded.sticker_first_enabled,
        sticker_first_threshold = excluded.sticker_first_threshold,
        chat_interest_categories = excluded.chat_interest_categories,
        chat_interest_min_hits = excluded.chat_interest_min_hits,
        air_reading_enabled = excluded.air_reading_enabled,
        addressee_graph_enabled = excluded.addressee_graph_enabled,
        link_across_groups = excluded.link_across_groups,
        updated_at = excluded.updated_at
    `).run(
      config.groupId,
      config.enabledModules.join(','),
      config.autoMod ? 1 : 0,
      config.dailyPunishmentLimit,
      config.punishmentsToday,
      config.punishmentsResetDate,
      config.mimicActiveUserId,
      config.mimicStartedBy,
      JSON.stringify(config.chatTriggerKeywords),
      config.chatTriggerAtOnly ? 1 : 0,
      config.chatDebounceMs,
      config.modConfidenceThreshold,
      JSON.stringify(config.modWhitelist),
      config.appealWindowHours,
      config.kickConfirmModel,
      (config.nameImagesEnabled ?? true) ? 1 : 0,
      config.nameImagesCollectionTimeoutMs ?? 120_000,
      config.nameImagesCollectionMax ?? 20,
      config.nameImagesCooldownMs ?? 300_000,
      config.nameImagesMaxPerName ?? 50,
      JSON.stringify(config.nameImagesBlocklist ?? []),
      (config.loreUpdateEnabled ?? true) ? 1 : 0,
      config.loreUpdateThreshold ?? 200,
      config.loreUpdateCooldownMs ?? 1_800_000,
      (config.liveStickerCaptureEnabled ?? true) ? 1 : 0,
      config.stickerLegendRefreshEveryMsgs ?? 50,
      config.chatPersonaText ?? null,
      config.activeCharacterId ?? null,
      config.charStartedBy ?? null,
      (config.welcomeEnabled ?? true) ? 1 : 0,
      (config.idGuardEnabled ?? true) ? 1 : 0,
      (config.stickerFirstEnabled ?? false) ? 1 : 0,
      config.stickerFirstThreshold ?? 0.55,
      JSON.stringify(config.chatInterestCategories ?? []),
      config.chatInterestMinHits ?? 1,
      (config.airReadingEnabled ?? false) ? 1 : 0,
      (config.addresseeGraphEnabled ?? false) ? 1 : 0,
      (config.linkAcrossGroups ?? false) ? 1 : 0,
      config.createdAt,
      config.updatedAt,
    );
  }

  incrementPunishments(groupId: string): void {
    this.db.prepare(
      'UPDATE group_config SET punishments_today = punishments_today + 1, updated_at = ? WHERE group_id = ?'
    ).run(new Date().toISOString(), groupId);
  }

  resetDailyPunishments(groupId: string): void {
    this.db.prepare(
      "UPDATE group_config SET punishments_today = 0, punishments_reset_date = ?, updated_at = ? WHERE group_id = ?"
    ).run(new Date().toISOString().slice(0, 10), new Date().toISOString(), groupId);
  }
}

class ModRejectionRepository implements IModRejectionRepository {
  constructor(private readonly db: DatabaseSync) {}

  private _fromRow(r: {
    id: number; group_id: string; content: string; reason: string;
    user_nickname: string | null; created_at: number;
    user_id: string | null; severity: number | null; context_snippet: string | null;
  }): ModRejection {
    return {
      id: r.id, groupId: r.group_id, content: r.content, reason: r.reason,
      userNickname: r.user_nickname, createdAt: r.created_at,
      userId: r.user_id ?? null, severity: r.severity ?? null,
      contextSnippet: r.context_snippet ?? null,
    };
  }

  insert(row: Omit<ModRejection, 'id'> & { userId?: string | null; severity?: number | null; contextSnippet?: string | null }): ModRejection {
    const result = this.db.prepare(
      'INSERT INTO mod_rejections (group_id, content, reason, user_nickname, created_at, user_id, severity, context_snippet) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(row.groupId, row.content, row.reason, row.userNickname, row.createdAt,
      row.userId ?? null, row.severity ?? null, row.contextSnippet ?? null);
    return {
      ...row, id: Number(result.lastInsertRowid),
      userId: row.userId ?? null, severity: row.severity ?? null,
      contextSnippet: row.contextSnippet ?? null,
    };
  }

  getRecent(groupId: string, limit: number): ModRejection[] {
    const rows = this.db.prepare(
      'SELECT id, group_id, content, reason, user_nickname, created_at, user_id, severity, context_snippet FROM mod_rejections WHERE group_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(groupId, limit) as unknown as Array<{
      id: number; group_id: string; content: string; reason: string;
      user_nickname: string | null; created_at: number;
      user_id: string | null; severity: number | null; context_snippet: string | null;
    }>;
    return rows.map(r => this._fromRow(r));
  }

  getRecentSince(groupId: string, sinceTimestamp: number, limit: number): ModRejection[] {
    const rows = this.db.prepare(
      'SELECT id, group_id, content, reason, user_nickname, created_at, user_id, severity, context_snippet FROM mod_rejections WHERE group_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?'
    ).all(groupId, sinceTimestamp, limit) as unknown as Array<{
      id: number; group_id: string; content: string; reason: string;
      user_nickname: string | null; created_at: number;
      user_id: string | null; severity: number | null; context_snippet: string | null;
    }>;
    return rows.map(r => this._fromRow(r));
  }
}

class RuleRepository implements IRuleRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(rule: Omit<Rule, 'id'>): Rule {
    let embBuf: Buffer | null = null;
    if (rule.embedding) {
      const f = rule.embedding;
      // Use byteOffset+byteLength to slice the view correctly — avoids writing the parent
      // buffer when `f` is a view (e.g. produced by ruleFromRow after a DB read-back).
      embBuf = Buffer.from(new Uint8Array(f.buffer, f.byteOffset, f.byteLength));
    }
    const source = rule.source ?? 'manual';
    const result = this.db.prepare(
      'INSERT INTO rules (group_id, content, type, source, embedding_vec) VALUES (?, ?, ?, ?, ?)'
    ).run(rule.groupId, rule.content, rule.type, source, embBuf);
    return { ...rule, source, id: Number(result.lastInsertRowid) };
  }

  deleteBySource(groupId: string, source: Rule['source']): number {
    const result = this.db.prepare(
      'DELETE FROM rules WHERE group_id = ? AND source = ?'
    ).run(groupId, source);
    return (result as { changes: number }).changes;
  }

  findById(id: number): Rule | null {
    const row = this.db.prepare('SELECT * FROM rules WHERE id = ?').get(id) as unknown as RuleRow | undefined;
    return row ? ruleFromRow(row) : null;
  }

  getAll(groupId: string): Rule[] {
    const rows = this.db.prepare('SELECT * FROM rules WHERE group_id = ?').all(groupId) as unknown as RuleRow[];
    return rows.map(ruleFromRow);
  }

  getPage(groupId: string, offset: number, limit: number): { rules: Rule[]; total: number } {
    const total = (this.db.prepare('SELECT COUNT(*) as count FROM rules WHERE group_id = ?').get(groupId) as unknown as CountRow).count;
    const rows = this.db.prepare('SELECT * FROM rules WHERE group_id = ? LIMIT ? OFFSET ?').all(groupId, limit, offset) as unknown as RuleRow[];
    return { rules: rows.map(ruleFromRow), total };
  }
}

class AnnouncementRepository implements IAnnouncementRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(ann: Omit<GroupAnnouncement, 'id'>): GroupAnnouncement {
    const result = this.db.prepare(`
      INSERT INTO group_announcements (group_id, notice_id, content, content_hash, fetched_at, parsed_rules)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(group_id, notice_id) DO UPDATE SET
        content = excluded.content,
        content_hash = excluded.content_hash,
        fetched_at = excluded.fetched_at,
        parsed_rules = excluded.parsed_rules
    `).run(
      ann.groupId, ann.noticeId, ann.content, ann.contentHash,
      ann.fetchedAt, JSON.stringify(ann.parsedRules)
    );
    const id = Number(result.lastInsertRowid) || (
      (this.db.prepare('SELECT id FROM group_announcements WHERE group_id = ? AND notice_id = ?')
        .get(ann.groupId, ann.noticeId) as { id: number }).id
    );
    return { ...ann, id };
  }

  getByNoticeId(groupId: string, noticeId: string): GroupAnnouncement | null {
    const row = this.db.prepare(
      'SELECT * FROM group_announcements WHERE group_id = ? AND notice_id = ?'
    ).get(groupId, noticeId) as unknown as AnnouncementRow | undefined;
    return row ? announcementFromRow(row) : null;
  }

  getLatest(groupId: string): GroupAnnouncement | null {
    const row = this.db.prepare(
      'SELECT * FROM group_announcements WHERE group_id = ? ORDER BY fetched_at DESC LIMIT 1'
    ).get(groupId) as unknown as AnnouncementRow | undefined;
    return row ? announcementFromRow(row) : null;
  }
}

class NameImageRepository implements INameImageRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(groupId: string, name: string, filePath: string, sourceFile: string | null, addedBy: string, maxPerName: number): NameImage | null {
    const addedAt = Math.floor(Date.now() / 1000);
    // Enforce cap at the repository layer — single-row count check before insert
    const current = this.countByName(groupId, name);
    if (current >= maxPerName) return null;
    let lastId: number;
    if (sourceFile !== null) {
      // Use INSERT OR IGNORE — returns 0 changes on dedup
      const result = this.db.prepare(
        'INSERT OR IGNORE INTO name_images (group_id, name, file_path, source_file, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(groupId, name, filePath, sourceFile, addedBy, addedAt) as { changes: number; lastInsertRowid: number };
      if (result.changes === 0) return null;
      lastId = result.lastInsertRowid;
    } else {
      const result = this.db.prepare(
        'INSERT INTO name_images (group_id, name, file_path, source_file, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(groupId, name, filePath, null, addedBy, addedAt) as { lastInsertRowid: number };
      lastId = result.lastInsertRowid;
    }
    const row = this.db.prepare(
      'SELECT * FROM name_images WHERE id = ?'
    ).get(lastId) as unknown as NameImageRow;
    return nameImageFromRow(row);
  }

  listByName(groupId: string, name: string): NameImage[] {
    const rows = this.db.prepare(
      'SELECT * FROM name_images WHERE group_id = ? AND name = ? ORDER BY added_at DESC'
    ).all(groupId, name) as unknown as NameImageRow[];
    return rows.map(nameImageFromRow);
  }

  countByName(groupId: string, name: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM name_images WHERE group_id = ? AND name = ?'
    ).get(groupId, name) as unknown as CountRow;
    return row.count;
  }

  pickRandom(groupId: string, name: string): NameImage | null {
    const row = this.db.prepare(
      'SELECT * FROM name_images WHERE group_id = ? AND name = ? ORDER BY RANDOM() LIMIT 1'
    ).get(groupId, name) as unknown as NameImageRow | undefined;
    return row ? nameImageFromRow(row) : null;
  }

  getAllNames(groupId: string): string[] {
    const rows = this.db.prepare(
      'SELECT DISTINCT name FROM name_images WHERE group_id = ? ORDER BY name'
    ).all(groupId) as unknown as { name: string }[];
    return rows.map(r => r.name);
  }
}

class LiveStickerRepository implements ILiveStickerRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(groupId: string, key: string, type: LiveSticker['type'], cqCode: string, summary: string | null, now: number): void {
    this.db.prepare(`
      INSERT INTO live_stickers (group_id, key, type, cq_code, summary, count, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(group_id, key) DO UPDATE SET
        count = count + 1,
        last_seen = excluded.last_seen
    `).run(groupId, key, type, cqCode, summary, now, now);
  }

  getTopByGroup(groupId: string, limit: number): LiveSticker[] {
    const rows = this.db.prepare(
      'SELECT * FROM live_stickers WHERE group_id = ? ORDER BY count DESC LIMIT ?'
    ).all(groupId, limit) as unknown as Array<{
      id: number; group_id: string; key: string; type: string;
      cq_code: string; summary: string | null; count: number;
      first_seen: number; last_seen: number;
    }>;
    return rows.map(r => ({
      id: r.id, groupId: r.group_id, key: r.key,
      type: r.type as LiveSticker['type'], cqCode: r.cq_code,
      summary: r.summary, count: r.count,
      firstSeen: r.first_seen, lastSeen: r.last_seen,
    }));
  }
}

class ImageDescriptionRepository implements IImageDescriptionRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(fileKey: string): string | null {
    const row = this.db.prepare(
      'SELECT description FROM image_descriptions WHERE file_key = ?'
    ).get(fileKey) as unknown as { description: string } | undefined;
    return row?.description ?? null;
  }

  set(fileKey: string, description: string, now: number): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO image_descriptions (file_key, description, created_at) VALUES (?, ?, ?)'
    ).run(fileKey, description, now);
  }

  purgeOlderThan(cutoffTs: number): number {
    const result = this.db.prepare(
      'DELETE FROM image_descriptions WHERE created_at < ?'
    ).run(cutoffTs) as { changes: number };
    return result.changes;
  }
}

class ImageModCacheRepository implements IImageModCacheRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(fileKey: string): ImageModVerdict | null {
    const row = this.db.prepare(
      'SELECT file_key, violation, severity, reason, rule_id, created_at FROM image_mod_cache WHERE file_key = ?'
    ).get(fileKey) as unknown as { file_key: string; violation: number; severity: number; reason: string | null; rule_id: number | null; created_at: number } | undefined;
    if (!row) return null;
    return {
      fileKey: row.file_key,
      violation: row.violation !== 0,
      severity: row.severity,
      reason: row.reason,
      ruleId: row.rule_id,
      createdAt: row.created_at,
    };
  }

  set(verdict: ImageModVerdict): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO image_mod_cache (file_key, violation, severity, reason, rule_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(verdict.fileKey, verdict.violation ? 1 : 0, verdict.severity, verdict.reason, verdict.ruleId, verdict.createdAt);
  }

  purgeOlderThan(cutoffTs: number): number {
    const result = this.db.prepare(
      'DELETE FROM image_mod_cache WHERE created_at < ?'
    ).run(cutoffTs) as { changes: number };
    return result.changes;
  }
}

class ForwardCacheRepository implements IForwardCacheRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(forwardId: string): { expandedText: string; nestedImageKeys: string[] } | null {
    const row = this.db.prepare(
      'SELECT expanded_text, nested_image_keys FROM forward_cache WHERE forward_id = ?'
    ).get(forwardId) as unknown as { expanded_text: string; nested_image_keys: string } | undefined;
    if (!row) return null;
    return {
      expandedText: row.expanded_text,
      nestedImageKeys: JSON.parse(row.nested_image_keys) as string[],
    };
  }

  put(forwardId: string, expandedText: string, nestedImageKeys: string[], now: number): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO forward_cache (forward_id, expanded_text, nested_image_keys, fetched_at) VALUES (?, ?, ?, ?)'
    ).run(forwardId, expandedText, JSON.stringify(nestedImageKeys), now);
  }

  deleteExpired(beforeTs: number): number {
    const result = this.db.prepare(
      'DELETE FROM forward_cache WHERE fetched_at < ?'
    ).run(beforeTs) as { changes: number };
    return result.changes;
  }
}

interface BotReplyRow {
  id: number; group_id: string; trigger_msg_id: string | null;
  trigger_user_nickname: string | null; trigger_content: string;
  bot_reply: string; module: string; sent_at: number;
  rating: number | null; rating_comment: string | null; rated_at: number | null;
  was_evasive: number | null;
}

function botReplyFromRow(r: BotReplyRow): BotReply {
  return {
    id: r.id, groupId: r.group_id, triggerMsgId: r.trigger_msg_id,
    triggerUserNickname: r.trigger_user_nickname, triggerContent: r.trigger_content,
    botReply: r.bot_reply, module: r.module, sentAt: r.sent_at,
    rating: r.rating, ratingComment: r.rating_comment, ratedAt: r.rated_at,
    wasEvasive: (r.was_evasive ?? 0) !== 0,
  };
}

class BotReplyRepository implements IBotReplyRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(row: Omit<BotReply, 'id' | 'rating' | 'ratingComment' | 'ratedAt' | 'wasEvasive'>): BotReply {
    const result = this.db.prepare(`
      INSERT INTO bot_replies (group_id, trigger_msg_id, trigger_user_nickname, trigger_content, bot_reply, module, sent_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(row.groupId, row.triggerMsgId ?? null, row.triggerUserNickname ?? null, row.triggerContent, row.botReply, row.module, row.sentAt);
    return { ...row, id: Number(result.lastInsertRowid), rating: null, ratingComment: null, ratedAt: null, wasEvasive: false };
  }

  getUnrated(groupId: string, limit: number): BotReply[] {
    const rows = this.db.prepare(
      'SELECT * FROM bot_replies WHERE group_id = ? AND rating IS NULL ORDER BY sent_at DESC LIMIT ?'
    ).all(groupId, limit) as unknown as BotReplyRow[];
    return rows.map(botReplyFromRow);
  }

  getRecent(groupId: string, limit: number): BotReply[] {
    const rows = this.db.prepare(
      'SELECT * FROM bot_replies WHERE group_id = ? ORDER BY sent_at DESC LIMIT ?'
    ).all(groupId, limit) as unknown as BotReplyRow[];
    return rows.map(botReplyFromRow);
  }

  rate(id: number, rating: number, comment: string | null, now: number): void {
    this.db.prepare(
      'UPDATE bot_replies SET rating = ?, rating_comment = ?, rated_at = ? WHERE id = ?'
    ).run(rating, comment ?? null, now, id);
  }

  markEvasive(id: number): void {
    this.db.prepare('UPDATE bot_replies SET was_evasive = 1 WHERE id = ?').run(id);
  }

  getById(id: number): BotReply | null {
    const row = this.db.prepare('SELECT * FROM bot_replies WHERE id = ?').get(id) as unknown as BotReplyRow | undefined;
    return row ? botReplyFromRow(row) : null;
  }

  listEvasiveSince(groupId: string, sinceTs: number): BotReply[] {
    const rows = this.db.prepare(
      'SELECT * FROM bot_replies WHERE group_id = ? AND was_evasive = 1 AND sent_at >= ? ORDER BY sent_at DESC'
    ).all(groupId, sinceTs) as unknown as BotReplyRow[];
    return rows.map(botReplyFromRow);
  }

  getRecentTexts(groupId: string, limit: number): string[] {
    const rows = this.db.prepare(
      'SELECT bot_reply FROM bot_replies WHERE group_id = ? ORDER BY sent_at DESC LIMIT ?'
    ).all(groupId, limit) as unknown as Array<{ bot_reply: string }>;
    // Reverse so oldest is first (same order as in-memory botRecentOutputs)
    return rows.map(r => r.bot_reply).reverse();
  }
}

interface LearnedFactRow {
  id: number; group_id: string; topic: string | null; fact: string;
  canonical_form: string | null; persona_form: string | null;
  source_user_id: string | null; source_user_nickname: string | null;
  source_msg_id: string | null; bot_reply_id: number | null;
  confidence: number; status: string;
  created_at: number; updated_at: number;
  embedding_vec: Buffer | null;
}

function learnedFactFromRow(r: LearnedFactRow): LearnedFact {
  let embedding: number[] | null = null;
  if (r.embedding_vec) {
    const view = new Float32Array(
      r.embedding_vec.buffer,
      r.embedding_vec.byteOffset,
      r.embedding_vec.byteLength / 4,
    );
    embedding = Array.from(view);
  }
  return {
    id: r.id, groupId: r.group_id, topic: r.topic, fact: r.fact,
    canonicalForm: r.canonical_form ?? null,
    personaForm: r.persona_form ?? null,
    sourceUserId: r.source_user_id, sourceUserNickname: r.source_user_nickname,
    sourceMsgId: r.source_msg_id, botReplyId: r.bot_reply_id,
    confidence: r.confidence,
    status: (r.status as LearnedFact['status']) ?? 'active',
    createdAt: r.created_at, updatedAt: r.updated_at,
    embedding,
  };
}

function embeddingToBuffer(embedding: number[]): Buffer {
  const f = new Float32Array(embedding);
  return Buffer.from(new Uint8Array(f.buffer, f.byteOffset, f.byteLength));
}

class LearnedFactsRepository implements ILearnedFactsRepository {
  private _embeddingSvc: IEmbeddingService | null = null;
  private _embedFailureLogged = false;

  constructor(private readonly db: DatabaseSync) {}

  setEmbeddingService(svc: IEmbeddingService | null): void {
    this._embeddingSvc = svc;
  }

  insert(row: {
    groupId: string;
    topic: string | null;
    fact: string;
    canonicalForm?: string | null;
    personaForm?: string | null;
    sourceUserId: string | null;
    sourceUserNickname: string | null;
    sourceMsgId: string | null;
    botReplyId: number | null;
    confidence?: number;
    status?: LearnedFact['status'];
  }): number {
    const now = Math.floor(Date.now() / 1000);
    // insert() is sync; the embed call is async. Store NULL on the row and
    // schedule a fire-and-forget update below — the backfill loop is the
    // safety net for any embedding that fails to land.
    const embBuf: Buffer | null = null;
    const svc = this._embeddingSvc;
    const status: LearnedFact['status'] = row.status ?? 'active';
    const result = this.db.prepare(`
      INSERT INTO learned_facts
        (group_id, topic, fact, canonical_form, persona_form,
         source_user_id, source_user_nickname,
         source_msg_id, bot_reply_id, confidence, status, created_at, updated_at, embedding_vec)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.groupId, row.topic, row.fact,
      row.canonicalForm ?? null, row.personaForm ?? null,
      row.sourceUserId, row.sourceUserNickname, row.sourceMsgId,
      row.botReplyId, row.confidence ?? 1.0, status, now, now, embBuf,
    );
    const id = Number(result.lastInsertRowid);

    // Fire-and-forget embedding compute for the just-inserted row. If the
    // service is not ready or throws, the row stays NULL and the startup
    // backfill loop will fill it in later.
    if (svc && svc.isReady) {
      const factText = row.fact;
      void svc.embed(factText).then(
        (vec) => {
          try { this.updateEmbedding(id, vec); } catch { /* row may have been deleted */ }
        },
        (err) => {
          if (!this._embedFailureLogged) {
            this._embedFailureLogged = true;
            // eslint-disable-next-line no-console
            console.warn('[learned-facts] embed failed for fact', id, String(err));
          }
        },
      );
    }
    return id;
  }

  listActive(groupId: string, limit: number): LearnedFact[] {
    const rows = this.db.prepare(
      `SELECT * FROM learned_facts WHERE group_id = ? AND status = 'active' ORDER BY created_at DESC, id DESC LIMIT ?`
    ).all(groupId, limit) as unknown as LearnedFactRow[];
    return rows.map(learnedFactFromRow);
  }

  listActiveWithEmbeddings(groupId: string): LearnedFact[] {
    const rows = this.db.prepare(
      `SELECT * FROM learned_facts WHERE group_id = ? AND status = 'active' AND embedding_vec IS NOT NULL AND confidence >= 0.6 ORDER BY created_at DESC, id DESC LIMIT 500`
    ).all(groupId) as unknown as LearnedFactRow[];
    return rows.map(learnedFactFromRow);
  }

  listNullEmbeddingActive(groupId: string, limit: number): LearnedFact[] {
    const rows = this.db.prepare(
      `SELECT * FROM learned_facts WHERE group_id = ? AND status = 'active' AND embedding_vec IS NULL ORDER BY id LIMIT ?`
    ).all(groupId, limit) as unknown as LearnedFactRow[];
    return rows.map(learnedFactFromRow);
  }

  listAllNullEmbeddingActive(limit: number): LearnedFact[] {
    const rows = this.db.prepare(
      `SELECT * FROM learned_facts WHERE status = 'active' AND embedding_vec IS NULL AND COALESCE(embedding_status, 'pending') != 'failed' ORDER BY id LIMIT ?`
    ).all(limit) as unknown as LearnedFactRow[];
    return rows.map(learnedFactFromRow);
  }

  updateEmbedding(id: number, embedding: number[]): void {
    const buf = embeddingToBuffer(embedding);
    this.db.prepare(
      'UPDATE learned_facts SET embedding_vec = ? WHERE id = ?'
    ).run(buf, id);
  }

  markStatus(id: number, status: LearnedFact['status']): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(
      'UPDATE learned_facts SET status = ?, updated_at = ? WHERE id = ?'
    ).run(status, now, id);
  }

  clearGroup(groupId: string): number {
    const result = this.db.prepare(
      'DELETE FROM learned_facts WHERE group_id = ?'
    ).run(groupId) as { changes: number };
    return result.changes;
  }

  countActive(groupId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as count FROM learned_facts WHERE group_id = ? AND status = 'active'`
    ).get(groupId) as unknown as CountRow;
    return row.count;
  }

  async findSimilarActive(
    groupId: string, text: string, threshold: number,
  ): Promise<{ fact: LearnedFact; cosine: number } | null> {
    const svc = this._embeddingSvc;
    if (!svc || !svc.isReady) return null;

    const candidates = this.listActiveWithEmbeddings(groupId);
    if (candidates.length === 0) return null;

    let queryVec: number[];
    try {
      queryVec = await svc.embed(text);
    } catch (err) {
      if (!this._embedFailureLogged) {
        this._embedFailureLogged = true;
        // eslint-disable-next-line no-console
        console.warn('[learned-facts] embed failed for findSimilarActive', String(err));
      }
      return null;
    }

    let best: { fact: LearnedFact; cosine: number } | null = null;
    for (const cand of candidates) {
      if (!cand.embedding) continue;
      const c = cosineSimilarity(queryVec, cand.embedding);
      if (best === null || c > best.cosine) {
        best = { fact: cand, cosine: c };
      }
    }
    if (best === null || best.cosine < threshold) return null;
    return best;
  }

  searchByBM25(groupId: string, query: string, limit: number): LearnedFact[] {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];
    try {
      const rows = this.db.prepare(`
        SELECT lf.*
        FROM learned_facts_fts fts
        JOIN learned_facts lf ON lf.id = fts.rowid
        WHERE learned_facts_fts MATCH ?
          AND fts.group_id = ?
          AND lf.status = 'active'
        ORDER BY bm25(learned_facts_fts)
        LIMIT ?
      `).all(sanitized, groupId, limit) as unknown as LearnedFactRow[];
      return rows.map(learnedFactFromRow);
    } catch (err) {
      // FTS syntax error or missing table -> empty, hybrid caller degrades to vector-only.
      bm25Logger.warn({ err: String(err) }, 'BM25 search failed');
      return [];
    }
  }

  listPending(groupId: string, limit: number, offset: number): LearnedFact[] {
    const rows = this.db.prepare(
      `SELECT * FROM learned_facts WHERE group_id = ? AND status = 'pending' ORDER BY id DESC LIMIT ? OFFSET ?`
    ).all(groupId, limit, offset) as unknown as LearnedFactRow[];
    return rows.map(learnedFactFromRow);
  }

  countPending(groupId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as count FROM learned_facts WHERE group_id = ? AND status = 'pending'`
    ).get(groupId) as unknown as CountRow;
    return row.count;
  }

  expirePendingOlderThan(cutoffTimestamp: number): number {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db.prepare(
      `UPDATE learned_facts SET status = 'rejected', updated_at = ? WHERE status = 'pending' AND created_at < ?`
    ).run(now, cutoffTimestamp) as { changes: number };
    return result.changes;
  }

  approveAllPending(groupId: string): number {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db.prepare(
      `UPDATE learned_facts SET status = 'active', updated_at = ? WHERE group_id = ? AND status = 'pending'`
    ).run(now, groupId) as { changes: number };
    return result.changes;
  }

  recordEmbeddingFailure(id: number): boolean {
    const now = Math.floor(Date.now() / 1000);
    // Check current attempt count via last_attempt_at as a proxy.
    // We count failures by looking at how many times embedding_status was set.
    // Simpler: use a counter approach by reading the current embedding_status.
    const row = this.db.prepare(
      'SELECT embedding_status FROM learned_facts WHERE id = ?'
    ).get(id) as { embedding_status: string | null } | undefined;
    const current = row?.embedding_status ?? 'pending';
    const failCount = current.startsWith('fail_') ? parseInt(current.slice(5), 10) : 0;
    const newCount = failCount + 1;
    if (newCount >= 3) {
      this.db.prepare(
        'UPDATE learned_facts SET embedding_status = ?, last_attempt_at = ? WHERE id = ?'
      ).run('failed', now, id);
      return true;
    }
    this.db.prepare(
      'UPDATE learned_facts SET embedding_status = ?, last_attempt_at = ? WHERE id = ?'
    ).run(`fail_${newCount}`, now, id);
    return false;
  }

  listActiveAliasFacts(groupId: string): LearnedFact[] {
    const rows = this.db.prepare(
      `SELECT * FROM learned_facts WHERE group_id = ? AND status = 'active' AND topic LIKE '%别名%' ORDER BY created_at DESC LIMIT 200`
    ).all(groupId) as unknown as LearnedFactRow[];
    return rows.map(learnedFactFromRow);
  }

  listAliasFactsForMap(groupId: string): LearnedFact[] {
    const rows = this.db.prepare(
      `SELECT * FROM learned_facts WHERE group_id = ? AND status IN ('active', 'pending') AND topic LIKE '%别名%' ORDER BY created_at DESC LIMIT 200`
    ).all(groupId) as unknown as LearnedFactRow[];
    return rows.map(learnedFactFromRow);
  }
}

class LocalStickerRepository implements ILocalStickerRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(
    groupId: string, key: string, type: LocalSticker['type'],
    localPath: string | null, cqCode: string, summary: string | null,
    contextSample: string | null, now: number, maxSamples: number,
  ): 'inserted' | 'updated' {
    const existing = this.db.prepare(
      'SELECT context_samples FROM local_stickers WHERE group_id = ? AND key = ?'
    ).get(groupId, key) as { context_samples: string } | undefined;

    if (!existing) {
      const samples = contextSample ? JSON.stringify([contextSample]) : '[]';
      this.db.prepare(`
        INSERT INTO local_stickers
          (group_id, key, type, local_path, cq_code, summary, context_samples, count, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(groupId, key, type, localPath ?? null, cqCode, summary ?? null, samples, now, now);
      return 'inserted';
    }

    // Update count, last_seen, and roll context_samples (cap at maxSamples)
    let samples: string[] = [];
    try { samples = JSON.parse(existing.context_samples) as string[]; } catch { /* ok */ }
    if (contextSample) {
      samples.push(contextSample);
      if (samples.length > maxSamples) samples = samples.slice(samples.length - maxSamples);
    }
    this.db.prepare(`
      UPDATE local_stickers SET count = count + 1, last_seen = ?, context_samples = ?
      WHERE group_id = ? AND key = ?
    `).run(now, JSON.stringify(samples), groupId, key);
    return 'updated';
  }

  getTopByGroup(groupId: string, limit: number): LocalSticker[] {
    const rows = this.db.prepare(`
      SELECT * FROM local_stickers WHERE group_id = ? AND COALESCE(blocked, 0) = 0
      ORDER BY (usage_positive - usage_negative) DESC, count DESC LIMIT ?
    `).all(groupId, limit) as unknown as Array<{
      id: number; group_id: string; key: string; type: string;
      local_path: string | null; cq_code: string; summary: string | null;
      context_samples: string; count: number; first_seen: number; last_seen: number;
      usage_positive: number; usage_negative: number;
    }>;
    return rows.map(r => ({
      id: r.id, groupId: r.group_id, key: r.key,
      type: r.type as LocalSticker['type'],
      localPath: r.local_path, cqCode: r.cq_code, summary: r.summary,
      contextSamples: (() => { try { return JSON.parse(r.context_samples) as string[]; } catch { return []; } })(),
      count: r.count, firstSeen: r.first_seen, lastSeen: r.last_seen,
      usagePositive: r.usage_positive, usageNegative: r.usage_negative,
    }));
  }

  blockSticker(groupId: string, key: string): boolean {
    const result = this.db.prepare(
      'UPDATE local_stickers SET blocked = 1 WHERE group_id = ? AND key = ?'
    ).run(groupId, key);
    return Number(result.changes ?? 0) > 0;
  }

  unblockSticker(groupId: string, key: string): boolean {
    const result = this.db.prepare(
      'UPDATE local_stickers SET blocked = 0 WHERE group_id = ? AND key = ?'
    ).run(groupId, key);
    return Number(result.changes ?? 0) > 0;
  }

  recordUsage(groupId: string, key: string, positive: boolean): void {
    // Two pre-built prepared statements keyed on `positive` — avoids the
    // string-interpolated-column pattern that tempts callers to think SQL
    // injection via `col` is ever okay.
    const sql = positive
      ? 'UPDATE local_stickers SET usage_positive = usage_positive + 1 WHERE group_id = ? AND key = ?'
      : 'UPDATE local_stickers SET usage_negative = usage_negative + 1 WHERE group_id = ? AND key = ?';
    this.db.prepare(sql).run(groupId, key);
  }

  getMfaceKeys(groupId: string): Set<string> {
    const rows = this.db.prepare(
      `SELECT key FROM local_stickers WHERE group_id = ? AND type = 'mface' AND COALESCE(blocked, 0) = 0`
    ).all(groupId) as Array<{ key: string }>;
    return new Set(rows.map(r => r.key));
  }

  getAllCandidates(groupId: string): LocalSticker[] {
    const rows = this.db.prepare(
      `SELECT * FROM local_stickers WHERE group_id = ? AND COALESCE(blocked, 0) = 0`
    ).all(groupId) as unknown as Array<{
      id: number; group_id: string; key: string; type: string;
      local_path: string | null; cq_code: string; summary: string | null;
      context_samples: string; count: number; first_seen: number; last_seen: number;
      usage_positive: number; usage_negative: number;
    }>;
    return rows.map(r => ({
      id: r.id, groupId: r.group_id, key: r.key,
      type: r.type as LocalSticker['type'],
      localPath: r.local_path, cqCode: r.cq_code, summary: r.summary,
      contextSamples: (() => { try { return JSON.parse(r.context_samples) as string[]; } catch { return []; } })(),
      count: r.count, firstSeen: r.first_seen, lastSeen: r.last_seen,
      usagePositive: r.usage_positive, usageNegative: r.usage_negative,
    }));
  }

  countByGroup(groupId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM local_stickers WHERE group_id = ? AND COALESCE(blocked, 0) = 0`
    ).get(groupId) as { cnt: number };
    return row.cnt;
  }

  getEmbeddingVec(groupId: string, key: string): number[] | null {
    const row = this.db.prepare(
      'SELECT embedding_vec FROM local_stickers WHERE group_id = ? AND key = ?'
    ).get(groupId, key) as { embedding_vec: ArrayBuffer | null } | undefined;
    if (!row?.embedding_vec) return null;
    return Array.from(new Float32Array(row.embedding_vec));
  }

  setEmbeddingVec(groupId: string, key: string, vec: number[]): void {
    const buf = new Float32Array(vec).buffer;
    this.db.prepare(
      'UPDATE local_stickers SET embedding_vec = ? WHERE group_id = ? AND key = ?'
    ).run(new Uint8Array(buf), groupId, key);
  }

  setSummary(groupId: string, key: string, summary: string): void {
    this.db.prepare(
      'UPDATE local_stickers SET summary = ? WHERE group_id = ? AND key = ?'
    ).run(summary, groupId, key);
  }

  listMissingSummary(groupId: string, limit: number): LocalSticker[] {
    const rows = this.db.prepare(`
      SELECT * FROM local_stickers
      WHERE group_id = ? AND (summary IS NULL OR summary = '')
      ORDER BY count DESC LIMIT ?
    `).all(groupId, limit) as unknown as Array<{
      id: number; group_id: string; key: string; type: string;
      local_path: string | null; cq_code: string; summary: string | null;
      context_samples: string; count: number; first_seen: number; last_seen: number;
      usage_positive: number; usage_negative: number;
    }>;
    return rows.map(r => ({
      id: r.id, groupId: r.group_id, key: r.key,
      type: r.type as LocalSticker['type'],
      localPath: r.local_path, cqCode: r.cq_code, summary: r.summary,
      contextSamples: (() => { try { return JSON.parse(r.context_samples) as string[]; } catch { return []; } })(),
      count: r.count, firstSeen: r.first_seen, lastSeen: r.last_seen,
      usagePositive: r.usage_positive, usageNegative: r.usage_negative,
    }));
  }
}

interface PendingModerationRow {
  id: number; group_id: string; msg_id: string; user_id: string;
  user_nickname: string | null; content: string; severity: number;
  reason: string; proposed_action: string; status: string;
  created_at: number; decided_at: number | null; decided_by: string | null;
}

class PendingModerationRepository implements IPendingModerationRepository {
  constructor(private readonly db: DatabaseSync) {}

  private _row(r: PendingModerationRow): PendingModeration {
    return {
      id: r.id, groupId: r.group_id, msgId: r.msg_id, userId: r.user_id,
      userNickname: r.user_nickname, content: r.content, severity: r.severity,
      reason: r.reason, proposedAction: r.proposed_action as ProposedAction,
      status: r.status as PendingStatus, createdAt: r.created_at,
      decidedAt: r.decided_at, decidedBy: r.decided_by,
    };
  }

  queue(row: Omit<PendingModeration, 'id' | 'status' | 'decidedAt' | 'decidedBy'>): number {
    const result = this.db.prepare(
      `INSERT INTO pending_moderation
         (group_id, msg_id, user_id, user_nickname, content, severity, reason, proposed_action, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.groupId, row.msgId, row.userId, row.userNickname ?? null,
      row.content, row.severity, row.reason, row.proposedAction, row.createdAt,
    ) as { lastInsertRowid: number };
    return Number(result.lastInsertRowid);
  }

  getById(id: number): PendingModeration | null {
    const r = this.db.prepare('SELECT * FROM pending_moderation WHERE id = ?').get(id) as PendingModerationRow | undefined;
    return r ? this._row(r) : null;
  }

  markStatus(id: number, status: PendingStatus, decidedBy?: string): void {
    this.db.prepare(
      `UPDATE pending_moderation SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?`
    ).run(status, Math.floor(Date.now() / 1000), decidedBy ?? null, id);
  }

  expireOlderThan(cutoffSec: number): number {
    const result = this.db.prepare(
      `UPDATE pending_moderation SET status = 'expired', decided_at = ?
       WHERE status = 'pending' AND created_at < ?`
    ).run(Math.floor(Date.now() / 1000), cutoffSec) as { changes: number };
    return result.changes;
  }

  listPending(limit: number): PendingModeration[] {
    return (this.db.prepare(
      `SELECT * FROM pending_moderation WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?`
    ).all(limit) as unknown as PendingModerationRow[]).map(r => this._row(r));
  }
}

class WelcomeLogRepository implements IWelcomeLogRepository {
  constructor(private readonly db: DatabaseSync) {}

  record(groupId: string, userId: string, nowSec: number): void {
    this.db.prepare(
      'INSERT INTO welcome_log (group_id, user_id, welcomed_at) VALUES (?, ?, ?)'
    ).run(groupId, userId, nowSec);
  }

  lastWelcomeAt(groupId: string, userId: string): number | null {
    const row = this.db.prepare(
      'SELECT welcomed_at FROM welcome_log WHERE group_id = ? AND user_id = ? ORDER BY welcomed_at DESC LIMIT 1'
    ).get(groupId, userId) as { welcomed_at: number } | undefined;
    return row?.welcomed_at ?? null;
  }
}

interface PersonaPatchRow {
  id: number;
  group_id: string;
  old_persona_text: string | null;
  new_persona_text: string;
  reasoning: string;
  diff_summary: string;
  status: string;
  kind: string | null;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
}

class PersonaPatchRepository implements IPersonaPatchRepository {
  constructor(private readonly db: DatabaseSync) {}

  private _row(r: PersonaPatchRow): PersonaPatchProposal {
    // Legacy rows predate the `kind` column (NULL here post-migration) — they
    // default to 'daily' per the ALTER TABLE default.
    const kind: PersonaPatchKind = r.kind === 'weekly' ? 'weekly' : 'daily';
    return {
      id: r.id,
      groupId: r.group_id,
      oldPersonaText: r.old_persona_text,
      newPersonaText: r.new_persona_text,
      reasoning: r.reasoning,
      diffSummary: r.diff_summary,
      status: r.status as PersonaPatchStatus,
      kind,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
      decidedBy: r.decided_by,
    };
  }

  insert(row: Omit<PersonaPatchProposal, 'id' | 'status' | 'decidedAt' | 'decidedBy' | 'kind'> & { kind?: PersonaPatchKind }): number {
    const kind: PersonaPatchKind = row.kind ?? 'daily';
    const result = this.db.prepare(
      `INSERT INTO persona_patch_proposals
         (group_id, old_persona_text, new_persona_text, reasoning, diff_summary, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.groupId,
      row.oldPersonaText,
      row.newPersonaText,
      row.reasoning,
      row.diffSummary,
      kind,
      row.createdAt,
    ) as { lastInsertRowid: number };
    return Number(result.lastInsertRowid);
  }

  getById(id: number): PersonaPatchProposal | null {
    const r = this.db.prepare(
      'SELECT * FROM persona_patch_proposals WHERE id = ?'
    ).get(id) as PersonaPatchRow | undefined;
    return r ? this._row(r) : null;
  }

  listPending(groupId: string, now: number, ttlSec: number, limit = 20): PersonaPatchProposal[] {
    const cutoff = now - ttlSec;
    // M8.1: weekly-first sort — weekly rows outrank daily at equal timestamps,
    // so admins see the bigger-picture proposal first when skimming /persona_review.
    const rows = this.db.prepare(
      `SELECT * FROM persona_patch_proposals
         WHERE group_id = ? AND status = 'pending' AND created_at >= ?
         ORDER BY CASE kind WHEN 'weekly' THEN 0 ELSE 1 END, created_at DESC LIMIT ?`
    ).all(groupId, cutoff, limit) as unknown as PersonaPatchRow[];
    return rows.map(r => this._row(r));
  }

  listHistory(groupId: string, sinceSec: number, limit = 50): PersonaPatchProposal[] {
    // M8.1: weekly-first sort (same rationale as listPending).
    const rows = this.db.prepare(
      `SELECT * FROM persona_patch_proposals
         WHERE group_id = ? AND created_at >= ?
         ORDER BY CASE kind WHEN 'weekly' THEN 0 ELSE 1 END, created_at DESC LIMIT ?`
    ).all(groupId, sinceSec, limit) as unknown as PersonaPatchRow[];
    return rows.map(r => this._row(r));
  }

  countProposalsSince(groupId: string, sinceSec: number, kind?: PersonaPatchKind): number {
    if (kind) {
      const row = this.db.prepare(
        `SELECT COUNT(*) AS n FROM persona_patch_proposals
           WHERE group_id = ? AND created_at >= ? AND kind = ?`
      ).get(groupId, sinceSec, kind) as { n: number } | undefined;
      return row?.n ?? 0;
    }
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM persona_patch_proposals WHERE group_id = ? AND created_at >= ?`
    ).get(groupId, sinceSec) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  reject(id: number, adminId: string, nowSec: number): void {
    this.db.prepare(
      `UPDATE persona_patch_proposals
          SET status = 'rejected', decided_at = ?, decided_by = ?
        WHERE id = ? AND status = 'pending'`
    ).run(nowSec, adminId, id);
  }

  hasRecentDuplicate(groupId: string, newPersonaText: string, windowSec: number, now: number, kind?: PersonaPatchKind): boolean {
    const cutoff = now - windowSec;
    if (kind) {
      const row = this.db.prepare(
        `SELECT 1 FROM persona_patch_proposals
           WHERE group_id = ? AND new_persona_text = ? AND kind = ? AND created_at >= ? LIMIT 1`
      ).get(groupId, newPersonaText, kind, cutoff) as { 1: number } | undefined;
      return !!row;
    }
    const row = this.db.prepare(
      `SELECT 1 FROM persona_patch_proposals
         WHERE group_id = ? AND new_persona_text = ? AND created_at >= ? LIMIT 1`
    ).get(groupId, newPersonaText, cutoff) as { 1: number } | undefined;
    return !!row;
  }

  findLastWeekly(groupId: string): PersonaPatchProposal | null {
    const r = this.db.prepare(
      `SELECT * FROM persona_patch_proposals
         WHERE group_id = ? AND kind = 'weekly'
         ORDER BY created_at DESC LIMIT 1`
    ).get(groupId) as PersonaPatchRow | undefined;
    return r ? this._row(r) : null;
  }

  rejectStaleDailiesBefore(groupId: string, beforeTs: number, adminId: string, nowSec: number): number {
    const result = this.db.prepare(
      `UPDATE persona_patch_proposals
          SET status = 'rejected', decided_at = ?, decided_by = ?
        WHERE group_id = ? AND kind = 'daily' AND status = 'pending' AND created_at < ?`
    ).run(nowSec, adminId, groupId, beforeTs) as { changes: number };
    return result.changes;
  }

  apply(id: number, adminId: string, nowSec: number): boolean {
    // Transactional: mark approved → update group_config.chat_persona_text → supersede siblings.
    // All three must land together or none. node:sqlite exposes manual BEGIN/COMMIT/ROLLBACK.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const proposal = this.db.prepare(
        `SELECT group_id, new_persona_text, status FROM persona_patch_proposals WHERE id = ?`
      ).get(id) as { group_id: string; new_persona_text: string; status: string } | undefined;

      if (!proposal || proposal.status !== 'pending') {
        this.db.exec('ROLLBACK');
        return false;
      }

      const update = this.db.prepare(
        `UPDATE persona_patch_proposals
            SET status = 'approved', decided_at = ?, decided_by = ?
          WHERE id = ? AND status = 'pending'`
      ).run(nowSec, adminId, id) as { changes: number };

      if (update.changes !== 1) {
        this.db.exec('ROLLBACK');
        return false;
      }

      const cfg = this.db.prepare(
        `UPDATE group_config SET chat_persona_text = ?, updated_at = ? WHERE group_id = ?`
      ).run(proposal.new_persona_text, new Date(nowSec * 1000).toISOString(), proposal.group_id) as { changes: number };

      if (cfg.changes !== 1) {
        this.db.exec('ROLLBACK');
        return false;
      }

      this.db.prepare(
        `UPDATE persona_patch_proposals
            SET status = 'superseded', decided_at = ?, decided_by = ?
          WHERE group_id = ? AND status = 'pending' AND id != ?`
      ).run(nowSec, adminId, proposal.group_id, id);

      this.db.exec('COMMIT');
      return true;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* best-effort */ }
      throw err;
    }
  }
}

// ---- BandoriLive ----

export interface BandoriLiveRow {
  id: number;
  eventKey: string;
  title: string;
  startDate: string | null;
  endDate: string | null;
  venue: string | null;
  city: string | null;
  bands: string[];
  detailUrl: string | null;
  ticketInfoText: string | null;
  fetchedAt: number;
  lastSeenAt: number;
  rawHash: string;
}

export interface IBandoriLiveRepository {
  upsert(row: Omit<BandoriLiveRow, 'id'>): void;
  /**
   * Events where start_date >= todayIso AND (start_date <= todayIso + 60 days OR start_date IS NULL),
   * ordered ascending by start_date (NULLs last). Default limit: 3.
   */
  getUpcoming(todayIso: string, limit?: number): BandoriLiveRow[];
  /** Case-insensitive substring search against bands JSON. Default limit: 10. */
  searchByBand(bandQuery: string, limit?: number): BandoriLiveRow[];
  /** Events within a date range (inclusive). */
  searchByDateRange(startIso: string, endIso: string, limit?: number): BandoriLiveRow[];
  getAll(): BandoriLiveRow[];
}

export class BandoriLiveRepository implements IBandoriLiveRepository {
  constructor(private readonly db: DatabaseSync) {}

  private _fromRow(r: Record<string, unknown>): BandoriLiveRow {
    let bands: string[] = [];
    try { bands = JSON.parse(r.bands as string) as string[]; } catch { /* ok */ }
    return {
      id: r.id as number,
      eventKey: r.event_key as string,
      title: r.title as string,
      startDate: (r.start_date as string | null) ?? null,
      endDate: (r.end_date as string | null) ?? null,
      venue: (r.venue as string | null) ?? null,
      city: (r.city as string | null) ?? null,
      bands,
      detailUrl: (r.detail_url as string | null) ?? null,
      ticketInfoText: (r.ticket_info_text as string | null) ?? null,
      fetchedAt: r.fetched_at as number,
      lastSeenAt: r.last_seen_at as number,
      rawHash: r.raw_hash as string,
    };
  }

  upsert(row: Omit<BandoriLiveRow, 'id'>): void {
    const nowSecs = Math.floor(Date.now() / 1000);
    const bandsJson = JSON.stringify(row.bands);
    const existing = this.db.prepare(
      'SELECT raw_hash, fetched_at FROM bandori_lives WHERE event_key = ?'
    ).get(row.eventKey) as { raw_hash: string; fetched_at: number } | undefined;

    if (!existing) {
      this.db.prepare(`
        INSERT INTO bandori_lives
          (event_key, title, start_date, end_date, venue, city, bands, detail_url,
           ticket_info_text, fetched_at, last_seen_at, raw_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.eventKey, row.title, row.startDate ?? null, row.endDate ?? null,
        row.venue ?? null, row.city ?? null, bandsJson, row.detailUrl ?? null,
        row.ticketInfoText ?? null, nowSecs, nowSecs, row.rawHash,
      );
      return;
    }

    if (existing.raw_hash === row.rawHash) {
      // Only bump lastSeenAt
      this.db.prepare(
        'UPDATE bandori_lives SET last_seen_at = ? WHERE event_key = ?'
      ).run(nowSecs, row.eventKey);
    } else {
      // rawHash changed — update all fields except fetched_at
      this.db.prepare(`
        UPDATE bandori_lives SET
          title = ?, start_date = ?, end_date = ?, venue = ?, city = ?,
          bands = ?, detail_url = ?, ticket_info_text = ?,
          last_seen_at = ?, raw_hash = ?
        WHERE event_key = ?
      `).run(
        row.title, row.startDate ?? null, row.endDate ?? null,
        row.venue ?? null, row.city ?? null, bandsJson, row.detailUrl ?? null,
        row.ticketInfoText ?? null, nowSecs, row.rawHash, row.eventKey,
      );
    }
  }

  getUpcoming(todayIso: string, limit = 3): BandoriLiveRow[] {
    // 60-day window
    const d = new Date(todayIso);
    d.setDate(d.getDate() + 60);
    const windowEnd = d.toISOString().slice(0, 10);
    const rows = this.db.prepare(`
      SELECT * FROM bandori_lives
      WHERE (start_date IS NULL OR (start_date >= ? AND start_date <= ?))
      ORDER BY CASE WHEN start_date IS NULL THEN 1 ELSE 0 END, start_date ASC
      LIMIT ?
    `).all(todayIso, windowEnd, limit) as unknown as Array<Record<string, unknown>>;
    return rows.map(r => this._fromRow(r));
  }

  searchByBand(bandQuery: string, limit = 10): BandoriLiveRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM bandori_lives
      WHERE LOWER(bands) LIKE LOWER(?)
      ORDER BY CASE WHEN start_date IS NULL THEN 1 ELSE 0 END, start_date ASC
      LIMIT ?
    `).all(`%${bandQuery}%`, limit) as unknown as Array<Record<string, unknown>>;
    return rows.map(r => this._fromRow(r));
  }

  searchByDateRange(startIso: string, endIso: string, limit = 10): BandoriLiveRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM bandori_lives
      WHERE start_date >= ? AND start_date <= ?
      ORDER BY start_date ASC
      LIMIT ?
    `).all(startIso, endIso, limit) as unknown as Array<Record<string, unknown>>;
    return rows.map(r => this._fromRow(r));
  }

  getAll(): BandoriLiveRow[] {
    const rows = this.db.prepare(
      `SELECT * FROM bandori_lives ORDER BY CASE WHEN start_date IS NULL THEN 1 ELSE 0 END, start_date ASC`
    ).all() as unknown as Array<Record<string, unknown>>;
    return rows.map(r => this._fromRow(r));
  }
}

// ---- Expression pattern repository ----

interface ExpressionPatternRow {
  group_id: string;
  situation: string;
  expression: string;
  weight: number;
  created_at: number;
  updated_at: number;
}

function expressionFromRow(r: ExpressionPatternRow): ExpressionPattern {
  return {
    groupId: r.group_id,
    situation: r.situation,
    expression: r.expression,
    weight: r.weight,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

class ExpressionPatternRepository implements IExpressionPatternRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(groupId: string, situation: string, expression: string): void {
    const now = Date.now();
    const existing = this.db.prepare(
      'SELECT weight FROM expression_patterns WHERE group_id = ? AND situation = ? AND expression = ?'
    ).get(groupId, situation, expression) as { weight: number } | undefined;

    if (existing) {
      this.db.prepare(
        'UPDATE expression_patterns SET weight = ?, updated_at = ? WHERE group_id = ? AND situation = ? AND expression = ?'
      ).run(existing.weight + 1, now, groupId, situation, expression);
    } else {
      this.db.prepare(
        'INSERT INTO expression_patterns (group_id, situation, expression, weight, created_at, updated_at) VALUES (?, ?, ?, 1.0, ?, ?)'
      ).run(groupId, situation, expression, now, now);
    }
  }

  listAll(groupId: string): ExpressionPattern[] {
    const rows = this.db.prepare(
      'SELECT * FROM expression_patterns WHERE group_id = ? ORDER BY weight DESC'
    ).all(groupId) as unknown as ExpressionPatternRow[];
    return rows.map(expressionFromRow);
  }

  getTopN(groupId: string, limit: number): ExpressionPattern[] {
    const rows = this.db.prepare(
      'SELECT * FROM expression_patterns WHERE group_id = ? ORDER BY weight DESC LIMIT ?'
    ).all(groupId, limit) as unknown as ExpressionPatternRow[];
    return rows.map(expressionFromRow);
  }

  getTopRecentN(groupId: string, limit: number): ExpressionPattern[] {
    const rows = this.db.prepare(
      'SELECT * FROM expression_patterns WHERE group_id = ? ORDER BY weight DESC, updated_at DESC LIMIT ?'
    ).all(groupId, limit) as unknown as ExpressionPatternRow[];
    return rows.map(expressionFromRow);
  }

  updateWeight(groupId: string, situation: string, expression: string, weight: number): void {
    this.db.prepare(
      'UPDATE expression_patterns SET weight = ?, updated_at = ? WHERE group_id = ? AND situation = ? AND expression = ?'
    ).run(weight, Date.now(), groupId, situation, expression);
  }

  delete(groupId: string, situation: string, expression: string): void {
    this.db.prepare(
      'DELETE FROM expression_patterns WHERE group_id = ? AND situation = ? AND expression = ?'
    ).run(groupId, situation, expression);
  }
}

// ---- User style repository ----

class UserStyleRepository implements IUserStyleRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(groupId: string, userId: string, nickname: string, styleJson: StyleJsonData): void {
    const now = Date.now();
    const json = JSON.stringify(styleJson);
    const existing = this.db.prepare(
      'SELECT 1 FROM user_styles WHERE group_id = ? AND user_id = ?'
    ).get(groupId, userId);

    if (existing) {
      this.db.prepare(
        'UPDATE user_styles SET nickname = ?, style_json = ?, updated_at = ? WHERE group_id = ? AND user_id = ?'
      ).run(nickname, json, now, groupId, userId);
    } else {
      this.db.prepare(
        'INSERT INTO user_styles (group_id, user_id, nickname, style_json, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(groupId, userId, nickname, json, now);
    }
  }

  get(groupId: string, userId: string): StyleJsonData | null {
    const row = this.db.prepare(
      'SELECT style_json FROM user_styles WHERE group_id = ? AND user_id = ?'
    ).get(groupId, userId) as { style_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.style_json) as StyleJsonData;
    } catch {
      return null;
    }
  }

  listAll(groupId: string): Array<{ userId: string; nickname: string; style: StyleJsonData; updatedAt: number }> {
    const rows = this.db.prepare(
      'SELECT user_id, nickname, style_json, updated_at FROM user_styles WHERE group_id = ? ORDER BY updated_at DESC'
    ).all(groupId) as unknown as Array<{ user_id: string; nickname: string; style_json: string; updated_at: number }>;

    const result: Array<{ userId: string; nickname: string; style: StyleJsonData; updatedAt: number }> = [];
    for (const r of rows) {
      try {
        const style = JSON.parse(r.style_json) as StyleJsonData;
        result.push({ userId: r.user_id, nickname: r.nickname, style, updatedAt: r.updated_at });
      } catch { /* skip malformed */ }
    }
    return result;
  }
}

// ---- User style aggregate repository (M8.2) ----

class UserStyleAggregateRepository implements IUserStyleAggregateRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(groupId: string, agg: Omit<GroupAggregateStyle, 'updatedAt'>): void {
    const now = Date.now();
    const json = JSON.stringify({
      topCatchphrases: agg.topCatchphrases,
      punctuationDensity: agg.punctuationDensity,
      emojiProneness: agg.emojiProneness,
      commonSentenceTraits: agg.commonSentenceTraits,
      topTopics: agg.topTopics,
    });
    this.db.prepare(
      `INSERT INTO user_styles_aggregate (group_id, aggregate_json, user_count, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(group_id) DO UPDATE SET
         aggregate_json = excluded.aggregate_json,
         user_count     = excluded.user_count,
         updated_at     = excluded.updated_at`
    ).run(groupId, json, agg.userCount, now);
  }

  get(groupId: string): GroupAggregateStyle | null {
    const row = this.db.prepare(
      'SELECT aggregate_json, user_count, updated_at FROM user_styles_aggregate WHERE group_id = ?'
    ).get(groupId) as { aggregate_json: string; user_count: number; updated_at: number } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.aggregate_json) as Omit<GroupAggregateStyle, 'userCount' | 'updatedAt'>;
      return {
        topCatchphrases: parsed.topCatchphrases ?? [],
        punctuationDensity: parsed.punctuationDensity ?? 'light',
        emojiProneness: parsed.emojiProneness ?? 'rare',
        commonSentenceTraits: parsed.commonSentenceTraits ?? [],
        topTopics: parsed.topTopics ?? [],
        userCount: row.user_count,
        updatedAt: row.updated_at,
      };
    } catch {
      return null;
    }
  }
}

// ---- Mood repository (M9.2) ----

class MoodRepository implements IMoodRepository {
  private readonly loadStmt;
  private readonly upsertStmt;

  constructor(db: DatabaseSync) {
    this.loadStmt = db.prepare(
      'SELECT group_id, valence, arousal, last_update FROM mood_state',
    );
    this.upsertStmt = db.prepare(
      'INSERT OR REPLACE INTO mood_state (group_id, valence, arousal, last_update) VALUES (?, ?, ?, ?)',
    );
  }

  loadAll(): MoodRow[] {
    const rows = this.loadStmt.all() as unknown as Array<{
      group_id: string; valence: number; arousal: number; last_update: number;
    }>;
    return rows.map(r => ({
      groupId: r.group_id,
      valence: r.valence,
      arousal: r.arousal,
      lastUpdate: r.last_update,
    }));
  }

  upsert(row: MoodRow): void {
    this.upsertStmt.run(row.groupId, row.valence, row.arousal, row.lastUpdate);
  }
}

// ---- Group diary repository (W-B) ----

interface GroupDiaryRow {
  id: number;
  group_id: string;
  period_start: number;
  period_end: number;
  kind: DiaryKind;
  summary: string;
  top_topics: string;
  top_speakers: string;
  mood: string | null;
  created_at: number;
}

function diaryFromRow(row: GroupDiaryRow): DiaryEntry {
  return {
    id: row.id,
    groupId: row.group_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    kind: row.kind,
    summary: row.summary,
    topTopics: row.top_topics,
    topSpeakers: row.top_speakers,
    mood: row.mood,
    createdAt: row.created_at,
  };
}

class GroupDiaryRepository implements IGroupDiaryRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(entry: Omit<DiaryEntry, 'id'>): number {
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO group_diary
       (group_id, period_start, period_end, kind, summary, top_topics, top_speakers, mood, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.groupId,
      entry.periodStart,
      entry.periodEnd,
      entry.kind,
      entry.summary,
      entry.topTopics,
      entry.topSpeakers,
      entry.mood,
      entry.createdAt,
    ) as { changes: number; lastInsertRowid: number | bigint };
    return result.changes > 0 ? Number(result.lastInsertRowid) : 0;
  }

  findLatestByKind(groupId: string, kind: DiaryKind): DiaryEntry | null {
    const row = this.db.prepare(
      `SELECT * FROM group_diary WHERE group_id = ? AND kind = ? ORDER BY period_end DESC LIMIT 1`
    ).get(groupId, kind) as GroupDiaryRow | undefined;
    return row ? diaryFromRow(row) : null;
  }

  findByPeriod(groupId: string, kind: DiaryKind, periodStart: number, periodEnd: number): DiaryEntry[] {
    const rows = this.db.prepare(
      `SELECT * FROM group_diary
       WHERE group_id = ? AND kind = ? AND period_start >= ? AND period_end <= ?
       ORDER BY period_start ASC`
    ).all(groupId, kind, periodStart, periodEnd) as unknown as GroupDiaryRow[];
    return rows.map(diaryFromRow);
  }

  findByGroupSince(groupId: string, sinceSec: number, limit: number): DiaryEntry[] {
    const rows = this.db.prepare(
      `SELECT * FROM group_diary WHERE group_id = ? AND period_end >= ?
       ORDER BY period_end DESC LIMIT ?`
    ).all(groupId, sinceSec, limit) as unknown as GroupDiaryRow[];
    return rows.map(diaryFromRow);
  }

  deleteByIds(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM group_diary WHERE id IN (${placeholders})`).run(...ids);
  }
}

// ---- Honest gaps repository (W-A) ----

class HonestGapsRepository implements IHonestGapsRepository {
  private readonly upsertStmt;
  private readonly topStmt;

  constructor(db: DatabaseSync) {
    this.upsertStmt = db.prepare(`
      INSERT INTO honest_gaps (group_id, term, seen_count, first_seen, last_seen)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(group_id, term) DO UPDATE SET
        seen_count = seen_count + 1,
        last_seen  = excluded.last_seen
    `);
    this.topStmt = db.prepare(`
      SELECT group_id, term, seen_count, first_seen, last_seen
      FROM honest_gaps
      WHERE group_id = ? AND seen_count >= ?
      ORDER BY seen_count DESC, last_seen DESC
      LIMIT ?
    `);
  }

  upsert(groupId: string, term: string, nowSec: number): void {
    this.upsertStmt.run(groupId, term, nowSec, nowSec);
  }

  getTopTerms(groupId: string, minSeen: number, limit: number): HonestGapsRow[] {
    const rows = this.topStmt.all(groupId, minSeen, limit) as unknown as Array<{
      group_id: string; term: string; seen_count: number; first_seen: number; last_seen: number;
    }>;
    return rows.map(r => ({
      groupId: r.group_id,
      term: r.term,
      seenCount: r.seen_count,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
    }));
  }
}

// ---- Path C: WebLookupCacheRepository ----

class WebLookupCacheRepository implements IWebLookupCacheRepository {
  constructor(private readonly _db: DatabaseSync) {}

  get(groupId: string, term: string, nowSec: number): WebLookupCacheRow | null {
    const row = this._db.prepare(
      'SELECT * FROM web_lookup_cache WHERE group_id = ? AND term = ? AND expires_at > ? ORDER BY id DESC LIMIT 1'
    ).get(groupId, term, nowSec) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row['id'] as number,
      groupId: row['group_id'] as string,
      term: row['term'] as string,
      snippet: row['snippet'] as string,
      sourceUrl: row['source_url'] as string,
      confidence: row['confidence'] as number,
      createdAt: row['created_at'] as number,
      expiresAt: row['expires_at'] as number,
    };
  }

  put(row: Omit<WebLookupCacheRow, 'id'>): void {
    this._db.prepare(
      `INSERT INTO web_lookup_cache (group_id, term, snippet, source_url, confidence, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(row.groupId, row.term, row.snippet, row.sourceUrl, row.confidence, row.createdAt, row.expiresAt);
  }

  cleanupExpired(nowSec: number): number {
    const info = this._db.prepare('DELETE FROM web_lookup_cache WHERE expires_at <= ?').run(nowSec) as { changes: number };
    return info.changes;
  }
}

// ---- Main Database class ----

export class Database {
  readonly messages: IMessageRepository;
  readonly users: IUserRepository;
  readonly moderation: IModerationRepository;
  readonly groupConfig: IGroupConfigRepository;
  readonly rules: IRuleRepository;
  readonly announcements: IAnnouncementRepository;
  readonly nameImages: INameImageRepository;
  readonly liveStickers: ILiveStickerRepository;
  readonly imageDescriptions: IImageDescriptionRepository;
  readonly imageModCache: IImageModCacheRepository;
  readonly forwardCache: IForwardCacheRepository;
  readonly botReplies: IBotReplyRepository;
  readonly localStickers: ILocalStickerRepository;
  readonly learnedFacts: ILearnedFactsRepository;
  readonly pendingModeration: IPendingModerationRepository;
  readonly welcomeLog: IWelcomeLogRepository;
  readonly personaPatches: IPersonaPatchRepository;
  readonly modRejections: IModRejectionRepository;
  readonly bandoriLives: IBandoriLiveRepository;
  readonly expressionPatterns: IExpressionPatternRepository;
  readonly userStyles: IUserStyleRepository;
  readonly userStylesAggregate: IUserStyleAggregateRepository;
  readonly mood: IMoodRepository;
  readonly honestGaps: IHonestGapsRepository;
  readonly memeGraph: IMemeGraphRepo;
  readonly phraseCandidates: IPhraseCandidatesRepo;
  readonly groupDiary: IGroupDiaryRepository;
  readonly webLookupCache: IWebLookupCacheRepository;

  private readonly _db: DatabaseSync;

  /** Expose raw DatabaseSync for modules that need direct SQL access (e.g. AffinityModule, JargonMiner). */
  get rawDb(): DatabaseSync { return this._db; }

  constructor(dbPath: string) {
    this._db = new DatabaseSync(dbPath);
    this._db.exec('PRAGMA journal_mode = WAL;');
    this._db.exec('PRAGMA foreign_keys = ON;');
    this._applySchema();

    this.messages = new MessageRepository(this._db);
    this.users = new UserRepository(this._db);
    this.moderation = new ModerationRepository(this._db);
    this.groupConfig = new GroupConfigRepository(this._db);
    this.rules = new RuleRepository(this._db);
    this.announcements = new AnnouncementRepository(this._db);
    this.nameImages = new NameImageRepository(this._db);
    this.liveStickers = new LiveStickerRepository(this._db);
    this.imageDescriptions = new ImageDescriptionRepository(this._db);
    this.imageModCache = new ImageModCacheRepository(this._db);
    this.forwardCache = new ForwardCacheRepository(this._db);
    this.botReplies = new BotReplyRepository(this._db);
    this.localStickers = new LocalStickerRepository(this._db);
    this.learnedFacts = new LearnedFactsRepository(this._db);
    this.pendingModeration = new PendingModerationRepository(this._db);
    this.welcomeLog = new WelcomeLogRepository(this._db);
    this.personaPatches = new PersonaPatchRepository(this._db);
    this.modRejections = new ModRejectionRepository(this._db);
    this.bandoriLives = new BandoriLiveRepository(this._db);
    this.expressionPatterns = new ExpressionPatternRepository(this._db);
    this.userStyles = new UserStyleRepository(this._db);
    this.userStylesAggregate = new UserStyleAggregateRepository(this._db);
    this.mood = new MoodRepository(this._db);
    this.honestGaps = new HonestGapsRepository(this._db);
    this.memeGraph = new MemeGraphRepository(this._db);
    this.phraseCandidates = new PhraseCandidatesRepository(this._db);
    this.groupDiary = new GroupDiaryRepository(this._db);
    this.webLookupCache = new WebLookupCacheRepository(this._db);
  }

  /** Execute arbitrary SQL — intended for bulk-import scripts and migrations only. */
  exec(sql: string): void {
    this._db.exec(sql);
  }

  close(): void {
    this._db.close();
  }

  private _applySchema(): void {
    const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));
    const sql = readFileSync(schemaPath, 'utf8');
    this._db.exec(sql);
    this._runMigrations();
  }

  private _runMigrations(): void {
    // ALTER TABLE: each wrapped in try/catch — SQLite throws "duplicate column" on existing DBs,
    // which is the correct idempotency signal for ADD COLUMN.
    for (const col of [
      'chat_lore_enabled INTEGER NOT NULL DEFAULT 1',
      'name_images_enabled INTEGER NOT NULL DEFAULT 1',
      'name_images_collection_timeout_ms INTEGER NOT NULL DEFAULT 120000',
      'name_images_collection_max INTEGER NOT NULL DEFAULT 20',
      'name_images_cooldown_ms INTEGER NOT NULL DEFAULT 300000',
      'name_images_max_per_name INTEGER NOT NULL DEFAULT 50',
      'chat_at_mention_queue_max INTEGER NOT NULL DEFAULT 5',
      'chat_at_mention_burst_window_ms INTEGER NOT NULL DEFAULT 30000',
      'chat_at_mention_burst_threshold INTEGER NOT NULL DEFAULT 3',
      'repeater_enabled INTEGER NOT NULL DEFAULT 1',
      'repeater_min_count INTEGER NOT NULL DEFAULT 3',
      'repeater_cooldown_ms INTEGER NOT NULL DEFAULT 600000',
      'repeater_min_content_length INTEGER NOT NULL DEFAULT 2',
      'repeater_max_content_length INTEGER NOT NULL DEFAULT 100',
      "name_images_blocklist TEXT NOT NULL DEFAULT '[]'",
      'lore_update_enabled INTEGER NOT NULL DEFAULT 1',
      'lore_update_threshold INTEGER NOT NULL DEFAULT 200',
      'lore_update_cooldown_ms INTEGER NOT NULL DEFAULT 1800000',
      'live_sticker_capture_enabled INTEGER NOT NULL DEFAULT 1',
      'sticker_legend_refresh_every_msgs INTEGER NOT NULL DEFAULT 50',
      'chat_persona_text TEXT',
    ]) {
      try { this._db.exec(`ALTER TABLE group_config ADD COLUMN ${col}`); } catch { /* already exists */ }
    }

    // name_images table — CREATE TABLE IF NOT EXISTS in schema.sql handles fresh installs,
    // but we repeat it here so existing DBs that predate schema.sql also get the table.
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS name_images (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id    TEXT    NOT NULL,
        name        TEXT    NOT NULL,
        file_path   TEXT    NOT NULL,
        source_file TEXT,
        added_by    TEXT    NOT NULL,
        added_at    INTEGER NOT NULL
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_name_images_group_name ON name_images(group_id, name)`);
    this._db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_name_images_source ON name_images(group_id, name, source_file) WHERE source_file IS NOT NULL`);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS live_stickers (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id    TEXT    NOT NULL,
        key         TEXT    NOT NULL,
        type        TEXT    NOT NULL,
        cq_code     TEXT    NOT NULL,
        summary     TEXT,
        count       INTEGER NOT NULL DEFAULT 1,
        first_seen  INTEGER NOT NULL,
        last_seen   INTEGER NOT NULL,
        UNIQUE(group_id, key)
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_live_stickers_group_count ON live_stickers(group_id, count DESC)`);

    // Add role column to users table for existing DBs
    try { this._db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'`); } catch { /* already exists */ }

    // bot_replies.was_evasive — added for self-learning module (Batch C / Change 4c).
    // Wrapped in try/catch to be idempotent on existing DBs that already have the column.
    try { this._db.exec(`ALTER TABLE bot_replies ADD COLUMN was_evasive INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }

    // learned_facts table — repeated here so existing DBs created before Batch C also get it.
    // schema.sql handles fresh installs; this branch covers upgrade-in-place. See
    // feedback_sqlite_schema_migration.md for why both paths matter.
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS learned_facts (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id             TEXT    NOT NULL,
        topic                TEXT,
        fact                 TEXT    NOT NULL,
        source_user_id       TEXT,
        source_user_nickname TEXT,
        source_msg_id        TEXT,
        bot_reply_id         INTEGER,
        confidence           REAL    NOT NULL DEFAULT 1.0,
        status               TEXT    NOT NULL DEFAULT 'active',
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL,
        embedding_vec        BLOB
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_learned_facts_group_active ON learned_facts(group_id, status, created_at DESC)`);
    // Partial index for Feature B pending queue — most groups have 0 pending
    // rows most of the time, so a partial index stays tiny.
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_learned_facts_group_pending ON learned_facts(group_id, status) WHERE status = 'pending'`);

    // learned_facts.embedding_vec — added for semantic retrieval. Idempotent
    // ALTER for existing DBs created before this column existed.
    try { this._db.exec(`ALTER TABLE learned_facts ADD COLUMN embedding_vec BLOB`); } catch { /* already exists */ }
    // embedding_status: 'pending' | 'done' | 'failed' | 'skipped' — for backfill tracking
    try { this._db.exec(`ALTER TABLE learned_facts ADD COLUMN embedding_status TEXT DEFAULT 'pending'`); } catch { /* already exists */ }
    try { this._db.exec(`ALTER TABLE learned_facts ADD COLUMN last_attempt_at INTEGER`); } catch { /* already exists */ }
    // W-C: canonical_form (retrieval-indexed neutral phrasing) + persona_form
    // (bot-voice injection phrasing). Nullable — legacy rows fall back to `fact`.
    try { this._db.exec(`ALTER TABLE learned_facts ADD COLUMN canonical_form TEXT`); } catch { /* already exists */ }
    try { this._db.exec(`ALTER TABLE learned_facts ADD COLUMN persona_form   TEXT`); } catch { /* already exists */ }
    // Partial index for backfill queries on learned_facts with null embeddings
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_learned_facts_null_embedding ON learned_facts(id) WHERE status = 'active' AND embedding_vec IS NULL`);

    // W-C: FTS5 virtual table + triggers for BM25 hybrid retrieval. trigram
    // tokenizer is required for CJK — unicode61 collapses contiguous CJK runs
    // into a single token so phrase-literal MATCH returns 0 rows.
    // If an existing DB has the table under a different tokenizer, drop and
    // recreate; the backfill below repopulates rowids from learned_facts.
    try {
      const existingSql = this._db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='learned_facts_fts'`,
      ).get() as { sql?: string } | undefined;
      if (existingSql?.sql && !/tokenize\s*=\s*['"]?trigram/i.test(existingSql.sql)) {
        this._db.exec(`DROP TABLE learned_facts_fts`);
      }
    } catch { /* table absent — CREATE below handles fresh install */ }

    this._db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS learned_facts_fts USING fts5(
        canonical_form, fact, group_id UNINDEXED,
        content='learned_facts', content_rowid='id', tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS learned_facts_ai AFTER INSERT ON learned_facts BEGIN
        INSERT INTO learned_facts_fts(rowid, canonical_form, fact, group_id)
        VALUES (new.id, new.canonical_form, new.fact, new.group_id);
      END;
      CREATE TRIGGER IF NOT EXISTS learned_facts_ad AFTER DELETE ON learned_facts BEGIN
        INSERT INTO learned_facts_fts(learned_facts_fts, rowid, canonical_form, fact, group_id)
        VALUES ('delete', old.id, old.canonical_form, old.fact, old.group_id);
      END;
      CREATE TRIGGER IF NOT EXISTS learned_facts_au AFTER UPDATE ON learned_facts BEGIN
        INSERT INTO learned_facts_fts(learned_facts_fts, rowid, canonical_form, fact, group_id)
        VALUES ('delete', old.id, old.canonical_form, old.fact, old.group_id);
        INSERT INTO learned_facts_fts(rowid, canonical_form, fact, group_id)
        VALUES (new.id, new.canonical_form, new.fact, new.group_id);
      END;
    `);

    // W-C: backfill FTS index for rows that predate the triggers. Deferred via
    // setImmediate so large DBs don't block boot. Triggers cover post-boot inserts.
    const ftsLogger = createLogger('learned-facts-fts');
    setImmediate(() => {
      try {
        const ftsCount = this._db.prepare(`SELECT COUNT(*) as n FROM learned_facts_fts`).get() as { n: number };
        const tblCount = this._db.prepare(`SELECT COUNT(*) as n FROM learned_facts`).get() as { n: number };
        if (ftsCount.n < tblCount.n) {
          this._db.exec(`INSERT INTO learned_facts_fts(learned_facts_fts) VALUES('rebuild')`);
        }
      } catch (e) {
        ftsLogger.warn({ err: String(e) }, 'FTS rebuild failed — vector-only fallback');
      }
    });

    // Path A: detect-and-rebuild legacy tokenizer (mirrors learned_facts_fts pattern above).
    // If an existing DB has messages_fts under unicode61, drop and recreate.
    try {
      const existingMsgsFts = this._db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='messages_fts'`,
      ).get() as { sql?: string } | undefined;
      if (existingMsgsFts?.sql && !/tokenize\s*=\s*['"]?trigram/i.test(existingMsgsFts.sql)) {
        this._db.exec(`DROP TABLE messages_fts`);
      }
    } catch { /* table absent — CREATE below handles fresh install */ }

    this._db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        group_id UNINDEXED,
        content='messages',
        content_rowid='id',
        tokenize='trigram'
      )
    `);
    this._db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content, group_id)
        VALUES (new.id, new.content, new.group_id);
      END
    `);
    this._db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, group_id)
        VALUES ('delete', old.id, old.content, old.group_id);
      END
    `);

    // One-shot backfill via setImmediate (same pattern as learned_facts_fts).
    // Deferred so 518k-row INSERT does not block bot startup.
    const msgsFtsLogger = createLogger('messages-fts');
    setImmediate(() => {
      try {
        const ftsCount = this._db.prepare(
          `SELECT COUNT(*) as n FROM messages_fts`,
        ).get() as { n: number };
        const tblCount = this._db.prepare(
          `SELECT COUNT(*) as n FROM messages`,
        ).get() as { n: number };
        if (ftsCount.n < tblCount.n) {
          // Full rebuild is faster than per-row INSERT for existing rows.
          this._db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
        }
      } catch (e) {
        msgsFtsLogger.warn({ err: String(e) }, 'messages-fts rebuild failed');
      }
    }).unref?.();

    // pending_moderation table — Batch D human-in-loop approval flow.
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS pending_moderation (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id         TEXT    NOT NULL,
        msg_id           TEXT    NOT NULL,
        user_id          TEXT    NOT NULL,
        user_nickname    TEXT,
        content          TEXT    NOT NULL,
        severity         INTEGER NOT NULL,
        reason           TEXT    NOT NULL,
        proposed_action  TEXT    NOT NULL,
        status           TEXT    NOT NULL DEFAULT 'pending',
        created_at       INTEGER NOT NULL,
        decided_at       INTEGER,
        decided_by       TEXT
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_moderation_status ON pending_moderation(status, created_at)`);

    // welcome_enabled column on group_config — default on for all groups.
    try { this._db.exec(`ALTER TABLE group_config ADD COLUMN welcome_enabled INTEGER NOT NULL DEFAULT 1`); } catch { /* already exists */ }

    // welcome_log table — schema.sql handles fresh installs; migration covers existing DBs.
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS welcome_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id     TEXT    NOT NULL,
        user_id      TEXT    NOT NULL,
        welcomed_at  INTEGER NOT NULL
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_welcome_log_user ON welcome_log(group_id, user_id, welcomed_at DESC)`);

    // id_guard_enabled column on group_config — default ON (strict zero-tolerance).
    try { this._db.exec(`ALTER TABLE group_config ADD COLUMN id_guard_enabled INTEGER NOT NULL DEFAULT 1`); } catch { /* already exists */ }

    // sticker-first mode columns — feat/sticker-first.
    try { this._db.exec(`ALTER TABLE group_config ADD COLUMN sticker_first_enabled INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
    try { this._db.exec(`ALTER TABLE group_config ADD COLUMN sticker_first_threshold REAL NOT NULL DEFAULT 0.55`); } catch { /* already exists */ }

    // image_mod_cache — verdicts from assessImage, keyed by sha256 file_key, TTL 7 days.
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS image_mod_cache (
        file_key   TEXT    PRIMARY KEY,
        violation  INTEGER NOT NULL,
        severity   INTEGER NOT NULL,
        reason     TEXT,
        rule_id    INTEGER,
        created_at INTEGER NOT NULL
      )
    `);

    // messages.raw_content — stores original CQ-code content for image context resolution.
    try { this._db.exec(`ALTER TABLE messages ADD COLUMN raw_content TEXT`); } catch { /* already exists */ }

    // /char feature columns on group_config — added for BanG Dream character role-play.
    try { this._db.exec(`ALTER TABLE group_config ADD COLUMN active_character_id TEXT`); } catch { /* already exists */ }
    try { this._db.exec(`ALTER TABLE group_config ADD COLUMN char_started_by TEXT`); } catch { /* already exists */ }

    // Snoopy-boundaries: interest-gating columns on group_config.
    try { this._db.exec(`ALTER TABLE group_config ADD COLUMN chat_interest_categories TEXT NOT NULL DEFAULT '[]'`); } catch { /* already exists */ }
    try { this._db.exec(`ALTER TABLE group_config ADD COLUMN chat_interest_min_hits INTEGER NOT NULL DEFAULT 1`); } catch { /* already exists */ }

    // M7 pre-chat judge opt-in flags (M7.3 addressee graph, M7.4 air-reading).
    // Both default OFF — the judge is opt-in per group to bound quota exposure.
    try { this._db.exec(`ALTER TABLE group_config ADD COLUMN air_reading_enabled INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
    try { this._db.exec(`ALTER TABLE group_config ADD COLUMN addressee_graph_enabled INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }

    // M9.3 cross-group recognition opt-in flag. Default OFF — privacy-first.
    try { this._db.exec(`ALTER TABLE group_config ADD COLUMN link_across_groups INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }

    // M9.3 cross-group audit table. CREATE IF NOT EXISTS is idempotent on re-run.
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS cross_group_audit (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        requester_gid TEXT    NOT NULL,
        target_uid    TEXT    NOT NULL,
        source_gids   TEXT    NOT NULL,
        aggregated    REAL    NOT NULL,
        ts            INTEGER NOT NULL
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_cross_group_audit_ts ON cross_group_audit(ts DESC)`);

    // local_stickers.blocked — banned stickers are excluded from top queries.
    try { this._db.exec(`ALTER TABLE local_stickers ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }

    // local_stickers.embedding_vec — cached embedding for sticker-first semantic match.
    try { this._db.exec(`ALTER TABLE local_stickers ADD COLUMN embedding_vec BLOB`); } catch { /* already exists */ }

    // forward_cache — pre-expanded 合并转发 content, keyed by forward_id, TTL 24h.
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS forward_cache (
        forward_id        TEXT    PRIMARY KEY,
        expanded_text     TEXT    NOT NULL,
        nested_image_keys TEXT    NOT NULL DEFAULT '[]',
        fetched_at        INTEGER NOT NULL
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_forward_cache_fetched ON forward_cache(fetched_at)`);

    // mod_rejections — moderator self-learning: when admin /reject's a
    // flagged message, record the (content, reason) pair as a false positive
    // example that the moderator prompt includes in future judgments so it
    // stops making the same wrong call.
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS mod_rejections (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id      TEXT    NOT NULL,
        content       TEXT    NOT NULL,
        reason        TEXT    NOT NULL,
        user_nickname TEXT,
        created_at    INTEGER NOT NULL
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_mod_rejections_group_ts ON mod_rejections(group_id, created_at DESC)`);

    // mod_rejections — new columns for richer self-learning context
    try { this._db.exec(`ALTER TABLE mod_rejections ADD COLUMN user_id TEXT`); } catch { /* already exists */ }
    try { this._db.exec(`ALTER TABLE mod_rejections ADD COLUMN severity INTEGER`); } catch { /* already exists */ }
    try { this._db.exec(`ALTER TABLE mod_rejections ADD COLUMN context_snippet TEXT`); } catch { /* already exists */ }

    // bandori_lives — daily-scraped BanG Dream! live event schedule.
    // CREATE TABLE IF NOT EXISTS handles both fresh installs and existing DBs idempotently.
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS bandori_lives (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key        TEXT    NOT NULL UNIQUE,
        title            TEXT    NOT NULL,
        start_date       TEXT,
        end_date         TEXT,
        venue            TEXT,
        city             TEXT,
        bands            TEXT    NOT NULL DEFAULT '[]',
        detail_url       TEXT,
        ticket_info_text TEXT,
        fetched_at       INTEGER NOT NULL,
        last_seen_at     INTEGER NOT NULL,
        raw_hash         TEXT    NOT NULL
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_bandori_lives_start_date ON bandori_lives(start_date)`);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_bandori_lives_last_seen  ON bandori_lives(last_seen_at)`);

    // INVARIANT: moderation_log rows must never be deleted. The daily punishment counter
    // (group_config.punishments_today) is a rate-limiter and may reset; moderation_log
    // rows are permanent audit/training records.
    //
    // Moderation review columns (§13) — idempotent; each ALTER is guarded individually.
    try { this._db.exec(`ALTER TABLE moderation_log ADD COLUMN reviewed    INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
    try { this._db.exec(`ALTER TABLE moderation_log ADD COLUMN reviewed_by TEXT`); } catch { /* already exists */ }
    try { this._db.exec(`ALTER TABLE moderation_log ADD COLUMN reviewed_at INTEGER`); } catch { /* already exists */ }
    // original_content: store the message text at assessment time so the review
    // panel doesn't need to do a flaky timestamp-based lookup.
    try { this._db.exec(`ALTER TABLE moderation_log ADD COLUMN original_content TEXT`); } catch { /* already exists */ }
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_mod_log_reviewed ON moderation_log(reviewed, group_id, timestamp DESC)`);

    // user_affinity — per-group per-user affinity (好感度) tracking.
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS user_affinity (
        group_id         TEXT    NOT NULL,
        user_id          TEXT    NOT NULL,
        score            INTEGER NOT NULL DEFAULT 30,
        last_interaction INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        PRIMARY KEY (group_id, user_id)
      )
    `);

    // jargon_candidates — existing DBs that already ran schema.sql get
    // the CREATE TABLE IF NOT EXISTS from there. This migration block
    // covers the edge case where schema.sql was cached before this table
    // was added. The CREATE TABLE + CREATE INDEX are idempotent.
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS jargon_candidates (
        group_id              TEXT    NOT NULL,
        content               TEXT    NOT NULL,
        count                 INTEGER NOT NULL DEFAULT 1,
        contexts              TEXT    NOT NULL DEFAULT '[]',
        last_inference_count  INTEGER NOT NULL DEFAULT 0,
        meaning               TEXT,
        is_jargon             INTEGER NOT NULL DEFAULT 0,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL,
        PRIMARY KEY (group_id, content)
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_jargon_group_count ON jargon_candidates(group_id, count DESC)`);

    // jargon_candidates.promoted — memes-v1 column for marking candidates promoted to meme_graph
    try { this._db.exec(`ALTER TABLE jargon_candidates ADD COLUMN promoted INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }

    // phrase_candidates — multi-word jargon candidates (2-5 grams) for memes-v1
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS phrase_candidates (
        group_id              TEXT    NOT NULL,
        content               TEXT    NOT NULL,
        gram_len              INTEGER NOT NULL,
        count                 INTEGER NOT NULL DEFAULT 1,
        contexts              TEXT    NOT NULL DEFAULT '[]',
        last_inference_count  INTEGER NOT NULL DEFAULT 0,
        meaning               TEXT,
        is_jargon             INTEGER NOT NULL DEFAULT 0,
        promoted              INTEGER NOT NULL DEFAULT 0,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL,
        PRIMARY KEY (group_id, content, gram_len)
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_phrase_group_count ON phrase_candidates(group_id, count DESC)`);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_phrase_unpromoted ON phrase_candidates(group_id, is_jargon, promoted) WHERE is_jargon = 1 AND promoted = 0`);

    // meme_graph — clustered meme entries after inference + variant aggregation (memes-v1)
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS meme_graph (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id           TEXT    NOT NULL,
        canonical          TEXT    NOT NULL,
        variants           TEXT    NOT NULL DEFAULT '[]',
        meaning            TEXT    NOT NULL,
        origin_event       TEXT,
        origin_msg_id      TEXT,
        origin_user_id     TEXT,
        origin_ts          INTEGER,
        first_seen_count   INTEGER NOT NULL DEFAULT 1,
        total_count        INTEGER NOT NULL DEFAULT 1,
        confidence         REAL    NOT NULL DEFAULT 0.5,
        status             TEXT    NOT NULL DEFAULT 'active',
        embedding_vec      BLOB,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        UNIQUE(group_id, canonical)
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_meme_group_active ON meme_graph(group_id, status) WHERE status IN ('active', 'manual_edit')`);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_meme_group_updated ON meme_graph(group_id, updated_at DESC)`);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_meme_null_embedding ON meme_graph(id) WHERE embedding_vec IS NULL`);

    // interaction_stats + social_relations — relationship tracker (H2).
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS interaction_stats (
        group_id       TEXT    NOT NULL,
        from_user      TEXT    NOT NULL,
        to_user        TEXT    NOT NULL,
        reply_count    INTEGER NOT NULL DEFAULT 0,
        mention_count  INTEGER NOT NULL DEFAULT 0,
        name_ref_count INTEGER NOT NULL DEFAULT 0,
        last_updated   INTEGER NOT NULL,
        PRIMARY KEY (group_id, from_user, to_user)
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_interaction_stats_group ON interaction_stats(group_id, last_updated DESC)`);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS social_relations (
        group_id      TEXT    NOT NULL,
        from_user     TEXT    NOT NULL,
        to_user       TEXT    NOT NULL,
        relation_type TEXT    NOT NULL,
        strength      REAL    NOT NULL DEFAULT 0.5,
        evidence      TEXT,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (group_id, from_user, to_user)
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_social_relations_group ON social_relations(group_id, strength DESC)`);

    // expression_patterns — bot reply style learning (H1 layer 1).
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS expression_patterns (
        group_id    TEXT    NOT NULL,
        situation   TEXT    NOT NULL,
        expression  TEXT    NOT NULL,
        weight      REAL    NOT NULL DEFAULT 1.0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (group_id, situation, expression)
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_expression_patterns_group_weight ON expression_patterns(group_id, weight DESC)`);

    // user_styles — per-user speaking style profiles (H1 layer 2).
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS user_styles (
        group_id    TEXT    NOT NULL,
        user_id     TEXT    NOT NULL,
        nickname    TEXT    NOT NULL,
        style_json  TEXT    NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (group_id, user_id)
      )
    `);

    // user_styles_aggregate — per-group rollup of user styles (M8.2).
    // schema.sql covers fresh installs; this branch covers existing DBs
    // (see feedback_sqlite_schema_migration: schema.sql is silently skipped
    // for DBs that already exist).
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS user_styles_aggregate (
        group_id       TEXT    PRIMARY KEY,
        aggregate_json TEXT    NOT NULL,
        user_count     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      )
    `);

    // Archive tables for old messages/bot_replies (P1-3: pruning strategy).
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS messages_archive (
        id INTEGER PRIMARY KEY, group_id TEXT NOT NULL, user_id TEXT NOT NULL,
        nickname TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, raw_content TEXT,
        timestamp INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, source_message_id TEXT
      )
    `);
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS bot_replies_archive (
        id INTEGER PRIMARY KEY, group_id TEXT NOT NULL, trigger_msg_id TEXT,
        trigger_user_nickname TEXT, trigger_content TEXT NOT NULL,
        bot_reply TEXT NOT NULL, module TEXT NOT NULL, sent_at INTEGER NOT NULL,
        rating INTEGER, rating_comment TEXT, rated_at INTEGER
      )
    `);

    // persona_patch_proposals (M6.6 + M8.1): self-reflection → admin-reviewable persona patch queue.
    // CREATE + indexes wrapped in IF NOT EXISTS so both fresh installs and existing DBs
    // converge on the same schema (per feedback_sqlite_schema_migration: schema.sql alone
    // is silently skipped for existing DBs, so this block is the source of truth for upgrades).
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS persona_patch_proposals (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id          TEXT    NOT NULL,
        old_persona_text  TEXT,
        new_persona_text  TEXT    NOT NULL,
        reasoning         TEXT    NOT NULL,
        diff_summary      TEXT    NOT NULL,
        status            TEXT    NOT NULL DEFAULT 'pending',
        kind              TEXT    NOT NULL DEFAULT 'daily',
        created_at        INTEGER NOT NULL,
        decided_at        INTEGER,
        decided_by        TEXT
      )
    `);
    // M8.1 — add kind column to existing DBs (CREATE TABLE above only fires on
    // fresh installs). Wrapped in try/catch for idempotency (duplicate column
    // on re-run). Default 'daily' satisfies back-compat for pre-M8.1 rows.
    try { this._db.exec(`ALTER TABLE persona_patch_proposals ADD COLUMN kind TEXT NOT NULL DEFAULT 'daily'`); } catch { /* already exists */ }
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_persona_patch_group_created
      ON persona_patch_proposals(group_id, created_at DESC)`);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_persona_patch_group_pending
      ON persona_patch_proposals(group_id, created_at DESC) WHERE status = 'pending'`);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_ppp_group_kind_created
      ON persona_patch_proposals(group_id, kind, created_at DESC)`);

    // mood_state (M9.2): per-group persisted mood (valence/arousal).
    // Mirrors schema.sql — required for existing DBs per feedback_sqlite_schema_migration
    // since schema.sql is silently skipped when the target DB already has tables.
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS mood_state (
        group_id    TEXT    PRIMARY KEY,
        valence     REAL    NOT NULL DEFAULT 0,
        arousal     REAL    NOT NULL DEFAULT 0,
        last_update INTEGER NOT NULL
      )
    `);

    // group_diary (W-B): daily/weekly/monthly rollup. Same dual-write rationale
    // as other newer tables — schema.sql covers fresh installs, this migration
    // covers existing DBs (see feedback_sqlite_schema_migration.md).
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS group_diary (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id      TEXT    NOT NULL,
        period_start  INTEGER NOT NULL,
        period_end    INTEGER NOT NULL,
        kind          TEXT    NOT NULL CHECK (kind IN ('daily','weekly','monthly')),
        summary       TEXT    NOT NULL,
        top_topics    TEXT    NOT NULL DEFAULT '[]',
        top_speakers  TEXT    NOT NULL DEFAULT '[]',
        mood          TEXT,
        created_at    INTEGER NOT NULL,
        UNIQUE(group_id, period_start, period_end, kind)
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_group_diary_lookup ON group_diary(group_id, kind, period_end DESC)`);

    // honest_gaps (W-A): per-group unfamiliar-term counter. Mirrored here for
    // existing DBs; schema.sql handles fresh installs. See
    // feedback_sqlite_schema_migration.
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS honest_gaps (
        group_id    TEXT    NOT NULL,
        term        TEXT    NOT NULL,
        seen_count  INTEGER NOT NULL DEFAULT 1,
        first_seen  INTEGER NOT NULL,
        last_seen   INTEGER NOT NULL,
        PRIMARY KEY (group_id, term)
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_honest_gaps_group_count ON honest_gaps(group_id, seen_count DESC)`);
    // Path B: stale-prune index on jargon_candidates(group_id, updated_at).
    // Prune query filters by updated_at — without this index it table-scans.
    // CREATE INDEX IF NOT EXISTS is idempotent on re-run.
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_jargon_updated ON jargon_candidates(group_id, updated_at)`);

    // Path C: web_lookup_cache table (additive, feedback_sqlite_schema_migration)
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS web_lookup_cache (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id    TEXT    NOT NULL,
        term        TEXT    NOT NULL,
        snippet     TEXT    NOT NULL,
        source_url  TEXT    NOT NULL,
        confidence  INTEGER NOT NULL,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL
      )
    `);
    this._db.exec(
      'CREATE INDEX IF NOT EXISTS idx_web_cache_term ON web_lookup_cache(group_id, term, expires_at DESC)'
    );
  }

  /**
   * Archive messages and bot_replies older than cutoffSec.
   * Moves rows into *_archive tables, then deletes from originals.
   */
  archiveOlderThan(cutoffSec: number): { messages: number; botReplies: number } {
    let msgCount = 0;
    let replyCount = 0;
    try {
      this._db.exec(`INSERT OR IGNORE INTO messages_archive SELECT * FROM messages WHERE timestamp < ${cutoffSec}`);
      const msgResult = this._db.prepare(`DELETE FROM messages WHERE timestamp < ?`).run(cutoffSec) as { changes: number };
      msgCount = msgResult.changes;
    } catch { /* non-fatal */ }
    try {
      this._db.exec(`INSERT OR IGNORE INTO bot_replies_archive SELECT * FROM bot_replies WHERE sent_at < ${cutoffSec}`);
      const replyResult = this._db.prepare(`DELETE FROM bot_replies WHERE sent_at < ?`).run(cutoffSec) as { changes: number };
      replyCount = replyResult.changes;
    } catch { /* non-fatal */ }
    return { messages: msgCount, botReplies: replyCount };
  }
}
