import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChatModule } from '../../src/modules/chat.js';
import { Database } from '../../src/storage/db.js';
import type { IClaudeClient, ClaudeResponse } from '../../src/ai/claude.js';
import type { GroupMessage } from '../../src/adapter/napcat.js';
import { initLogger } from '../../src/utils/logger.js';

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

function makeMockClaude(text = '有啊'): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text, inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
  };
}

// Returns a claude mock that cycles through distinct texts per call, so
// self-dedup (chat.ts:3107) doesn't silence repeat generateReply calls in a test.
function makeCyclingMockClaude(texts: string[]): IClaudeClient {
  let i = 0;
  return {
    complete: vi.fn().mockImplementation(async () => {
      const text = texts[i % texts.length] ?? 'reply';
      i++;
      return {
        text, inputTokens: 10, outputTokens: 5,
        cacheReadTokens: 0, cacheWriteTokens: 0,
      } satisfies ClaudeResponse;
    }),
  };
}

function makeChat(claude: IClaudeClient, db: Database, overrides: Record<string, unknown> = {}): ChatModule {
  return new ChatModule(claude, db, {
    botUserId: BOT_ID,
    debounceMs: 0,
    chatMinScore: -999, // always pass scoring gate
    ...overrides,
  });
}

type EngagedEntry = { tokens: Set<string>; until: number; msgCount: number };
function getEngaged(chat: ChatModule, groupId: string): EngagedEntry | undefined {
  return (chat as unknown as { engagedTopic: Map<string, EngagedEntry> }).engagedTopic.get(groupId);
}
function setEngaged(chat: ChatModule, groupId: string, entry: EngagedEntry): void {
  (chat as unknown as { engagedTopic: Map<string, EngagedEntry> }).engagedTopic.set(groupId, entry);
}

describe('ChatModule — engagedTopic accumulate + followUpPhrase factor', () => {
  let db: Database;
  let claude: IClaudeClient;

  beforeEach(() => { db = new Database(':memory:'); claude = makeMockClaude(); });
  afterEach(() => { vi.restoreAllMocks(); });

  // Row 1: first reply seeds tokens (function words filtered).
  // Assertion keeps tokenizer-agnostic: 最近 bigram survives + size non-trivial.
  // Bigrams li/iv/ve may or may not also be present (that's an extractTokens
  // implementation detail — we don't lock it in here).
  it('row 1: first bot reply seeds engagedTopic.tokens with content tokens', async () => {
    const chat = makeChat(claude, db);
    await chat.generateReply('g1', makeMsg({ content: '最近有什么live', rawContent: '最近有什么live' }), []);
    const e = getEngaged(chat, 'g1');
    expect(e).toBeDefined();
    expect(e!.tokens.has('最近')).toBe(true);
    expect(e!.tokens.size).toBeGreaterThanOrEqual(2);
    // FOLLOWUP_FUNCTION_WORDS entries must never appear
    expect(e!.tokens.has('还有')).toBe(false);
    expect(e!.tokens.has('呢')).toBe(false);
  });

  // Row 2: accumulate beats overwrite — turn 2 follow-up preserves turn 1 tokens.
  // This is the central behavioral fix. Without accumulate, turn 2 overwrites
  // the seeded engagedTopic with extractTokens('还有码')=[] → latch poisoned.
  // With accumulate + function-word filter, 最近 (from turn 1) survives and
  // 还有码 never lands as a token.
  it('row 2: accumulate preserves turn-1 tokens through function-word follow-up', async () => {
    const chat = makeChat(claude, db);
    // Turn 1 — bot replies to `最近有什么live`; engagedTopic now seeded with 最近 (and bigrams)
    await chat.generateReply('g1', makeMsg({ content: '最近有什么live', rawContent: '最近有什么live' }), []);
    const before = getEngaged(chat, 'g1')!;
    expect(before.tokens.has('最近')).toBe(true);
    // Turn 2 — user sends bare follow-up `还有码`; bot replies (mock); accumulate runs
    await chat.generateReply('g1', makeMsg({ content: '还有码', rawContent: '还有码' }), []);
    const after = getEngaged(chat, 'g1')!;
    // The latch survives — 最近 was NOT clobbered
    expect(after.tokens.has('最近')).toBe(true);
    // 还有码 itself is in FOLLOWUP_FUNCTION_WORDS, must never appear as a token
    expect(after.tokens.has('还有码')).toBe(false);
    // Other function-word members also absent
    for (const w of ['还有', '呢', '然后', '继续', '之后', '那', '那呢']) {
      expect(after.tokens.has(w)).toBe(false);
    }
  });

  // Row 2b: dedicated unit test for the function-word filter itself.
  // Decouples filter correctness from tokenizer behavior — exercises the
  // accumulate filter predicate directly against a synthetic token array.
  it('row 2b: FOLLOWUP_FUNCTION_WORDS filter drops function-word entries (unit)', async () => {
    // Import the set via a fresh require to avoid polluting the chat-level tests.
    // (ESM dynamic import keeps the test file self-contained.)
    const { FOLLOWUP_FUNCTION_WORDS } = await import('../../src/utils/topic-followup-phrase.js');
    const synthetic = ['最近', '还有', 'live', '呢', 'roselia', '那呢', 'tae'];
    const filtered = synthetic.filter(t => !FOLLOWUP_FUNCTION_WORDS.has(t));
    expect(filtered).toEqual(['最近', 'live', 'roselia', 'tae']);
    // Explicit member checks
    expect(FOLLOWUP_FUNCTION_WORDS.has('还有')).toBe(true);
    expect(FOLLOWUP_FUNCTION_WORDS.has('呢')).toBe(true);
    expect(FOLLOWUP_FUNCTION_WORDS.has('那呢')).toBe(true);
    expect(FOLLOWUP_FUNCTION_WORDS.has('最近')).toBe(false);
    expect(FOLLOWUP_FUNCTION_WORDS.has('live')).toBe(false);
  });

  // Row 3: accumulate unions old + new content tokens
  // Use distinct replies per turn so self-dedup (chat.ts:3107) does not silence
  // turns 2+ — the mock cycler returns '回复A', '回复B', '回复C' on successive calls.
  it('row 3: 3 new-token replies accumulate into union (no overwrite)', async () => {
    const cyclingClaude = makeCyclingMockClaude(['回复A', '回复B', '回复C']);
    const chat = makeChat(cyclingClaude, db);
    await chat.generateReply('g1', makeMsg({ messageId: 'm1', content: 'roselia fire', rawContent: 'roselia fire' }), []);
    await chat.generateReply('g1', makeMsg({ messageId: 'm2', content: 'band yuki', rawContent: 'band yuki' }), []);
    await chat.generateReply('g1', makeMsg({ messageId: 'm3', content: 'tae saya', rawContent: 'tae saya' }), []);
    const e = getEngaged(chat, 'g1')!;
    // Union contains all content tokens across all turns
    for (const t of ['roselia', 'fire', 'band', 'yuki', 'tae', 'saya']) {
      expect(e.tokens.has(t)).toBe(true);
    }
  });

  // Row 4: FIFO cap at 30
  it('row 4: token set FIFO-evicts oldest when exceeding 30', async () => {
    const chat = makeChat(claude, db);
    // Pre-seed 30 synthetic tokens
    const seeded: EngagedEntry = {
      tokens: new Set(Array.from({ length: 30 }, (_, i) => `tok${i}`)),
      until: Date.now() + 90_000,
      msgCount: 0,
    };
    setEngaged(chat, 'g1', seeded);
    await chat.generateReply('g1', makeMsg({ content: 'tok30', rawContent: 'tok30' }), []);
    const e = getEngaged(chat, 'g1')!;
    expect(e.tokens.size).toBeLessThanOrEqual(30);
    expect(e.tokens.has('tok30')).toBe(true);
    expect(e.tokens.has('tok0')).toBe(false); // oldest evicted
  });

  // Row 5: followUpPhrase fires when engagedTopic valid AND phrase matches
  it('row 5: followUpPhrase = 0.4 when engagedTopic valid + phrase matches', async () => {
    const chat = makeChat(claude, db, { chatMinScore: 999 });
    setEngaged(chat, 'g1', {
      tokens: new Set(['live', '最近']),
      until: Date.now() + 90_000,
      msgCount: 0,
    });
    const scored = (chat as unknown as {
      _computeWeightedScore: (g: string, m: GroupMessage, now: number, r3: unknown[], r5: unknown[]) => { factors: { followUpPhrase: number } };
    })._computeWeightedScore('g1', makeMsg({ content: '还有吗', rawContent: '还有吗' }), Date.now(), [], []);
    expect(scored.factors.followUpPhrase).toBe(0.4);
  });

  // Row 6: expired engagedTopic → no factor
  it('row 6: followUpPhrase = 0 when engagedTopic.until expired', async () => {
    const chat = makeChat(claude, db, { chatMinScore: 999 });
    setEngaged(chat, 'g1', {
      tokens: new Set(['live']),
      until: Date.now() - 10_000,
      msgCount: 0,
    });
    const scored = (chat as unknown as {
      _computeWeightedScore: (g: string, m: GroupMessage, now: number, r3: unknown[], r5: unknown[]) => { factors: { followUpPhrase: number } };
    })._computeWeightedScore('g1', makeMsg({ content: '还有吗', rawContent: '还有吗' }), Date.now(), [], []);
    expect(scored.factors.followUpPhrase).toBe(0);
  });

  // Row 7: no engagedTopic entry → no factor
  it('row 7: followUpPhrase = 0 when no engagedTopic for group', async () => {
    const chat = makeChat(claude, db, { chatMinScore: 999 });
    const scored = (chat as unknown as {
      _computeWeightedScore: (g: string, m: GroupMessage, now: number, r3: unknown[], r5: unknown[]) => { factors: { followUpPhrase: number } };
    })._computeWeightedScore('g1', makeMsg({ content: '还有吗', rawContent: '还有吗' }), Date.now(), [], []);
    expect(scored.factors.followUpPhrase).toBe(0);
  });

  // Row 8: engagedTopic valid but phrase does NOT match → no factor
  it('row 8: followUpPhrase = 0 when engagedTopic valid but phrase fails to match', async () => {
    const chat = makeChat(claude, db, { chatMinScore: 999 });
    setEngaged(chat, 'g1', {
      tokens: new Set(['live']),
      until: Date.now() + 90_000,
      msgCount: 0,
    });
    const scored = (chat as unknown as {
      _computeWeightedScore: (g: string, m: GroupMessage, now: number, r3: unknown[], r5: unknown[]) => { factors: { followUpPhrase: number } };
    })._computeWeightedScore('g1', makeMsg({ content: '你之后呢准备干嘛', rawContent: '你之后呢准备干嘛' }), Date.now(), [], []);
    expect(scored.factors.followUpPhrase).toBe(0);
  });

  // Row 9: co-fire with topicStick (both additive).
  // extractTokens('6月有啥live') → ['6月','li','iv','ve'] — seed overlap ≥ 2 via those bigrams.
  it('row 9: followUpPhrase + topicStick co-fire when overlap≥2 and phrase matches', async () => {
    const chat = makeChat(claude, db, { chatMinScore: 999 });
    setEngaged(chat, 'g1', {
      tokens: new Set(['6月', 'li', 'iv', 've']),
      until: Date.now() + 90_000,
      msgCount: 0,
    });
    const scored = (chat as unknown as {
      _computeWeightedScore: (g: string, m: GroupMessage, now: number, r3: unknown[], r5: unknown[]) => { factors: { followUpPhrase: number; topicStick: number } };
    })._computeWeightedScore('g1', makeMsg({ content: '6月有啥live', rawContent: '6月有啥live' }), Date.now(), [], []);
    expect(scored.factors.followUpPhrase).toBe(0.4);
    expect(scored.factors.topicStick).toBeGreaterThan(0); // topicStick co-fires via overlap ≥ 2
  });
});

// ── 3-turn integration test ─────────────────────────────────────────────
describe('ChatModule — 3-turn conversation latch integration', () => {
  let db: Database;
  let claude: IClaudeClient;

  beforeEach(() => { db = new Database(':memory:'); claude = makeMockClaude(); });
  afterEach(() => { vi.restoreAllMocks(); });

  // Tokenizer reality: extractTokens('最近有什么live') → ['最近','li','iv','ve'];
  // extractTokens('还有码') → []; extractTokens('6月有啥live') → ['6月','li','iv','ve'].
  // Turn 1 seeds {最近, li, iv, ve}; turn 3 shares {li,iv,ve}=3 overlap ≥ 2 → topicStick
  // co-fires with followUpPhrase on the N月 fact-tail regex. Assert kind='reply' only.
  it('turn 1 seeds, turn 2 preserves, turn 3 replies', async () => {
    // Distinct replies across turns so self-dedup (chat.ts:3107) doesn't silence
    // turns 2/3 on near-duplicate bot output.
    const cyclingClaude = makeCyclingMockClaude(['六月有几场啊', '还有一场', '大概5月底']);
    const chat = makeChat(cyclingClaude, db);

    // Turn 1 — user fires live-query, bot replies
    const r1 = await chat.generateReply('g1', makeMsg({ messageId: 'm1', content: '最近有什么live', rawContent: '最近有什么live' }), []);
    expect(r1.kind).toBe('reply');
    const after1 = getEngaged(chat, 'g1')!;
    expect(after1.tokens.has('最近')).toBe(true);
    expect(after1.tokens.size).toBeGreaterThanOrEqual(2);

    // Turn 2 — user sends 还有码 (FOLLOWUP_FUNCTION_WORDS member). Accumulate path:
    // filter drops any function-word entries; turn-1 tokens are preserved untouched.
    await chat.generateReply('g1', makeMsg({ messageId: 'm2', content: '还有码', rawContent: '还有码' }), []);
    const after2 = getEngaged(chat, 'g1')!;
    expect(after2.tokens.has('最近')).toBe(true);
    // No FOLLOWUP_FUNCTION_WORDS leaked in
    for (const w of ['还有', '还有码', '呢', '然后', '继续']) expect(after2.tokens.has(w)).toBe(false);
    // Token set did not shrink below turn 1
    expect(after2.tokens.size).toBeGreaterThanOrEqual(after1.tokens.size);

    // Turn 3 — `6月有啥live` matches N月 fact-tail regex → followUpPhrase fires.
    // Seeded tokens {最近, li, iv, ve} overlap message tokens {6月, li, iv, ve} = 3 ≥ 2
    // → topicStick also fires. Contract: kind === 'reply'.
    const r3 = await chat.generateReply('g1', makeMsg({ messageId: 'm3', content: '6月有啥live', rawContent: '6月有啥live' }), []);
    expect(r3.kind).toBe('reply');
  });
});
