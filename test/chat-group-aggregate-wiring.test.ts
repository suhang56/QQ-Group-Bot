import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatModule } from '../src/modules/chat.js';
import type { IStylePromptSource } from '../src/modules/chat.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import { Database } from '../src/storage/db.js';
import { initLogger } from '../src/utils/logger.js';
import { defaultGroupConfig } from '../src/config.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-xyz';
const VIBE_TEXT = '## 群的说话氛围\n- 群里常见口头禅：草、哈哈\n- 标点习惯：偏少';

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm1', groupId: 'g1', userId: 'u1',
    nickname: 'Alice', role: 'member',
    content: 'hello', rawContent: 'hello',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeMockClaude(): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text: 'bot reply',
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

function systemTextFromCall(claude: IClaudeClient, callIndex = 0): string {
  const call = (claude.complete as ReturnType<typeof vi.fn>).mock.calls[callIndex]![0] as {
    system: Array<{ text: string }>;
  };
  return call.system.map(s => s.text).join('\n---\n');
}

describe('ChatModule — M8.2 group aggregate injection', () => {
  let db: Database;
  let claude: IClaudeClient;

  beforeEach(() => {
    db = new Database(':memory:');
    claude = makeMockClaude();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('injects group vibe block into system prompt when aggregate text is non-empty', async () => {
    const styleSource: IStylePromptSource = {
      formatStyleForPrompt: vi.fn().mockReturnValue(''),
      formatGroupAggregateForPrompt: vi.fn().mockReturnValue(VIBE_TEXT),
    };
    const chat = makeChat(claude, db);
    chat.setStyleSource(styleSource);

    await chat.generateReply('g1', makeMsg(), []);

    expect(styleSource.formatGroupAggregateForPrompt).toHaveBeenCalledWith('g1');
    const systemText = systemTextFromCall(claude);
    expect(systemText).toContain('## 群的说话氛围');
    expect(systemText).toContain('群里常见口头禅：草、哈哈');
  });

  it('omits group vibe section entirely when aggregate helper returns empty', async () => {
    const styleSource: IStylePromptSource = {
      formatStyleForPrompt: vi.fn().mockReturnValue(''),
      formatGroupAggregateForPrompt: vi.fn().mockReturnValue(''),
    };
    const chat = makeChat(claude, db);
    chat.setStyleSource(styleSource);

    await chat.generateReply('g1', makeMsg(), []);

    const systemText = systemTextFromCall(claude);
    expect(systemText).not.toContain('群的说话氛围');
  });

  it('rebuilds identity prompt after invalidateGroupIdentityCache drops cache', async () => {
    const values = [VIBE_TEXT, '## 群的说话氛围\n- 群里常见口头禅：牛'];
    const formatAgg = vi.fn().mockImplementation(() => values.shift() ?? '');
    const styleSource: IStylePromptSource = {
      formatStyleForPrompt: vi.fn().mockReturnValue(''),
      formatGroupAggregateForPrompt: formatAgg,
    };
    const chat = makeChat(claude, db);
    chat.setStyleSource(styleSource);

    await chat.generateReply('g1', makeMsg({ messageId: 'a' }), []);
    const first = systemTextFromCall(claude, 0);
    expect(first).toContain('草、哈哈');

    // drop cache → next build must re-invoke the helper
    chat.invalidateGroupIdentityCache('g1');

    await chat.generateReply('g1', makeMsg({ messageId: 'b' }), []);
    const second = systemTextFromCall(claude, 1);
    expect(second).toContain('牛');
    // helper called at least twice (cache was invalidated)
    expect(formatAgg).toHaveBeenCalledTimes(2);
  });

  it('suppresses group vibe block when char-mode is active for the group', async () => {
    const styleSource: IStylePromptSource = {
      formatStyleForPrompt: vi.fn().mockReturnValue(''),
      formatGroupAggregateForPrompt: vi.fn().mockReturnValue(VIBE_TEXT),
    };
    const chat = makeChat(claude, db);
    chat.setStyleSource(styleSource);

    // Activate char-mode: group_config.activeCharacterId set + charModule wired.
    db.groupConfig.upsert({
      ...defaultGroupConfig('g1'),
      activeCharacterId: 'char-1',
      charStartedBy: 'admin-1',
    });
    chat.setCharModule({
      composePersonaPrompt: (_id: string) => 'CHAR-PERSONA-ACTIVE',
    } as unknown as Parameters<ChatModule['setCharModule']>[0]);

    await chat.generateReply('g1', makeMsg(), []);

    const systemText = systemTextFromCall(claude);
    expect(systemText).not.toContain('群的说话氛围');
    // helper need not be invoked at all when char-mode gates the block upstream
    expect(styleSource.formatGroupAggregateForPrompt).not.toHaveBeenCalled();
  });
});
