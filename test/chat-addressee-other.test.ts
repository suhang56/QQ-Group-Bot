/**
 * chat-addressee-other.test.ts
 *
 * Integration tests for the addressee-other silent guard in
 * ChatModule._generateReplyImpl. Verifies that triggers explicitly
 * @-targeting a non-bot user (and not reply-to-bot) short-circuit
 * to silent BEFORE adversarial classifiers, preChatJudge, vision,
 * and any LLM call.
 *
 * Live reproducer: row #7085 trigger
 *   [CQ:at,qq=987326549] 你选个合照写个文案
 * The TASK_REQUEST regex matches '写个文案'; without this guard the
 * adversarial path produced an outsider 'no interest' deflection.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChatModule } from '../src/modules/chat.js';
import { Database } from '../src/storage/db.js';
import { initLogger } from '../src/utils/logger.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import { isSilent } from '../src/utils/chat-result.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-555';
const OTHER_USER = '987326549';

function makeClaude(): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text: 'should-not-be-called',
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
  };
}

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  const base: GroupMessage = {
    messageId: `m-${Math.random().toString(36).slice(2, 8)}`,
    groupId: 'g1',
    userId: 'u-1',
    nickname: 'User',
    role: 'member',
    content: 'placeholder',
    rawContent: 'placeholder',
    timestamp: Math.floor(Date.now() / 1000),
  };
  return { ...base, ...overrides };
}

function makeChat(claude: IClaudeClient, db: Database): ChatModule {
  return new ChatModule(claude, db, {
    botUserId: BOT_ID,
    debounceMs: 0,
    chatMinScore: -999,
  });
}

describe('ChatModule — addressee-other silent guard', () => {
  let db: Database;
  let claude: IClaudeClient;
  let chat: ChatModule;

  beforeEach(() => {
    db = new Database(':memory:');
    claude = makeClaude();
    chat = makeChat(claude, db);
  });

  it('T1: live reproducer — @-other + TASK_REQUEST text returns silent addressee-other (no LLM call)', async () => {
    const msg = makeMsg({
      rawContent: `[CQ:at,qq=${OTHER_USER}] 你选个合照写个文案`,
      content: '你选个合照写个文案',
    });

    const result = await chat.generateReply('g1', msg, []);

    expect(isSilent(result)).toBe(true);
    if (result.kind === 'silent') {
      expect(result.reasonCode).toBe('addressee-other');
    }
    expect(claude.complete).not.toHaveBeenCalled();
  });

  it('T2: @-other + benign text returns silent addressee-other', async () => {
    const msg = makeMsg({
      rawContent: `[CQ:at,qq=${OTHER_USER}] hello`,
      content: 'hello',
    });

    const result = await chat.generateReply('g1', msg, []);

    expect(isSilent(result)).toBe(true);
    if (result.kind === 'silent') {
      expect(result.reasonCode).toBe('addressee-other');
    }
  });

  it('T3: @-bot + TASK_REQUEST text — guard does NOT fire (bot is addressee)', async () => {
    const msg = makeMsg({
      rawContent: `[CQ:at,qq=${BOT_ID}] 你写个文案`,
      content: '你写个文案',
    });

    const result = await chat.generateReply('g1', msg, []);

    if (result.kind === 'silent') {
      expect(result.reasonCode).not.toBe('addressee-other');
    }
  });

  it('T4: @-bot AND @-other (mixed) — guard does NOT fire (bot among addressees)', async () => {
    const msg = makeMsg({
      rawContent: `[CQ:at,qq=${BOT_ID}][CQ:at,qq=${OTHER_USER}] 帮个忙`,
      content: '帮个忙',
    });

    const result = await chat.generateReply('g1', msg, []);

    if (result.kind === 'silent') {
      expect(result.reasonCode).not.toBe('addressee-other');
    }
  });

  it('T5: reply-to-bot (no @) — guard does NOT fire (bot reply-target wins)', async () => {
    // Populate outgoingMsgIds via the public recorder.
    chat.recordOutgoingMessage('g1', 12345);

    const msg = makeMsg({
      rawContent: `[CQ:reply,id=12345] hello`,
      content: 'hello',
    });

    const result = await chat.generateReply('g1', msg, []);

    if (result.kind === 'silent') {
      expect(result.reasonCode).not.toBe('addressee-other');
    }
  });

  it('T6: reply-to-bot AND @-other — replyToBot wins, guard does NOT fire', async () => {
    chat.recordOutgoingMessage('g1', 12345);

    const msg = makeMsg({
      rawContent: `[CQ:at,qq=${OTHER_USER}][CQ:reply,id=12345] hello`,
      content: 'hello',
    });

    const result = await chat.generateReply('g1', msg, []);

    if (result.kind === 'silent') {
      expect(result.reasonCode).not.toBe('addressee-other');
    }
  });

  it('T7: plain text, no @ — guard does NOT fire (chime-in path preserved)', async () => {
    const msg = makeMsg({
      rawContent: '今天天气真好',
      content: '今天天气真好',
    });

    const result = await chat.generateReply('g1', msg, []);

    if (result.kind === 'silent') {
      expect(result.reasonCode).not.toBe('addressee-other');
    }
  });

  it('T8: pure @-bot (existing pure-@ deflection unchanged) — guard does NOT fire', async () => {
    const msg = makeMsg({
      rawContent: `[CQ:at,qq=${BOT_ID}]`,
      content: '',
    });

    const result = await chat.generateReply('g1', msg, []);

    // Pure-@ to bot returns a fallback at_only deflection, not silent
    // addressee-other. Either way, reasonCode must NOT be addressee-other.
    if (result.kind === 'silent') {
      expect(result.reasonCode).not.toBe('addressee-other');
    }
  });

  it('T9: @all broadcast — guard does NOT fire (group broadcast, not directed)', async () => {
    const msg = makeMsg({
      rawContent: `[CQ:at,qq=all] hello`,
      content: 'hello',
    });

    const result = await chat.generateReply('g1', msg, []);

    if (result.kind === 'silent') {
      expect(result.reasonCode).not.toBe('addressee-other');
    }
  });

  it('determinism: T1 fires silent addressee-other reliably across 5 runs (no LLM-mock flake)', async () => {
    for (let i = 0; i < 5; i++) {
      const freshDb = new Database(':memory:');
      const freshClaude = makeClaude();
      const freshChat = makeChat(freshClaude, freshDb);
      const msg = makeMsg({
        messageId: `m-stress-${i}`,
        rawContent: `[CQ:at,qq=${OTHER_USER}] 你选个合照写个文案`,
        content: '你选个合照写个文案',
      });
      const result = await freshChat.generateReply('g1', msg, []);
      expect(isSilent(result)).toBe(true);
      if (result.kind === 'silent') {
        expect(result.reasonCode).toBe('addressee-other');
      }
      expect(freshClaude.complete).not.toHaveBeenCalled();
    }
  });
});
