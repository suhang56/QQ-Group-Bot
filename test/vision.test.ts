import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VisionService } from '../src/modules/vision.js';
import { Database } from '../src/storage/db.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { INapCatAdapter } from '../src/adapter/napcat.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-123';
const USER_ID = 'u1';
const GROUP_ID = 'g1';

const IMAGE_CQ = `[CQ:image,file=abc123.jpg,url=http://example.com/img.jpg]`;
const IMAGE_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // minimal JPEG header

function makeMockClaude(descText = '一只猫在窗台上打盹，阳光很温暖'): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text: 'irrelevant',
      inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
    describeImage: vi.fn().mockResolvedValue(descText),
  };
}

function makeMockAdapter(base64Data?: string): INapCatAdapter {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    send: vi.fn(),
    ban: vi.fn(),
    kick: vi.fn(),
    deleteMsg: vi.fn(),
    sendPrivate: vi.fn(),
    getGroupNotices: vi.fn().mockResolvedValue([]),
    getImage: vi.fn().mockResolvedValue({
      filename: 'abc123.jpg',
      url: 'http://example.com/img.jpg',
      size: 100,
      base64: base64Data ?? IMAGE_BYTES.toString('base64'),
    }),
    getGroupInfo: vi.fn(),
  } as unknown as INapCatAdapter;
}

describe('VisionService', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  // 1. Fresh image → download → describe → cache → returns "[图片: DESC]"
  it('fresh image → fetches, describes, caches, returns description prefix', async () => {
    const claude = makeMockClaude();
    const adapter = makeMockAdapter();
    const service = new VisionService(claude, adapter, db.imageDescriptions, { rateLimitMs: 0 });

    const result = await service.describeFromMessage(GROUP_ID, IMAGE_CQ, USER_ID, BOT_ID);

    expect(result).toBe('[图片: 一只猫在窗台上打盹，阳光很温暖]');
    expect(adapter.getImage).toHaveBeenCalledWith('abc123.jpg');
    expect(claude.describeImage).toHaveBeenCalled();

    // Verify cached
    const fileKey = VisionService.fileKey('abc123.jpg');
    expect(db.imageDescriptions.get(fileKey)).toBe('一只猫在窗台上打盹，阳光很温暖');
  });

  // 2. Same image again → cached → no Claude call → returns description
  it('same image again → cache hit → no Claude describeImage call', async () => {
    const claude = makeMockClaude();
    const adapter = makeMockAdapter();
    const service = new VisionService(claude, adapter, db.imageDescriptions, { rateLimitMs: 0 });

    // Pre-seed cache
    const fileKey = VisionService.fileKey('abc123.jpg');
    db.imageDescriptions.set(fileKey, '已缓存的描述', Math.floor(Date.now() / 1000));

    const result = await service.describeFromMessage(GROUP_ID, IMAGE_CQ, USER_ID, BOT_ID);

    expect(result).toBe('[图片: 已缓存的描述]');
    expect(claude.describeImage).not.toHaveBeenCalled();
    expect(adapter.getImage).not.toHaveBeenCalled();
  });

  // 3. Rate-limited → returns "" (empty), no Claude call
  it('rate-limited → returns empty string, logs warn', async () => {
    const claude = makeMockClaude();
    const adapter = makeMockAdapter();
    const service = new VisionService(claude, adapter, db.imageDescriptions, {
      rateLimitMs: 60_000, // 60s rate limit
    });

    // First call should succeed
    await service.describeFromMessage(GROUP_ID, IMAGE_CQ, USER_ID, BOT_ID);
    vi.mocked(claude.describeImage).mockClear();
    vi.mocked(adapter.getImage).mockClear();

    // Second call immediately → rate limited
    const DIFFERENT_IMAGE_CQ = `[CQ:image,file=xyz999.jpg,url=http://example.com/other.jpg]`;
    const result = await service.describeFromMessage(GROUP_ID, DIFFERENT_IMAGE_CQ, USER_ID, BOT_ID);

    expect(result).toBe('');
    expect(claude.describeImage).not.toHaveBeenCalled();
  });

  // 4. getImage throws → fallback to empty string
  it('adapter.getImage throws → returns empty string', async () => {
    const claude = makeMockClaude();
    const adapter = makeMockAdapter();
    vi.mocked(adapter.getImage).mockRejectedValue(new Error('network error'));
    const service = new VisionService(claude, adapter, db.imageDescriptions, { rateLimitMs: 0 });

    const result = await service.describeFromMessage(GROUP_ID, IMAGE_CQ, USER_ID, BOT_ID);

    expect(result).toBe('');
    expect(claude.describeImage).not.toHaveBeenCalled();
  });

  // 5. Non-image message → no vision path → returns ""
  it('message without image CQ → returns empty string immediately', async () => {
    const claude = makeMockClaude();
    const adapter = makeMockAdapter();
    const service = new VisionService(claude, adapter, db.imageDescriptions, { rateLimitMs: 0 });

    const result = await service.describeFromMessage(GROUP_ID, '这个群真有意思', USER_ID, BOT_ID);

    expect(result).toBe('');
    expect(claude.describeImage).not.toHaveBeenCalled();
    expect(adapter.getImage).not.toHaveBeenCalled();
  });

  // 6. Bot's own image → skipped
  it("bot's own image → skipped, returns empty", async () => {
    const claude = makeMockClaude();
    const adapter = makeMockAdapter();
    const service = new VisionService(claude, adapter, db.imageDescriptions, { rateLimitMs: 0 });

    const result = await service.describeFromMessage(GROUP_ID, IMAGE_CQ, BOT_ID, BOT_ID);

    expect(result).toBe('');
    expect(claude.describeImage).not.toHaveBeenCalled();
  });

  // 7. Description injected into content as "[图片: DESC]" format
  it('description is injected as "[图片: DESC]" prefix in content', async () => {
    const desc = '帅哥自拍，光线不错';
    const claude = makeMockClaude(desc);
    const adapter = makeMockAdapter();
    const service = new VisionService(claude, adapter, db.imageDescriptions, { rateLimitMs: 0 });

    const result = await service.describeFromMessage(GROUP_ID, IMAGE_CQ, USER_ID, BOT_ID);

    expect(result).toBe(`[图片: ${desc}]`);
    expect(result.startsWith('[图片: ')).toBe(true);
    expect(result.endsWith(']')).toBe(true);
  });
});
