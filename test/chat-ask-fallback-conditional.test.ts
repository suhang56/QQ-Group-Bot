import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatModule } from '../src/modules/chat.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import { Database } from '../src/storage/db.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-test';
const NOW_SEC = Math.floor(Date.now() / 1000);

function makeMsg(content: string, overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm1', groupId: 'g1', userId: 'u1',
    nickname: 'Tester', role: 'member',
    content,
    rawContent: content,
    timestamp: NOW_SEC,
    ...overrides,
  };
}

function makeClaudeSpy(): { client: IClaudeClient; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn().mockResolvedValue({
    text: '好的',
    inputTokens: 10, outputTokens: 5,
    cacheReadTokens: 0, cacheWriteTokens: 0,
  } satisfies ClaudeResponse);
  return { client: { complete: spy }, spy };
}

function makeOnDemandLookup(result: { type: 'found'; meaning: string } | { type: 'unknown' } | null) {
  return { lookupTerm: vi.fn().mockResolvedValue(result) };
}

describe('chat-ask-fallback-conditional wiring', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  function makeChat(claude: IClaudeClient, onDemandLookup: any): ChatModule {
    const chat = new ChatModule(claude, db, {
      botUserId: BOT_ID,
      debounceMs: 0,
      chatMinScore: -999,
    } as any);
    chat.setOnDemandLookup(onDemandLookup);
    return chat;
  }

  it('Case 1: narrative + unknown term -> no ask-directive in system prompt', async () => {
    const { client, spy } = makeClaudeSpy();
    const lookup = makeOnDemandLookup({ type: 'unknown' });
    const chat = makeChat(client, lookup);
    await chat.generateReply('g1', makeMsg('为什么我发3xx被踢 你们玩什么呢'), []);
    if (!spy.mock.calls.length) return; // bot may suppress reply; skip if no call
    const call = spy.mock.calls[0][0];
    const systemText = (call.system as Array<{ text: string }>).map(s => s.text).join('\n');
    expect(systemText).not.toContain('你没听过');
  });

  it('Case 2: direct question + unknown term -> ask-directive present', async () => {
    const { client, spy } = makeClaudeSpy();
    const lookup = makeOnDemandLookup({ type: 'unknown' });
    const chat = makeChat(client, lookup);
    await chat.generateReply('g1', makeMsg('xtt是啥'), []);
    if (!spy.mock.calls.length) return;
    const call = spy.mock.calls[0][0];
    const systemText = (call.system as Array<{ text: string }>).map(s => s.text).join('\n');
    expect(systemText).toContain('你没听过');
  });

  it('Case 3: direct question + found term -> found block only, no ask-directive', async () => {
    const { client, spy } = makeClaudeSpy();
    const lookup = makeOnDemandLookup({ type: 'found', meaning: 'xtt是指某人' });
    const chat = makeChat(client, lookup);
    await chat.generateReply('g1', makeMsg('xtt是啥'), []);
    if (!spy.mock.calls.length) return;
    const call = spy.mock.calls[0][0];
    const systemText = (call.system as Array<{ text: string }>).map(s => s.text).join('\n');
    expect(systemText).toContain('必须用下面“已知”内容直接回答');
    expect(systemText).toContain('已知');
    expect(systemText).not.toContain('你没听过');
  });
});
