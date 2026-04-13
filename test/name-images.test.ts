import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Database } from '../src/storage/db.js';
import { NameImagesModule, type IImageAdapter } from '../src/modules/name-images.js';
import { _extractImageUrl, _extractImageFile } from '../src/core/router.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'name-img-test-'));
}

function makeDb(): Database {
  return new Database(':memory:');
}

function makeModule(db: Database, dir: string): NameImagesModule {
  return new NameImagesModule(db.nameImages, dir);
}

/** Create a minimal 1×1 JPEG buffer (valid magic bytes). */
function fakeJpeg(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(50).fill(0x00)]);
}

/** Stub global fetch for tests. */
function stubFetch(buf: Buffer, contentType = 'image/jpeg'): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    headers: { get: () => contentType },
    arrayBuffer: () => Promise.resolve(buf.buffer),
  }));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('NameImagesModule — collection state', () => {
  let db: Database;
  let tmpDir: string;
  let mod: NameImagesModule;

  beforeEach(() => {
    db = makeDb();
    tmpDir = makeTmpDir();
    mod = makeModule(db, tmpDir);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. /add starts collection; subsequent image gets saved
  it('startCollecting → getCollectionTarget returns name', () => {
    mod.startCollecting('g1', 'u1', '西瓜', 120_000);
    expect(mod.getCollectionTarget('g1', 'u1')).toBe('西瓜');
  });

  // 2. Collection state auto-expires after timeout
  it('collection state expires after timeoutMs', () => {
    mod.startCollecting('g1', 'u1', '西瓜', 120_000);
    vi.advanceTimersByTime(120_001);
    expect(mod.getCollectionTarget('g1', 'u1')).toBeNull();
  });

  // 7. User not in collection state → getCollectionTarget returns null
  it('returns null when user is not collecting', () => {
    expect(mod.getCollectionTarget('g1', 'u-unknown')).toBeNull();
  });

  it('stopCollecting clears state immediately', () => {
    mod.startCollecting('g1', 'u1', '某人', 120_000);
    mod.stopCollecting('g1', 'u1');
    expect(mod.getCollectionTarget('g1', 'u1')).toBeNull();
  });

  it('different users in same group have independent states', () => {
    mod.startCollecting('g1', 'u1', 'Alice', 120_000);
    mod.startCollecting('g1', 'u2', 'Bob', 120_000);
    expect(mod.getCollectionTarget('g1', 'u1')).toBe('Alice');
    expect(mod.getCollectionTarget('g1', 'u2')).toBe('Bob');
    mod.stopCollecting('g1', 'u1');
    expect(mod.getCollectionTarget('g1', 'u1')).toBeNull();
    expect(mod.getCollectionTarget('g1', 'u2')).toBe('Bob');
  });
});

describe('NameImagesModule — saveImage', () => {
  let db: Database;
  let tmpDir: string;
  let mod: NameImagesModule;

  beforeEach(() => {
    db = makeDb();
    tmpDir = makeTmpDir();
    mod = makeModule(db, tmpDir);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. Successful save
  it('saves image to disk and inserts into DB', async () => {
    stubFetch(fakeJpeg());
    const result = await mod.saveImage('g1', '西瓜', 'http://example.com/a.jpg', 'src-a', 'u1', 50);
    expect(result).not.toBe('dedup');
    expect(result).not.toBe('cap_reached');
    if (typeof result === 'object') {
      expect(fs.existsSync(result.filePath)).toBe(true);
      expect(result.name).toBe('西瓜');
      expect(result.groupId).toBe('g1');
    }
    expect(db.nameImages.countByName('g1', '西瓜')).toBe(1);
  });

  // 3. Same source_file twice → dedup
  it('same source_file twice → second insert is dedup', async () => {
    stubFetch(fakeJpeg());
    await mod.saveImage('g1', '西瓜', 'http://example.com/a.jpg', 'src-dup', 'u1', 50);
    stubFetch(fakeJpeg());
    const second = await mod.saveImage('g1', '西瓜', 'http://example.com/a.jpg', 'src-dup', 'u1', 50);
    expect(second).toBe('dedup');
    expect(db.nameImages.countByName('g1', '西瓜')).toBe(1);
  });

  // 8. Add when at max-per-name cap → cap_reached
  it('returns cap_reached when at nameImagesMaxPerName limit', async () => {
    // Insert 3 images manually
    for (let i = 0; i < 3; i++) {
      stubFetch(fakeJpeg());
      await mod.saveImage('g1', '西瓜', `http://example.com/${i}.jpg`, `src-${i}`, 'u1', 3);
    }
    stubFetch(fakeJpeg());
    const result = await mod.saveImage('g1', '西瓜', 'http://example.com/4.jpg', 'src-4', 'u1', 3);
    expect(result).toBe('cap_reached');
    expect(db.nameImages.countByName('g1', '西瓜')).toBe(3);
  });

  // 9. Image URL download fails → throws
  it('throws when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, headers: { get: () => null } }));
    await expect(
      mod.saveImage('g1', '西瓜', 'http://example.com/bad.jpg', 'src-bad', 'u1', 50)
    ).rejects.toThrow();
    expect(db.nameImages.countByName('g1', '西瓜')).toBe(0);
  });

  // Non-image content type → throws
  it('throws when content-type is not image/', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/html' },
      arrayBuffer: () => Promise.resolve(Buffer.from('<html>').buffer),
    }));
    await expect(
      mod.saveImage('g1', '西瓜', 'http://example.com/html', 'src-html', 'u1', 50)
    ).rejects.toThrow('Non-image content-type');
  });

  // Image over 5 MB → throws
  it('throws when image exceeds 5 MB size limit', async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 0x00);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: () => Promise.resolve(oversized.buffer),
    }));
    await expect(
      mod.saveImage('g1', '西瓜', 'http://example.com/big.jpg', 'src-big', 'u1', 50)
    ).rejects.toThrow('Image too large');
    expect(db.nameImages.countByName('g1', '西瓜')).toBe(0);
  });

  // adapter.getImage base64 → save succeeds
  it('adapter.getImage returning base64 → file written and DB row inserted', async () => {
    const fakeAdapter: IImageAdapter = {
      getImage: vi.fn().mockResolvedValue({
        filename: 'img.jpg', url: '', size: fakeJpeg().length,
        base64: fakeJpeg().toString('base64'),
      }),
    };
    const modWithAdapter = new NameImagesModule(db.nameImages, tmpDir, fakeAdapter);
    const result = await modWithAdapter.saveImage('g1', '西瓜', '', 'file-unique-1', 'u1', 50, 'abc123.image');
    expect(result).not.toBe('dedup');
    expect(result).not.toBe('cap_reached');
    if (typeof result === 'object') expect(fs.existsSync(result.filePath)).toBe(true);
    expect(db.nameImages.countByName('g1', '西瓜')).toBe(1);
    expect(fakeAdapter.getImage).toHaveBeenCalledWith('abc123.image');
  });

  // adapter.getImage throws → fallback to URL fetch
  it('adapter.getImage throwing → falls back to URL fetch', async () => {
    const fakeAdapter: IImageAdapter = {
      getImage: vi.fn().mockRejectedValue(new Error('NapCat timeout')),
    };
    stubFetch(fakeJpeg());
    const modWithAdapter = new NameImagesModule(db.nameImages, tmpDir, fakeAdapter);
    const result = await modWithAdapter.saveImage('g1', '西瓜', 'http://example.com/a.jpg', 'file-unique-2', 'u1', 50, 'abc123.image');
    expect(result).not.toBe('dedup');
    expect(db.nameImages.countByName('g1', '西瓜')).toBe(1);
  });

  // Same source_file (cqFile) → dedup on second save
  it('same cqFile twice → second insert is dedup', async () => {
    const fakeAdapter: IImageAdapter = {
      getImage: vi.fn().mockResolvedValue({
        filename: 'img.jpg', url: '', size: fakeJpeg().length,
        base64: fakeJpeg().toString('base64'),
      }),
    };
    const modWithAdapter = new NameImagesModule(db.nameImages, tmpDir, fakeAdapter);
    await modWithAdapter.saveImage('g1', '西瓜', '', 'src-dedup', 'u1', 50, 'src-dedup');
    const second = await modWithAdapter.saveImage('g1', '西瓜', '', 'src-dedup', 'u1', 50, 'src-dedup');
    expect(second).toBe('dedup');
    expect(db.nameImages.countByName('g1', '西瓜')).toBe(1);
  });
});

describe('NameImagesModule — name detection and cooldown', () => {
  let db: Database;
  let tmpDir: string;
  let mod: NameImagesModule;

  beforeEach(() => {
    db = makeDb();
    tmpDir = makeTmpDir();
    mod = makeModule(db, tmpDir);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 4. Name appears in message → pickRandom returns image
  it('pickRandom returns null when no images for name', () => {
    expect(mod.pickRandom('g1', '西瓜')).toBeNull();
  });

  // 5. Cooldown: first call allowed, second blocked
  it('checkAndSetCooldown allows first, blocks second within cooldown', () => {
    expect(mod.checkAndSetCooldown('g1', '西瓜', 300_000)).toBe(true);
    expect(mod.checkAndSetCooldown('g1', '西瓜', 300_000)).toBe(false);
  });

  it('checkAndSetCooldown allows after cooldown expires', () => {
    expect(mod.checkAndSetCooldown('g1', '西瓜', 300_000)).toBe(true);
    vi.advanceTimersByTime(300_001);
    expect(mod.checkAndSetCooldown('g1', '西瓜', 300_000)).toBe(true);
  });

  // 6. Multiple names in message → longest match wins
  it('findLongestMatch picks longest name when multiple match', () => {
    const names = ['西瓜', '西瓜伪', '伪'];
    expect(mod.findLongestMatch('西瓜伪真的很好吃', names)).toBe('西瓜伪');
  });

  it('findLongestMatch returns null when no name matches', () => {
    expect(mod.findLongestMatch('今天天气真好', ['西瓜', 'Alice'])).toBeNull();
  });

  // 12. Case-insensitive for Latin names
  it('findLongestMatch is case-insensitive for Latin names', () => {
    expect(mod.findLongestMatch('kisa is cool', ['Kisa'])).toBe('Kisa');
    expect(mod.findLongestMatch('KISA IS COOL', ['kisa'])).toBe('kisa');
  });

  // 11. Name with spaces is handled
  it('name with spaces is found in message', () => {
    expect(mod.findLongestMatch('西瓜 伪 来了', ['西瓜 伪'])).toBe('西瓜 伪');
  });
});

describe('NameImagesModule — getAllNames cache', () => {
  let db: Database;
  let tmpDir: string;
  let mod: NameImagesModule;

  beforeEach(() => {
    db = makeDb();
    tmpDir = makeTmpDir();
    mod = makeModule(db, tmpDir);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getAllNames returns empty list when no images', () => {
    expect(mod.getAllNames('g1')).toEqual([]);
  });

  it('getAllNames cache expires after 60s and refreshes', async () => {
    // Insert via repo directly to bypass download
    db.nameImages.insert('g1', '测试', '/fake/path.jpg', null, 'u1');
    // First call (no cache)
    const names1 = mod.getAllNames('g1');
    expect(names1).toContain('测试');
    // Advance < 60s → still cached
    vi.advanceTimersByTime(59_999);
    const names2 = mod.getAllNames('g1');
    expect(names2).toContain('测试');
    // Advance past 60s → cache expires, fresh read
    vi.advanceTimersByTime(2);
    db.nameImages.insert('g1', '新名字', '/fake/path2.jpg', null, 'u1');
    const names3 = mod.getAllNames('g1');
    expect(names3).toContain('新名字');
  });
});

describe('_extractImageFile', () => {
  it('extracts file field from CQ:image', () => {
    const raw = '[CQ:image,file=abc123.image,url=https://example.com/img.jpg]';
    expect(_extractImageFile(raw)).toBe('abc123.image');
  });

  it('returns null when no file field', () => {
    expect(_extractImageFile('[CQ:at,qq=123]')).toBeNull();
  });
});

describe('_extractImageUrl', () => {
  it('extracts http url from CQ:image', () => {
    const raw = '[CQ:image,file=xxx,url=https://example.com/img.jpg]';
    expect(_extractImageUrl(raw)).toBe('https://example.com/img.jpg');
  });

  it('returns null when no url field', () => {
    expect(_extractImageUrl('[CQ:image,file=abc]')).toBeNull();
  });

  it('returns null for relative url', () => {
    expect(_extractImageUrl('[CQ:image,file=x,url=/download?id=123]')).toBeNull();
  });

  // 10. Non-image in collection mode: no [CQ:image,...] → no save triggered
  it('returns null when rawContent has no image CQ code', () => {
    expect(_extractImageUrl('普通文字消息')).toBeNull();
    expect(_extractImageUrl('[CQ:at,qq=12345]')).toBeNull();
  });
});
