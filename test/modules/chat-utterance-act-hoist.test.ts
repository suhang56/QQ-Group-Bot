import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatModule } from '../../src/modules/chat.js';
import { Database } from '../../src/storage/db.js';
import type { IClaudeClient, ClaudeResponse } from '../../src/ai/claude.js';
import type { GroupMessage } from '../../src/adapter/napcat.js';
import { initLogger } from '../../src/utils/logger.js';
import { ALL_UTTERANCE_ACTS } from '../../src/utils/utterance-act.js';

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
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
  } as unknown as IClaudeClient;
}

function makeChat(claude: IClaudeClient, db: Database): ChatModule {
  return new ChatModule(claude, db, {
    botUserId: BOT_ID,
    debounceMs: 0,
    chatMinScore: -999,
    maxGroupRepliesPerMinute: 1000,
    moodProactiveEnabled: false,
    deflectCacheEnabled: false,
  });
}

describe('ChatModule R4-lite — utterance_act hoist coverage on guard-exit paths', () => {
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

  // Test 1: Silent timing path (L1660 analogue)
  // Earliest possible early-return: empty content, no @-mention. Hoist at
  // L1657 must fire before this guard so the silent meta carries a
  // non-null utteranceAct.
  it('Test 1: silent (empty content) carries non-null utteranceAct from hoist', async () => {
    const result = await chat.generateReply(
      'g1',
      makeMsg({ content: '', rawContent: '', messageId: 'm1' }),
      [],
    );
    expect(result.kind).toBe('silent');
    expect(result.meta.utteranceAct).toBeDefined();
    expect(result.meta.utteranceAct).not.toBeNull();
    expect(ALL_UTTERANCE_ACTS).toContain(result.meta.utteranceAct);
    // With no signal (empty content, no @-mention, no relay, no fact),
    // classifyUtteranceAct defaults to chime_in.
    expect(result.meta.utteranceAct).toBe('chime_in');
  });

  // Test 2: Group rate-limit silent (L1679 analogue).
  // Exhaust the per-minute group limit, then send one more non-direct
  // message — the L1677 gate fires, returns silent at L1679. Hoist must
  // have fired at L1657 first.
  it('Test 2: silent (rate-limit timing) carries non-null utteranceAct from hoist', async () => {
    const claudeRL = makeClaude();
    const dbRL = new Database(':memory:');
    const chatRL = new ChatModule(claudeRL, dbRL, {
      botUserId: BOT_ID,
      debounceMs: 0,
      chatMinScore: -999,
      maxGroupRepliesPerMinute: 2,
      moodProactiveEnabled: false,
      deflectCacheEnabled: false,
    });
    try {
      // Exhaust the limit (2 non-silent replies bump the minute counter).
      await chatRL.generateReply('g1', makeMsg({ content: 'a', messageId: 'm1' }), []);
      await chatRL.generateReply('g1', makeMsg({ content: 'b', messageId: 'm2' }), []);
      const result = await chatRL.generateReply(
        'g1',
        makeMsg({ content: 'c', messageId: 'm3' }),
        [],
      );
      expect(result.kind).toBe('silent');
      if (result.kind === 'silent') {
        expect(result.reasonCode).toBe('timing');
      }
      expect(result.meta.utteranceAct).toBeDefined();
      expect(ALL_UTTERANCE_ACTS).toContain(result.meta.utteranceAct);
    } finally {
      dbRL.close();
    }
  });

  // Test 3: Fallback / pure-at path (L1776 analogue).
  // Pure @-mention with empty content body → isPureAtMention === true →
  // takes the at_only deflection path lower in the function. Hoist fired
  // already at L1657 (after isPureAtMention is computed). Whatever the
  // final result.kind is (fallback / reply / silent), utteranceAct must
  // be non-null because the hoist set it before any branch.
  it('Test 3: pure-@ mention path carries non-null utteranceAct from hoist', async () => {
    const result = await chat.generateReply(
      'g1',
      makeMsg({
        content: '',
        rawContent: `[CQ:at,qq=${BOT_ID}]`,
        messageId: 'm1',
      }),
      [],
    );
    expect(result.meta.utteranceAct).toBeDefined();
    expect(ALL_UTTERANCE_ACTS).toContain(result.meta.utteranceAct);
  });

  // Test 4: In-flight lock silent (timing-guard analogue, swap from
  // deflection-curse path per architect handoff §"Test 4 fallback":
  // deflection engine mocking is too entangled for unit test. The
  // in-flight lock guard at L1828-ish exits silent with reasonCode
  // 'timing' AFTER the hoist at L1657 — same coverage shape: a
  // pre-L2694 silent exit must carry non-null utteranceAct.
  it('Test 4: in-flight-lock silent (post-hoist guard exit) carries non-null utteranceAct', async () => {
    const inFlight = (chat as unknown as { inFlightGroups: Set<string> }).inFlightGroups;
    inFlight.add('g1');
    try {
      const result = await chat.generateReply(
        'g1',
        makeMsg({ content: 'blocked', messageId: 'm1' }),
        [],
      );
      expect(result.kind).toBe('silent');
      expect(result.meta.utteranceAct).toBeDefined();
      expect(ALL_UTTERANCE_ACTS).toContain(result.meta.utteranceAct);
    } finally {
      inFlight.delete('g1');
    }
  });

  // Test 5: Normal reply path — no regression.
  // A direct @-mention message bypasses timing gates and reaches the LLM
  // (mocked). The hoist fires at L1657 and L2694 overwrites with a more
  // accurate value (full isDirect + fact-retrieval signals). utteranceAct
  // on the final ChatResult must be a valid UtteranceAct — the L2694
  // reclassify wins by idempotent overwrite. Content avoids "bot"/status
  // keywords so the classifier lands on direct_chat (act picked by the
  // L2694 reclassify with isDirect=true), demonstrating the double-call
  // does not corrupt the final value vs the hoist's conservative output.
  it('Test 5: normal reply path retains non-null utteranceAct (hoist + L2694 idempotent)', async () => {
    const atMsg = makeMsg({
      content: '今天天气真好',
      rawContent: `[CQ:at,qq=${BOT_ID}]今天天气真好`,
      messageId: 'm1',
    });
    const result = await chat.generateReply('g1', atMsg, []);
    expect(result.meta.utteranceAct).toBeDefined();
    expect(ALL_UTTERANCE_ACTS).toContain(result.meta.utteranceAct);
    // Direct @-mention + non-bot-referent content + isDirect=true at L2694
    // ⇒ direct_chat. If gating dropped the path to non-reply (e.g. some
    // dampener), the hoist value (chime_in default) is acceptable too —
    // both are valid UtteranceAct values, asserted via ALL_UTTERANCE_ACTS.
    if (result.kind === 'reply') {
      expect(result.meta.utteranceAct).toBe('direct_chat');
    }
  });
});
