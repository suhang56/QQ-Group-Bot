import { describe, it, expect, vi, beforeEach } from 'vitest';
import { faceList, parseFaces, renderFace, FACE_LEGEND } from '../src/utils/qqface.js';
import { ChatModule } from '../src/modules/chat.js';
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

function makeMockClaude(text = '[CQ:face,id=178] 哈哈'): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text, inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
  };
}

describe('qqface utils', () => {
  it('faceList returns non-empty array with numeric ids', () => {
    const list = faceList();
    expect(list.length).toBeGreaterThan(100);
    expect(list.every(f => typeof f.id === 'number' && typeof f.name === 'string')).toBe(true);
  });

  it('faceList is sorted by id ascending', () => {
    const list = faceList();
    for (let i = 1; i < list.length; i++) {
      expect(list[i]!.id).toBeGreaterThanOrEqual(list[i - 1]!.id);
    }
  });

  it('parseFaces extracts face ids from CQ codes in raw content', () => {
    const ids = parseFaces('[CQ:face,id=178] 哈哈 [CQ:face,id=14]');
    expect(ids).toEqual([178, 14]);
  });

  it('parseFaces returns empty array when no faces present', () => {
    expect(parseFaces('hello world')).toEqual([]);
    expect(parseFaces('[CQ:at,qq=123] test')).toEqual([]);
  });

  it('parseFaces handles CQ face with extra params', () => {
    const ids = parseFaces('[CQ:face,id=281,type=normal]');
    expect(ids).toContain(281);
  });

  it('renderFace returns correct CQ code', () => {
    expect(renderFace(178)).toBe('[CQ:face,id=178]');
    expect(renderFace(14)).toBe('[CQ:face,id=14]');
  });

  it('FACE_LEGEND contains key faces as [id]name tokens', () => {
    expect(FACE_LEGEND).toContain('[14]');
    expect(FACE_LEGEND).toContain('[178]');
    expect(FACE_LEGEND).toContain('[281]');
    expect(FACE_LEGEND).toContain('微笑');
  });

  it('FACE_LEGEND is within 2KB budget', () => {
    expect(Buffer.byteLength(FACE_LEGEND, 'utf8')).toBeLessThanOrEqual(2048);
  });
});

describe('ChatModule — QQ face emoji integration', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  // Bot reply contains [CQ:face,id=178] — stripped by postProcess (user banned QQ built-in faces)
  it('reply containing CQ:face code has face stripped before return', async () => {
    const claude = makeMockClaude('[CQ:face,id=178] 哈哈');
    const chat = new ChatModule(claude, db, {
      botUserId: BOT_ID, lurkerReplyChance: 1.0, lurkerCooldownMs: 0, debounceMs: 0,
    });
    const msg = makeMsg({ rawContent: `[CQ:at,qq=${BOT_ID}] hi` });
    const result = await chat.generateReply('g1', msg, []);
    expect(result.kind).not.toBe('silent');
    expect('text' in result && result.text).not.toContain('[CQ:face,id=');
    expect('text' in result && result.text).toContain('哈哈');
  });

  // Reply with only face codes → stripped → empty → dropped silently
  it('reply with only CQ:face codes is dropped as empty after stripping', async () => {
    const claude = makeMockClaude('[CQ:face,id=99999]');
    const chat = new ChatModule(claude, db, {
      botUserId: BOT_ID, lurkerReplyChance: 1.0, lurkerCooldownMs: 0, debounceMs: 0,
    });
    const msg = makeMsg({ rawContent: `[CQ:at,qq=${BOT_ID}] hi` });
    const result = await chat.generateReply('g1', msg, []);
    expect(result.kind).toBe('silent');
  });

  // User message with faces → parseFaces extracts them (for future use)
  it('user message faces are parseable from rawContent', () => {
    const rawContent = '[CQ:face,id=281] 好的 [CQ:face,id=14]';
    const ids = parseFaces(rawContent);
    expect(ids).toContain(281);
    expect(ids).toContain(14);
  });

  // System prompt must NOT include face legend (QQ built-in faces are banned)
  it('system prompt does NOT include CQ face legend — bot is banned from using built-in faces', async () => {
    const claude = makeMockClaude('hi');
    const chat = new ChatModule(claude, db, {
      botUserId: BOT_ID, lurkerReplyChance: 1.0, lurkerCooldownMs: 0, debounceMs: 0,
    });
    const msg = makeMsg({ rawContent: `[CQ:at,qq=${BOT_ID}] hi` });
    await chat.generateReply('g1', msg, []);
    const call = vi.mocked(claude.complete).mock.calls[0]![0];
    const systemText = call.system.map(s => s.text).join(' ');
    expect(systemText).not.toContain('[CQ:face,id=N]');
    expect(systemText).not.toContain('FACE_LEGEND');
    // mface stickers are still allowed
    expect(systemText).toContain('mface');
  });
});

