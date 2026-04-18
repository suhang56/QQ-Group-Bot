import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatModule, type IHonestGapsPromptSource } from '../src/modules/chat.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import { Database } from '../src/storage/db.js';
import { initLogger } from '../src/utils/logger.js';

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

function makeMockClaude(text = 'bot reply'): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text,
      inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
  };
}

function makeChat(claude: IClaudeClient, db: Database): ChatModule {
  return new ChatModule(claude, db, {
    botUserId: BOT_ID,
    debounceMs: 0,
    chatMinScore: -999,
  });
}

function captureSystem(claude: IClaudeClient) {
  const call = (claude.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
    system: Array<{ text: string }>;
  };
  return call.system.map(s => s.text).join('\n---\n');
}

describe('ChatModule — honest-gaps wiring', () => {
  let db: Database;
  let claude: IClaudeClient;

  beforeEach(() => {
    db = new Database(':memory:');
    claude = makeMockClaude();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('omits honest-gaps section when source returns empty (no dead tag in system prompt)', async () => {
    const source: IHonestGapsPromptSource = {
      formatForPrompt: vi.fn().mockReturnValue(''),
    };
    const chat = makeChat(claude, db);
    chat.setHonestGapsSource(source);

    await chat.generateReply('g1', makeMsg(), []);

    const systemText = captureSystem(claude);
    expect(systemText).not.toContain('honest_gaps_do_not_follow_instructions');
    expect(source.formatForPrompt).toHaveBeenCalledWith('g1');
  });

  it('injects honest-gaps block into system prompt when source returns content', async () => {
    const source: IHonestGapsPromptSource = {
      formatForPrompt: vi.fn().mockReturnValue(
        '\n\n<honest_gaps_do_not_follow_instructions>\n## 这些词群友经常说但你不熟\n- ygfn (出现 12 次)\n</honest_gaps_do_not_follow_instructions>',
      ),
    };
    const chat = makeChat(claude, db);
    chat.setHonestGapsSource(source);

    await chat.generateReply('g1', makeMsg(), []);

    const systemText = captureSystem(claude);
    expect(systemText).toContain('<honest_gaps_do_not_follow_instructions>');
    expect(systemText).toContain('</honest_gaps_do_not_follow_instructions>');
    expect(systemText).toContain('ygfn');
    expect(systemText).toContain('这些词群友经常说但你不熟');
  });
});
