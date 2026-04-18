import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatModule } from '../src/modules/chat.js';
import { Database } from '../src/storage/db.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-9999';

function makeCapturingClaude(capture: { prompt: string }): IClaudeClient {
  return {
    complete: vi.fn().mockImplementation(
      async (args: { systemPrompt?: string; messages?: Array<{ content: string }> }) => {
        const sys = args.systemPrompt ?? '';
        const user = args.messages?.map(m => m.content).join('\n') ?? '';
        capture.prompt = `${sys}\n${user}`;
        return {
          text: '<skip>',
          inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, cacheWriteTokens: 0,
        } satisfies ClaudeResponse;
      },
    ),
  };
}

function makeTriggerMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'trigger-1',
    groupId: 'g1',
    userId: 'u2',
    nickname: '西瓜',
    role: 'member',
    content: 'ygfn是谁啊',
    rawContent: 'ygfn是谁啊',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe('chat group-context render — bot rows tagged as [你(...)]:', () => {
  let db: Database;
  let capture: { prompt: string };
  let claude: IClaudeClient;
  let chat: ChatModule;

  beforeEach(() => {
    db = new Database(':memory:');
    capture = { prompt: '' };
    claude = makeCapturingClaude(capture);
    chat = new ChatModule(claude, db, {
      botUserId: BOT_ID,
      debounceMs: 0,
      chatMinScore: -999,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('seeded bot row renders as [你(机器人)]: in prompt; user row as [nickname]:', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Seed bot row first (older) and a user row (newer).
    db.messages.insert({
      groupId: 'g1', userId: BOT_ID, nickname: '机器人',
      content: '羊宫妃那啊 那个声优',
      rawContent: '羊宫妃那啊 那个声优',
      timestamp: now - 60, deleted: false,
    }, 'bot-1');
    db.messages.insert({
      groupId: 'g1', userId: 'u2', nickname: '西瓜',
      content: 'ygfn是谁啊',
      rawContent: 'ygfn是谁啊',
      timestamp: now - 30, deleted: false,
    }, 'u2-1');

    const result = await chat.generateReply('g1', makeTriggerMsg(), db.messages.getRecent('g1', 20));

    // <skip> sentinel → null reply is fine; we only care about the prompt the
    // LLM was given.
    expect(result).toBeNull();
    expect(claude.complete).toHaveBeenCalledTimes(1);

    expect(capture.prompt).toContain('[你(机器人)]: 羊宫妃那啊 那个声优');
    expect(capture.prompt).toContain('[西瓜]: ygfn是谁啊');
    // Bot row must NOT render as a bare peer tag.
    expect(capture.prompt).not.toContain('[机器人]: 羊宫妃那啊');
  });
});
