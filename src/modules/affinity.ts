import type { DatabaseSync } from 'node:sqlite';
import { createLogger } from '../utils/logger.js';

export type InteractionType =
  | 'chat'
  | 'at_friendly'
  | 'reply_continue'
  | 'correction'
  | 'praise'
  | 'mock'
  | 'joke_share'
  | 'question_ask'
  | 'thanks'
  | 'farewell';

const INTERACTION_DELTAS: Record<InteractionType, number> = {
  chat: 1,
  at_friendly: 2,
  reply_continue: 1,
  correction: 3,
  praise: 2,
  mock: -2,
  joke_share: 1,
  question_ask: 1,
  thanks: 2,
  farewell: 1,
};

const DEFAULT_SCORE = 30;
const MIN_SCORE = 0;
const MAX_SCORE = 100;

/** 7 days in milliseconds. */
const DECAY_INACTIVE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
/** 30 days in milliseconds. */
const CLEANUP_INACTIVE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;
const DECAY_AMOUNT = 5;

/** M9.3: recency decay half-life (days) for weighted cross-group aggregation. */
const CROSS_GROUP_RECENCY_HALFLIFE_DAYS = 14;
/** M9.3: weight-sum threshold below which we fall back to max(score). */
const CROSS_GROUP_MIN_WEIGHT = 0.5;
/** M9.3: hint emits only when aggregated score beats this. */
const CROSS_GROUP_HINT_SCORE_FLOOR = 70;
/** M9.3: hint requires at least this many distinct source groups. */
const CROSS_GROUP_HINT_MIN_GROUPS = 2;
/** M9.3: hint is suppressed when user is already well-known locally. */
const CROSS_GROUP_LOCAL_KNOWN_CEILING = 70;
/** M9.3: audit rows older than this are purged in dailyDecay. */
const CROSS_GROUP_AUDIT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Anti-farm: 5-minute cooldown for repeatable social types. */
const COOLDOWN_MS = 5 * 60 * 1000;
const COOLDOWN_TYPES: ReadonlySet<InteractionType> = new Set<InteractionType>([
  'praise',
  'thanks',
  'mock',
  'farewell',
]);
/** Daily positive-gain cap per (group,user). mock is negative — never gated. */
const DAILY_POSITIVE_CAP = 10;
const DAY_MS = 86_400_000;

export interface InteractionContext {
  isMention: boolean;
  isReplyToBot: boolean;
  isAdversarial: boolean;
  comprehensionScore: number;
}

// Regex overlays — short, case-insensitive, mixed Chinese + English.
// Priority order (first match wins): mock > praise > thanks > farewell > joke_share > question_ask.
const RE_PRAISE = /好棒|真棒|牛[批逼b]|绝了|强[啊爆]|awsl|yyds|太强|给力|优秀|厉害/i;
const RE_MOCK_KW = /傻逼|蠢|sb|弱智|废物|滚/i;
const RE_THANKS = /谢谢|多谢|感谢|thanks|thx|感恩/i;
const RE_FAREWELL = /再见|拜拜|晚安|下线|睡了|goodnight|bye/i;
const RE_QUESTION = /\?|？|怎么办|如何|啥意思|是什么/;
const RE_JOKE = /哈哈|笑死|草|绷不住|乐|wwww/i;

/**
 * Classify a user message into one of the 10 InteractionType values.
 *
 * Overlay regex first (specific signal beats context); otherwise fall back to
 * the conversation context. mock wins over everything so "你是傻逼" still
 * scores as mock even in an adversarial correction flow.
 *
 * Content may be empty/null (e.g. sticker-only or image-only messages) — in
 * that case overlays never match and we go straight to context.
 */
export function detectInteractionType(
  content: string | null | undefined,
  ctx: InteractionContext,
): InteractionType {
  const text = content ?? '';

  // Overlay priority: mock before others. The RE_MOCK_KW check covers both
  // the "insult keyword" and the "adversarial + insult keyword" clauses of
  // the spec — either way the message is classified as mock.
  if (RE_MOCK_KW.test(text)) return 'mock';

  if (RE_PRAISE.test(text)) return 'praise';
  if (RE_THANKS.test(text)) return 'thanks';
  if (RE_FAREWELL.test(text)) return 'farewell';
  if (RE_JOKE.test(text)) return 'joke_share';
  if (RE_QUESTION.test(text)) return 'question_ask';

  // Context fallback.
  if (ctx.isReplyToBot) return 'reply_continue';
  if (ctx.isMention && !ctx.isAdversarial && ctx.comprehensionScore >= 0.5) {
    return 'at_friendly';
  }
  if (ctx.isAdversarial && ctx.comprehensionScore < 0.5) return 'correction';
  return 'chat';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

interface AffinityAggregateRow {
  groupId: string;
  score: number;
  lastInteraction: number;
  interactionCount: number;
}

export interface CrossGroupScoreResult {
  score: number;
  groupCount: number;
  sourceGroups: string[];
}

/**
 * Pure weighted aggregation for M9.3 cross-group recognition.
 * weight_g = log(1 + interaction_count_g) * exp(-days_since_g / 14).
 * If total weight < 0.5, fall back to max(score_g) — cold users with a
 * handful of interactions shouldn't collapse to 0 via weighted mean.
 *
 * Exported for unit testing of the math without any DB wiring.
 */
export function _computeAggregated(
  rows: ReadonlyArray<AffinityAggregateRow>,
  now: number,
): number {
  if (rows.length === 0) return 0;
  let weightSum = 0;
  let weightedScoreSum = 0;
  let maxScore = 0;
  for (const r of rows) {
    if (r.score > maxScore) maxScore = r.score;
    const daysSince = Math.max(0, (now - r.lastInteraction) / (24 * 60 * 60 * 1000));
    const recencyFactor = Math.exp(-daysSince / CROSS_GROUP_RECENCY_HALFLIFE_DAYS);
    const countFactor = Math.log(1 + Math.max(0, r.interactionCount));
    const w = countFactor * recencyFactor;
    if (w > 0) {
      weightSum += w;
      weightedScoreSum += r.score * w;
    }
  }
  if (weightSum < CROSS_GROUP_MIN_WEIGHT) return maxScore;
  return weightedScoreSum / weightSum;
}

export class AffinityModule {
  private readonly logger = createLogger('affinity');
  private readonly db: DatabaseSync;
  /** key = `${gid}:${uid}:${type}`; value = last-applied timestamp (ms). */
  private readonly cooldowns = new Map<string, number>();
  /** key = `${gid}:${uid}`; tracks net positive gain per UTC-ish day. */
  private readonly dailyGain = new Map<string, { day: number; net: number }>();

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  getScore(groupId: string, userId: string): number {
    const row = this.db.prepare(
      'SELECT score FROM user_affinity WHERE group_id = ? AND user_id = ?',
    ).get(groupId, userId) as { score: number } | undefined;
    return row?.score ?? DEFAULT_SCORE;
  }

  recordInteraction(groupId: string, userId: string, type: InteractionType): void {
    const baseDelta = INTERACTION_DELTAS[type];
    const now = Date.now();

    // ── Anti-farm gates (compute effective delta) ─────────────────────────
    let delta = baseDelta;

    // 1) 5-minute cooldown on repeatable social types.
    if (COOLDOWN_TYPES.has(type)) {
      const cdKey = `${groupId}:${userId}:${type}`;
      const last = this.cooldowns.get(cdKey);
      if (last !== undefined && now - last < COOLDOWN_MS) {
        delta = 0;
      } else {
        this.cooldowns.set(cdKey, now);
      }
    }

    // 2) Daily positive-gain cap. mock is negative — always applies (never
    // consumes or gates on the cap). Only gates strictly-positive deltas.
    const dgKey = `${groupId}:${userId}`;
    const today = Math.floor(now / DAY_MS);
    const tracker = this.dailyGain.get(dgKey);
    const active = tracker && tracker.day === today ? tracker : { day: today, net: 0 };
    if (delta > 0) {
      if (active.net >= DAILY_POSITIVE_CAP) {
        delta = 0;
      } else if (active.net + delta > DAILY_POSITIVE_CAP) {
        delta = DAILY_POSITIVE_CAP - active.net;
      }
      if (delta > 0) {
        this.dailyGain.set(dgKey, { day: today, net: active.net + delta });
      } else {
        this.dailyGain.set(dgKey, active);
      }
    } else if (delta < 0) {
      this.dailyGain.set(dgKey, active);
    }

    // ── Persist row (always touch last_interaction, even on delta=0) ──────
    const existing = this.db.prepare(
      'SELECT score FROM user_affinity WHERE group_id = ? AND user_id = ?',
    ).get(groupId, userId) as { score: number } | undefined;

    if (existing) {
      const newScore = clamp(existing.score + delta, MIN_SCORE, MAX_SCORE);
      this.db.prepare(
        'UPDATE user_affinity SET score = ?, last_interaction = ?, updated_at = ? WHERE group_id = ? AND user_id = ?',
      ).run(newScore, now, now, groupId, userId);
    } else {
      const initialScore = clamp(DEFAULT_SCORE + delta, MIN_SCORE, MAX_SCORE);
      this.db.prepare(
        'INSERT INTO user_affinity (group_id, user_id, score, last_interaction, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run(groupId, userId, initialScore, now, now);
    }

    this.logger.debug({ groupId, userId, type, delta, baseDelta }, 'affinity interaction recorded');
  }

  dailyDecay(): void {
    const now = Date.now();
    const decayThreshold = now - DECAY_INACTIVE_THRESHOLD_MS;
    const cleanupThreshold = now - CLEANUP_INACTIVE_THRESHOLD_MS;

    // Delete truly inactive rows first (score <= 0 AND inactive > 30 days)
    const deleted = this.db.prepare(
      'DELETE FROM user_affinity WHERE score <= 0 AND last_interaction < ?',
    ).run(cleanupThreshold);

    // Decay scores for users inactive > 7 days, floor at 0
    this.db.prepare(`
      UPDATE user_affinity
      SET score = MAX(0, score - ?), updated_at = ?
      WHERE last_interaction < ?
    `).run(DECAY_AMOUNT, now, decayThreshold);

    // M9.3: purge audit rows older than 90d. Wrapped in try/catch because
    // cross_group_audit may not exist in extremely old test DBs that set up
    // only user_affinity directly.
    try {
      const auditCutoff = now - CROSS_GROUP_AUDIT_TTL_MS;
      this.db.prepare('DELETE FROM cross_group_audit WHERE ts < ?').run(auditCutoff);
    } catch { /* table not present — OK in isolated unit tests */ }

    this.logger.info({ deletedCount: (deleted as { changes: number }).changes }, 'daily affinity decay applied');
  }

  /**
   * M9.3 cross-group score lookup. Privacy-first:
   *   1. If requester's GroupConfig.linkAcrossGroups is false → return null
   *      WITHOUT querying any user_affinity data. This gives audit-log proof
   *      that the flag really gates access.
   *   2. Read user_affinity rows across ALL groups for this user.
   *   3. Drop the requester's own group (we're asking "other groups").
   *   4. Drop any source group that has NOT bilaterally opted in.
   *   5. Aggregate via log-count × exp-recency weighted mean (_computeAggregated).
   *
   * Returns null when no qualifying source groups remain, or when the flag is
   * off. Does NOT log an audit row on its own — callers that pass the score
   * through to visible output (formatCrossGroupHint) trigger the audit write.
   */
  getCrossGroupScore(requesterGroupId: string, userId: string): CrossGroupScoreResult | null {
    // Hard-stop: flag off → zero DB reads. Ordering matters for audit proof.
    const requesterFlag = this._getLinkAcrossGroupsFlag(requesterGroupId);
    if (!requesterFlag) return null;

    const affinityRows = this.db.prepare(
      'SELECT group_id, score, last_interaction FROM user_affinity WHERE user_id = ?',
    ).all(userId) as Array<{ group_id: string; score: number; last_interaction: number }>;

    if (affinityRows.length === 0) return null;

    const aggregateRows: AffinityAggregateRow[] = [];
    for (const row of affinityRows) {
      if (row.group_id === requesterGroupId) continue;
      if (!this._getLinkAcrossGroupsFlag(row.group_id)) continue;
      const interactionCount = this._sumInteractionCountsForUserInGroup(row.group_id, userId);
      aggregateRows.push({
        groupId: row.group_id,
        score: row.score,
        lastInteraction: row.last_interaction,
        interactionCount,
      });
    }

    if (aggregateRows.length === 0) return null;

    const score = _computeAggregated(aggregateRows, Date.now());
    const sourceGroups = aggregateRows.map(r => r.groupId);
    return { score, groupCount: sourceGroups.length, sourceGroups };
  }

  /**
   * M9.3 cross-group hint. Only emits when ALL these are true:
   *   - requester group has linkAcrossGroups=true
   *   - aggregated cross-group score > 70
   *   - at least 2 source groups contribute
   *   - user's CURRENT-group score is NOT already "well known" (≤70) —
   *     suppresses noise when the user is already familiar locally.
   *
   * On successful emit, writes one row to cross_group_audit. The returned
   * string is concatenation-safe for system-prompt injection (we do not
   * interpolate source group names or numeric scores into the visible text).
   */
  formatCrossGroupHint(
    requesterGroupId: string,
    userId: string,
    nickname: string,
    currentGroupScore: number,
  ): string | null {
    if (currentGroupScore > CROSS_GROUP_LOCAL_KNOWN_CEILING) return null;
    const result = this.getCrossGroupScore(requesterGroupId, userId);
    if (!result) return null;
    if (result.score <= CROSS_GROUP_HINT_SCORE_FLOOR) return null;
    if (result.groupCount < CROSS_GROUP_HINT_MIN_GROUPS) return null;

    this._auditCrossGroupRead(requesterGroupId, userId, result.sourceGroups, result.score, Date.now());

    // Vague phrasing — never leak the other group names or the raw score.
    return `（${nickname} 和你在其它 ${result.groupCount} 个群也有互动）`;
  }

  /**
   * M9.3 admin tool: delete the given userId's affinity rows from every group
   * OTHER than currentGroupId. Use via /forget_me_cross_group. Returns the
   * number of rows removed so the admin sees a concrete confirmation count.
   */
  forgetUserCrossGroup(currentGroupId: string, userId: string): number {
    const result = this.db.prepare(
      'DELETE FROM user_affinity WHERE user_id = ? AND group_id != ?',
    ).run(userId, currentGroupId) as { changes: number };
    return result.changes ?? 0;
  }

  /**
   * M9.3 admin tool: fetch recent cross-group audit rows (last 30d by default)
   * for review. Optionally filter by target userId. Caller — /cross_group_audit
   * admin DM command — is expected to already be admin + rate-limit gated.
   */
  listCrossGroupAudit(opts: { sinceMs: number; targetUid?: string; limit: number }): Array<{
    id: number;
    requesterGid: string;
    targetUid: string;
    sourceGids: string[];
    aggregated: number;
    ts: number;
  }> {
    const { sinceMs, targetUid, limit } = opts;
    try {
      const rows = targetUid !== undefined
        ? this.db.prepare(
            'SELECT id, requester_gid, target_uid, source_gids, aggregated, ts FROM cross_group_audit WHERE ts >= ? AND target_uid = ? ORDER BY ts DESC LIMIT ?',
          ).all(sinceMs, targetUid, limit) as Array<{
            id: number; requester_gid: string; target_uid: string;
            source_gids: string; aggregated: number; ts: number;
          }>
        : this.db.prepare(
            'SELECT id, requester_gid, target_uid, source_gids, aggregated, ts FROM cross_group_audit WHERE ts >= ? ORDER BY ts DESC LIMIT ?',
          ).all(sinceMs, limit) as Array<{
            id: number; requester_gid: string; target_uid: string;
            source_gids: string; aggregated: number; ts: number;
          }>;
      return rows.map(r => ({
        id: r.id,
        requesterGid: r.requester_gid,
        targetUid: r.target_uid,
        sourceGids: (() => { try { return JSON.parse(r.source_gids) as string[]; } catch { return []; } })(),
        aggregated: r.aggregated,
        ts: r.ts,
      }));
    } catch {
      return [];
    }
  }

  // ---- M9.3 private helpers ----

  private _getLinkAcrossGroupsFlag(groupId: string): boolean {
    try {
      const row = this.db.prepare(
        'SELECT link_across_groups FROM group_config WHERE group_id = ?',
      ).get(groupId) as { link_across_groups: number } | undefined;
      return (row?.link_across_groups ?? 0) !== 0;
    } catch {
      // Column or table missing in isolated unit tests → safest answer is false.
      return false;
    }
  }

  private _sumInteractionCountsForUserInGroup(groupId: string, userId: string): number {
    // Sum as-sender + as-target across reply/mention/name-ref counts.
    // Missing interaction_stats table → treat as zero activity so callers
    // degrade to the score-only signal rather than crashing.
    try {
      const row = this.db.prepare(`
        SELECT COALESCE(SUM(reply_count + mention_count + name_ref_count), 0) AS total
        FROM interaction_stats
        WHERE group_id = ? AND (from_user = ? OR to_user = ?)
      `).get(groupId, userId, userId) as { total: number } | undefined;
      return row?.total ?? 0;
    } catch {
      return 0;
    }
  }

  private _auditCrossGroupRead(
    requesterGid: string,
    targetUid: string,
    sourceGids: string[],
    aggregated: number,
    now: number,
  ): void {
    try {
      this.db.prepare(
        'INSERT INTO cross_group_audit (requester_gid, target_uid, source_gids, aggregated, ts) VALUES (?, ?, ?, ?, ?)',
      ).run(requesterGid, targetUid, JSON.stringify(sourceGids), aggregated, now);
    } catch (err) {
      // Non-fatal — audit failure should not break chat reply, but log it.
      this.logger.warn({ err, requesterGid, targetUid }, 'cross_group_audit insert failed');
    }
  }

  getAffinityFactor(groupId: string, userId: string): number {
    const score = this.getScore(groupId, userId);
    if (score > 70) return 0.15;
    if (score < 30) return -0.10;
    return 0;
  }

  formatAffinityHint(groupId: string, userId: string, nickname: string): string | null {
    const score = this.getScore(groupId, userId);
    if (score > 70) return `（${nickname} 是你比较熟的群友）`;
    if (score < 30) return `（${nickname} 你不太熟）`;
    return null;
  }

  listTopN(groupId: string, n: number): Array<{ userId: string; score: number }> {
    if (n <= 0) return [];
    const rows = this.db.prepare(
      'SELECT user_id, score FROM user_affinity WHERE group_id = ? ORDER BY score DESC LIMIT ?',
    ).all(groupId, n) as Array<{ user_id: string; score: number }>;
    return rows.map(r => ({ userId: r.user_id, score: r.score }));
  }
}
