import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatModule } from '../src/modules/chat.js';
import { Database } from '../src/storage/db.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-123';

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm1',
    groupId: 'g1',
    userId: 'peer',
    nickname: 'Peer',
    role: 'member',
    content: 'hello',
    rawContent: 'hello',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeClaude(text = 'bot reply'): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text,
      inputTokens: 1, outputTokens: 1,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
  };
}

// maxGroupRepliesPerMinute=2 keeps the test fast; we exhaust with 2 non-direct
// bumps then assert the 3rd non-direct is silent, and a direct signal on the
// 3rd call bypasses the gate.
function makeChat(claude: IClaudeClient, db: Database): ChatModule {
  return new ChatModule(claude, db, {
    botUserId: BOT_ID,
    debounceMs: 0,
    chatMinScore: -999,
    maxGroupRepliesPerMinute: 2,
  });
}

describe('ChatModule R2a — direct override bypasses group rate limit', () => {
  let db: Database;
  let claude: IClaudeClient;
  let chat: ChatModule;

  beforeEach(() => {
    db = new Database(':memory:');
    claude = makeClaude();
    chat = makeChat(claude, db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  async function exhaustLimit(): Promise<void> {
    // Each non-silent generateReply returns true from _checkGroupLimit, bumping
    // the minute counter by 1. After maxGroupRepliesPerMinute=2 bumps, the 3rd
    // non-direct call will hit the silent-timing branch.
    await chat.generateReply('g1', makeMsg({ content: 'a', messageId: 'm1' }), []);
    await chat.generateReply('g1', makeMsg({ content: 'b', messageId: 'm2' }), []);
  }

  it('baseline: non-direct message is silenced when group rate limit is exhausted', async () => {
    await exhaustLimit();
    const result = await chat.generateReply(
      'g1',
      makeMsg({ content: 'c', messageId: 'm3' }),
      [],
    );
    expect(result.kind).toBe('silent');
    if (result.kind === 'silent') expect(result.reasonCode).toBe('timing');
  });

  it('direct override: @bot bypasses the group rate limit (LLM reached)', async () => {
    await exhaustLimit();
    const callsBefore = (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    const atMsg = makeMsg({
      content: 'hello bot',
      rawContent: `[CQ:at,qq=${BOT_ID}]hello bot`,
      messageId: 'm3',
    });
    await chat.generateReply('g1', atMsg, []);
    // Bypass assertion: claude.complete was invoked (rate-limit gate didn't
    // short-circuit). Downstream gates may still modulate the final result.
    expect(
      (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(callsBefore);
  });

  it('direct override: CQ:reply quoting a bot-authored message bypasses the group rate limit', async () => {
    await exhaustLimit();
    const callsBefore = (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    const botRecent: GroupMessage = {
      messageId: '9001',
      groupId: 'g1',
      userId: BOT_ID,
      nickname: 'bot',
      role: 'member',
      content: 'earlier bot reply',
      rawContent: 'earlier bot reply',
      timestamp: Math.floor(Date.now() / 1000) - 1,
    };
    const replyMsg = makeMsg({
      content: 'yo',
      rawContent: '[CQ:reply,id=9001]yo',
      messageId: 'm3',
    });
    await chat.generateReply('g1', replyMsg, [botRecent]);
    expect(
      (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(callsBefore);
  });

  it('direct override: CQ:reply quoting a NON-bot message does NOT bypass rate limit', async () => {
    await exhaustLimit();
    const peerRecent: GroupMessage = {
      messageId: '9002',
      groupId: 'g1',
      userId: 'other-peer',
      nickname: 'other',
      role: 'member',
      content: 'earlier peer msg',
      rawContent: 'earlier peer msg',
      timestamp: Math.floor(Date.now() / 1000) - 1,
    };
    const replyMsg = makeMsg({
      content: 'yo',
      rawContent: '[CQ:reply,id=9002]yo',
      messageId: 'm3',
    });
    const result = await chat.generateReply('g1', replyMsg, [peerRecent]);
    expect(result.kind).toBe('silent');
    if (result.kind === 'silent') expect(result.reasonCode).toBe('timing');
  });

  it('direct override does NOT fire when botUserId is unset', async () => {
    const chatNoBot = new ChatModule(claude, db, {
      debounceMs: 0,
      chatMinScore: -999,
      maxGroupRepliesPerMinute: 2,
    });
    await chatNoBot.generateReply('g1', makeMsg({ content: 'a' }), []);
    await chatNoBot.generateReply('g1', makeMsg({ content: 'b' }), []);
    const atLike = makeMsg({
      content: 'hi',
      rawContent: '[CQ:at,qq=other]hi',
      messageId: 'm3',
    });
    const result = await chatNoBot.generateReply('g1', atLike, []);
    expect(result.kind).toBe('silent');
  });
});

// Separate chat factory for debounce cases — needs a non-zero debounceMs and
// loose rate limit so only the debounce gate fires.
function makeChatDebounce(claude: IClaudeClient, db: Database): ChatModule {
  return new ChatModule(claude, db, {
    botUserId: BOT_ID,
    debounceMs: 5_000,
    chatMinScore: -999,
    maxGroupRepliesPerMinute: 1000,
  });
}

describe('ChatModule R2a — direct override bypasses debounce', () => {
  let db: Database;
  let claude: IClaudeClient;
  let chat: ChatModule;

  beforeEach(() => {
    db = new Database(':memory:');
    claude = makeClaude();
    chat = makeChatDebounce(claude, db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it('baseline: non-direct follow-up within debounce window is silenced', async () => {
    await chat.generateReply('g1', makeMsg({ content: 'first', messageId: 'm1' }), []);
    const second = await chat.generateReply(
      'g1',
      makeMsg({ content: 'second', messageId: 'm2' }),
      [],
    );
    expect(second.kind).toBe('silent');
    if (second.kind === 'silent') expect(second.reasonCode).toBe('timing');
  });

  it('direct @bot bypasses debounce window (LLM reached)', async () => {
    await chat.generateReply('g1', makeMsg({ content: 'first', messageId: 'm1' }), []);
    const callsBefore = (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    const atMsg = makeMsg({
      content: 'hey bot',
      rawContent: `[CQ:at,qq=${BOT_ID}]hey bot`,
      messageId: 'm2',
    });
    await chat.generateReply('g1', atMsg, []);
    expect(
      (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(callsBefore);
  });

  it('direct reply-to-bot bypasses debounce window', async () => {
    await chat.generateReply('g1', makeMsg({ content: 'first', messageId: 'm1' }), []);
    const callsBefore = (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    const botRecent: GroupMessage = {
      messageId: '9001',
      groupId: 'g1',
      userId: BOT_ID,
      nickname: 'bot',
      role: 'member',
      content: 'earlier bot reply',
      rawContent: 'earlier bot reply',
      timestamp: Math.floor(Date.now() / 1000) - 1,
    };
    const replyMsg = makeMsg({
      content: 'yo',
      rawContent: '[CQ:reply,id=9001]yo',
      messageId: 'm2',
    });
    await chat.generateReply('g1', replyMsg, [botRecent]);
    expect(
      (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(callsBefore);
  });

  it('debounceMap is still updated on direct paths (signal preserved for proactive gates)', async () => {
    await chat.generateReply('g1', makeMsg({ content: 'first', messageId: 'm1' }), []);
    const atMsg = makeMsg({
      content: 'hey bot',
      rawContent: `[CQ:at,qq=${BOT_ID}]hey bot`,
      messageId: 'm2',
    });
    await chat.generateReply('g1', atMsg, []);
    // Immediate non-direct follow-up must still be debounced — proves the
    // direct call DID update debounceMap.
    const third = await chat.generateReply(
      'g1',
      makeMsg({ content: 'third', messageId: 'm3' }),
      [],
    );
    expect(third.kind).toBe('silent');
    if (third.kind === 'silent') expect(third.reasonCode).toBe('timing');
  });
});

describe('ChatModule R2a — direct override bypasses in-flight lock', () => {
  let db: Database;
  let claude: IClaudeClient;
  let chat: ChatModule;

  beforeEach(() => {
    db = new Database(':memory:');
    claude = makeClaude();
    chat = new ChatModule(claude, db, {
      botUserId: BOT_ID,
      debounceMs: 0,
      chatMinScore: -999,
      maxGroupRepliesPerMinute: 1000,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it('non-direct message is silenced while a reply is in-flight for the group', async () => {
    const inFlight = (chat as unknown as { inFlightGroups: Set<string> }).inFlightGroups;
    inFlight.add('g1');
    try {
      const result = await chat.generateReply(
        'g1',
        makeMsg({ content: 'blocked', messageId: 'm1' }),
        [],
      );
      expect(result.kind).toBe('silent');
      if (result.kind === 'silent') expect(result.reasonCode).toBe('timing');
    } finally {
      inFlight.delete('g1');
    }
  });

  it('direct @bot bypasses the in-flight lock', async () => {
    const inFlight = (chat as unknown as { inFlightGroups: Set<string> }).inFlightGroups;
    inFlight.add('g1');
    try {
      const atMsg = makeMsg({
        content: 'direct',
        rawContent: `[CQ:at,qq=${BOT_ID}]direct`,
        messageId: 'm1',
      });
      const result = await chat.generateReply('g1', atMsg, []);
      // Bypass must not short-circuit at the in-flight gate; if anything
      // silences, it must be a non-timing downstream reason.
      if (result.kind === 'silent') expect(result.reasonCode).not.toBe('timing');
    } finally {
      inFlight.delete('g1');
    }
  });
});

describe('ChatModule R2a — atMentionIgnoreUntil is NOT bypassed (legitimate abuse protection)', () => {
  let db: Database;
  let claude: IClaudeClient;
  let chat: ChatModule;

  beforeEach(() => {
    db = new Database(':memory:');
    claude = makeClaude();
    chat = new ChatModule(claude, db, {
      botUserId: BOT_ID,
      debounceMs: 0,
      chatMinScore: -999,
      maxGroupRepliesPerMinute: 1000,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it('direct @ from an ignored user still silences with bot-triggered reason', async () => {
    const ignoreMap = (chat as unknown as {
      atMentionIgnoreUntil: Map<string, number>;
    }).atMentionIgnoreUntil;
    ignoreMap.set('g1:peer', Date.now() + 60_000);
    const atMsg = makeMsg({
      content: 'direct',
      rawContent: `[CQ:at,qq=${BOT_ID}]direct`,
      messageId: 'm1',
    });
    const result = await chat.generateReply('g1', atMsg, []);
    expect(result.kind).toBe('silent');
    if (result.kind === 'silent') expect(result.reasonCode).toBe('bot-triggered');
  });
});
