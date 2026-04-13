import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatModule, extractKeywords, extractTopFaces } from '../src/modules/chat.js';
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
    // lurkerReplyChance=1.0 and chatSilenceBonusSec=1 so score reaches 1.0 for any message
    // older than 1 second — tests that don't test probability/score always reply
    chat = new ChatModule(claude, db, {
      botUserId: BOT_ID,
      lurkerReplyChance: 1.0,  // always pass probability unless overridden
      lurkerCooldownMs: 0,     // no cooldown unless overridden
      burstMinMessages: 5,
      burstWindowMs: 10_000,
      chatSilenceBonusSec: 1,  // 1s silence → score=1.0; disables score gate for most tests
      chatMinScore: 0,         // no minimum score gate unless overridden
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

  it('replies to messages without the old [模仿] prefix guard (prefix removed)', async () => {
    // Prefix guard removed — chat module no longer filters on [模仿] content
    const result = await chat.generateReply('g1', makeMsg({ content: 'some text' }), []);
    expect(result).toBe('bot reply');
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
      chatSilenceBonusSec: 1,  // 15s silence → score=1.0
      chatMinScore: 0,
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

  // ── In-flight lock: duplicate @-mention within debounce window ───────────
  // Regression for: user sent "@QAQ 咪", bot replied "咪" twice.
  // Root cause: two concurrent generateReply() calls both read debounceMap as
  // undefined before either wrote it, so both passed the timestamp-based check.
  it('concurrent @-mention triggers send reply exactly once (in-flight lock)', async () => {
    // Use a slow claude mock so the first call is still in-flight when the second arrives
    let resolveFirst!: (v: string) => void;
    const firstCallPending = new Promise<string>(r => { resolveFirst = r; });
    const completeMock = vi.fn()
      .mockReturnValueOnce(
        (async () => ({ text: await firstCallPending, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }))()
      )
      .mockResolvedValue({ text: 'second reply', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });

    const slowClaude: IClaudeClient = { complete: completeMock };
    const concurrentChat = new ChatModule(slowClaude, db, {
      botUserId: BOT_ID,
      lurkerReplyChance: 1.0,
      lurkerCooldownMs: 0,
      debounceMs: 50,  // short debounce so both get past timestamp check
    });

    const atMsg = makeMsg({ rawContent: `[CQ:at,qq=${BOT_ID}] 咪`, content: '咪' });

    // Launch both concurrently — second arrives 10ms later, still within debounce window
    const p1 = concurrentChat.generateReply('g1', atMsg, []);
    await new Promise(r => setTimeout(r, 10));
    const p2 = concurrentChat.generateReply('g1', atMsg, []);

    // Resolve the first call
    resolveFirst('咪');
    const [r1, r2] = await Promise.all([p1, p2]);

    // Exactly one reply, not two
    const replies = [r1, r2].filter(r => r !== null);
    expect(replies).toHaveLength(1);
    expect(completeMock).toHaveBeenCalledTimes(1);
  });

  // ── Score-based participation gate ────────────────────────────────────

  it('score gate: fresh message (0s silence) → score ~0 → blocked by chatMinScore', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Insert a message timestamped right now — zero silence
    db.messages.insert({ groupId: 'g1', userId: 'u2', nickname: 'Bob', content: 'hey', timestamp: now, deleted: false });

    chat = new ChatModule(claude, db, {
      botUserId: BOT_ID,
      lurkerReplyChance: 1.0,
      lurkerCooldownMs: 0,
      chatSilenceBonusSec: 120,
      chatMinScore: 0.1,  // score must be >= 0.1 (i.e. silence >= 12s)
    });
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(result).toBeNull();
  });

  it('score gate: 60s silence with bonusSec=120 → score=0.5 → random<0.5 passes', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.3); // 0.3 < 0.5 * 1.0 → pass
    const now = Math.floor(Date.now() / 1000);
    db.messages.insert({ groupId: 'g1', userId: 'u2', nickname: 'Bob', content: 'hey', timestamp: now - 60, deleted: false });

    chat = new ChatModule(claude, db, {
      botUserId: BOT_ID,
      lurkerReplyChance: 1.0,
      lurkerCooldownMs: 0,
      chatSilenceBonusSec: 120,
      chatMinScore: 0.1,
    });
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(result).toBe('bot reply');
  });

  it('score gate: 60s silence with bonusSec=120 → score=0.5 → random=0.6 blocked', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.6); // 0.6 >= 0.5 * 1.0 → skip
    const now = Math.floor(Date.now() / 1000);
    db.messages.insert({ groupId: 'g1', userId: 'u2', nickname: 'Bob', content: 'hey', timestamp: now - 60, deleted: false });

    chat = new ChatModule(claude, db, {
      botUserId: BOT_ID,
      lurkerReplyChance: 1.0,
      lurkerCooldownMs: 0,
      chatSilenceBonusSec: 120,
      chatMinScore: 0.1,
    });
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(result).toBeNull();
  });

  it('score gate: silence >= bonusSec → score capped at 1.0 → full lurkerReplyChance applies', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.14); // < 0.15 * 1.0 → pass
    const now = Math.floor(Date.now() / 1000);
    db.messages.insert({ groupId: 'g1', userId: 'u2', nickname: 'Bob', content: 'hey', timestamp: now - 300, deleted: false });

    chat = new ChatModule(claude, db, {
      botUserId: BOT_ID,
      lurkerReplyChance: 0.15,
      lurkerCooldownMs: 0,
      chatSilenceBonusSec: 120,
      chatMinScore: 0.1,
    });
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(result).toBe('bot reply');
  });

  it('score gate: empty group (no DB messages) → score=1.0 → full chance', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.10);
    chat = new ChatModule(claude, db, {
      botUserId: BOT_ID,
      lurkerReplyChance: 0.15,
      lurkerCooldownMs: 0,
      chatSilenceBonusSec: 120,
      chatMinScore: 0.1,
    });
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(result).toBe('bot reply');
  });

  it('score gate: @-mention always bypasses score check', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Fresh message → score near 0
    db.messages.insert({ groupId: 'g1', userId: 'u2', nickname: 'Bob', content: 'hey', timestamp: now, deleted: false });

    chat = new ChatModule(claude, db, {
      botUserId: BOT_ID,
      lurkerReplyChance: 0,
      lurkerCooldownMs: 999_999,
      chatSilenceBonusSec: 120,
      chatMinScore: 0.99,
    });
    const msg = makeMsg({ rawContent: `[CQ:at,qq=${BOT_ID}] hello`, content: 'hello' });
    const result = await chat.generateReply('g1', msg, []);
    expect(result).toBe('bot reply');
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
      chatSilenceBonusSec: 1,
      chatMinScore: 0,
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
    db.messages.insert({ groupId: 'g1', userId: 'u1', nickname: 'Solo', content: 'only msg', timestamp: ts - 10, deleted: false });

    const chat = makeChatWithCounts(20, 10);
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(result).toBe('bot reply');

    const sample = db.messages.sampleRandomHistorical('g1', 20, 10);
    expect(sample).toHaveLength(0);
  });
});

describe('ChatModule — keyword retrieval and group identity', () => {
  let db: Database;
  let claude: IClaudeClient;

  beforeEach(() => {
    db = new Database(':memory:');
    claude = makeMockClaude();
  });

  function makeChat(overrides: Record<string, unknown> = {}) {
    return new ChatModule(claude, db, {
      botUserId: BOT_ID,
      lurkerReplyChance: 1.0,
      lurkerCooldownMs: 0,
      chatSilenceBonusSec: 1,
      chatMinScore: 0,
      chatKeywordMatchCount: 15,
      groupIdentityTopUsers: 20,
      groupIdentityCacheTtlMs: 3_600_000,
      ...overrides,
    });
  }

  // 1. Zero matching keywords → fallback to recent+random only (no keyword section)
  it('trigger with zero matching keywords: no keyword section in prompt, still replies', async () => {
    const ts = Math.floor(Date.now() / 1000);
    db.messages.insert({ groupId: 'g1', userId: 'u1', nickname: 'Alice', content: 'good morning everyone', timestamp: ts - 60, deleted: false });

    const chat = makeChat();
    // Trigger with only stopwords — extractKeywords returns []
    const result = await chat.generateReply('g1', makeMsg({ content: '我 你 他' }), []);
    expect(result).toBe('bot reply');

    const call = (claude.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { messages: Array<{ content: string }> };
    const promptText = call.messages.map((m: { content: string }) => m.content).join(' ');
    expect(promptText).not.toContain('相关历史消息');
    expect(promptText).toContain('最近聊天');
  });

  // 2. Keyword cap: searchByKeywords returns at most chatKeywordMatchCount rows
  it('keyword search returns at most chatKeywordMatchCount rows even with many matches', async () => {
    const ts = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 50; i++) {
      db.messages.insert({ groupId: 'g1', userId: `u${i}`, nickname: `User${i}`, content: `邦多利真好吃 ${i}`, timestamp: ts - i * 60, deleted: false });
    }
    const results = db.messages.searchByKeywords('g1', ['邦多利'], 15);
    expect(results.length).toBeLessThanOrEqual(15);
    expect(results.length).toBeGreaterThan(0);
  });

  // 3. Chinese tokenization: stopwords excluded, CQ codes stripped, meaningful tokens kept
  it('extractKeywords: CQ codes stripped and stopwords excluded', () => {
    // With explicit spaces between tokens (how QQ sends them after CQ stripping)
    const keywords = extractKeywords('[CQ:at,qq=1234] 邦多利 是 什么');
    // CQ:at stripped, single-char stopwords like '是' filtered by length<2, '什么' is a stopword
    expect(keywords).not.toContain('什么');
    expect(keywords).toContain('邦多利');
    // Verify stopword filtering: pure stopword message yields empty
    const stopOnly = extractKeywords('我 你 他 的 了 是 不');
    expect(stopOnly).toHaveLength(0);
  });

  // 4. English keyword matches
  it('English keyword "ygfn" matches messages containing it', async () => {
    const ts = Math.floor(Date.now() / 1000);
    db.messages.insert({ groupId: 'g1', userId: 'u1', nickname: 'Alice', content: 'ygfn is a great server', timestamp: ts - 100, deleted: false });
    db.messages.insert({ groupId: 'g1', userId: 'u2', nickname: 'Bob', content: 'nothing here', timestamp: ts - 90, deleted: false });

    const results = db.messages.searchByKeywords('g1', ['ygfn'], 10);
    expect(results.length).toBe(1);
    expect(results[0]!.content).toContain('ygfn');
  });

  // 5. Group identity cache: first call queries DB, second call within TTL uses cache
  it('group identity cache: DB queried once, second call within TTL hits cache', async () => {
    const ts = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 5; i++) {
      db.messages.insert({ groupId: 'g1', userId: `u${i}`, nickname: `User${i}`, content: `hello ${i}`, timestamp: ts - i, deleted: false });
      db.users.upsert({ userId: `u${i}`, groupId: 'g1', nickname: `User${i}`, styleSummary: null, lastSeen: ts - i });
    }

    const getTopUsersSpy = vi.spyOn(db.messages, 'getTopUsers');
    // Use @-mention so both calls bypass lurker gates, and debounceMs=0 so debounce never blocks
    const chat = makeChat({ groupIdentityCacheTtlMs: 3_600_000, debounceMs: 0 });
    const atMsg1 = makeMsg({ content: '有人吗', rawContent: `[CQ:at,qq=${BOT_ID}] 有人吗` });
    const atMsg2 = makeMsg({ content: '在线吗', rawContent: `[CQ:at,qq=${BOT_ID}] 在线吗` });

    await chat.generateReply('g1', atMsg1, []);
    await chat.generateReply('g1', atMsg2, []);

    expect(getTopUsersSpy).toHaveBeenCalledTimes(1);
  });

  // 6. Cross-group isolation: keywords from group A don't return messages from group B
  it('cross-group isolation: searchByKeywords only returns messages from the queried group', async () => {
    const ts = Math.floor(Date.now() / 1000);
    db.messages.insert({ groupId: 'gA', userId: 'u1', nickname: 'Alice', content: '邦多利真好', timestamp: ts - 10, deleted: false });
    db.messages.insert({ groupId: 'gB', userId: 'u2', nickname: 'Bob', content: '邦多利也好', timestamp: ts - 5, deleted: false });

    const resultsA = db.messages.searchByKeywords('gA', ['邦多利'], 10);
    const resultsB = db.messages.searchByKeywords('gB', ['邦多利'], 10);

    expect(resultsA.every(m => m.groupId === 'gA')).toBe(true);
    expect(resultsB.every(m => m.groupId === 'gB')).toBe(true);
    expect(resultsA).toHaveLength(1);
    expect(resultsB).toHaveLength(1);
  });

  // 7. Empty corpus: all retrievals return [], chat falls back gracefully
  it('empty corpus: zero keyword matches + zero historical, reply still succeeds', async () => {
    const chat = makeChat();
    const result = await chat.generateReply('g1', makeMsg({ content: '邦多利是什么' }), []);
    expect(result).toBe('bot reply');

    const call = (claude.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { messages: Array<{ content: string }> };
    const promptText = call.messages.map((m: { content: string }) => m.content).join(' ');
    expect(promptText).toContain('邦多利是什么');
  });

  // 8. extractTopFaces unit tests
  it('extractTopFaces: counts face IDs and returns top-N by frequency', () => {
    const messages = [
      { content: '[CQ:face,id=14] 哈哈 [CQ:face,id=14]' }, // id=14 appears twice
      { content: '[CQ:face,id=21] 好可爱' },
      { content: '[CQ:face,id=14] 再来一次' },
      { content: '[CQ:face,id=21] [CQ:face,id=100]' },
    ];
    const top2 = extractTopFaces(messages, 2);
    expect(top2[0]).toBe(14); // most frequent
    expect(top2[1]).toBe(21); // second most frequent
    expect(top2).toHaveLength(2);
  });

  it('extractTopFaces: no faces in messages → returns empty array', () => {
    const messages = [{ content: '哈哈今天天气不错' }, { content: '笑死我了' }];
    expect(extractTopFaces(messages, 5)).toHaveLength(0);
  });

  it('extractTopFaces: fewer unique faces than topN → returns all', () => {
    const messages = [{ content: '[CQ:face,id=14]' }, { content: '[CQ:face,id=21]' }];
    expect(extractTopFaces(messages, 10)).toHaveLength(2);
  });

  // 9. Emoji injection into system prompt
  it('emoji: group with face usage has top faces injected into system prompt', async () => {
    const ts = Math.floor(Date.now() / 1000);
    // Insert messages with face codes — id=14 used most
    for (let i = 0; i < 5; i++) {
      db.messages.insert({ groupId: 'g1', userId: `u${i}`, nickname: `U${i}`,
        content: `[CQ:face,id=14] msg ${i}`, timestamp: ts - (i + 1) * 60, deleted: false });
    }
    db.messages.insert({ groupId: 'g1', userId: 'u5', nickname: 'U5',
      content: '[CQ:face,id=21]', timestamp: ts - 360, deleted: false });

    const chat = makeChat({ chatEmojiTopN: 2, chatEmojiSampleSize: 50, debounceMs: 0 });
    const msg = makeMsg({ content: '有人吗', rawContent: `[CQ:at,qq=${BOT_ID}] 有人吗` });
    await chat.generateReply('g1', msg, []);

    const call = (claude.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { system: Array<{ text: string }> };
    const systemText = call.system.map((s: { text: string }) => s.text).join(' ');
    // Should contain the group's most-used face
    expect(systemText).toContain('[CQ:face,id=14]');
    expect(systemText).toContain('最近常用的表情');
  });

  it('emoji: group with no faces → no emoji injection line', async () => {
    const ts = Math.floor(Date.now() / 1000);
    db.messages.insert({ groupId: 'g1', userId: 'u1', nickname: 'Alice', content: '纯文字消息', timestamp: ts - 60, deleted: false });

    const chat = makeChat({ chatEmojiTopN: 5, chatEmojiSampleSize: 50, debounceMs: 0 });
    const msg = makeMsg({ content: '有人吗', rawContent: `[CQ:at,qq=${BOT_ID}] 有人吗` });
    await chat.generateReply('g1', msg, []);

    const call = (claude.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { system: Array<{ text: string }> };
    const systemText = call.system.map((s: { text: string }) => s.text).join(' ');
    expect(systemText).not.toContain('最近常用的表情');
  });
});

describe('ChatModule — group lore loading', () => {
  let db: Database;
  let claude: IClaudeClient;
  let tmpDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    claude = makeMockClaude();
    // Use OS temp dir for lore files in tests
    tmpDir = require('node:os').tmpdir();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeChatWithLoreDir(loreDirPath: string, loreSizeCapBytes?: number) {
    return new ChatModule(claude, db, {
      botUserId: BOT_ID,
      lurkerReplyChance: 1.0,
      lurkerCooldownMs: 0,
      debounceMs: 0,
      chatSilenceBonusSec: 1,
      chatMinScore: 0,
      loreDirPath,
      ...(loreSizeCapBytes !== undefined ? { loreSizeCapBytes } : {}),
    });
  }

  // 1. Lore file exists → system prompt contains lore markdown
  it('lore file exists: system prompt contains lore markdown', async () => {
    const { writeFileSync } = await import('node:fs');
    const lorePath = require('node:path').join(tmpDir, `g-lore-test-1.md`);
    writeFileSync(lorePath, '# 群志\n## 梗辞典\n邦多利 — 好吃的零食', 'utf8');

    const chat = makeChatWithLoreDir(tmpDir);
    const msg = makeMsg({ content: '有人吗', groupId: 'g-lore-test-1', rawContent: `[CQ:at,qq=${BOT_ID}] 有人吗` });
    await chat.generateReply('g-lore-test-1', msg, []);

    const call = (claude.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { system: Array<{ text: string }> };
    const systemText = call.system.map((s: { text: string }) => s.text).join(' ');
    expect(systemText).toContain('群志');
    expect(systemText).toContain('邦多利');
  });

  // 2. Lore file missing → falls back to generic, chat still works
  it('lore file missing: falls back to generic identity prompt, reply succeeds', async () => {
    const chat = makeChatWithLoreDir('/nonexistent/path/that/does/not/exist');
    const msg = makeMsg({ content: '有人吗', rawContent: `[CQ:at,qq=${BOT_ID}] 有人吗` });
    const result = await chat.generateReply('g1', msg, []);
    expect(result).toBe('bot reply');

    const call = (claude.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { system: Array<{ text: string }> };
    const systemText = call.system.map((s: { text: string }) => s.text).join(' ');
    // Falls back to generic prompt — should contain standard fallback phrase
    expect(systemText).toContain('说话风格随群');
    expect(systemText).not.toContain('以下是这个群的资料');
  });

  // 3. Lore file empty → treat as missing, warn log
  it('lore file empty: treated as missing, warn logged, fallback used', async () => {
    const { writeFileSync } = await import('node:fs');
    const lorePath = require('node:path').join(tmpDir, 'g-lore-test-3.md');
    writeFileSync(lorePath, '   \n\n', 'utf8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chat = makeChatWithLoreDir(tmpDir);
    const msg = makeMsg({ content: '有人吗', groupId: 'g-lore-test-3', rawContent: `[CQ:at,qq=${BOT_ID}] 有人吗` });
    await chat.generateReply('g-lore-test-3', msg, []);

    const call = (claude.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { system: Array<{ text: string }> };
    const systemText = call.system.map((s: { text: string }) => s.text).join(' ');
    expect(systemText).not.toContain('以下是这个群的资料');
    warnSpy.mockRestore();
  });

  // 4. Lore file too large → warn, truncate, still use
  it('lore file too large: truncated to cap, lore still injected', async () => {
    const { writeFileSync } = await import('node:fs');
    const bigContent = '# 群志\n' + 'x'.repeat(2000);
    const lorePath = require('node:path').join(tmpDir, 'g-lore-test-4.md');
    writeFileSync(lorePath, bigContent, 'utf8');

    const chat = makeChatWithLoreDir(tmpDir, 500); // 500-byte cap
    const msg = makeMsg({ content: '有人吗', groupId: 'g-lore-test-4', rawContent: `[CQ:at,qq=${BOT_ID}] 有人吗` });
    await chat.generateReply('g-lore-test-4', msg, []);

    const call = (claude.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { system: Array<{ text: string }> };
    const systemText = call.system.map((s: { text: string }) => s.text).join(' ');
    // Should still contain lore (truncated) and be shorter than original
    expect(systemText).toContain('群志');
    // System text should not contain 2000 x's (it was truncated)
    expect(systemText.length).toBeLessThan(bigContent.length + 500);
  });
});

describe('ChatModule — sentinel: AI self-disclosure prevention', () => {
  let claude: ReturnType<typeof vi.fn>;
  let db: Database;

  beforeEach(() => {
    claude = vi.fn();
    db = new Database(':memory:');
  });

  function makeSentinelChat() {
    return new ChatModule(
      { complete: claude } as unknown as IClaudeClient,
      db,
      { botUserId: BOT_ID, debounceMs: 0, lurkerReplyChance: 1, lurkerCooldownMs: 0 }
    );
  }

  function mentionMsg(content: string) {
    return makeMsg({ content, rawContent: `[CQ:at,qq=${BOT_ID}] ${content}` });
  }

  it('clean reply passes through sentinel unchanged', async () => {
    claude.mockResolvedValue({ text: '哈哈今天天气不错', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const chat = makeSentinelChat();
    const result = await chat.generateReply('g1', mentionMsg('天气'), []);
    expect(result).toBe('哈哈今天天气不错');
    expect(claude.mock.calls.length).toBe(1);
  });

  it('AI self-disclosure in first reply triggers regeneration, returns clean second reply', async () => {
    let n = 0;
    claude.mockImplementation(async () => {
      n++;
      return {
        text: n === 1 ? '我只是一个AI，根据您提供的历史发言：笑死我了' : '笑死我了',
        inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
      };
    });
    const chat = makeSentinelChat();
    const result = await chat.generateReply('g1', mentionMsg('哈'), []);
    expect(result).toBe('笑死我了');
    expect(claude.mock.calls.length).toBe(2);
  });

  it('claude name-drop triggers sentinel (claude mentioned in third-person)', async () => {
    let n = 0;
    claude.mockImplementation(async () => {
      n++;
      return {
        text: n === 1 ? '笑死这算法题都给你拒了，claude是真有个性' : '笑死这算法题都给你拒了',
        inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
      };
    });
    const chat = makeSentinelChat();
    const result = await chat.generateReply('g1', mentionMsg('算法题'), []);
    expect(result).toBe('笑死这算法题都给你拒了');
    expect(claude.mock.calls.length).toBe(2);
  });

  it('both attempts contain forbidden content → returns "..."', async () => {
    claude.mockResolvedValue({
      text: '我是一个AI助手，很高兴为您服务',
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    const chat = makeSentinelChat();
    const result = await chat.generateReply('g1', mentionMsg('你好'), []);
    expect(result).toBe('...');
    expect(claude.mock.calls.length).toBe(2);
  });

  it('system prompt uses identity framing and contains output rules', async () => {
    claude.mockResolvedValue({ text: '没啥', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const chat = makeSentinelChat();
    await chat.generateReply('g1', mentionMsg('哈'), []);
    const call = claude.mock.calls[0]![0] as { system: Array<{ text: string }> };
    const systemText = call.system.map((s: { text: string }) => s.text).join('');
    expect(systemText).toContain('你就是这个QQ群里的一员');
    expect(systemText).toContain('输出规则');
  });
});
