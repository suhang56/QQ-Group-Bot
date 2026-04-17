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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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

    this.logger.info({ deletedCount: (deleted as { changes: number }).changes }, 'daily affinity decay applied');
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
}
