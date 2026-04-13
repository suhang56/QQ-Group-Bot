import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatModule } from '../src/modules/chat.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import { Database } from '../src/storage/db.js';
import { ClaudeApiError } from '../src/utils/errors.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-123';

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm1', groupId: 'g1', userId: 'u1',
    nickname: 'Alice', role: 'member',
    content: 'hello', rawContent: 'hello',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeMockClaude(text = 'bot reply'): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text,
      inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
  };
}

// Insert N messages into db spaced by deltaSeconds between each
function insertMessages(db: Database, groupId: string, count: number, baseTimestamp: number, deltaSeconds: number) {
  for (let i = 0; i < count; i++) {
    db.messages.insert({
      groupId, userId: `u${i}`, nickname: `User${i}`,
      content: `msg ${i}`, timestamp: baseTimestamp + i * deltaSeconds, deleted: false,
    });
  }
}

describe('ChatModule', () => {
  let db: Database;
  let claude: IClaudeClient;
  let chat: ChatModule;

  beforeEach(() => {
    db = new Database(':memory:');
    claude = makeMockClaude();
    // Default lurker config: 15% chance, 90s cooldown, burst=5 msgs in 10s
    // Use lurkerReplyChance=1.0 by default so tests that don't test probability always reply
    chat = new ChatModule(claude, db, {
      botUserId: BOT_ID,
      lurkerReplyChance: 1.0,  // always pass probability unless overridden
      lurkerCooldownMs: 0,     // no cooldown unless overridden
      burstMinMessages: 5,
      burstWindowMs: 10_000,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Existing behavior ────────────────────────────────────────────────

  it('generateReply returns text from Claude', async () => {
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(result).toBe('bot reply');
  });

  it('uses recent messages as few-shot context', async () => {
    const ts = Math.floor(Date.now() / 1000);
    db.messages.insert({ groupId: 'g1', userId: 'u2', nickname: 'Bob', content: 'sup', timestamp: ts - 10, deleted: false });
    db.messages.insert({ groupId: 'g1', userId: 'u3', nickname: 'Carol', content: 'yo', timestamp: ts - 5, deleted: false });

    const recentMsgs = db.messages.getRecent('g1', 20);
    await chat.generateReply('g1', makeMsg(), recentMsgs);

    const call = (claude.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { messages: Array<{ content: string }> };
    const allContent = call.messages.map(m => m.content).join(' ');
    expect(allContent).toContain('sup');
    expect(allContent).toContain('yo');
  });

  it('returns null on ClaudeApiError (fail-safe)', async () => {
    (claude.complete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ClaudeApiError(new Error('timeout')));
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(result).toBeNull();
  });

  it('returns null when group rate limit is exceeded', async () => {
    chat = new ChatModule(claude, db, { maxGroupRepliesPerMinute: 0, botUserId: BOT_ID, lurkerReplyChance: 1.0, lurkerCooldownMs: 0 });
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(result).toBeNull();
  });

  it('debounces consecutive messages (same group, within window)', async () => {
    vi.useFakeTimers();
    chat = new ChatModule(claude, db, { debounceMs: 2000, botUserId: BOT_ID, lurkerReplyChance: 1.0, lurkerCooldownMs: 0 });

    const p1 = chat.generateReply('g1', makeMsg({ content: 'msg1' }), []);
    const p2 = chat.generateReply('g1', makeMsg({ content: 'msg2' }), []);

    vi.advanceTimersByTime(2100);
    const [r1, r2] = await Promise.all([p1, p2]);

    const callCount = (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callCount).toBeLessThanOrEqual(1);
    expect([r1, r2].filter(r => r === null).length).toBeGreaterThanOrEqual(1);

    vi.useRealTimers();
  });

  it('does not reply when trigger message is from bot itself ([模仿] prefix)', async () => {
    const result = await chat.generateReply('g1', makeMsg({ content: '[模仿 @Bob] some text' }), []);
    expect(result).toBeNull();
  });

  it('handles empty recent messages gracefully', async () => {
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(result).not.toBeNull();
    expect(typeof result).toBe('string');
  });

  it('handles message with only CQ codes (empty content after strip)', async () => {
    const result = await chat.generateReply('g1', makeMsg({ content: '' }), []);
    expect(result).toBeNull();
  });

  // ── @-mention always replies ─────────────────────────────────────────

  it('@-mention always replies regardless of probability', async () => {
    chat = new ChatModule(claude, db, {
      botUserId: BOT_ID,
      lurkerReplyChance: 0,    // probability would block
      lurkerCooldownMs: 999_999, // cooldown would block
    });
    const msg = makeMsg({ rawContent: `[CQ:at,qq=${BOT_ID}] hello bot` });
    const result = await chat.generateReply('g1', msg, []);
    expect(result).toBe('bot reply');
  });

  it('@-mention always replies regardless of burst', async () => {
    // Fill burst window: 5 messages in 8 seconds
    const now = Math.floor(Date.now() / 1000);
    insertMessages(db, 'g1', 5, now - 8, 2);

    chat = new ChatModule(claude, db, {
      botUserId: BOT_ID,
      lurkerReplyChance: 0,
      lurkerCooldownMs: 999_999,
      burstMinMessages: 5,
      burstWindowMs: 10_000,
    });
    const msg = makeMsg({ rawContent: `[CQ:at,qq=${BOT_ID}] are you there?` });
    const result = await chat.generateReply('g1', msg, []);
    expect(result).toBe('bot reply');
  });

  // ── Reply-to-bot always triggers ────────────────────────────────────

  it('reply-to-bot-msg always replies regardless of probability/cooldown', async () => {
    chat = new ChatModule(claude, db, {
      botUserId: BOT_ID,
      lurkerReplyChance: 0,
      lurkerCooldownMs: 999_999,
    });
    const msg = makeMsg({ rawContent: '[CQ:reply,id=999]thanks for that' });
    const result = await chat.generateReply('g1', msg, []);
    expect(result).toBe('bot reply');
  });

  // ── Probabilistic gate ───────────────────────────────────────────────

  it('probabilistic: Math.random=0.10 with chance=0.15 → replies', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.10);
    chat = new ChatModule(claude, db, {
      botUserId: BOT_ID,
      lurkerReplyChance: 0.15,
      lurkerCooldownMs: 0,
    });
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(result).toBe('bot reply');
  });

  it('probabilistic: Math.random=0.20 with chance=0.15 → skips', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.20);
    chat = new ChatModule(claude, db, {
      botUserId: BOT_ID,
      lurkerReplyChance: 0.15,
      lurkerCooldownMs: 0,
    });
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(result).toBeNull();
  });

  // ── Cooldown ─────────────────────────────────────────────────────────

  it('cooldown: second qualifying message within 90s is skipped', async () => {
    chat = new ChatModule(claude, db, {
      botUserId: BOT_ID,
      lurkerReplyChance: 1.0,
      lurkerCooldownMs: 90_000,
    });
    // First message — should reply (no cooldown yet)
    const r1 = await chat.generateReply('g1', makeMsg({ content: 'msg 1' }), []);
    expect(r1).toBe('bot reply');

    // Second message immediately after — cooldown blocks it
    const r2 = await chat.generateReply('g1', makeMsg({ content: 'msg 2' }), []);
    expect(r2).toBeNull();
  });

  // ── Burst detection ──────────────────────────────────────────────────

  it('burst: 5 messages in 8 seconds → skips (non-mention)', async () => {
    const now = Math.floor(Date.now() / 1000);
    // 5 messages spread over 8 seconds (0,2,4,6,8 seconds apart)
    insertMessages(db, 'g1', 5, now - 8, 2);

    chat = new ChatModule(claude, db, {
      botUserId: BOT_ID,
      lurkerReplyChance: 1.0,
      lurkerCooldownMs: 0,
      burstMinMessages: 5,
      burstWindowMs: 10_000,
    });
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(result).toBeNull();
  });

  it('burst cools: 6th message 15s after oldest → eligible', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Insert 4 old messages (outside burst window) + 1 recent
    insertMessages(db, 'g1', 4, now - 30, 1);  // ts: now-30, now-29, now-28, now-27
    db.messages.insert({ groupId: 'g1', userId: 'u99', nickname: 'X', content: 'recent', timestamp: now - 15, deleted: false });
    // newest=now-15, oldest of last 5 = now-30 → span = 15s ≥ 10s → NOT burst

    chat = new ChatModule(claude, db, {
      botUserId: BOT_ID,
      lurkerReplyChance: 1.0,
      lurkerCooldownMs: 0,
      burstMinMessages: 5,
      burstWindowMs: 10_000,
    });
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(result).toBe('bot reply');
  });

  it('empty group history → no burst false positive', async () => {
    // No messages in DB — getRecent returns [] → fewer than burstMinMessages → not burst
    chat = new ChatModule(claude, db, {
      botUserId: BOT_ID,
      lurkerReplyChance: 1.0,
      lurkerCooldownMs: 0,
      burstMinMessages: 5,
      burstWindowMs: 10_000,
    });
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(result).toBe('bot reply');
  });

  // ── Debounce still works within lurker flow ───────────────────────────

  it('debounce still fires within lurker flow', async () => {
    vi.useFakeTimers();
    chat = new ChatModule(claude, db, {
      debounceMs: 2000,
      botUserId: BOT_ID,
      lurkerReplyChance: 1.0,
      lurkerCooldownMs: 0,
    });

    const p1 = chat.generateReply('g1', makeMsg({ content: 'first' }), []);
    const p2 = chat.generateReply('g1', makeMsg({ content: 'second' }), []);
    vi.advanceTimersByTime(2100);
    const results = await Promise.all([p1, p2]);

    expect(results.filter(r => r === null).length).toBeGreaterThanOrEqual(1);
    vi.useRealTimers();
  });
});

describe('ChatModule — mixed few-shot history', () => {
  let db: Database;
  let claude: IClaudeClient;

  function makeChatWithCounts(recent: number, historical: number) {
    return new ChatModule(claude, db, {
      botUserId: BOT_ID,
      lurkerReplyChance: 1.0,
      lurkerCooldownMs: 0,
      chatRecentCount: recent,
      chatHistoricalSampleCount: historical,
    });
  }

  beforeEach(() => {
    db = new Database(':memory:');
    claude = makeMockClaude();
  });

  // 1. Group with only 5 messages — historical sample returns empty; chat still works
  it('group with 5 messages: historical sample is empty, reply still succeeds', async () => {
    const ts = Math.floor(Date.now() / 1000);
    insertMessages(db, 'g1', 5, ts - 50, 10);

    const chat = makeChatWithCounts(20, 10);
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(result).toBe('bot reply');

    // sampleRandomHistorical with excludeNewestN=20 and only 5 msgs → should return 0
    const sample = db.messages.sampleRandomHistorical('g1', 20, 10);
    expect(sample).toHaveLength(0);
  });

  // 2. Group with 100 messages — recent 20, historical 10 from the other 80
  it('group with 100 messages: recent=20, historical sample=10 from remaining 80', async () => {
    const ts = Math.floor(Date.now() / 1000);
    insertMessages(db, 'g1', 100, ts - 1000, 10);

    const sample = db.messages.sampleRandomHistorical('g1', 20, 10);
    expect(sample).toHaveLength(10);

    const recentIds = new Set(db.messages.getRecent('g1', 20).map(m => m.id));
    for (const m of sample) {
      expect(recentIds.has(m.id)).toBe(false);
    }
  });

  // 3. Group with 500 messages — verify no overlap with recent window
  it('group with 500 messages: no overlap between recent and historical sample', async () => {
    const ts = Math.floor(Date.now() / 1000);
    insertMessages(db, 'g1', 500, ts - 5000, 10);

    const recentIds = new Set(db.messages.getRecent('g1', 20).map(m => m.id));
    const sample = db.messages.sampleRandomHistorical('g1', 20, 10);

    expect(sample).toHaveLength(10);
    for (const m of sample) {
      expect(recentIds.has(m.id)).toBe(false);
    }
  });

  // 4. Sample reproducibility: two calls return different samples (not cached)
  it('two sampleRandomHistorical calls return different orderings (not cached)', async () => {
    const ts = Math.floor(Date.now() / 1000);
    insertMessages(db, 'g1', 200, ts - 2000, 10);

    const sample1 = db.messages.sampleRandomHistorical('g1', 20, 10).map(m => m.id);
    const sample2 = db.messages.sampleRandomHistorical('g1', 20, 10).map(m => m.id);

    // With 180 eligible messages and sample size 10, identical draws are astronomically unlikely
    // We just verify neither call throws and both return the right count
    expect(sample1).toHaveLength(10);
    expect(sample2).toHaveLength(10);
    // At least one id should differ (extremely high probability)
    const allSame = sample1.every((id, i) => id === sample2[i]);
    expect(allSame).toBe(false);
  });

  // 5. Off-by-one: excludeNewestN boundary is respected exactly
  it('excludeNewestN boundary: message at position N+1 is eligible, message at N is excluded', async () => {
    const ts = Math.floor(Date.now() / 1000);
    // Insert exactly 5 messages, timestamps ts-4 through ts
    for (let i = 0; i < 5; i++) {
      db.messages.insert({ groupId: 'g1', userId: 'u1', nickname: 'U', content: `msg${i}`, timestamp: ts - (4 - i), deleted: false });
    }

    // excludeNewestN=4 → newest 4 excluded, 1 remains eligible
    const sample = db.messages.sampleRandomHistorical('g1', 4, 10);
    expect(sample).toHaveLength(1);

    const recentIds = new Set(db.messages.getRecent('g1', 4).map(m => m.id));
    expect(recentIds.has(sample[0]!.id)).toBe(false);
  });

  // 6. Empty group — both slices return empty, chat handles gracefully
  it('empty group: both recent and historical are empty, reply still works', async () => {
    const chat = makeChatWithCounts(20, 10);
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(result).toBe('bot reply');
  });

  // 7. Single-message group — recent=1, historical=0, chat works
  it('single-message group: historical=0, reply still works', async () => {
    const ts = Math.floor(Date.now() / 1000);
    db.messages.insert({ groupId: 'g1', userId: 'u1', nickname: 'Solo', content: 'only msg', timestamp: ts, deleted: false });

    const chat = makeChatWithCounts(20, 10);
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(result).toBe('bot reply');

    const sample = db.messages.sampleRandomHistorical('g1', 20, 10);
    expect(sample).toHaveLength(0);
  });
});
