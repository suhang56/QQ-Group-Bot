import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Database } from '../../src/storage/db.js';
import type { IClaudeClient, ClaudeRequest, ClaudeResponse } from '../../src/ai/claude.js';
import type { IEmbeddingService } from '../../src/storage/embeddings.js';
import { initLogger } from '../../src/utils/logger.js';
import { StickerUsageCaptureService, LaterReactionWorker } from '../../src/modules/sticker-usage-capture.js';

initLogger({ level: 'silent' });

const BOT = 'BOT';

function fakeClaude(label: string): IClaudeClient {
  return {
    async complete(_req: ClaudeRequest): Promise<ClaudeResponse> {
      return { text: label, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    },
    async describeImage(): Promise<string> { return ''; },
    async visionWithPrompt(): Promise<string> { return ''; },
  };
}

function throwingClaude(): IClaudeClient {
  return {
    async complete(): Promise<ClaudeResponse> { throw new Error('boom'); },
    async describeImage(): Promise<string> { return ''; },
    async visionWithPrompt(): Promise<string> { return ''; },
  };
}

function fakeEmbedder(vec: number[]): IEmbeddingService {
  return {
    isReady: true,
    async embed(_text: string): Promise<number[]> { return vec; },
    async waitReady(): Promise<void> { /* ready */ },
  };
}

function notReadyEmbedder(): IEmbeddingService {
  return {
    isReady: false,
    async embed(): Promise<number[]> { throw new Error('not ready'); },
    async waitReady(): Promise<void> { /* noop */ },
  };
}

function seedMsg(
  db: Database,
  args: { groupId: string; userId: string; nickname?: string; content: string; rawContent?: string; ts: number; sourceMsgId?: string },
): number {
  const m = db.messages.insert({
    groupId: args.groupId,
    userId: args.userId,
    nickname: args.nickname ?? args.userId,
    content: args.content,
    rawContent: args.rawContent ?? args.content,
    timestamp: args.ts,
    deleted: false,
  }, args.sourceMsgId);
  return m.id;
}

/** Wait for any pending async fire-and-forget tasks to drain. */
async function flush(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

describe('StickerUsageCaptureService.extractStickerKey', () => {
  it('extracts mface key', () => {
    const k = StickerUsageCaptureService.extractStickerKey('[CQ:mface,emoji_id=99,package_id=10,summary=hi]');
    expect(k).toBe('mface:10:99');
  });
  it('extracts image sticker key (sub_type=1)', () => {
    const k = StickerUsageCaptureService.extractStickerKey('[CQ:image,file=abc.jpg,sub_type=1]');
    expect(k).toBe('img:abc.jpg');
  });
  it('returns null when image lacks sub_type=1', () => {
    const k = StickerUsageCaptureService.extractStickerKey('[CQ:image,file=abc.jpg]');
    expect(k).toBeNull();
  });
  it('returns null when no sticker', () => {
    const k = StickerUsageCaptureService.extractStickerKey('hello world');
    expect(k).toBeNull();
  });
});

describe('StickerUsageCaptureService.captureUsageFromMessage', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    StickerUsageCaptureService._resetCacheForTests();
  });

  it('inserts row with prev_msgs, trigger_text, then resolves act_label via mock claude', async () => {
    seedMsg(db, { groupId: 'g1', userId: 'u9', content: 'hello', ts: 90 });
    seedMsg(db, { groupId: 'g1', userId: 'u8', content: 'how are you', ts: 95 });
    seedMsg(db, { groupId: 'g1', userId: 'u7', content: 'lol', ts: 99 });
    const svc = new StickerUsageCaptureService(
      db.stickerUsageSamples, db.messages,
      { claude: fakeClaude('laugh'), embedder: fakeEmbedder([1, 2, 3]) },
    );
    svc.captureUsageFromMessage(
      { groupId: 'g1', userId: 'u1', rawContent: '[CQ:mface,emoji_id=1,package_id=1]', timestamp: 100 },
      BOT,
    );
    await flush();
    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stickerKey).toBe('mface:1:1');
    expect(rows[0]!.senderUserId).toBe('u1');
    expect(rows[0]!.prevMsgs.map(m => m.content)).toEqual(['hello', 'how are you', 'lol']);
    expect(rows[0]!.triggerText).toBe('lol');
    expect(rows[0]!.actLabel).toBe('laugh');
    expect(rows[0]!.contextEmbedding).not.toBeNull();
    expect(rows[0]!.contextEmbedding!).toHaveLength(3);
  });

  it('skip-bot-source: senderUserId === botUserId → no row inserted', async () => {
    const svc = new StickerUsageCaptureService(db.stickerUsageSamples, db.messages, {});
    svc.captureUsageFromMessage(
      { groupId: 'g1', userId: BOT, rawContent: '[CQ:mface,emoji_id=1,package_id=1]', timestamp: 100 },
      BOT,
    );
    await flush();
    expect(db.stickerUsageSamples.count('g1')).toBe(0);
  });

  it('prev_msgs trimmed to N=5 even when more available', async () => {
    for (let i = 0; i < 10; i++) {
      seedMsg(db, { groupId: 'g1', userId: 'u' + i, content: 'm' + i, ts: 50 + i });
    }
    const svc = new StickerUsageCaptureService(db.stickerUsageSamples, db.messages, { prevN: 5 });
    svc.captureUsageFromMessage(
      { groupId: 'g1', userId: 'us', rawContent: '[CQ:mface,emoji_id=1,package_id=1]', timestamp: 100 },
      BOT,
    );
    await flush();
    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    expect(rows[0]!.prevMsgs).toHaveLength(5);
    // Chronological order — should be the last 5 messages (m5..m9)
    expect(rows[0]!.prevMsgs.map(m => m.content)).toEqual(['m5', 'm6', 'm7', 'm8', 'm9']);
    expect(rows[0]!.triggerText).toBe('m9');
  });

  it('prev_msgs fewer than N available — all stored, no error', async () => {
    seedMsg(db, { groupId: 'g1', userId: 'u9', content: 'only one', ts: 90 });
    const svc = new StickerUsageCaptureService(db.stickerUsageSamples, db.messages, { prevN: 5 });
    svc.captureUsageFromMessage(
      { groupId: 'g1', userId: 'us', rawContent: '[CQ:mface,emoji_id=1,package_id=1]', timestamp: 100 },
      BOT,
    );
    await flush();
    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    expect(rows[0]!.prevMsgs).toHaveLength(1);
    expect(rows[0]!.triggerText).toBe('only one');
  });

  it('first sticker in group: empty prev / empty trigger', async () => {
    const svc = new StickerUsageCaptureService(db.stickerUsageSamples, db.messages, {});
    svc.captureUsageFromMessage(
      { groupId: 'g1', userId: 'u1', rawContent: '[CQ:mface,emoji_id=1,package_id=1]', timestamp: 100 },
      BOT,
    );
    await flush();
    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    expect(rows[0]!.prevMsgs).toEqual([]);
    expect(rows[0]!.triggerText).toBe('');
  });

  it('CQ:reply,id=X resolves via findBySourceId → replyToTarget contains userId + content', async () => {
    seedMsg(db, { groupId: 'g1', userId: 'uTarget', content: 'the question', ts: 50, sourceMsgId: '12345' });
    const svc = new StickerUsageCaptureService(db.stickerUsageSamples, db.messages, {});
    svc.captureUsageFromMessage(
      { groupId: 'g1', userId: 'us', rawContent: '[CQ:reply,id=12345][CQ:mface,emoji_id=1,package_id=1]', timestamp: 100 },
      BOT,
    );
    await flush();
    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    expect(rows[0]!.replyToTarget).toBe('uTarget: the question');
  });

  it('CQ:reply,id=X with no matching message → replyToTarget null', async () => {
    const svc = new StickerUsageCaptureService(db.stickerUsageSamples, db.messages, {});
    svc.captureUsageFromMessage(
      { groupId: 'g1', userId: 'us', rawContent: '[CQ:reply,id=99999][CQ:mface,emoji_id=1,package_id=1]', timestamp: 100 },
      BOT,
    );
    await flush();
    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    expect(rows[0]!.replyToTarget).toBeNull();
  });

  it('prev_msgs filter excludes bot self-messages', async () => {
    seedMsg(db, { groupId: 'g1', userId: 'u9', content: 'human msg', ts: 90 });
    seedMsg(db, { groupId: 'g1', userId: BOT, content: 'bot reply', ts: 95 });
    seedMsg(db, { groupId: 'g1', userId: 'u8', content: 'another human', ts: 99 });
    const svc = new StickerUsageCaptureService(db.stickerUsageSamples, db.messages, {});
    svc.captureUsageFromMessage(
      { groupId: 'g1', userId: 'u1', rawContent: '[CQ:mface,emoji_id=1,package_id=1]', timestamp: 100 },
      BOT,
    );
    await flush();
    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    expect(rows[0]!.prevMsgs.map(m => m.content)).toEqual(['human msg', 'another human']);
  });

  it('act-label cache hit: same prev+key → claude.complete called once', async () => {
    seedMsg(db, { groupId: 'g1', userId: 'u9', content: 'same trigger', ts: 90 });
    const claude = fakeClaude('laugh');
    const spy = vi.spyOn(claude, 'complete');
    const svc = new StickerUsageCaptureService(db.stickerUsageSamples, db.messages, { claude });

    svc.captureUsageFromMessage(
      { groupId: 'g1', userId: 'u1', rawContent: '[CQ:mface,emoji_id=1,package_id=1]', timestamp: 100 },
      BOT,
    );
    await flush();
    svc.captureUsageFromMessage(
      { groupId: 'g1', userId: 'u2', rawContent: '[CQ:mface,emoji_id=1,package_id=1]', timestamp: 101 },
      BOT,
    );
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    expect(rows.every(r => r.actLabel === 'laugh')).toBe(true);
  });

  it('act-label LLM throws → label = spam-unknown', async () => {
    seedMsg(db, { groupId: 'g1', userId: 'u9', content: 'ctx', ts: 90 });
    const svc = new StickerUsageCaptureService(db.stickerUsageSamples, db.messages, { claude: throwingClaude() });
    svc.captureUsageFromMessage(
      { groupId: 'g1', userId: 'u1', rawContent: '[CQ:mface,emoji_id=1,package_id=1]', timestamp: 100 },
      BOT,
    );
    await flush();
    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    expect(rows[0]!.actLabel).toBe('spam-unknown');
  });

  it('act-label invalid output → label = spam-unknown', async () => {
    seedMsg(db, { groupId: 'g1', userId: 'u9', content: 'ctx', ts: 90 });
    const svc = new StickerUsageCaptureService(db.stickerUsageSamples, db.messages, { claude: fakeClaude('banana') });
    svc.captureUsageFromMessage(
      { groupId: 'g1', userId: 'u1', rawContent: '[CQ:mface,emoji_id=1,package_id=1]', timestamp: 100 },
      BOT,
    );
    await flush();
    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    expect(rows[0]!.actLabel).toBe('spam-unknown');
  });

  it('embedder not ready → context_embedding stays null', async () => {
    seedMsg(db, { groupId: 'g1', userId: 'u9', content: 'ctx', ts: 90 });
    const svc = new StickerUsageCaptureService(db.stickerUsageSamples, db.messages, { embedder: notReadyEmbedder() });
    svc.captureUsageFromMessage(
      { groupId: 'g1', userId: 'u1', rawContent: '[CQ:mface,emoji_id=1,package_id=1]', timestamp: 100 },
      BOT,
    );
    await flush();
    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    expect(rows[0]!.contextEmbedding).toBeNull();
  });

  it('no claude configured → actLabel stays null', async () => {
    seedMsg(db, { groupId: 'g1', userId: 'u9', content: 'ctx', ts: 90 });
    const svc = new StickerUsageCaptureService(db.stickerUsageSamples, db.messages, {});
    svc.captureUsageFromMessage(
      { groupId: 'g1', userId: 'u1', rawContent: '[CQ:mface,emoji_id=1,package_id=1]', timestamp: 100 },
      BOT,
    );
    await flush();
    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    expect(rows[0]!.actLabel).toBeNull();
  });
});

describe('LaterReactionWorker.scan', () => {
  let db: Database;
  beforeEach(() => { db = new Database(':memory:'); });

  it('classifies echo: same sticker_key in next msgs', () => {
    const id = db.stickerUsageSamples.insert({
      groupId: 'g1', stickerKey: 'mface:1:1', senderUserId: 'u1',
      prevMsgs: [], triggerText: '', replyToTarget: null, createdAt: 100,
    });
    seedMsg(db, { groupId: 'g1', userId: 'u2', content: '', rawContent: '[CQ:mface,emoji_id=1,package_id=1]', ts: 105 });
    seedMsg(db, { groupId: 'g1', userId: 'u3', content: '', rawContent: '[CQ:mface,emoji_id=1,package_id=1]', ts: 110 });
    const w = new LaterReactionWorker(db.stickerUsageSamples, db.messages);
    w.scan('g1', 120);
    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    const echo = rows[0]!.laterReactions.find(r => r.type === 'echo');
    expect(echo).toBeDefined();
    expect(echo!.count).toBe(2);
    expect(rows[0]!.id).toBe(id);
  });

  it('classifies rebuttal', () => {
    db.stickerUsageSamples.insert({
      groupId: 'g1', stickerKey: 'k', senderUserId: 'u1',
      prevMsgs: [], triggerText: '', replyToTarget: null, createdAt: 100,
    });
    seedMsg(db, { groupId: 'g1', userId: 'u2', content: '神经病吧', ts: 105 });
    seedMsg(db, { groupId: 'g1', userId: 'u3', content: '别戳啦', ts: 110 });
    const w = new LaterReactionWorker(db.stickerUsageSamples, db.messages);
    w.scan('g1', 120);
    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    const reb = rows[0]!.laterReactions.find(r => r.type === 'rebuttal');
    expect(reb).toBeDefined();
    expect(reb!.count).toBe(2);
  });

  it('classifies meme-react with negative-lookahead: 草 matches, 草莓 does not', () => {
    db.stickerUsageSamples.insert({
      groupId: 'g1', stickerKey: 'k', senderUserId: 'u1',
      prevMsgs: [], triggerText: '', replyToTarget: null, createdAt: 100,
    });
    seedMsg(db, { groupId: 'g1', userId: 'u2', content: '草', ts: 105 });
    seedMsg(db, { groupId: 'g1', userId: 'u3', content: '我吃草莓', ts: 110 });
    const w = new LaterReactionWorker(db.stickerUsageSamples, db.messages);
    w.scan('g1', 120);
    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    const meme = rows[0]!.laterReactions.find(r => r.type === 'meme-react');
    expect(meme).toBeDefined();
    expect(meme!.count).toBe(1);
  });

  it('classifies silence when ≥2 follow-ups all unrelated', () => {
    db.stickerUsageSamples.insert({
      groupId: 'g1', stickerKey: 'k', senderUserId: 'u1',
      prevMsgs: [], triggerText: '', replyToTarget: null, createdAt: 100,
    });
    seedMsg(db, { groupId: 'g1', userId: 'u2', content: 'unrelated topic A', ts: 105 });
    seedMsg(db, { groupId: 'g1', userId: 'u3', content: 'unrelated topic B', ts: 110 });
    const w = new LaterReactionWorker(db.stickerUsageSamples, db.messages);
    w.scan('g1', 120);
    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    expect(rows[0]!.laterReactions).toEqual([{ type: 'silence', count: 2, sampleMsg: null }]);
  });

  it('row outside window is not scanned (auto-skipped via findRecentForUpdate)', () => {
    db.stickerUsageSamples.insert({
      groupId: 'g1', stickerKey: 'k', senderUserId: 'u1',
      prevMsgs: [], triggerText: '', replyToTarget: null, createdAt: 100,
    });
    seedMsg(db, { groupId: 'g1', userId: 'u2', content: '神经病', ts: 105 });
    const w = new LaterReactionWorker(db.stickerUsageSamples, db.messages);
    // nowSec=300 → since=180, sticker at 100 falls outside the window
    w.scan('g1', 300);
    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    expect(rows[0]!.laterReactions).toEqual([]);
  });

  it('caps follow-ups at N=8 even when more exist in window', () => {
    db.stickerUsageSamples.insert({
      groupId: 'g1', stickerKey: 'mface:1:1', senderUserId: 'u1',
      prevMsgs: [], triggerText: '', replyToTarget: null, createdAt: 100,
    });
    for (let i = 0; i < 12; i++) {
      seedMsg(db, {
        groupId: 'g1', userId: 'u' + i, content: '',
        rawContent: '[CQ:mface,emoji_id=1,package_id=1]', ts: 101 + i,
      });
    }
    const w = new LaterReactionWorker(db.stickerUsageSamples, db.messages);
    w.scan('g1', 120);
    const rows = db.stickerUsageSamples.findRecentForUpdate('g1', 0);
    const echo = rows[0]!.laterReactions.find(r => r.type === 'echo');
    expect(echo!.count).toBe(LaterReactionWorker.N_FOLLOWUPS);
  });

  it('idempotent — running twice yields same result', () => {
    db.stickerUsageSamples.insert({
      groupId: 'g1', stickerKey: 'k', senderUserId: 'u1',
      prevMsgs: [], triggerText: '', replyToTarget: null, createdAt: 100,
    });
    seedMsg(db, { groupId: 'g1', userId: 'u2', content: '神经病', ts: 105 });
    const w = new LaterReactionWorker(db.stickerUsageSamples, db.messages);
    w.scan('g1', 120);
    const r1 = db.stickerUsageSamples.findRecentForUpdate('g1', 0)[0]!.laterReactions;
    w.scan('g1', 120);
    const r2 = db.stickerUsageSamples.findRecentForUpdate('g1', 0)[0]!.laterReactions;
    expect(r1).toEqual(r2);
  });
});
