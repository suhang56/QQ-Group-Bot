import type { DatabaseSync } from 'node:sqlite';
import { createLogger } from '../utils/logger.js';

export type InteractionType = 'chat' | 'at_friendly' | 'reply_continue' | 'correction';

const INTERACTION_DELTAS: Record<InteractionType, number> = {
  chat: 1,
  at_friendly: 2,
  reply_continue: 1,
  correction: 3,
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
    const delta = INTERACTION_DELTAS[type];
    const now = Date.now();

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

    this.logger.debug({ groupId, userId, type, delta }, 'affinity interaction recorded');
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
