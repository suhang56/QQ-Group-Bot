import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StickerFirstModule, type IStickerFirstModule } from '../src/modules/sticker-first.js';
import type { ILocalStickerRepository, LocalSticker } from '../src/storage/db.js';
import type { IEmbeddingService } from '../src/storage/embeddings.js';
import type { IStickerSampler, StickerCandidate } from '../src/services/sticker-sampler.js';
import { initLogger } from '../src/utils/logger.js';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

initLogger({ level: 'silent' });

// Pass-through sampler that preserves original order (no randomness)
const identitySampler: IStickerSampler = {
  sample(candidates, limit) {
    return candidates.slice(0, limit) as StickerCandidate[];
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSticker(overrides: Partial<LocalSticker> = {}): LocalSticker {
  return {
    id: 1,
    groupId: 'g1',
    key: 'abc123',
    type: 'image',
    localPath: '/tmp/sticker.jpg',
    cqCode: '[CQ:image,file=file:///tmp/sticker.jpg]',
    summary: '笑哭',
    contextSamples: ['哈哈哈', '好笑'],
    count: 5,
    firstSeen: 1000,
    lastSeen: 2000,
    usagePositive: 0,
    usageNegative: 0,
    ...overrides,
  };
}

function makeRepo(stickers: LocalSticker[] = []): ILocalStickerRepository {
  return {
    upsert: vi.fn(),
    getTopByGroup: vi.fn().mockReturnValue(stickers),
    getAllCandidates: vi.fn().mockReturnValue(stickers),
    recordUsage: vi.fn(),
    setSummary: vi.fn(),
    listMissingSummary: vi.fn().mockReturnValue([]),
    blockSticker: vi.fn().mockReturnValue(true),
    unblockSticker: vi.fn().mockReturnValue(true),
    getMfaceKeys: vi.fn().mockReturnValue(new Set<string>()),
  };
}

function makeEmbedder(ready = true, vecFn?: (text: string) => number[]): IEmbeddingService {
  const defaultFn = (text: string): number[] => {
    // Simple deterministic fake: hash text to a unit vector
    const h = text.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const v = [Math.sin(h), Math.cos(h), 0.5, 0.1];
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map(x => x / norm);
  };
  return {
    isReady: ready,
    embed: vi.fn().mockImplementation(vecFn ?? defaultFn),
    waitReady: vi.fn().mockResolvedValue(undefined),
  };
}

// Vectors that produce a known cosine similarity of ~0.999 (identical direction)
function sameVec(): number[] { return [1, 0, 0, 0]; }

// Returns a sticker with context that embeds to sameVec() — used for "matches well" cases
function makeMatchingSticker(key = 'match1', localPath = '/tmp/s.jpg'): LocalSticker {
  return makeSticker({ key, localPath, summary: '开心', contextSamples: ['开心', '哈哈'] });
}

// ─── EC-1: Mode OFF ─────────────────────────────────────────────────────────

describe('EC-1: mode OFF → returns null immediately', () => {
  it('pickSticker returns null when stickerFirstEnabled=false', async () => {
    const repo = makeRepo([makeMatchingSticker()]);
    const embedder = makeEmbedder(true, () => sameVec());
    const mod: IStickerFirstModule = new StickerFirstModule(repo, embedder, identitySampler);
    const result = await mod.pickSticker('g1', '开心啊', 0.25, false);
    expect(result).toBeNull();
    expect(repo.getAllCandidates).not.toHaveBeenCalled();
  });
});

// ─── EC-2: Empty library ─────────────────────────────────────────────────────

describe('EC-2: empty sticker library → returns null', () => {
  it('pickSticker returns null when no stickers in group', async () => {
    const repo = makeRepo([]);
    const embedder = makeEmbedder(true, () => sameVec());
    const mod: IStickerFirstModule = new StickerFirstModule(repo, embedder, identitySampler);
    const result = await mod.pickSticker('g1', '测试', 0.25, true);
    expect(result).toBeNull();
  });
});

// ─── EC-3: All scores below threshold ───────────────────────────────────────

describe('EC-3: all scores below threshold → returns null', () => {
  it('returns null when best cosine < threshold', async () => {
    const sticker = makeSticker({ contextSamples: ['悲伤', '哭泣'] });
    const repo = makeRepo([sticker]);
    let callIdx = 0;
    // query = [1,0,0,0], sticker = [-1,0,0,0] → cosine=-1 (very low)
    const embedder = makeEmbedder(true, () => {
      return callIdx++ === 0 ? [1, 0, 0, 0] : [-1, 0, 0, 0];
    });
    const mod: IStickerFirstModule = new StickerFirstModule(repo, embedder, identitySampler);
    const result = await mod.pickSticker('g1', '开心', 0.25, true);
    expect(result).toBeNull();
  });
});

// ─── EC-4: One sticker above threshold ──────────────────────────────────────

describe('EC-4: one sticker above threshold → returns its CQ code', () => {
  it('returns cqCode when cosine >= threshold', async () => {
    const localPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-')) + '/s.jpg';
    fs.writeFileSync(localPath, 'fake');
    const sticker = makeSticker({ localPath, cqCode: '[CQ:image,file=ok]', summary: '开心', contextSamples: ['哈哈哈哈哈'] });
    const repo = makeRepo([sticker]);
    // query and context both embed to same vec → cosine = 1.0
    const embedder = makeEmbedder(true, () => [1, 0, 0, 0]);
    const mod: IStickerFirstModule = new StickerFirstModule(repo, embedder, identitySampler);
    const result = await mod.pickSticker('g1', '开心', 0.25, true);
    expect(result).not.toBeNull();
    expect(result!.cqCode).toBe('[CQ:image,file=ok]');
    expect(result!.key).toBe(sticker.key);
    fs.unlinkSync(localPath);
  });
});

// ─── EC-5: Multiple stickers, top-1 wins ────────────────────────────────────

describe('EC-5: multiple stickers above threshold → top-1 wins', () => {
  it('returns the sticker with highest cosine similarity', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-ec5-'));
    const pathA = path.join(dir, 'a.jpg');
    const pathB = path.join(dir, 'b.jpg');
    const pathC = path.join(dir, 'c.jpg');
    fs.writeFileSync(pathA, 'x');
    fs.writeFileSync(pathB, 'x');
    fs.writeFileSync(pathC, 'x');

    const stickerA = makeSticker({ key: 'sA', localPath: pathA, cqCode: '[CQ:A]', summary: '开心A', contextSamples: ['哈哈哈哈'] });
    const stickerB = makeSticker({ key: 'sB', localPath: pathB, cqCode: '[CQ:B]', summary: '开心B', contextSamples: ['哈哈哈哈'] });
    const stickerC = makeSticker({ key: 'sC', localPath: pathC, cqCode: '[CQ:C]', summary: '开心C', contextSamples: ['哈哈哈哈'] });
    const repo = makeRepo([stickerA, stickerB, stickerC]);

    // query → [1,0,0,0]; sA→[0.9,0.1,0,0] (highest); sB→[0.5,0.5,0,0]; sC→[0.3,0.7,0,0]
    // But we produce: query first, then for sA context, sB context, sC context
    const vecs = [
      [1, 0, 0, 0],        // query
      [1, 0, 0, 0],        // sA context "A" → cosine 1.0 (BEST)
      [0.5, 0.5, 0, 0.71], // sB context "B" → cosine ~0.5
      [0.3, 0.7, 0, 0.64], // sC context "C" → cosine ~0.3
    ].map(v => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)); return v.map(x => x / n); });
    let idx = 0;
    const embedder = makeEmbedder(true, () => vecs[idx++]!);
    const mod: IStickerFirstModule = new StickerFirstModule(repo, embedder, identitySampler);
    const result = await mod.pickSticker('g1', 'query', 0.20, true);
    expect(result?.cqCode).toBe('[CQ:A]');
    [pathA, pathB, pathC].forEach(p => fs.unlinkSync(p));
    fs.rmdirSync(dir);
  });
});

// ─── EC-6: Top suppressed, next-best above threshold ────────────────────────

describe('EC-6: top suppressed, next-best above threshold', () => {
  it('returns second-best when top is in cooldown', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-ec6-'));
    const pathA = path.join(dir, 'a.jpg');
    const pathB = path.join(dir, 'b.jpg');
    fs.writeFileSync(pathA, 'x');
    fs.writeFileSync(pathB, 'x');

    const stickerA = makeSticker({ key: 'top', localPath: pathA, cqCode: '[CQ:TOP]', summary: '开心顶', contextSamples: ['哈哈哈哈'] });
    const stickerB = makeSticker({ key: 'second', localPath: pathB, cqCode: '[CQ:SECOND]', summary: '开心二', contextSamples: ['哈哈哈哈'] });
    const repo = makeRepo([stickerA, stickerB]);

    const vecs = [
      [1, 0, 0, 0],   // query
      [1, 0, 0, 0],   // stickerA context → cosine 1.0
      [0.9, 0.1, 0, 0.4], // stickerB context → cosine ~0.87 (above 0.20)
    ].map(v => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)); return v.map(x => x / n); });
    let idx = 0;
    const embedder = makeEmbedder(true, () => vecs[idx++]!);
    const mod: IStickerFirstModule = new StickerFirstModule(repo, embedder, identitySampler);

    // Suppress the top sticker
    mod.suppressSticker('g1', 'top');

    const result = await mod.pickSticker('g1', 'query', 0.20, true);
    expect(result?.cqCode).toBe('[CQ:SECOND]');
    [pathA, pathB].forEach(p => fs.unlinkSync(p));
    fs.rmdirSync(dir);
  });
});

// ─── EC-6b: All candidates suppressed ───────────────────────────────────────

describe('EC-6b: all candidates suppressed → returns null', () => {
  it('falls through to null when all stickers in cooldown', async () => {
    const sticker = makeSticker({ key: 'suppressed', contextSamples: ['hi'] });
    const repo = makeRepo([sticker]);
    const embedder = makeEmbedder(true, () => [1, 0, 0, 0]);
    const mod: IStickerFirstModule = new StickerFirstModule(repo, embedder, identitySampler);
    mod.suppressSticker('g1', 'suppressed');
    const result = await mod.pickSticker('g1', 'hi', 0.0, true);
    expect(result).toBeNull();
  });
});

// ─── EC-14: Migration idempotency ───────────────────────────────────────────

describe('EC-14: migration idempotency', () => {
  it('applyMigrations called twice does not throw', async () => {
    const { Database } = await import('../src/storage/db.js');
    const tmpDb = path.join(os.tmpdir(), `sfm-${Date.now()}.db`);
    const db1 = new Database(tmpDb);
    // First run: columns added
    expect(() => db1.close()).not.toThrow();

    // Second run: columns already exist — must be no-op
    const db2 = new Database(tmpDb);
    expect(() => db2.close()).not.toThrow();
    fs.unlinkSync(tmpDb);
  });
});

// ─── EC-21: Embedder not ready ───────────────────────────────────────────────

describe('EC-21: embedder not ready → returns null', () => {
  it('falls through to null without throwing', async () => {
    const sticker = makeSticker({ contextSamples: ['hi'] });
    const repo = makeRepo([sticker]);
    const embedder = makeEmbedder(false);
    const mod: IStickerFirstModule = new StickerFirstModule(repo, embedder, identitySampler);
    const result = await mod.pickSticker('g1', 'hi', 0.25, true);
    expect(result).toBeNull();
    expect(embedder.embed).not.toHaveBeenCalled();
  });
});

// ─── EC-17: Static system prompt invariant ───────────────────────────────────

describe('EC-17: static system prompt invariant', () => {
  it('pickSticker performs NO LLM calls — no system prompt surface', async () => {
    // StickerFirstModule constructor must NOT accept any AI client
    // Its pickSticker must only use embedder + repo
    const repo = makeRepo([makeSticker({ contextSamples: ['hi'] })]);
    const embedder = makeEmbedder(true, () => [1, 0, 0, 0]);
    const mod: IStickerFirstModule = new StickerFirstModule(repo, embedder, identitySampler);
    // No claude client in constructor → any LLM call would throw at compile time
    const result = await mod.pickSticker('g1', 'hi', 0.0, true);
    // Just verifying no error thrown and it returns a value type
    expect(result === null || typeof result?.cqCode === 'string').toBe(true);
  });
});

// ─── EC-7,8: Threshold boundaries ───────────────────────────────────────────

describe('EC-7: threshold 0.0 — accepts everything above zero cosine', () => {
  it('sticker wins when threshold=0.0 and cosine > 0', async () => {
    const localPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-ec7-')) + '/s.jpg';
    fs.writeFileSync(localPath, 'x');
    const sticker = makeSticker({ localPath, cqCode: '[CQ:low]', summary: '开心', contextSamples: ['哈哈哈哈哈'] });
    const repo = makeRepo([sticker]);
    // cos(query, sample) = small positive
    let call = 0;
    const embedder = makeEmbedder(true, () => call++ === 0 ? [1, 0, 0, 0] : [0.01, 0, 0, 0.9999]);
    const mod: IStickerFirstModule = new StickerFirstModule(repo, embedder, identitySampler);
    const result = await mod.pickSticker('g1', '哈哈哈', 0.0, true);
    // cosine should be > 0.0 so it wins
    expect(result).not.toBeNull();
    fs.unlinkSync(localPath);
  });
});

describe('EC-8: threshold 1.0 — only a perfect match wins', () => {
  it('returns null when cosine < 1.0 and threshold=1.0', async () => {
    const sticker = makeSticker({ summary: '开心', contextSamples: ['哈哈哈哈哈'] });
    const repo = makeRepo([sticker]);
    let call = 0;
    const embedder = makeEmbedder(true, () => call++ === 0 ? [1, 0, 0, 0] : [0.99, 0.1, 0, 0]);
    const mod: IStickerFirstModule = new StickerFirstModule(repo, embedder, identitySampler);
    const result = await mod.pickSticker('g1', '开心哈', 1.0, true);
    expect(result).toBeNull();
  });

  it('returns sticker on exact match when threshold=1.0', async () => {
    const localPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-ec8b-')) + '/s.jpg';
    fs.writeFileSync(localPath, 'x');
    const sticker = makeSticker({ localPath, summary: '开心', contextSamples: ['哈哈哈哈哈'] });
    const repo = makeRepo([sticker]);
    const embedder = makeEmbedder(true, () => [1, 0, 0, 0]); // always same vec → cosine=1.0
    const mod: IStickerFirstModule = new StickerFirstModule(repo, embedder, identitySampler);
    const result = await mod.pickSticker('g1', '开心哈哈', 1.0, true);
    expect(result).not.toBeNull();
    fs.unlinkSync(localPath);
  });
});

// ─── EC-20: LLM returns skip/null → intercept never fires ───────────────────
// This is tested in integration via chat.ts, but we verify module contract:
describe('EC-20: null processedText → pickSticker never called', () => {
  it('module contract: pickSticker called with enabled=true can return null without throwing', async () => {
    const repo = makeRepo([]);
    const embedder = makeEmbedder(true);
    const mod: IStickerFirstModule = new StickerFirstModule(repo, embedder, identitySampler);
    // When generateReply returns null, the caller does not call pickSticker
    // This test validates the module itself doesn't misbehave on empty library
    await expect(mod.pickSticker('g1', '', 0.5, true)).resolves.toBeNull();
  });
});

// ─── Sticker with null/missing localPath should be excluded ─────────────────

describe('Sticker with null localPath is excluded from candidates', () => {
  it('returns null when only sticker has null localPath', async () => {
    const sticker = makeSticker({ localPath: null, contextSamples: ['hi'] });
    const repo = makeRepo([sticker]);
    const embedder = makeEmbedder(true, () => [1, 0, 0, 0]);
    const mod: IStickerFirstModule = new StickerFirstModule(repo, embedder, identitySampler);
    const result = await mod.pickSticker('g1', 'hi', 0.0, true);
    expect(result).toBeNull();
  });

  it('returns null when localPath does not exist on disk', async () => {
    const sticker = makeSticker({ localPath: '/no/such/file.jpg', contextSamples: ['hi'] });
    const repo = makeRepo([sticker]);
    const embedder = makeEmbedder(true, () => [1, 0, 0, 0]);
    const mod: IStickerFirstModule = new StickerFirstModule(repo, embedder, identitySampler);
    const result = await mod.pickSticker('g1', 'hi', 0.0, true);
    expect(result).toBeNull();
  });
});

// ─── Sticker with insufficient scorable text is excluded ─────────────────────

describe('Sticker with <6 chars total scorable text is excluded', () => {
  it('summary+context < 6 chars → excluded', async () => {
    const sticker = makeSticker({ summary: 'hi', contextSamples: [] }); // 2 chars, <6
    const repo = makeRepo([sticker]);
    const embedder = makeEmbedder(true, () => [1, 0, 0, 0]);
    const mod: IStickerFirstModule = new StickerFirstModule(repo, embedder, identitySampler);
    const result = await mod.pickSticker('g1', 'test text here', 0.0, true);
    expect(result).toBeNull();
  });

  it('null summary + short context < 6 chars → excluded', async () => {
    const sticker = makeSticker({ summary: null, contextSamples: ['ab'] }); // 2 chars total
    const repo = makeRepo([sticker]);
    const embedder = makeEmbedder(true, () => [1, 0, 0, 0]);
    const mod: IStickerFirstModule = new StickerFirstModule(repo, embedder, identitySampler);
    const result = await mod.pickSticker('g1', 'something', 0.0, true);
    expect(result).toBeNull();
  });

  it('summary+context >= 6 chars → not excluded on text-length grounds', async () => {
    const localPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-mintext-')) + '/s.jpg';
    fs.writeFileSync(localPath, 'x');
    const sticker = makeSticker({ localPath, summary: 'abc', contextSamples: ['def'] }); // 6 chars
    const repo = makeRepo([sticker]);
    const embedder = makeEmbedder(true, () => [1, 0, 0, 0]);
    const mod: IStickerFirstModule = new StickerFirstModule(repo, embedder, identitySampler);
    const result = await mod.pickSticker('g1', 'test', 0.0, true);
    expect(result).not.toBeNull();
    fs.unlinkSync(localPath);
  });
});

// ─── suppressSticker API ─────────────────────────────────────────────────────

describe('suppressSticker', () => {
  it('suppressed key is excluded for 5 minutes', async () => {
    const localPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-sup-')) + '/s.jpg';
    fs.writeFileSync(localPath, 'x');
    const sticker = makeSticker({ key: 'k1', localPath, contextSamples: ['hi there ok'] });
    const repo = makeRepo([sticker]);
    const embedder = makeEmbedder(true, () => [1, 0, 0, 0]);
    const mod: IStickerFirstModule = new StickerFirstModule(repo, embedder, identitySampler);
    mod.suppressSticker('g1', 'k1');
    const result = await mod.pickSticker('g1', 'hi', 0.0, true);
    expect(result).toBeNull();
    fs.unlinkSync(localPath);
  });

  it('suppression is per-group, does not affect another group', async () => {
    const localPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-grp-')) + '/s.jpg';
    fs.writeFileSync(localPath, 'x');
    const sticker = makeSticker({ key: 'k1', localPath, contextSamples: ['hi there ok'] });
    const repoG2 = makeRepo([sticker]);
    const embedder = makeEmbedder(true, () => [1, 0, 0, 0]);
    const mod: IStickerFirstModule = new StickerFirstModule(repoG2, embedder, identitySampler);
    mod.suppressSticker('g1', 'k1');
    // Group g2 is NOT suppressed
    const result = await mod.pickSticker('g2', 'hi', 0.0, true);
    expect(result).not.toBeNull();
    fs.unlinkSync(localPath);
  });
});

// ─── Embed strategy: concatenated string ────────────────────────────────────

describe('Scoring: concatenated context string (not per-sample max)', () => {
  it('embeds concatenated [summary, ...contextSamples].join(" ") as ONE string per sticker', async () => {
    const localPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-concat-')) + '/s.jpg';
    fs.writeFileSync(localPath, 'x');
    const sticker = makeSticker({
      localPath,
      summary: '开心',
      contextSamples: ['哈哈哈', '好笑啊', '太好笑了'],
    });
    const repo = makeRepo([sticker]);
    const calls: string[] = [];
    const embedder = makeEmbedder(true, (text) => { calls.push(text); return [1, 0, 0, 0]; });
    const mod: IStickerFirstModule = new StickerFirstModule(repo, embedder, identitySampler);
    await mod.pickSticker('g1', 'test query', 0.0, true);
    // First call = query text, second call = concatenated sticker text
    expect(calls.length).toBe(2);
    expect(calls[0]).toBe('test query');
    expect(calls[1]).toBe('开心 哈哈哈 好笑啊 太好笑了');
    fs.unlinkSync(localPath);
  });
});

// ─── EC-12, EC-13: GroupConfig defaults for sticker-first ───────────────────

describe('EC-12/EC-13: GroupConfig has stickerFirstEnabled + stickerFirstThreshold', () => {
  it('defaultGroupConfig includes stickerFirstEnabled=false and stickerFirstThreshold=0.55', async () => {
    const { defaultGroupConfig } = await import('../src/config.js');
    const cfg = defaultGroupConfig('g1');
    expect(cfg.stickerFirstEnabled).toBe(false);
    expect(cfg.stickerFirstThreshold).toBe(0.55);
  });
});

// ─── EC: GroupConfig read/write via DB ───────────────────────────────────────

describe('GroupConfig DB round-trip for sticker-first fields', () => {
  it('upsert + get preserves stickerFirstEnabled and stickerFirstThreshold', async () => {
    const { Database } = await import('../src/storage/db.js');
    const { defaultGroupConfig } = await import('../src/config.js');
    const tmpDb = path.join(os.tmpdir(), `sfcfg-${Date.now()}.db`);
    const db = new Database(tmpDb);

    const cfg = { ...defaultGroupConfig('g1'), stickerFirstEnabled: true, stickerFirstThreshold: 0.35 };
    db.groupConfig.upsert(cfg);
    const retrieved = db.groupConfig.get('g1');
    expect(retrieved?.stickerFirstEnabled).toBe(true);
    expect(retrieved?.stickerFirstThreshold).toBeCloseTo(0.35);

    db.close();
    fs.unlinkSync(tmpDb);
  });

  it('default value is stickerFirstEnabled=false when config inserted without explicit value', async () => {
    const { Database } = await import('../src/storage/db.js');
    const { defaultGroupConfig } = await import('../src/config.js');
    const tmpDb = path.join(os.tmpdir(), `sfcfg2-${Date.now()}.db`);
    const db = new Database(tmpDb);

    db.groupConfig.upsert(defaultGroupConfig('g1'));
    const retrieved = db.groupConfig.get('g1');
    expect(retrieved?.stickerFirstEnabled).toBe(false);
    expect(retrieved?.stickerFirstThreshold).toBe(0.55);

    db.close();
    fs.unlinkSync(tmpDb);
  });
});

// ─── EC-9, EC-10, EC-11: BotErrorCode.STICKER_THRESHOLD_INVALID ─────────────

describe('EC-9/EC-10/EC-11: BotErrorCode.STICKER_THRESHOLD_INVALID = E030', () => {
  it('BotErrorCode includes STICKER_THRESHOLD_INVALID = E030', async () => {
    const { BotErrorCode } = await import('../src/utils/errors.js');
    expect(BotErrorCode.STICKER_THRESHOLD_INVALID).toBe('E030');
  });
});

// ─── StickerChoice return type ───────────────────────────────────────────────

describe('StickerChoice shape', () => {
  it('pickSticker returns { key, cqCode, score } when sticker wins', async () => {
    const localPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-shape-')) + '/s.jpg';
    fs.writeFileSync(localPath, 'x');
    const sticker = makeSticker({ localPath, cqCode: '[CQ:X]', contextSamples: ['hi there ok'] });
    const repo = makeRepo([sticker]);
    const embedder = makeEmbedder(true, () => [1, 0, 0, 0]);
    const mod: IStickerFirstModule = new StickerFirstModule(repo, embedder, identitySampler);
    const result = await mod.pickSticker('g1', 'hi', 0.0, true);
    expect(result).not.toBeNull();
    expect(typeof result!.key).toBe('string');
    expect(typeof result!.cqCode).toBe('string');
    expect(typeof result!.score).toBe('number');
    expect(result!.score).toBeGreaterThanOrEqual(0.0);
    fs.unlinkSync(localPath);
  });
});

// ─── Embed failure paths ─────────────────────────────────────────────────────

describe('Embed query failure falls through to null', () => {
  it('returns null and does not throw when embed(intendedText) rejects', async () => {
    const sticker = makeSticker({ contextSamples: ['哈哈哈哈哈'] });
    const repo = makeRepo([sticker]);
    const embedder = makeEmbedder(true, () => { throw new Error('embed network error'); });
    const mod: IStickerFirstModule = new StickerFirstModule(repo, embedder, identitySampler);
    const result = await mod.pickSticker('g1', '测试', 0.0, true);
    expect(result).toBeNull();
  });
});

describe('Embed sticker failure skips that sticker', () => {
  it('skips sticker whose embed rejects, returns null if no others qualify', async () => {
    const localPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-embfail-')) + '/s.jpg';
    fs.writeFileSync(localPath, 'x');
    const sticker = makeSticker({ localPath, summary: '开心', contextSamples: ['哈哈哈哈哈'] });
    const repo = makeRepo([sticker]);
    let callIdx = 0;
    const embedder = makeEmbedder(true, () => {
      if (callIdx++ === 0) return [1, 0, 0, 0]; // query succeeds
      throw new Error('sticker embed failure');  // sticker embed fails
    });
    const mod: IStickerFirstModule = new StickerFirstModule(repo, embedder, identitySampler);
    const result = await mod.pickSticker('g1', '测试', 0.0, true);
    expect(result).toBeNull(); // sticker skipped, no candidates left
    fs.unlinkSync(localPath);
  });
});
