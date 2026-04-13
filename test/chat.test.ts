import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatModule } from '../src/modules/chat.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import { Database } from '../src/storage/db.js';
import { ClaudeApiError } from '../src/utils/errors.js';
import { initLogger } from '../src/utils/logger.js';
import { BotErrorCode } from '../src/utils/errors.js';

initLogger({ level: 'silent' });

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

describe('ChatModule', () => {
  let db: Database;
  let claude: IClaudeClient;
  let chat: ChatModule;

  beforeEach(() => {
    db = new Database(':memory:');
    claude = makeMockClaude();
    chat = new ChatModule(claude, db);
  });

  it('generateReply returns text from Claude', async () => {
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(result).toBe('bot reply');
  });

  it('uses recent messages as few-shot context', async () => {
    // Insert some history
    const ts = Math.floor(Date.now() / 1000);
    db.messages.insert({ groupId: 'g1', userId: 'u2', nickname: 'Bob', content: 'sup', timestamp: ts - 10, deleted: false });
    db.messages.insert({ groupId: 'g1', userId: 'u3', nickname: 'Carol', content: 'yo', timestamp: ts - 5, deleted: false });

    const recentMsgs = db.messages.getRecent('g1', 20);
    await chat.generateReply('g1', makeMsg(), recentMsgs);

    const call = (claude.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { messages: Array<{ content: string }> };
    // The recent messages should appear in the prompt
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
    // Saturate the group reply count
    chat = new ChatModule(claude, db, { maxGroupRepliesPerMinute: 0 });
    const result = await chat.generateReply('g1', makeMsg(), []);
    expect(result).toBeNull();
  });

  it('debounces consecutive messages (same group, within window)', async () => {
    vi.useFakeTimers();
    chat = new ChatModule(claude, db, { debounceMs: 2000 });

    const p1 = chat.generateReply('g1', makeMsg({ content: 'msg1' }), []);
    const p2 = chat.generateReply('g1', makeMsg({ content: 'msg2' }), []);

    // Advance past debounce
    vi.advanceTimersByTime(2100);
    const [r1, r2] = await Promise.all([p1, p2]);

    // Only the last message in the debounce window should trigger a Claude call
    const callCount = (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callCount).toBeLessThanOrEqual(1);
    // The other should be null (debounced away)
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
    // Empty content — no meaningful trigger, return null
    expect(result).toBeNull();
  });
});
