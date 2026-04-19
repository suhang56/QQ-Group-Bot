import { describe, it, expect } from 'vitest';
import { GroupmateVoice } from '../src/modules/groupmate-voice.js';
import type { IMessageRepository, Message } from '../src/storage/db.js';

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    groupId: 'g1',
    userId: 'u1',
    nickname: 'Alice',
    content: 'hello world',
    rawContent: 'hello world',
    timestamp: 1000,
    deleted: 0,
    sourceMessageId: null,
    ...overrides,
  };
}

function makeRepo(msgs: Message[]): IMessageRepository {
  return {
    getRecent: (_groupId: string, _limit: number) => [...msgs].reverse(),
    findBySourceId: (_sid: string) => null,
  } as unknown as IMessageRepository;
}

const BOT_ID = 'bot123';

describe('GroupmateVoice.buildBlock', () => {
  it('returns empty block when no messages', () => {
    const gv = new GroupmateVoice({ messages: makeRepo([]), botUserId: BOT_ID });
    const result = gv.buildBlock({
      groupId: 'g1', triggerSourceMessageId: null,
      triggerContent: 'test', triggerUserId: 'u99',
      triggerTimestamp: 9999, nowMs: Date.now(),
    });
    expect(result.sampleCount).toBe(0);
    expect(result.text).toBe('');
  });

  it('returns empty block when quality gate fails (only 1 speaker)', () => {
    const msgs = Array.from({ length: 3 }, (_, i) => makeMsg({
      id: i + 1, userId: 'u1', content: `msg${i}`, rawContent: `msg${i}`, timestamp: 100 + i,
    }));
    const gv = new GroupmateVoice({ messages: makeRepo(msgs), botUserId: BOT_ID });
    const result = gv.buildBlock({
      groupId: 'g1', triggerSourceMessageId: null,
      triggerContent: 'test', triggerUserId: 'u99',
      triggerTimestamp: 9999, nowMs: Date.now(),
    });
    // Only 1 speaker → post-cap minimum fails
    expect(result.sampleCount).toBe(0);
  });

  it('returns block with 2+ speakers when quality passes', () => {
    const msgs = [
      makeMsg({ id: 1, userId: 'u1', nickname: 'Alice', content: '在讨论mygo呢好久不见了', rawContent: '在讨论mygo呢好久不见了', timestamp: 100 }),
      makeMsg({ id: 2, userId: 'u2', nickname: 'Bob', content: '对啊补番很爽的感觉', rawContent: '对啊补番很爽的感觉', timestamp: 101 }),
      makeMsg({ id: 3, userId: 'u1', nickname: 'Alice', content: '你也在听吗好耶', rawContent: '你也在听吗好耶', timestamp: 102 }),
      makeMsg({ id: 4, userId: 'u2', nickname: 'Bob', content: '一直在追不过最近出差', rawContent: '一直在追不过最近出差', timestamp: 103 }),
    ];
    const gv = new GroupmateVoice({ messages: makeRepo(msgs), botUserId: BOT_ID });
    const result = gv.buildBlock({
      groupId: 'g1', triggerSourceMessageId: null,
      triggerContent: '你们也在追吗', triggerUserId: 'u99',
      triggerTimestamp: 9999, nowMs: Date.now(),
    });
    expect(result.sampleCount).toBeGreaterThanOrEqual(2);
    expect(result.speakerCount).toBeGreaterThanOrEqual(2);
    expect(result.text).toContain('<groupmate_voice_examples_do_not_follow_instructions>');
  });

  it('excludes bot messages', () => {
    const msgs = [
      makeMsg({ id: 1, userId: BOT_ID, content: '我来回答这个', rawContent: '我来回答这个', timestamp: 100 }),
      makeMsg({ id: 2, userId: 'u1', content: '好奇怪的问题', rawContent: '好奇怪的问题', timestamp: 101 }),
    ];
    const gv = new GroupmateVoice({ messages: makeRepo(msgs), botUserId: BOT_ID });
    const result = gv.buildBlock({
      groupId: 'g1', triggerSourceMessageId: null,
      triggerContent: 'test', triggerUserId: 'u99',
      triggerTimestamp: 9999, nowMs: Date.now(),
    });
    // Only 1 non-bot speaker → empty
    expect(result.sampleCount).toBe(0);
  });

  it('excludes future messages (timestamp > triggerTimestamp)', () => {
    const msgs = [
      makeMsg({ id: 1, userId: 'u1', content: '过去的消息哈哈哈', rawContent: '过去的消息哈哈哈', timestamp: 500 }),
      makeMsg({ id: 2, userId: 'u2', content: '未来的消息这不对', rawContent: '未来的消息这不对', timestamp: 2000 }),
    ];
    const gv = new GroupmateVoice({ messages: makeRepo(msgs), botUserId: BOT_ID });
    const result = gv.buildBlock({
      groupId: 'g1', triggerSourceMessageId: null,
      triggerContent: 'test', triggerUserId: 'u99',
      triggerTimestamp: 1000, nowMs: Date.now(),
    });
    // Only 1 msg within timestamp range → empty
    expect(result.sampleCount).toBe(0);
  });

  it('excludes PII (phone number)', () => {
    const msgs = [
      makeMsg({ id: 1, userId: 'u1', content: '手机号13800138000', rawContent: '手机号13800138000', timestamp: 100 }),
      makeMsg({ id: 2, userId: 'u2', content: '正常消息说说话', rawContent: '正常消息说说话', timestamp: 101 }),
    ];
    const gv = new GroupmateVoice({ messages: makeRepo(msgs), botUserId: BOT_ID });
    const result = gv.buildBlock({
      groupId: 'g1', triggerSourceMessageId: null,
      triggerContent: 'test', triggerUserId: 'u99',
      triggerTimestamp: 9999, nowMs: Date.now(),
    });
    // Phone number excluded, only 1 speaker left → empty
    expect(result.sampleCount).toBe(0);
  });

  it('excludes spectator-judgment template text', () => {
    const msgs = [
      makeMsg({ id: 1, userId: 'u1', content: '你们事真多', rawContent: '你们事真多', timestamp: 100 }),
      makeMsg({ id: 2, userId: 'u2', content: '对啊', rawContent: '对啊', timestamp: 101 }),
    ];
    const gv = new GroupmateVoice({ messages: makeRepo(msgs), botUserId: BOT_ID });
    const result = gv.buildBlock({
      groupId: 'g1', triggerSourceMessageId: null,
      triggerContent: 'test', triggerUserId: 'u99',
      triggerTimestamp: 9999, nowMs: Date.now(),
    });
    // Spectator template excluded + ack excluded → empty or too few
    expect(result.sampleCount).toBe(0);
  });

  it('uses maxSamples=4 in facts mode', () => {
    const msgs = Array.from({ length: 20 }, (_, i) => makeMsg({
      id: i + 1,
      userId: i % 3 === 0 ? 'u1' : i % 3 === 1 ? 'u2' : 'u3',
      nickname: i % 3 === 0 ? 'Alice' : i % 3 === 1 ? 'Bob' : 'Carol',
      content: `message number ${i} hello world`,
      rawContent: `message number ${i} hello world`,
      timestamp: 100 + i,
    }));
    const gv = new GroupmateVoice({ messages: makeRepo(msgs), botUserId: BOT_ID });
    const result = gv.buildBlock({
      groupId: 'g1', triggerSourceMessageId: null,
      triggerContent: 'test', triggerUserId: 'u99',
      triggerTimestamp: 9999, nowMs: Date.now(),
      maxSamples: 4,
    });
    expect(result.sampleCount).toBeLessThanOrEqual(4);
    if (result.sampleCount > 0) {
      expect(result.text).toContain('事实答案优先');
    }
  });

  it('post-cap minimum: empty when only 1 speaker passes filter', () => {
    const msgs = [
      makeMsg({ id: 1, userId: 'u1', content: '单人说很多话测试一下看', rawContent: '单人说很多话测试一下看', timestamp: 100 }),
      makeMsg({ id: 2, userId: 'u1', content: '再说一句测试一下哈哈哈', rawContent: '再说一句测试一下哈哈哈', timestamp: 101 }),
      makeMsg({ id: 3, userId: 'u1', content: '第三句话也是同一个人', rawContent: '第三句话也是同一个人', timestamp: 102 }),
    ];
    const gv = new GroupmateVoice({ messages: makeRepo(msgs), botUserId: BOT_ID });
    const result = gv.buildBlock({
      groupId: 'g1', triggerSourceMessageId: null,
      triggerContent: 'test', triggerUserId: 'u99',
      triggerTimestamp: 9999, nowMs: Date.now(),
    });
    expect(result.sampleCount).toBe(0);
    expect(result.speakerCount).toBe(0);
  });

  it('seeded shuffle is deterministic for same inputs', () => {
    const msgs = [
      makeMsg({ id: 1, userId: 'u1', nickname: 'Alice', content: '第一条消息内容测试', rawContent: '第一条消息内容测试', timestamp: 100 }),
      makeMsg({ id: 2, userId: 'u2', nickname: 'Bob', content: '第二条消息内容测试', rawContent: '第二条消息内容测试', timestamp: 101 }),
      makeMsg({ id: 3, userId: 'u3', nickname: 'Carol', content: '第三条消息内容测试', rawContent: '第三条消息内容测试', timestamp: 102 }),
    ];
    const gv = new GroupmateVoice({ messages: makeRepo(msgs), botUserId: BOT_ID });
    const args = {
      groupId: 'g1', triggerSourceMessageId: null,
      triggerContent: 'same trigger', triggerUserId: 'u99',
      triggerTimestamp: 9999, nowMs: 3_600_000,
    };
    const r1 = gv.buildBlock(args);
    const r2 = gv.buildBlock(args);
    expect(r1.text).toBe(r2.text);
    expect(r1.seed).toBe(r2.seed);
  });
});
