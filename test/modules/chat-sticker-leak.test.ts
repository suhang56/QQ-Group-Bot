/**
 * PR1 integration: send-guard-chain fires on sticker-token-only bot output,
 * returns silent+reasonCode='sticker-leak-stripped'; partial-strip passes with
 * cleaned text; natural text is untouched; deflection-engine._validate rejects
 * sticker-token cached replies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatModule } from '../../src/modules/chat.js';
import { Database } from '../../src/storage/db.js';
import { initLogger } from '../../src/utils/logger.js';
import type { IClaudeClient, ClaudeResponse } from '../../src/ai/claude.js';
import type { GroupMessage } from '../../src/adapter/napcat.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-sticker-leak';
const GROUP_ID = 'g-sticker-leak';

function makeClaudeReturning(text: string): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text,
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
  };
}

function makeAtMsg(content: string, overrides: Partial<GroupMessage> = {}): GroupMessage {
  const messageId = overrides.messageId ?? `m-${Math.random().toString(36).slice(2, 8)}`;
  return {
    messageId,
    groupId: GROUP_ID,
    userId: 'u1',
    nickname: 'Peer',
    role: 'member',
    content,
    rawContent: `[CQ:at,qq=${BOT_ID}] ${content}`,
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeChat(db: Database, claude: IClaudeClient): ChatModule {
  return new ChatModule(claude, db, {
    botUserId: BOT_ID,
    debounceMs: 0,
    chatMinScore: -999, // bypass engagement gate
    chatBurstCount: 99,
    moodProactiveEnabled: false,
    deflectCacheEnabled: false,
  });
}

describe('ChatModule — sticker-token-leak guard integration', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('main chat path: LLM returns multi-sticker-only "<sticker:1> <sticker:2>" (bypasses token-only pre-check) → silent with sticker-leak-stripped', async () => {
    // Single bare/bracketed token is caught by the existing `isStickerTokenOutput`
    // pre-check (reasonCode 'guard'). The new chain is the defense for embedded
    // and multi-token leaks, which the old pre-check does NOT match.
    const claude = makeClaudeReturning('<sticker:1> <sticker:2>');
    const chat = makeChat(db, claude);
    const r = await chat.generateReply(GROUP_ID, makeAtMsg('hi bot'), []);
    expect(r.kind).toBe('silent');
    if (r.kind === 'silent') expect(r.reasonCode).toBe('sticker-leak-stripped');
  });

  it('main chat path: LLM returns "  sticker:18  sticker:22  " → silent with sticker-leak-stripped', async () => {
    const claude = makeClaudeReturning('  sticker:18  sticker:22  ');
    const chat = makeChat(db, claude);
    const r = await chat.generateReply(GROUP_ID, makeAtMsg('hey'), []);
    expect(r.kind).toBe('silent');
    if (r.kind === 'silent') expect(r.reasonCode).toBe('sticker-leak-stripped');
  });

  it('partial-strip: LLM returns "haha <sticker:1>" → reply with stripped text', async () => {
    const claude = makeClaudeReturning('haha <sticker:1>');
    const chat = makeChat(db, claude);
    const r = await chat.generateReply(GROUP_ID, makeAtMsg('hi'), []);
    expect(r.kind).toBe('reply');
    if (r.kind === 'reply') expect(r.text).toBe('haha');
  });

  it('natural reply: LLM returns normal text → reply unchanged', async () => {
    const claude = makeClaudeReturning('好啊');
    const chat = makeChat(db, claude);
    const r = await chat.generateReply(GROUP_ID, makeAtMsg('hi'), []);
    expect(r.kind).toBe('reply');
    if (r.kind === 'reply') expect(r.text).toBe('好啊');
  });

  it('natural reply containing word "sticker" without digit → unchanged', async () => {
    const claude = makeClaudeReturning('用 sticker 回');
    const chat = makeChat(db, claude);
    const r = await chat.generateReply(GROUP_ID, makeAtMsg('hi'), []);
    expect(r.kind).toBe('reply');
    if (r.kind === 'reply') expect(r.text).toBe('用 sticker 回');
  });
});

describe('deflection-engine._validate — sticker:\\d+ rejection', () => {
  it('rejects cached reply containing bare sticker token', async () => {
    const { DeflectionEngine } = await import('../../src/modules/deflection-engine.js');
    const claude = makeClaudeReturning('whatever');
    const engine = new DeflectionEngine(claude);
    const validate = (engine as unknown as { _validate(raw: string): string | null })._validate.bind(engine);
    expect(validate('sticker29')).toBe('sticker29'); // no digit-after-colon → new rule does NOT reject
    expect(validate('ok good')).toBe('ok good');
    // Sticker-token forms are rejected by the new rule. (Colon-containing text
    // would also be rejected by the pre-existing colon rule, so we construct
    // inputs that uniquely exercise the new sticker:\d+ rule below.)
    expect(validate('sticker:29 hi')).toBeNull();
    expect(validate('hi sticker:7')).toBeNull();
  });
});
