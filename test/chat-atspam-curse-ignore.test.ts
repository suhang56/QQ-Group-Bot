/**
 * chat-atspam-curse-ignore.test.ts
 *
 * Covers the 5+ @-mention curse+ignore behavior: a single user hammering
 * the bot with @s across a stricter threshold (5 within 10 minutes) gets
 * one dismissive pushback phrase, then the bot silently ignores that user
 * for 10 minutes. Distinct from the existing 4-@ annoyance mode — annoyance
 * remains (softer directive variant); curse+ignore sits on top.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ChatModule,
  ATSPAM_CURSE_POOL,
} from '../src/modules/chat.js';
import { Database } from '../src/storage/db.js';
import { initLogger } from '../src/utils/logger.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import { isSendable } from '../src/utils/chat-result.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-555';

// Produce a unique reply text per Claude call so the chat module's
// near-dup / echo / skeleton-dup filters don't drop subsequent iterations.
// Returns the text via a counter embedded in the output.
function makeClaude(): IClaudeClient {
  let counter = 0;
  return {
    complete: vi.fn().mockImplementation(async () => ({
      text: `bot normal reply number ${counter++} about topic ${Math.random().toString(36).slice(2, 10)}`,
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse)),
  };
}

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  const userId = overrides.userId ?? 'u1';
  const base: GroupMessage = {
    messageId: `m-${Math.random().toString(36).slice(2, 8)}`,
    groupId: 'g1',
    userId,
    nickname: 'Spammer',
    role: 'member',
    content: 'hi',
    rawContent: `[CQ:at,qq=${BOT_ID}] hi`,
    timestamp: Math.floor(Date.now() / 1000),
  };
  return { ...base, ...overrides };
}

function makeAtMsg(userId = 'u1', content = 'hi', messageId = `m-${Math.random().toString(36).slice(2, 8)}`): GroupMessage {
  return makeMsg({
    userId, content, messageId,
    rawContent: `[CQ:at,qq=${BOT_ID}] ${content}`,
  });
}

function makePlainMsg(userId: string, content: string, messageId = `m-${Math.random().toString(36).slice(2, 8)}`): GroupMessage {
  return makeMsg({
    userId, content, messageId, rawContent: content,
  });
}

interface ChatInternals {
  atMentionCurseIgnoreThreshold: number;
  atMentionCurseIgnoreMs: number;
  atMentionIgnoreUntil: Map<string, number>;
  atMentionSpamThreshold: number;
}

function makeChat(claude: IClaudeClient, db: Database): ChatModule {
  return new ChatModule(claude, db, {
    botUserId: BOT_ID,
    debounceMs: 0,
    chatMinScore: -999, // bypass scoring gate so generateReply runs end-to-end
  });
}

describe('ChatModule — 5+ @-spam curse+ignore', () => {
  let db: Database;
  let claude: IClaudeClient;
  let chat: ChatModule;
  let internals: ChatInternals;

  beforeEach(() => {
    db = new Database(':memory:');
    claude = makeClaude();
    chat = makeChat(claude, db);
    internals = chat as unknown as ChatInternals;
  });

  it('config: curse-ignore threshold (5) is stricter than annoyance threshold (4)', () => {
    expect(internals.atMentionCurseIgnoreThreshold).toBe(5);
    expect(internals.atMentionSpamThreshold).toBe(4);
    expect(internals.atMentionCurseIgnoreThreshold).toBeGreaterThan(internals.atMentionSpamThreshold);
  });

  it('ATSPAM_CURSE_POOL contains the 9 spec phrases', () => {
    expect(ATSPAM_CURSE_POOL).toContain('烦不烦一直 @');
    expect(ATSPAM_CURSE_POOL).toContain('滚');
    expect(ATSPAM_CURSE_POOL).toContain('闭嘴');
    expect(ATSPAM_CURSE_POOL.length).toBeGreaterThanOrEqual(9);
  });

  it('4 @-mentions in window → does not fire curse+ignore (annoyance-only path preserved)', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await chat.generateReply('g1', makeAtMsg('u1', `msg${i}`, `m${i}`), []);
      // 4th triggers annoyance-mode directive, but not curse+ignore — so the
      // reply must NOT be a curse-pool phrase (it's a normal Claude reply).
      expect(r.kind).not.toBe('silent');
      expect(ATSPAM_CURSE_POOL).not.toContain('text' in r ? r.text : '');
    }
    expect(internals.atMentionIgnoreUntil.has('g1:u1')).toBe(false);
  });

  it('5th @ from same user → returns one phrase from ATSPAM_CURSE_POOL (no LLM call)', async () => {
    for (let i = 0; i < 4; i++) {
      await chat.generateReply('g1', makeAtMsg('u1', `msg${i}`, `m${i}`), []);
    }
    const callsBefore = (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    const r = await chat.generateReply('g1', makeAtMsg('u1', 'msg5', 'm5'), []);
    expect(r.kind).toBe('reply');
    expect(ATSPAM_CURSE_POOL).toContain((r as Extract<typeof r, { kind: 'reply' }>).text);
    const callsAfter = (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    // Fast path must not incur an LLM call
    expect(callsAfter).toBe(callsBefore);
    // Ignore window must be set
    expect(internals.atMentionIgnoreUntil.get('g1:u1')).toBeGreaterThan(Date.now());
  });

  it('6th @ from same user (after curse) → null silently (ignored)', async () => {
    for (let i = 0; i < 5; i++) {
      await chat.generateReply('g1', makeAtMsg('u1', `msg${i}`, `m${i}`), []);
    }
    const callsBefore = (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    const r = await chat.generateReply('g1', makeAtMsg('u1', 'msg6', 'm6'), []);
    expect(r.kind).toBe('silent');
    const callsAfter = (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfter).toBe(callsBefore); // no LLM call during ignore
  });

  it('6th @ from DIFFERENT user → replies normally (per-user scope)', async () => {
    // Spam 5 @s from u1 → curse, ignore u1
    for (let i = 0; i < 5; i++) {
      await chat.generateReply('g1', makeAtMsg('u1', `msg${i}`, `m-u1-${i}`), []);
    }
    expect(internals.atMentionIgnoreUntil.has('g1:u1')).toBe(true);
    // u2 sends its first @ in the same group → must go through normal path
    const r = await chat.generateReply('g1', makeAtMsg('u2', 'hi', 'm-u2-1'), []);
    expect(r.kind).not.toBe('silent');
    expect(ATSPAM_CURSE_POOL).not.toContain('text' in r ? r.text : '');
  });

  it('after ignore window expires → next @ goes through normal path', async () => {
    for (let i = 0; i < 5; i++) {
      await chat.generateReply('g1', makeAtMsg('u1', `msg${i}`, `m${i}`), []);
    }
    // Simulate the ignore window expiring by rewriting the stored expiry to the past
    internals.atMentionIgnoreUntil.set('g1:u1', Date.now() - 1);
    // Also prune the @-history so count starts fresh (simulating 10-min elapse)
    const historyKey = 'g1:u1';
    (chat as unknown as { atMentionHistory: Map<string, number[]> }).atMentionHistory.set(historyKey, []);
    const r = await chat.generateReply('g1', makeAtMsg('u1', 'back', 'm-back'), []);
    expect(r.kind).not.toBe('silent');
    expect(ATSPAM_CURSE_POOL).not.toContain('text' in r ? r.text : '');
    // Expired entry was lazy-cleaned
    expect(internals.atMentionIgnoreUntil.has('g1:u1')).toBe(false);
  });

  it('non-@ message from ignored user → null silently (ignore applies to ANY message)', async () => {
    for (let i = 0; i < 5; i++) {
      await chat.generateReply('g1', makeAtMsg('u1', `msg${i}`, `m${i}`), []);
    }
    expect(internals.atMentionIgnoreUntil.has('g1:u1')).toBe(true);
    const callsBefore = (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    const r = await chat.generateReply('g1', makePlainMsg('u1', 'hello everyone', 'm-plain'), []);
    expect(r.kind).toBe('silent');
    const callsAfter = (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfter).toBe(callsBefore);
  });

  it('non-@ message from OTHER user during ignore → replies normally (per-user scope)', async () => {
    for (let i = 0; i < 5; i++) {
      await chat.generateReply('g1', makeAtMsg('u1', `msg${i}`, `m${i}`), []);
    }
    const r = await chat.generateReply('g1', makePlainMsg('u2', 'hi everyone', 'm-u2-plain'), []);
    expect(r.kind).not.toBe('silent');
    expect(ATSPAM_CURSE_POOL).not.toContain('text' in r ? r.text : '');
  });

  it('curse phrase is deterministic — never LLM output text (curse uses fast-path, skips Claude)', async () => {
    // Build a Claude mock that returns a tell-tale marker; if the curse path
    // actually called Claude, the marker would appear in the reply.
    const marker = 'SHOULD_NOT_APPEAR_FROM_LLM_XYZ';
    const pickedClaude: IClaudeClient = {
      complete: vi.fn().mockResolvedValue({
        text: marker,
        inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
      } satisfies ClaudeResponse),
    };
    const pickedChat = new ChatModule(pickedClaude, new Database(':memory:'), {
      botUserId: BOT_ID, debounceMs: 0, chatMinScore: -999,
    });
    for (let i = 0; i < 4; i++) {
      // Don't assert mid-loop — near-dup detector may drop some iterations,
      // but the count is kept by _recordAtMention regardless of downstream drops.
      await pickedChat.generateReply('g1', makeAtMsg('u1', `msg${i}`, `m${i}`), []);
    }
    const r = await pickedChat.generateReply('g1', makeAtMsg('u1', 'msg5', 'm5'), []);
    expect(r.kind).toBe('reply');
    const rText = (r as Extract<typeof r, { kind: 'reply' }>).text;
    expect(rText).not.toBe(marker);
    expect(ATSPAM_CURSE_POOL).toContain(rText);
  });

  it('per-user scope: user A at curse+ignore does not affect user B in same group', async () => {
    // A gets curse+ignored after 5 @s
    for (let i = 0; i < 5; i++) {
      await chat.generateReply('g1', makeAtMsg('uA', `spam${i}`, `m-a-${i}`), []);
    }
    expect(internals.atMentionIgnoreUntil.has('g1:uA')).toBe(true);

    // B sends their FIRST @ in the same group. Must:
    //  - not be silenced (not in ignore map)
    //  - not get annoyance-mode (per-user count is 1, not >=4)
    //  - not get a curse phrase (per-user count is 1, not ===5)
    //  → must hit the full normal LLM path (claude.complete called)
    const callsBefore = (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    const r = await chat.generateReply('g1', makeAtMsg('uB', 'hey bot', 'm-b-1'), []);
    const callsAfter = (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(r.kind).not.toBe('silent');
    expect(ATSPAM_CURSE_POOL).not.toContain('text' in r ? r.text : '');
    expect(callsAfter).toBeGreaterThan(callsBefore);
    expect(internals.atMentionIgnoreUntil.has('g1:uB')).toBe(false);
  });

  it('per-user annoyance: user A at 4 @s does not flip annoyance for user B in same group', async () => {
    for (let i = 0; i < 4; i++) {
      await chat.generateReply('g1', makeAtMsg('uA', `hi${i}`, `m-a-${i}`), []);
    }
    const perUserA = (chat as unknown as { atMentionHistory: Map<string, number[]> })
      .atMentionHistory.get('g1:uA') ?? [];
    expect(perUserA.length).toBeGreaterThanOrEqual(4);

    // user B's per-user count is 0 → normal @-path, full LLM reply
    const callsBefore = (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    const r = await chat.generateReply('g1', makeAtMsg('uB', 'hello there', 'm-b-1'), []);
    const callsAfter = (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(r.kind).not.toBe('silent');
    expect(callsAfter).toBeGreaterThan(callsBefore);
    expect(ATSPAM_CURSE_POOL).not.toContain('text' in r ? r.text : '');
  });

  it('ignore scope: groups are independent (g2 unaffected by g1 ignore)', async () => {
    for (let i = 0; i < 5; i++) {
      await chat.generateReply('g1', makeAtMsg('u1', `msg${i}`, `m${i}`), []);
    }
    expect(internals.atMentionIgnoreUntil.has('g1:u1')).toBe(true);
    // Same user, different group — untouched
    expect(internals.atMentionIgnoreUntil.has('g2:u1')).toBe(false);
    const r = await chat.generateReply('g2', makeAtMsg('u1', 'hi', 'm-g2'), []);
    expect(r.kind).not.toBe('silent');
    expect(ATSPAM_CURSE_POOL).not.toContain('text' in r ? r.text : '');
  });
});
