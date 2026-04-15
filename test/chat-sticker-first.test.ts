import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatModule } from '../src/modules/chat.js';
import { StickerFirstModule } from '../src/modules/sticker-first.js';
import { defaultGroupConfig } from '../src/config.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { GroupMessage } from '../src/adapter/napcat.js';
import type { ILocalStickerRepository, LocalSticker } from '../src/storage/db.js';
import type { IEmbeddingService } from '../src/storage/embeddings.js';
import { Database } from '../src/storage/db.js';
import { initLogger } from '../src/utils/logger.js';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-1';

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm1', groupId: 'g1', userId: 'u1',
    nickname: 'Alice', role: 'member',
    content: '哈哈', rawContent: '哈哈',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeClaude(text = '哈哈哈太好笑了'): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text,
      inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
  };
}

function makeSticker(overrides: Partial<LocalSticker> = {}): LocalSticker {
  return {
    id: 1, groupId: 'g1', key: 'k1', type: 'image',
    localPath: null, cqCode: '[CQ:image,file=ok]',
    summary: '笑哭', contextSamples: ['哈哈哈', '好笑'],
    count: 5, firstSeen: 1000, lastSeen: 2000,
    usagePositive: 0, usageNegative: 0,
    ...overrides,
  };
}

function makeRepo(stickers: LocalSticker[]): ILocalStickerRepository {
  return {
    upsert: vi.fn(),
    getTopByGroup: vi.fn().mockReturnValue(stickers),
    recordUsage: vi.fn(),
    setSummary: vi.fn(),
    listMissingSummary: vi.fn().mockReturnValue([]),
  };
}

function makeEmbedder(ready = true): IEmbeddingService {
  return {
    isReady: ready,
    embed: vi.fn().mockResolvedValue([1, 0, 0, 0]),
    waitReady: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ChatModule — sticker-first integration (EC-18, EC-19, EC-20)', () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-chat-'));
    db = new Database(':memory:');
    db.groupConfig.upsert(defaultGroupConfig('g1'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── EC-4 integration: sticker wins over text ─────────────────────────────

  it('generateReply returns sticker CQ code when mode ON and sticker scores above threshold', async () => {
    const localPath = path.join(tmpDir, 's.jpg');
    fs.writeFileSync(localPath, 'x');
    const sticker = makeSticker({ localPath, cqCode: '[CQ:sticker-match]', summary: '开心', contextSamples: ['哈哈哈哈哈'] });
    const repo = makeRepo([sticker]);
    const embedder = makeEmbedder(true);
    const stickerFirst = new StickerFirstModule(repo, embedder);

    // Enable sticker-first mode with low threshold (0.0 — any positive cosine wins)
    db.groupConfig.upsert({ ...defaultGroupConfig('g1'), stickerFirstEnabled: true, stickerFirstThreshold: 0.0 });

    const claude = makeClaude('哈哈哈太好笑了');
    const chat = new ChatModule(claude, db, {
      botUserId: BOT_ID, debounceMs: 0, chatMinScore: -999,
      stickerFirst,
    });

    const msg = makeMsg();
    const result = await chat.generateReply('g1', msg, []);
    expect(result).toBe('[CQ:sticker-match]');
  });

  // ── Mode OFF: text returned normally ─────────────────────────────────────

  it('generateReply returns text when sticker-first mode is OFF', async () => {
    const localPath = path.join(tmpDir, 's2.jpg');
    fs.writeFileSync(localPath, 'x');
    const sticker = makeSticker({ localPath, summary: '开心', contextSamples: ['哈哈哈哈哈'] });
    const repo = makeRepo([sticker]);
    const embedder = makeEmbedder(true);
    const stickerFirst = new StickerFirstModule(repo, embedder);

    // Mode is OFF by default
    const claude = makeClaude('这是文字回复');
    const chat = new ChatModule(claude, db, {
      botUserId: BOT_ID, debounceMs: 0, chatMinScore: -999,
      stickerFirst,
    });

    const msg = makeMsg();
    const result = await chat.generateReply('g1', msg, []);
    expect(result).toBe('这是文字回复');
  });

  // ── EC-20: generateReply returns null when LLM says <skip> ───────────────

  it('EC-20: generateReply returns null for <skip> — sticker-first intercept never fires', async () => {
    const sticker = makeSticker({ summary: '开心', contextSamples: ['哈哈哈哈哈'] });
    const repo = makeRepo([sticker]);
    const embedder = makeEmbedder(true);
    const pickSpy = vi.spyOn(new StickerFirstModule(repo, embedder), 'pickSticker');
    const stickerFirst = new StickerFirstModule(repo, embedder);

    db.groupConfig.upsert({ ...defaultGroupConfig('g1'), stickerFirstEnabled: true, stickerFirstThreshold: 0.0 });

    const claude = makeClaude('<skip>');
    const chat = new ChatModule(claude, db, {
      botUserId: BOT_ID, debounceMs: 0, chatMinScore: -999,
      stickerFirst,
    });

    const msg = makeMsg();
    const result = await chat.generateReply('g1', msg, []);
    expect(result).toBeNull();
    // pickSticker must never have been called (intercept not reached when LLM returns skip)
    // We can verify by checking the repo was never queried
    expect(repo.getTopByGroup).not.toHaveBeenCalled();
    pickSpy.mockRestore();
  });

  // ── EC-21: embedder not ready — falls through to text ────────────────────

  it('EC-21: when embedder not ready, generateReply falls through to text', async () => {
    const localPath = path.join(tmpDir, 's3.jpg');
    fs.writeFileSync(localPath, 'x');
    const sticker = makeSticker({ localPath, summary: '开心', contextSamples: ['哈哈哈哈哈'] });
    const repo = makeRepo([sticker]);
    const embedder = makeEmbedder(false); // isReady = false
    const stickerFirst = new StickerFirstModule(repo, embedder);

    db.groupConfig.upsert({ ...defaultGroupConfig('g1'), stickerFirstEnabled: true, stickerFirstThreshold: 0.0 });

    const claude = makeClaude('文字回复');
    const chat = new ChatModule(claude, db, {
      botUserId: BOT_ID, debounceMs: 0, chatMinScore: -999,
      stickerFirst,
    });

    const msg = makeMsg();
    const result = await chat.generateReply('g1', msg, []);
    expect(result).toBe('文字回复');
    expect(embedder.embed).not.toHaveBeenCalled();
  });

  // ── EC-3: all scores below threshold — text returned ─────────────────────

  it('EC-3: when all stickers below threshold, generateReply returns text', async () => {
    const localPath = path.join(tmpDir, 's4.jpg');
    fs.writeFileSync(localPath, 'x');
    const sticker = makeSticker({ localPath, summary: '悲伤', contextSamples: ['哭泣哭泣哭泣'] });
    const repo = makeRepo([sticker]);
    // query and sticker return opposite vectors → cosine < 0 → below threshold 0.25
    let idx = 0;
    const embedder: IEmbeddingService = {
      isReady: true,
      embed: vi.fn().mockImplementation(() => {
        const v = idx++ === 0 ? [1, 0, 0, 0] : [-1, 0, 0, 0];
        return Promise.resolve(v);
      }),
      waitReady: vi.fn().mockResolvedValue(undefined),
    };
    const stickerFirst = new StickerFirstModule(repo, embedder);

    db.groupConfig.upsert({ ...defaultGroupConfig('g1'), stickerFirstEnabled: true, stickerFirstThreshold: 0.25 });

    const claude = makeClaude('开心的文字');
    const chat = new ChatModule(claude, db, {
      botUserId: BOT_ID, debounceMs: 0, chatMinScore: -999,
      stickerFirst,
    });

    const msg = makeMsg();
    const result = await chat.generateReply('g1', msg, []);
    expect(result).toBe('开心的文字');
  });

  // ── Sticker-first exception falls through to text ─────────────────────────

  it('sticker-first exception in pickSticker falls through to text (fail-safe)', async () => {
    const repo = makeRepo([makeSticker()]);
    const embedder: IEmbeddingService = {
      isReady: true,
      embed: vi.fn().mockRejectedValue(new Error('catastrophic embed failure')),
      waitReady: vi.fn().mockResolvedValue(undefined),
    };
    const stickerFirst = new StickerFirstModule(repo, embedder);

    db.groupConfig.upsert({ ...defaultGroupConfig('g1'), stickerFirstEnabled: true, stickerFirstThreshold: 0.0 });

    const claude = makeClaude('安全文字');
    const chat = new ChatModule(claude, db, {
      botUserId: BOT_ID, debounceMs: 0, chatMinScore: -999,
      stickerFirst,
    });

    const msg = makeMsg();
    const result = await chat.generateReply('g1', msg, []);
    expect(result).toBe('安全文字');
  });
});
