import { describe, it, expect, vi, beforeEach } from 'vitest';
import { expandForwards, extractImageKeys, purgeExpiredForwardCache } from '../src/core/forward-expand.js';
import type { INapCatAdapter } from '../src/adapter/napcat.js';
import type { IForwardCacheRepository } from '../src/storage/db.js';
import type { Logger } from 'pino';

function makeAdapter(messages: Array<{
  messageId: string; senderId: string; senderNickname: string;
  content: string; rawContent: string; timestamp: number;
}>): INapCatAdapter {
  return { getForwardMessages: vi.fn().mockResolvedValue(messages) } as unknown as INapCatAdapter;
}

function makeCache(): IForwardCacheRepository & {
  _store: Map<string, { expandedText: string; nestedImageKeys: string[]; fetchedAt: number }>;
} {
  const store = new Map<string, { expandedText: string; nestedImageKeys: string[]; fetchedAt: number }>();
  return {
    _store: store,
    get(id) {
      const e = store.get(id);
      return e ? { expandedText: e.expandedText, nestedImageKeys: e.nestedImageKeys } : null;
    },
    put(id, text, keys, now) { store.set(id, { expandedText: text, nestedImageKeys: keys, fetchedAt: now }); },
    deleteExpired(beforeTs) {
      let count = 0;
      for (const [k, v] of store) {
        if (v.fetchedAt < beforeTs) { store.delete(k); count++; }
      }
      return count;
    },
  };
}

const silentLogger = {
  warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(),
} as unknown as Logger;

const GROUP_ID = 'g1';

describe('expandForwards', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns rawContent unchanged when no forward CQ present', async () => {
    const adapter = makeAdapter([]);
    const cache = makeCache();
    const result = await expandForwards('hello world', adapter, cache, GROUP_ID, silentLogger);
    expect(result).toBe('hello world');
    expect(adapter.getForwardMessages).not.toHaveBeenCalled();
  });

  it('expands a single forward with 3 messages', async () => {
    const adapter = makeAdapter([
      { messageId: '1', senderId: '100', senderNickname: 'Alice', content: '你好', rawContent: '你好', timestamp: 1 },
      { messageId: '2', senderId: '101', senderNickname: 'Bob', content: '世界', rawContent: '世界', timestamp: 2 },
      { messageId: '3', senderId: '102', senderNickname: 'Carol', content: '!!!', rawContent: '!!!', timestamp: 3 },
    ]);
    const cache = makeCache();
    const raw = '[CQ:forward,id=fwd1]';
    const result = await expandForwards(raw, adapter, cache, GROUP_ID, silentLogger);

    expect(result).toContain('[转发开始 (3 条)]');
    expect(result).toContain('Alice: 你好');
    expect(result).toContain('Bob: 世界');
    expect(result).toContain('Carol: !!!');
    expect(result).toContain('[转发结束]');
    expect(cache.get('fwd1')).not.toBeNull();
  });

  it('returns cache hit without calling adapter again', async () => {
    const adapter = makeAdapter([]);
    const cache = makeCache();
    const now = Math.floor(Date.now() / 1000);
    cache.put('fwd2', '[转发开始 (1 条)]\nX: cached\n[转发结束]', [], now);

    const result = await expandForwards('[CQ:forward,id=fwd2]', adapter, cache, GROUP_ID, silentLogger);

    expect(result).toContain('cached');
    expect(adapter.getForwardMessages).not.toHaveBeenCalled();
  });

  it('returns [转发过深，省略] when maxDepth is exceeded', async () => {
    const adapter = makeAdapter([
      { messageId: '5', senderId: '200', senderNickname: 'Deep', content: 'nested', rawContent: '[CQ:forward,id=inner]', timestamp: 1 },
    ]);
    const cache = makeCache();

    // Outer forward resolves, but its message contains another forward — at depth 1, maxDepth=1 prevents recursion
    const raw = '[CQ:forward,id=outer]';
    const result = await expandForwards(raw, adapter, cache, GROUP_ID, silentLogger, 1);

    expect(result).toContain('[转发开始 (1 条)]');
    // Nested forward text should be stripped (too deep sentinel won't appear in content since depth 1 = maxDepth)
    expect(result).not.toContain('[CQ:forward');
  });

  it('returns [转发: (无法读取)] when adapter throws', async () => {
    const adapter = { getForwardMessages: vi.fn().mockRejectedValue(new Error('network error')) } as unknown as INapCatAdapter;
    const cache = makeCache();

    const result = await expandForwards('[CQ:forward,id=broken]', adapter, cache, GROUP_ID, silentLogger);
    expect(result).toContain('[转发: (无法读取)]');
  });

  it('expands nested forward recursively', async () => {
    // inner adapter call returns text message
    const adapter = {
      getForwardMessages: vi.fn()
        .mockResolvedValueOnce([
          // outer forward: one message that itself contains a forward
          { messageId: '10', senderId: '1', senderNickname: 'Outer', content: '', rawContent: '[CQ:forward,id=inner]', timestamp: 1 },
        ])
        .mockResolvedValueOnce([
          { messageId: '11', senderId: '2', senderNickname: 'Inner', content: '深层消息', rawContent: '深层消息', timestamp: 2 },
        ]),
    } as unknown as INapCatAdapter;
    const cache = makeCache();

    const result = await expandForwards('[CQ:forward,id=outer2]', adapter, cache, GROUP_ID, silentLogger, 3);

    expect(result).toContain('Outer');
    expect(result).toContain('[转发开始 (1 条)]');
    // Inner expand should be embedded
    expect(result).toContain('Inner');
    expect(result).toContain('深层消息');
  });

  it('annotates messages with image count', async () => {
    const imgRaw = '[CQ:image,file=abc123,url=http://x.com/x.jpg]';
    const adapter = makeAdapter([
      { messageId: '20', senderId: '300', senderNickname: 'Img', content: '', rawContent: imgRaw, timestamp: 1 },
    ]);
    const cache = makeCache();

    const result = await expandForwards('[CQ:forward,id=imgfwd]', adapter, cache, GROUP_ID, silentLogger);

    expect(result).toContain('[图片×1]');
    const cached = cache.get('imgfwd');
    expect(cached?.nestedImageKeys).toContain('abc123');
  });
});

describe('extractImageKeys', () => {
  it('extracts file keys from CQ:image codes', () => {
    const raw = '[CQ:image,file=key1,url=x][CQ:image,file=key2]';
    expect(extractImageKeys(raw)).toEqual(['key1', 'key2']);
  });

  it('returns empty array when no images present', () => {
    expect(extractImageKeys('hello world')).toEqual([]);
  });
});

describe('purgeExpiredForwardCache', () => {
  it('deletes entries older than cutoff and returns count', () => {
    const cache = makeCache();
    const nowSec = Math.floor(Date.now() / 1000);
    const oldTs = nowSec - 25 * 3600; // 25h ago — expired
    const newTs = nowSec - 1;          // 1s ago — fresh
    cache.put('old1', 'x', [], oldTs);
    cache.put('old2', 'y', [], oldTs);
    cache.put('fresh', 'z', [], newTs);

    const purged = purgeExpiredForwardCache(cache);
    expect(purged).toBe(2);
    expect(cache.get('fresh')).not.toBeNull();
    expect(cache.get('old1')).toBeNull();
  });
});
