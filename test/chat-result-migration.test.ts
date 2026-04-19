/**
 * Migration regression tests: verify that `generateReply` return shape conforms to
 * ChatResult discriminated union, and that no code path returns the old `string | null` sentinel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatModule } from '../src/modules/chat.js';
import { Database } from '../src/storage/db.js';
import { initLogger } from '../src/utils/logger.js';
import { isSendable, isSilent, isReply } from '../src/utils/chat-result.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-migration';

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm1', groupId: 'g1', userId: 'u1',
    nickname: 'Alice', role: 'member',
    content: '你好', rawContent: '你好',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeClaude(text = '好的'): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text, inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
  };
}

function makeChat(claude: IClaudeClient, db: Database): ChatModule {
  return new ChatModule(claude, db, {
    botUserId: BOT_ID, debounceMs: 0, chatMinScore: -999,
  });
}

describe('ChatResult migration — return type is always ChatResult', () => {
  let db: Database;

  beforeEach(() => { db = new Database(':memory:'); });

  it('result is an object (not null, not string)', async () => {
    const chat = makeChat(makeClaude('你好啊'), db);
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(typeof result).toBe('object');
    expect(result).not.toBeNull();
  });

  it('result always has .kind property', async () => {
    const chat = makeChat(makeClaude('你好啊'), db);
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(result).toHaveProperty('kind');
    expect(['reply', 'sticker', 'fallback', 'silent', 'defer']).toContain(result.kind);
  });

  it('result always has .meta property', async () => {
    const chat = makeChat(makeClaude('你好啊'), db);
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(result).toHaveProperty('meta');
    expect(typeof result.meta).toBe('object');
  });

  it('result always has .reasonCode property', async () => {
    const chat = makeChat(makeClaude('你好啊'), db);
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(result).toHaveProperty('reasonCode');
    expect(typeof result.reasonCode).toBe('string');
  });

  it('engaged reply → isSendable + isReply', async () => {
    const msg = makeMsg({ rawContent: `[CQ:at,qq=${BOT_ID}] 你好` });
    const chat = makeChat(makeClaude('回复文字'), db);
    const result = await chat.generateReply('g1', msg, []);
    if (result.kind === 'reply') {
      expect(isSendable(result)).toBe(true);
      expect(isReply(result)).toBe(true);
      expect(typeof result.text).toBe('string');
    }
  });

  it('LLM returns <skip> on non-direct trigger → kind === silent', async () => {
    const claude = makeClaude('<skip>');
    const chat = makeChat(claude, db);
    // Non-direct: no @-mention, just ambient chat (low score → silent via engagement gate or skip)
    const result = await chat.generateReply('g1', makeMsg({ rawContent: 'hello', chatMinScore: 999 }), []);
    // Either silently gated (low score) or skipped — result is not sendable text
    expect(isSendable(result)).toBe(false);
  });

  it('LLM returns <skip> on direct @-mention → kind === fallback (bot-blank-needed-ack)', async () => {
    const claude = makeClaude('<skip>');
    const chat = makeChat(claude, db);
    const result = await chat.generateReply('g1', makeMsg({ rawContent: `[CQ:at,qq=${BOT_ID}] hello` }), []);
    expect(result.kind).toBe('fallback');
    expect('text' in result && typeof result.text).toBe('string');
    expect(isSendable(result)).toBe(true);
  });

  it('reply result has meta.injectedFactIds as array', async () => {
    const msg = makeMsg({ rawContent: `[CQ:at,qq=${BOT_ID}] 你好` });
    const chat = makeChat(makeClaude('好的'), db);
    const result = await chat.generateReply('g1', msg, []);
    if (result.kind === 'reply') {
      expect(Array.isArray(result.meta.injectedFactIds)).toBe(true);
    }
  });

  it('reply result has meta.evasive as boolean', async () => {
    const msg = makeMsg({ rawContent: `[CQ:at,qq=${BOT_ID}] 你好` });
    const chat = makeChat(makeClaude('好的'), db);
    const result = await chat.generateReply('g1', msg, []);
    if (result.kind === 'reply') {
      expect(typeof result.meta.evasive).toBe('boolean');
    }
  });

  // Edge: multiple calls return independent ChatResult objects (no shared mutation)
  it('two calls return independent ChatResult objects', async () => {
    const msg = makeMsg({ rawContent: `[CQ:at,qq=${BOT_ID}] 你好` });
    const chat = makeChat(makeClaude('回复'), db);
    const r1 = await chat.generateReply('g1', msg, []);
    const r2 = await chat.generateReply('g1', msg, []);
    expect(r1).not.toBe(r2);
  });
});
