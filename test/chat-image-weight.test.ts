import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChatModule, type ScoreFactors } from '../src/modules/chat.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import { Database } from '../src/storage/db.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-123';
const GROUP_ID = 'g1';

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm1',
    groupId: GROUP_ID,
    userId: 'u1',
    nickname: 'Alice',
    role: 'member',
    content: '',
    rawContent: '',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeMockClaude(): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text: 'ok',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
  };
}

function getScore(
  chat: ChatModule,
  groupId: string,
  msg: GroupMessage,
  nowMs: number,
): { score: number; factors: ScoreFactors; isDirect: boolean } {
  const recent3: Array<{ userId: string; timestamp: number }> = [];
  const recent5: Array<{ timestamp: number }> = [];
  return (chat as unknown as {
    _computeWeightedScore: (
      g: string, m: GroupMessage, n: number,
      r3: Array<{ userId: string; timestamp: number }>,
      r5: Array<{ timestamp: number }>,
    ) => { score: number; factors: ScoreFactors; isDirect: boolean };
  })._computeWeightedScore(groupId, msg, nowMs, recent3, recent5);
}

describe('G1: hasImage weight and lore keyword bonus', () => {
  let db: Database;
  let chat: ChatModule;

  beforeEach(() => {
    db = new Database(':memory:');
    chat = new ChatModule(makeMockClaude(), db, { botUserId: BOT_ID });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hasImage factor is 0.40 for image messages', () => {
    const msg = makeMsg({
      content: 'look at this',
      rawContent: '[CQ:image,file=abc.jpg] look at this',
    });
    const { factors } = getScore(chat, GROUP_ID, msg, Date.now());
    expect(factors.hasImage).toBe(0.40);
  });

  it('hasImage factor is 0.40 for mface messages', () => {
    const msg = makeMsg({
      content: '',
      rawContent: '[CQ:mface,id=123,package_id=456]',
    });
    const { factors } = getScore(chat, GROUP_ID, msg, Date.now());
    expect(factors.hasImage).toBe(0.40);
  });

  it('hasImage factor is 0 for text-only messages', () => {
    const msg = makeMsg({
      content: 'just text',
      rawContent: 'just text',
    });
    const { factors } = getScore(chat, GROUP_ID, msg, Date.now());
    expect(factors.hasImage).toBe(0);
  });

  it('loreKw gets +0.15 bonus when image message contains lore keyword', () => {
    // Mock _hasLoreKeyword to return true
    const internal = chat as unknown as { _hasLoreKeyword: (g: string, c: string) => boolean };
    vi.spyOn(internal, '_hasLoreKeyword' as never).mockReturnValue(true as never);

    const msg = makeMsg({
      content: '凑友希那的图片好可爱',
      rawContent: '[CQ:image,file=abc.jpg] 凑友希那的图片好可爱',
    });
    const { factors } = getScore(chat, GROUP_ID, msg, Date.now());
    expect(factors.hasImage).toBe(0.40);
    // Snoopy-boundaries: loreKw base 0.2 + 0.15 (image bonus) = 0.35
    expect(factors.loreKw).toBeCloseTo(0.35, 10);
  });

  it('no loreKw bonus for image without lore keywords', () => {
    // Mock _hasLoreKeyword to return false (no match)
    const internal = chat as unknown as { _hasLoreKeyword: (g: string, c: string) => boolean };
    vi.spyOn(internal, '_hasLoreKeyword' as never).mockReturnValue(false as never);

    const msg = makeMsg({
      content: '今天吃了什么',
      rawContent: '[CQ:image,file=abc.jpg] 今天吃了什么',
    });
    const { factors } = getScore(chat, GROUP_ID, msg, Date.now());
    expect(factors.hasImage).toBe(0.40);
    expect(factors.loreKw).toBe(0);
  });

  it('no loreKw bonus for text-only message with lore keywords (no image)', () => {
    // Mock _hasLoreKeyword to return true
    const internal = chat as unknown as { _hasLoreKeyword: (g: string, c: string) => boolean };
    vi.spyOn(internal, '_hasLoreKeyword' as never).mockReturnValue(true as never);

    const msg = makeMsg({
      content: '邦多利新曲好听',
      rawContent: '邦多利新曲好听',
    });
    const { factors } = getScore(chat, GROUP_ID, msg, Date.now());
    expect(factors.hasImage).toBe(0);
    // Snoopy-boundaries: loreKw base 0.2 (no image bonus since hasImage=0)
    expect(factors.loreKw).toBe(0.2);
  });
});
