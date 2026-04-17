/**
 * at-mention-group-override.test.ts — UR-C #4.
 * Verifies per-group @-mention rate limit closes the multi-account loophole
 * on the per-user absolute @-override.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChatModule } from '../src/modules/chat.js';
import { Database } from '../src/storage/db.js';
import { initLogger } from '../src/utils/logger.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-999';

function makeClaude(): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text: 'ok', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
  };
}

interface ChatInternals {
  _recordAtMention(groupId: string, userId: string, nowMs: number): number;
  _recordGroupAtMention(groupId: string, nowMs: number): number;
  atMentionSpamThreshold: number;
  atMentionSpamWindowMs: number;
  atMentionGroupThreshold: number;
  atMentionGroupWindowMs: number;
}

describe('@-mention spam — per-group override (UR-C #4)', () => {
  let db: Database;
  let chat: ChatModule;
  let internals: ChatInternals;

  beforeEach(() => {
    db = new Database(':memory:');
    chat = new ChatModule(makeClaude(), db, { botUserId: BOT_ID });
    internals = chat as unknown as ChatInternals;
  });

  it('per-user recorder: threshold 4 in 10min window', () => {
    const now = 1_000_000;
    // 3 @s from user1 — below threshold
    for (let i = 0; i < 3; i++) {
      expect(internals._recordAtMention('g1', 'u1', now + i * 1000)).toBeLessThan(4);
    }
    // 4th crosses threshold
    expect(internals._recordAtMention('g1', 'u1', now + 4000)).toBe(4);
  });

  it('per-group recorder: counts across all users within 5min window', () => {
    const now = 1_000_000;
    // 5 @s from 5 different users in quick succession — each user at count 1
    for (let i = 0; i < 5; i++) {
      expect(internals._recordAtMention('g1', `u${i}`, now + i * 1000)).toBe(1);
    }
    // Per-group count accumulates across users
    for (let i = 0; i < 5; i++) {
      internals._recordGroupAtMention('g1', now + i * 1000);
    }
    // 6th @ from a new user pushes group-level count to 6 — triggers annoyance
    expect(internals._recordGroupAtMention('g1', now + 5000)).toBe(6);
  });

  it('per-group recorder: prunes entries older than window', () => {
    const now = 1_000_000;
    const windowMs = internals.atMentionGroupWindowMs;
    // Record 6 events at t=0
    for (let i = 0; i < 6; i++) internals._recordGroupAtMention('g1', now + i);
    expect(internals._recordGroupAtMention('g1', now + 10)).toBe(7);
    // Advance past the window — old entries drop
    const afterExpiry = now + windowMs + 1000;
    expect(internals._recordGroupAtMention('g1', afterExpiry)).toBe(1);
  });

  it('per-group recorder: independent per group', () => {
    const now = 1_000_000;
    for (let i = 0; i < 6; i++) internals._recordGroupAtMention('g1', now + i);
    expect(internals._recordGroupAtMention('g2', now + 100)).toBe(1);
  });

  it('regression: multi-account spam (5 users × 2 @s each = 10 @s, each under per-user threshold 4)', () => {
    // Each user alone would stay at count 2 (safe from per-user trigger).
    const now = 1_000_000;
    let groupCount = 0;
    for (let user = 0; user < 5; user++) {
      for (let i = 0; i < 2; i++) {
        const perUser = internals._recordAtMention('g1', `u${user}`, now + user * 2000 + i * 100);
        expect(perUser).toBeLessThan(internals.atMentionSpamThreshold);
        groupCount = internals._recordGroupAtMention('g1', now + user * 2000 + i * 100);
      }
    }
    // Group-level count must have crossed the threshold despite no per-user trigger.
    expect(groupCount).toBeGreaterThanOrEqual(internals.atMentionGroupThreshold);
  });

  it('config sanity: per-group threshold (6) > per-user threshold (4) so single users trip per-user first', () => {
    expect(internals.atMentionGroupThreshold).toBeGreaterThan(internals.atMentionSpamThreshold);
    expect(internals.atMentionGroupWindowMs).toBeLessThan(internals.atMentionSpamWindowMs);
  });
});
