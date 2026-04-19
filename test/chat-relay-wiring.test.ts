import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatModule } from '../src/modules/chat.js';
import { Database } from '../src/storage/db.js';
import { initLogger } from '../src/utils/logger.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';

initLogger({ level: 'silent' });

vi.mock('../src/modules/relay-detector.js', () => ({
  detectRelay: vi.fn(),
}));

import { detectRelay } from '../src/modules/relay-detector.js';

const BOT_ID = 'bot-relay';

function makeClaude(): IClaudeClient {
  let counter = 0;
  return {
    complete: vi.fn().mockImplementation(async (): Promise<ClaudeResponse> => ({
      text: `normal reply ${counter++} topic ${Math.random().toString(36).slice(2, 8)}`,
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
    })),
  };
}

function makeMsg(content = 'hi', overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: `m-${Math.random().toString(36).slice(2, 8)}`,
    groupId: 'g1',
    userId: 'u1',
    nickname: 'User',
    role: 'member',
    content,
    rawContent: content,
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeChat(claude: IClaudeClient, db: Database): ChatModule {
  return new ChatModule(claude, db, {
    botUserId: BOT_ID,
    debounceMs: 0,
    chatMinScore: -999,
  });
}

describe('chat relay wiring', () => {
  let db: Database;
  let claude: IClaudeClient;
  let chat: ChatModule;

  beforeEach(() => {
    db = new Database(':memory:');
    claude = makeClaude();
    chat = makeChat(claude, db);
    vi.mocked(detectRelay).mockReset();
  });

  it('1: relay detected + random < 0.5 + cooldown clear -> verbatim reply, no LLM', async () => {
    vi.mocked(detectRelay).mockReturnValue({ kind: 'echo', content: '帅', chainLength: 3 });
    vi.spyOn(Math, 'random').mockReturnValue(0.3);

    const callsBefore = (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    const result = await chat.generateReply('g1', makeMsg('帅'), []);

    expect(result.kind).toBe('reply');
    expect('text' in result && result.text).toBe('帅');
    expect((claude.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);

    vi.restoreAllMocks();
  });

  it('2: relay detected + random >= 0.5 -> null, no LLM', async () => {
    vi.mocked(detectRelay).mockReturnValue({ kind: 'echo', content: '帅', chainLength: 3 });
    vi.spyOn(Math, 'random').mockReturnValue(0.7);

    const callsBefore = (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    const result = await chat.generateReply('g1', makeMsg('帅'), []);

    expect(result.kind).toBe('silent');
    expect((claude.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);

    vi.restoreAllMocks();
  });

  it('3: relay detected + cooldown active (< 2 min) -> null, no LLM', async () => {
    vi.mocked(detectRelay).mockReturnValue({ kind: 'echo', content: '帅', chainLength: 3 });
    vi.spyOn(Math, 'random').mockReturnValue(0.3);

    // Pre-set lastProactiveReply to 1 minute ago
    (chat as unknown as { lastProactiveReply: Map<string, number> })
      .lastProactiveReply.set('g1', Date.now() - 60 * 1000);

    const callsBefore = (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    const result = await chat.generateReply('g1', makeMsg('帅'), []);

    expect(result.kind).toBe('silent');
    expect((claude.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);

    vi.restoreAllMocks();
  });

  it('4: no relay (detectRelay null), engagement fires -> LLM called once', async () => {
    vi.mocked(detectRelay).mockReturnValue(null);

    // Send an @-mention to ensure shouldReply = true
    const atMsg = makeMsg('hello bot', {
      rawContent: `[CQ:at,qq=${BOT_ID}] hello bot`,
    });

    const callsBefore = (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    const result = await chat.generateReply('g1', atMsg, []);

    // With chatMinScore=-999, the engagement gate passes; LLM must be called
    expect((claude.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore);
    expect(result.kind).not.toBe('silent');
  });
});
