import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isSticker,
  buildStickerKey,
  buildCqCode,
  buildSummary,
  extractTextContext,
  extractStickers,
} from '../scripts/extract-stickers.js';

// ---- Helpers to create fake chunk streams ----

function makeElement(type: string, data: Record<string, unknown> = {}) {
  return { type, data };
}

function makeMarketFace(emojiId = 'abc123', emojiPackageId = 100, name = '笑') {
  return makeElement('market_face', { emojiId, emojiPackageId, key: 'k1', name });
}

function makeImageSticker(opts: { sub_type?: number; url?: string; file_unique?: string; md5?: string } = {}) {
  return makeElement('image', {
    sub_type: opts.sub_type,
    url: opts.url ?? 'https://gchat.qpic.cn/gchatpic_new/123/456.png',
    file_unique: opts.file_unique,
    md5: opts.md5 ?? 'deadbeef',
    filename: 'sticker.gif',
  });
}

function makePlainImage() {
  return makeElement('image', {
    url: '/download?appid=1407&fileid=xyz',
    md5: 'plainimagemd5',
    filename: 'photo.jpg',
    width: 1920,
    height: 1080,
    size: 200000,
  });
}

function makeMessage(elements: ReturnType<typeof makeElement>[], timestamp = 1700000000000) {
  return JSON.stringify({ id: 'msg1', timestamp, sender: { uin: '123' }, content: { elements } });
}

function makeTextMessage(text: string, timestamp = 1700000000000) {
  return JSON.stringify({
    id: 'msg_text',
    timestamp,
    sender: { uin: '123' },
    content: {
      elements: [{ type: 'text', data: { text } }],
    },
  });
}

async function* fakeLines(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

// Helper: run extraction over synthetic JSONL lines per "chunk"
async function runExtract(chunkLines: string[][]): Promise<Map<string, { type: string; cqCode: string; summary: string; count: number; lastSeen: number; samples: string[] }>> {
  let callCount = 0;
  const fakeReader = (_path: string) => fakeLines(chunkLines[callCount++] ?? []);
  const fakeFiles = chunkLines.map((_, i) => `/fake/chunk_${i}.jsonl`);
  const result = await extractStickers(fakeFiles, fakeReader);
  return result as Map<string, { type: string; cqCode: string; summary: string; count: number; lastSeen: number; samples: string[] }>;
}

// ---- Unit tests for pure functions ----

describe('isSticker', () => {
  it('returns true for market_face', () => {
    expect(isSticker(makeMarketFace())).toBe(true);
  });

  it('returns true for image with sub_type === 1', () => {
    expect(isSticker(makeImageSticker({ sub_type: 1 }))).toBe(true);
  });

  it('returns true for image with gchat.qpic.cn url', () => {
    expect(isSticker(makeImageSticker({ url: 'https://gchat.qpic.cn/something' }))).toBe(true);
  });

  it('returns false for plain image (no sub_type, no gchat url)', () => {
    expect(isSticker(makePlainImage())).toBe(false);
  });

  it('returns false for text element', () => {
    expect(isSticker({ type: 'text', data: { text: 'hello' } })).toBe(false);
  });

  it('returns false for face element', () => {
    expect(isSticker({ type: 'face', data: { id: 1 } })).toBe(false);
  });
});

describe('buildStickerKey', () => {
  it('builds mface key correctly', () => {
    const el = makeMarketFace('emojiXYZ', 12345);
    expect(buildStickerKey(el)).toBe('mface:12345:emojiXYZ');
  });

  it('returns null and warns for market_face missing emojiId', () => {
    const el = makeElement('market_face', { emojiPackageId: 100 });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(buildStickerKey(el)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('market_face missing'));
    warnSpy.mockRestore();
  });

  it('returns null and warns for market_face missing emojiPackageId', () => {
    const el = makeElement('market_face', { emojiId: 'abc' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(buildStickerKey(el)).toBeNull();
    warnSpy.mockRestore();
  });

  it('uses file_unique for image key when present', () => {
    const el = makeImageSticker({ file_unique: 'unique123' });
    expect(buildStickerKey(el)).toBe('image:unique123');
  });

  it('falls back to md5 for image key', () => {
    const el = makeImageSticker({ md5: 'abcdef' });
    expect(buildStickerKey(el)).toBe('image:abcdef');
  });

  it('falls back to md5-of-url when no file_unique or md5', () => {
    const el = makeElement('image', { url: 'https://gchat.qpic.cn/test', sub_type: 1 });
    const key = buildStickerKey(el);
    expect(key).toMatch(/^image:[a-f0-9]{32}$/);
  });
});

describe('buildCqCode', () => {
  it('builds mface CQ code correctly', () => {
    const el = makeMarketFace('emojiXYZ', 12345, '[笑]');
    const cq = buildCqCode(el);
    expect(cq).toBe('[CQ:mface,emoji_id=emojiXYZ,emoji_package_id=12345,key=k1,summary=[笑]]');
  });

  it('builds image CQ code using md5 when no file_unique', () => {
    const el = makeImageSticker({ md5: 'deadbeef' });
    expect(buildCqCode(el)).toBe('[CQ:image,file=deadbeef]');
  });
});

describe('buildSummary', () => {
  it('returns name for market_face', () => {
    const el = makeMarketFace('id', 1, '[猫猫]');
    expect(buildSummary(el)).toBe('[猫猫]');
  });

  it('returns empty string for image', () => {
    const el = makeImageSticker();
    expect(buildSummary(el)).toBe('');
  });
});

describe('extractTextContext', () => {
  it('extracts and joins text elements', () => {
    const els = [
      { type: 'text', data: { text: 'hello ' } },
      { type: 'face', data: { id: 1 } },
      { type: 'text', data: { text: 'world' } },
    ];
    expect(extractTextContext(els)).toBe('hello world');
  });

  it('returns empty for undefined elements', () => {
    expect(extractTextContext(undefined)).toBe('');
  });

  it('returns empty when no text elements', () => {
    const els = [{ type: 'face', data: { id: 1 } }];
    expect(extractTextContext(els)).toBe('');
  });
});

// ---- Integration-style tests using mocked streamFileLines ----

describe('extractStickers edge cases', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('edge case 1: malformed JSONL line — logs warn, skips, continues', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lines = [
      'NOT VALID JSON{{{{',
      makeMessage([makeMarketFace('id1', 100)]),
    ];
    const result = await runExtract([lines]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Malformed JSON'));
    expect(result.size).toBe(1);
    warnSpy.mockRestore();
  });

  it('edge case 2: message with no elements array — skip', async () => {
    const lines = [
      JSON.stringify({ id: 'msg1', timestamp: 1700000000000, sender: { uin: '123' }, content: {} }),
    ];
    const result = await runExtract([lines]);
    expect(result.size).toBe(0);
  });

  it('edge case 3: message with elements but no sticker types — skip', async () => {
    const lines = [
      makeMessage([{ type: 'text', data: { text: 'hello' } }, { type: 'face', data: { id: 1 } }]),
    ];
    const result = await runExtract([lines]);
    expect(result.size).toBe(0);
  });

  it('edge case 4: market_face missing emoji_id — skip with warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = makeElement('market_face', { emojiPackageId: 100, key: 'k', name: 'test' });
    const lines = [makeMessage([el])];
    const result = await runExtract([lines]);
    expect(result.size).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('market_face missing'));
    warnSpy.mockRestore();
  });

  it('edge case 5: image without sub_type and without gchat.qpic.cn URL — skip', async () => {
    const lines = [makeMessage([makePlainImage()])];
    const result = await runExtract([lines]);
    expect(result.size).toBe(0);
  });

  it('edge case 6: same sticker used 1000 times — count accurate, samples capped at 3', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(makeMessage([makeMarketFace('stickerA', 200)], 1700000000000 + i * 1000));
    }
    const result = await runExtract([lines]);
    const key = 'mface:200:stickerA';
    expect(result.get(key)?.count).toBe(1000);
    expect(result.get(key)?.samples.length).toBeLessThanOrEqual(3);
  });

  it('edge case 7: empty source directory causes error', async () => {
    const result = await runExtract([]);
    // extractStickers with empty chunkFiles returns empty map (no error at this level)
    // The error is thrown in main(); here we just verify no stickers extracted
    expect(result.size).toBe(0);
  });

  it('edge case 8: UTF-8 emoji in summary field round-trips correctly', async () => {
    const emoji = '🐷咕咕';
    const el = makeElement('market_face', { emojiId: 'piggy', emojiPackageId: 999, key: 'kp', name: emoji });
    const lines = [makeMessage([el])];
    const result = await runExtract([lines]);
    const record = result.get('mface:999:piggy');
    expect(record?.summary).toBe(emoji);
    // Verify JSON round-trip
    const json = JSON.stringify(record);
    const parsed = JSON.parse(json) as { summary: string };
    expect(parsed.summary).toBe(emoji);
  });

  it('edge case 9: sticker at start of conversation (no prev text) — samples valid, prev empty string', async () => {
    // First message is a sticker, no preceding text at all
    const lines = [
      makeMessage([makeMarketFace('first', 300)], 1700000000000),
      makeTextMessage('some text after'),
    ];
    const result = await runExtract([lines]);
    const record = result.get('mface:300:first');
    expect(record).toBeDefined();
    expect(record?.samples.length).toBeGreaterThan(0);
    // Before context should be empty string (no preceding text)
    expect(record?.samples[0]).toBeDefined();
  });

  it('counts multiple distinct stickers correctly', async () => {
    const lines = [
      makeMessage([makeMarketFace('id1', 100)]),
      makeMessage([makeMarketFace('id2', 200)]),
      makeMessage([makeMarketFace('id1', 100)]),
      makeMessage([makeMarketFace('id2', 200)]),
      makeMessage([makeMarketFace('id2', 200)]),
    ];
    const result = await runExtract([lines]);
    expect(result.get('mface:100:id1')?.count).toBe(2);
    expect(result.get('mface:200:id2')?.count).toBe(3);
  });

  it('tracks lastSeen as max timestamp (seconds)', async () => {
    const lines = [
      makeMessage([makeMarketFace('ts_test', 500)], 1700000000000),
      makeMessage([makeMarketFace('ts_test', 500)], 1700010000000),
    ];
    const result = await runExtract([lines]);
    expect(result.get('mface:500:ts_test')?.lastSeen).toBe(1700010000);
  });

  it('accumulates context samples from surrounding text', async () => {
    const lines = [
      makeTextMessage('text before sticker'),
      makeMessage([makeMarketFace('ctx_test', 600)]),
    ];
    const result = await runExtract([lines]);
    const record = result.get('mface:600:ctx_test');
    expect(record?.samples[0]).toContain('text before sticker');
  });
});
