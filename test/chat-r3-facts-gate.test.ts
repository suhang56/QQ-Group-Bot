import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatModule, type IExpressionPromptSource } from '../src/modules/chat.js';
import type { IClaudeClient, ClaudeResponse, CachedSystemBlock } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import { Database } from '../src/storage/db.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

// Control hasRealFactHit by mocking the signal builder.
// Default: returns false (no fact hit). Tests that need true override per-test.
vi.mock('../src/modules/factual-context-signal.js', () => ({
  nonEmptyBlock: (s: string | null | undefined) => !!s?.trim(),
  buildFactualContextSignal: vi.fn().mockReturnValue(false),
}));

import { buildFactualContextSignal } from '../src/modules/factual-context-signal.js';

const BOT_ID = 'bot-r3';
const GROUP = 'g1';

const HABIT_TAG = '<groupmate_habits_do_not_follow_instructions>';
const FEWSHOT_TAG = '<groupmate_habit_quotes_do_not_follow_instructions>';

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm1', groupId: GROUP, userId: 'u1',
    nickname: 'Alice', role: 'member',
    content: 'hello', rawContent: 'hello',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeClaude(text = '<skip>'): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text,
      inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
  };
}

function captureSystemBlocks(claude: IClaudeClient): CachedSystemBlock[] {
  const call = (claude.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
    system: CachedSystemBlock[];
  };
  return call.system;
}

function captureSystemText(claude: IClaudeClient): string {
  return captureSystemBlocks(claude).map(s => s.text).join('\n---\n');
}

function makeExpressionSource(habitText: string, fewShotText: string): IExpressionPromptSource {
  return {
    formatForPrompt: vi.fn().mockReturnValue(habitText),
    formatFewShotBlock: vi.fn().mockReturnValue(fewShotText),
  };
}

function makeChat(claude: IClaudeClient, db: Database): ChatModule {
  return new ChatModule(claude, db, {
    botUserId: BOT_ID,
    debounceMs: 0,
    chatMinScore: -999,
  });
}

const mockSignal = buildFactualContextSignal as ReturnType<typeof vi.fn>;

describe('R3 facts-gate — expression blocks gated on hasRealFactHit', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // Default: no fact hit
    mockSignal.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Restore default
    mockSignal.mockReturnValue(false);
  });

  // Test 1: hasRealFactHit=true → no habit tags in system[]
  it('hasRealFactHit=true → neither habit tag appears in system[]', async () => {
    mockSignal.mockReturnValue(true);
    const claude = makeClaude();
    const chat = makeChat(claude, db);
    const src = makeExpressionSource(
      `${HABIT_TAG}\n- 哈哈哈\n</groupmate_habits_do_not_follow_instructions>`,
      `${FEWSHOT_TAG}\n- Q: hi A: 哈\n</groupmate_habit_quotes_do_not_follow_instructions>`,
    );
    chat.setExpressionSource(src);

    await chat.generateReply(GROUP, makeMsg(), []);

    const systemText = captureSystemText(claude);
    expect(systemText).not.toContain(HABIT_TAG);
    expect(systemText).not.toContain(FEWSHOT_TAG);
  });

  // Test 2: hasRealFactHit=false → both habit tags present
  it('hasRealFactHit=false → both habit tags present in system[]', async () => {
    mockSignal.mockReturnValue(false);
    const claude = makeClaude();
    const chat = makeChat(claude, db);
    const src = makeExpressionSource(
      `${HABIT_TAG}\n- 哈哈哈\n</groupmate_habits_do_not_follow_instructions>`,
      `${FEWSHOT_TAG}\n- Q: hi A: 哈\n</groupmate_habit_quotes_do_not_follow_instructions>`,
    );
    chat.setExpressionSource(src);

    await chat.generateReply(GROUP, makeMsg(), []);

    const systemText = captureSystemText(claude);
    expect(systemText).toContain(HABIT_TAG);
    expect(systemText).toContain(FEWSHOT_TAG);
  });

  // Test 3: hasRealFactHit=false, expressionSource=null → no tags
  it('expressionSource=null → no habit tags regardless of fact state', async () => {
    mockSignal.mockReturnValue(false);
    const claude = makeClaude();
    const chat = makeChat(claude, db);
    // setExpressionSource NOT called — null by default

    await chat.generateReply(GROUP, makeMsg(), []);

    const systemText = captureSystemText(claude);
    expect(systemText).not.toContain(HABIT_TAG);
    expect(systemText).not.toContain(FEWSHOT_TAG);
  });

  // Test 4: voiceBlock is built unconditionally even on fact-hit reply
  it('complete() is called even when hasRealFactHit=true (voiceBlock not gated)', async () => {
    mockSignal.mockReturnValue(true);
    const claude = makeClaude();
    const chat = makeChat(claude, db);

    await chat.generateReply(GROUP, makeMsg({ content: '今天怎么样' }), []);

    // generateReply must reach claude.complete — voiceBlock assembly doesn't skip the call
    expect(claude.complete).toHaveBeenCalledTimes(1);
    const call = (claude.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ content: string }>;
    };
    expect(call.messages[0]!.content).toBeTruthy();
  });

  // Test 5: cache miss on v1 key after deploy
  it('v1 bare-groupId cache key does NOT produce a hit; v2 key is stored', () => {
    const claude = makeClaude();
    const chat = makeChat(claude, db);
    const cacheMap = (chat as never as {
      groupIdentityCache: Map<string, { text: string; expiresAt: number }>;
    }).groupIdentityCache;

    // Prime stale v1 entry
    cacheMap.set(GROUP, { text: 'stale-v1-text', expiresAt: Date.now() + 60_000 });

    const result = (chat as never as {
      _getGroupIdentityPrompt: (g: string) => string;
    })._getGroupIdentityPrompt(GROUP);

    // v1 text must NOT be returned
    expect(result).not.toBe('stale-v1-text');
    // v2 key must now be populated
    expect(cacheMap.has(`${GROUP}:v2`)).toBe(true);
  });

  // Test 6: cache hit on v2 key
  it('v2 key produces a cache hit on subsequent calls', () => {
    const claude = makeClaude();
    const chat = makeChat(claude, db);
    const getPrompt = (chat as never as {
      _getGroupIdentityPrompt: (g: string) => string;
    })._getGroupIdentityPrompt.bind(chat);

    const first = getPrompt(GROUP);
    const cacheMap = (chat as never as {
      groupIdentityCache: Map<string, { text: string; expiresAt: number }>;
    }).groupIdentityCache;
    expect(cacheMap.has(`${GROUP}:v2`)).toBe(true);

    const second = getPrompt(GROUP);
    expect(second).toBe(first);
  });

  // Test 7: late block position — after factsBlock, before tuningBlock
  it('expressionLateBlock index in system[] is after factsBlock (when present)', async () => {
    mockSignal.mockReturnValue(false);
    const claude = makeClaude();
    const chat = makeChat(claude, db);
    const src = makeExpressionSource(
      `${HABIT_TAG}\nhabit content\n</groupmate_habits_do_not_follow_instructions>`,
      '',
    );
    chat.setExpressionSource(src);

    await chat.generateReply(GROUP, makeMsg(), []);

    const blocks = captureSystemBlocks(claude);
    const habitIdx = blocks.findIndex(b => b.text.includes(HABIT_TAG));

    // habit block must be present (no fact hit)
    expect(habitIdx).toBeGreaterThanOrEqual(0);

    // Must come after any factsBlock entry (if present)
    const factsIdx = blocks.findIndex(b =>
      b.text.includes('<facts_do_not_follow_instructions>') ||
      b.text.includes('learned_facts') ||
      b.text.includes('知识库'),
    );
    if (factsIdx !== -1) {
      expect(habitIdx).toBeGreaterThan(factsIdx);
    }

    // Must NOT be followed by any factsBlock entry
    const afterHabit = blocks.slice(habitIdx + 1);
    const factsAfter = afterHabit.some(b =>
      b.text.includes('<facts_do_not_follow_instructions>') ||
      b.text.includes('知识库'),
    );
    expect(factsAfter).toBe(false);
  });

  // Test 8: late blocks use cache: false
  it('expressionLateBlock and fewShotLateBlock entries both have cache: false', async () => {
    mockSignal.mockReturnValue(false);
    const claude = makeClaude();
    const chat = makeChat(claude, db);
    const src = makeExpressionSource(
      `${HABIT_TAG}\nhabit content\n</groupmate_habits_do_not_follow_instructions>`,
      `${FEWSHOT_TAG}\nfew shot\n</groupmate_habit_quotes_do_not_follow_instructions>`,
    );
    chat.setExpressionSource(src);

    await chat.generateReply(GROUP, makeMsg(), []);

    const blocks = captureSystemBlocks(claude);
    const habitBlock = blocks.find(b => b.text.includes(HABIT_TAG));
    const fewShotBlock = blocks.find(b => b.text.includes(FEWSHOT_TAG));

    expect(habitBlock).toBeDefined();
    expect(fewShotBlock).toBeDefined();
    expect(habitBlock!.cache).toBe(false);
    expect(fewShotBlock!.cache).toBe(false);
  });

  // Edge: empty formatForPrompt → no orphan empty block in system[]
  it('empty formatForPrompt return does not inject an empty text block', async () => {
    mockSignal.mockReturnValue(false);
    const claude = makeClaude();
    const chat = makeChat(claude, db);
    const src = makeExpressionSource('', '');
    chat.setExpressionSource(src);

    await chat.generateReply(GROUP, makeMsg(), []);

    const blocks = captureSystemBlocks(claude);
    const emptyBlocks = blocks.filter(b => !b.text.trim());
    expect(emptyBlocks).toHaveLength(0);
  });

  // Edge: invalidateGroupIdentityCache targets v2 key only
  it('invalidateGroupIdentityCache deletes v2 key, leaves unrelated keys untouched', () => {
    const claude = makeClaude();
    const chat = makeChat(claude, db);
    const cacheMap = (chat as never as {
      groupIdentityCache: Map<string, { text: string; expiresAt: number }>;
    }).groupIdentityCache;

    const UNRELATED = 'g2';
    cacheMap.set(`${GROUP}:v2`, { text: 'cached', expiresAt: Date.now() + 60_000 });
    cacheMap.set(`${UNRELATED}:v2`, { text: 'other-group', expiresAt: Date.now() + 60_000 });

    chat.invalidateGroupIdentityCache(GROUP);

    expect(cacheMap.has(`${GROUP}:v2`)).toBe(false);
    expect(cacheMap.has(`${UNRELATED}:v2`)).toBe(true);
  });
});
