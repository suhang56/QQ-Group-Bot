import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildStickerSection, clearStickerSectionCache, getStickerPool } from '../src/utils/stickers.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function makeMockClaude(labelText = '摆烂'): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text: labelText,
      inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
  };
}

function writeStickerJsonl(dir: string, groupId: string, entries: object[]): void {
  fs.mkdirSync(dir, { recursive: true });
  const lines = entries.map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(dir, `${groupId}.jsonl`), lines, 'utf8');
}

describe('buildStickerSection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stickers-test-'));
    clearStickerSectionCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty string when no sticker file exists', async () => {
    const claude = makeMockClaude();
    const result = await buildStickerSection('g-missing', tmpDir, 5, claude);
    expect(result).toBe('');
    expect((claude.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('returns empty string when sticker file has no market_face entries', async () => {
    writeStickerJsonl(tmpDir, 'g-noface', [
      { key: 'image:abc', type: 'image', cqCode: '[CQ:image,file=abc]', summary: '', count: 5, lastSeen: 0, samples: [] },
    ]);
    const claude = makeMockClaude();
    const result = await buildStickerSection('g-noface', tmpDir, 5, claude);
    expect(result).toBe('');
  });

  it('calls Claude to generate labels and builds section', async () => {
    writeStickerJsonl(tmpDir, 'g-basic', [
      { key: 'mface:100:abc', type: 'market_face', cqCode: '[CQ:mface,emoji_id=abc,emoji_package_id=100,key=k1,summary=[已老实]]', summary: '[已老实]', count: 50, lastSeen: 1700000000, samples: ['哈哈', '草'] },
    ]);
    const claude = makeMockClaude('已老实');
    const result = await buildStickerSection('g-basic', tmpDir, 5, claude);
    expect(result).toContain('表情包');
    expect(result).toContain('[CQ:mface');
    expect(result).toContain('已老实');
    expect((claude.complete as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('respects topN limit', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      key: `mface:100:id${i}`,
      type: 'market_face',
      cqCode: `[CQ:mface,emoji_id=id${i},emoji_package_id=100,key=k${i},summary=[面${i}]]`,
      summary: `[面${i}]`,
      count: 10 - i,
      lastSeen: 1700000000,
      samples: [],
    }));
    writeStickerJsonl(tmpDir, 'g-topn', entries);
    const claude = makeMockClaude('标签');
    await buildStickerSection('g-topn', tmpDir, 3, claude);
    expect((claude.complete as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(3);
  });

  it('uses disk label cache instead of calling Claude again', async () => {
    writeStickerJsonl(tmpDir, 'g-cache', [
      { key: 'mface:200:xyz', type: 'market_face', cqCode: '[CQ:mface,emoji_id=xyz,emoji_package_id=200,key=kz,summary=[盯]]', summary: '[盯]', count: 30, lastSeen: 1700000000, samples: [] },
    ]);
    // Pre-write labels cache
    fs.writeFileSync(path.join(tmpDir, 'g-cache.labels.json'), JSON.stringify({ 'mface:200:xyz': '盯人' }), 'utf8');
    const claude = makeMockClaude();
    const result = await buildStickerSection('g-cache', tmpDir, 5, claude);
    expect((claude.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(result).toContain('盯人');
  });

  it('saves generated labels to disk cache', async () => {
    writeStickerJsonl(tmpDir, 'g-save', [
      { key: 'mface:300:aaa', type: 'market_face', cqCode: '[CQ:mface,emoji_id=aaa,emoji_package_id=300,key=ka,summary=[哎]]', summary: '[哎]', count: 20, lastSeen: 1700000000, samples: [] },
    ]);
    const claude = makeMockClaude('无奈');
    await buildStickerSection('g-save', tmpDir, 5, claude);
    const labelsFile = path.join(tmpDir, 'g-save.labels.json');
    expect(fs.existsSync(labelsFile)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(labelsFile, 'utf8')) as Record<string, string>;
    expect(saved['mface:300:aaa']).toBe('无奈');
  });

  it('returns cached in-memory section on second call without re-reading disk', async () => {
    writeStickerJsonl(tmpDir, 'g-mem', [
      { key: 'mface:400:bbb', type: 'market_face', cqCode: '[CQ:mface,emoji_id=bbb,emoji_package_id=400,key=kb,summary=[生气]]', summary: '[生气]', count: 35, lastSeen: 1700000000, samples: [] },
    ]);
    const claude = makeMockClaude('生气');
    const r1 = await buildStickerSection('g-mem', tmpDir, 5, claude);
    const r2 = await buildStickerSection('g-mem', tmpDir, 5, claude);
    expect(r1).toBe(r2);
    expect((claude.complete as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('getStickerPool returns null before buildStickerSection runs', () => {
    expect(getStickerPool('g-never-built')).toBeNull();
  });

  it('getStickerPool returns labeled pool after buildStickerSection', async () => {
    writeStickerJsonl(tmpDir, 'g-pool', [
      { key: 'mface:500:c1', type: 'market_face', cqCode: '[CQ:mface,emoji_id=c1,emoji_package_id=500,key=kc1,summary=[笑]]', summary: '[笑]', count: 10, lastSeen: 0, samples: [] },
      { key: 'mface:500:c2', type: 'market_face', cqCode: '[CQ:mface,emoji_id=c2,emoji_package_id=500,key=kc2,summary=[哭]]', summary: '[哭]', count: 5, lastSeen: 0, samples: [] },
    ]);
    const claude = makeMockClaude('标签');
    await buildStickerSection('g-pool', tmpDir, 5, claude);
    const pool = getStickerPool('g-pool');
    expect(pool).not.toBeNull();
    expect(pool!.length).toBe(2);
    expect(pool!.every(s => typeof s.label === 'string' && typeof s.cqCode === 'string')).toBe(true);
  });

  it('clearStickerSectionCache also clears pool cache', async () => {
    writeStickerJsonl(tmpDir, 'g-clear', [
      { key: 'mface:600:d1', type: 'market_face', cqCode: '[CQ:mface,emoji_id=d1,emoji_package_id=600,key=kd,summary=[呢]]', summary: '[呢]', count: 3, lastSeen: 0, samples: [] },
    ]);
    await buildStickerSection('g-clear', tmpDir, 5, makeMockClaude('呢'));
    expect(getStickerPool('g-clear')).not.toBeNull();
    clearStickerSectionCache();
    expect(getStickerPool('g-clear')).toBeNull();
  });
});
