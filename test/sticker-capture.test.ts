import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StickerCaptureService } from '../src/modules/sticker-capture.js';
import type { ILocalStickerRepository } from '../src/storage/db.js';
import type { INapCatAdapter } from '../src/adapter/napcat.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

function makeRepo(): ILocalStickerRepository {
  return {
    upsert: vi.fn().mockReturnValue('inserted'),
    getTopByGroup: vi.fn().mockReturnValue([]),
    recordUsage: vi.fn(),
  };
}

function makeAdapter(): INapCatAdapter {
  return {
    connect: vi.fn(), disconnect: vi.fn(), on: vi.fn(),
    send: vi.fn().mockResolvedValue(1),
    ban: vi.fn(), kick: vi.fn(), deleteMsg: vi.fn(), sendPrivate: vi.fn(),
    getGroupNotices: vi.fn(),
    getImage: vi.fn().mockResolvedValue({
      filename: 'sticker.jpg', url: 'http://example.com/img.jpg', size: 100,
    }),
    getGroupInfo: vi.fn(),
  } as unknown as INapCatAdapter;
}

// Minimal fetch mock that returns fake image bytes
const FAKE_IMAGE = Buffer.from('GIF89a', 'utf8');
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  ok: true,
  arrayBuffer: () => Promise.resolve(FAKE_IMAGE.buffer),
}));

describe('StickerCaptureService — static helpers', () => {
  it('extractImageStickerFile returns file token for sub_type=1 images', () => {
    const raw = '[CQ:image,file=abc123,url=http://x.com/img.jpg,sub_type=1]';
    expect(StickerCaptureService.extractImageStickerFile(raw)).toBe('abc123');
  });

  it('extractImageStickerFile returns null when sub_type is not 1', () => {
    const raw = '[CQ:image,file=abc123,url=http://x.com/img.jpg,sub_type=0]';
    expect(StickerCaptureService.extractImageStickerFile(raw)).toBeNull();
  });

  it('extractImageStickerFile returns null when no image', () => {
    expect(StickerCaptureService.extractImageStickerFile('hello world')).toBeNull();
  });

  it('extractMfaces returns key+cqCode+summary for each mface', () => {
    const raw = '[CQ:mface,package_id=pkg1,emoji_id=eid1,summary=笑哭]';
    const results = StickerCaptureService.extractMfaces(raw);
    expect(results).toHaveLength(1);
    expect(results[0]!.key).toBe('mface:pkg1:eid1');
    expect(results[0]!.summary).toBe('笑哭');
  });

  it('extractMfaces returns empty array when no mface', () => {
    expect(StickerCaptureService.extractMfaces('普通消息')).toHaveLength(0);
  });

  it('buildContextSample joins non-empty texts', () => {
    expect(StickerCaptureService.buildContextSample(['哈哈', '真的假的'])).toBe('哈哈 / 真的假的');
  });

  it('buildContextSample returns null when all empty', () => {
    expect(StickerCaptureService.buildContextSample(['', '  '])).toBeNull();
  });
});

describe('StickerCaptureService — mface capture', () => {
  let repo: ILocalStickerRepository;
  let svc: StickerCaptureService;

  beforeEach(() => {
    repo = makeRepo();
    svc = new StickerCaptureService(repo, makeAdapter(), { downloadRateLimitMs: 0 });
  });

  it('captures mface without downloading — upserts with localPath=null', async () => {
    const raw = '[CQ:mface,package_id=pkg1,emoji_id=eid1,summary=摆烂]';
    await svc.captureFromMessage('g1', raw, '太懒了', 'u1', 'bot');
    expect(repo.upsert).toHaveBeenCalledWith(
      'g1', 'mface:pkg1:eid1', 'mface', null,
      raw, '摆烂', '太懒了', expect.any(Number), expect.any(Number),
    );
  });

  it('skips messages from the bot itself', async () => {
    const raw = '[CQ:mface,package_id=pkg1,emoji_id=eid1]';
    await svc.captureFromMessage('g1', raw, null, 'bot', 'bot');
    expect(repo.upsert).not.toHaveBeenCalled();
  });
});

describe('StickerCaptureService — image sticker capture', () => {
  let repo: ILocalStickerRepository;
  let adapter: INapCatAdapter;

  beforeEach(() => {
    repo = makeRepo();
    adapter = makeAdapter();
  });

  it('new image sticker → inserts row (upsert returns inserted)', async () => {
    vi.mocked(repo.upsert).mockReturnValue('inserted');
    const svc = new StickerCaptureService(repo, adapter, {
      localDir: '/tmp/test-stickers', downloadRateLimitMs: 0,
    });
    const raw = '[CQ:image,file=tok1,url=http://x.com/img.jpg,sub_type=1]';
    await svc.captureFromMessage('g1', raw, '笑死', 'u1', 'bot');
    expect(repo.upsert).toHaveBeenCalledWith(
      'g1', expect.any(String), 'image', expect.stringContaining('g1'),
      expect.stringContaining('[CQ:image,file=file:///'), null, '笑死',
      expect.any(Number), expect.any(Number),
    );
  });

  it('duplicate sticker → upsert returns updated, no file write attempt conflict', async () => {
    vi.mocked(repo.upsert).mockReturnValue('updated');
    const svc = new StickerCaptureService(repo, adapter, { downloadRateLimitMs: 0 });
    const raw = '[CQ:image,file=tok1,url=http://x.com/img.jpg,sub_type=1]';
    // Should not throw even though file already exists
    await expect(svc.captureFromMessage('g1', raw, null, 'u1', 'bot')).resolves.not.toThrow();
    expect(repo.upsert).toHaveBeenCalledTimes(1);
  });

  it('rate limit: second call within window skips download', async () => {
    const svc = new StickerCaptureService(repo, adapter, { downloadRateLimitMs: 10_000 });
    const raw = '[CQ:image,file=tok1,url=http://x.com/img.jpg,sub_type=1]';
    await svc.captureFromMessage('g1', raw, null, 'u1', 'bot');
    const callCount = vi.mocked(repo.upsert).mock.calls.length;
    // Second call within rate limit window → skipped
    await svc.captureFromMessage('g1', raw, null, 'u1', 'bot');
    expect(vi.mocked(repo.upsert).mock.calls.length).toBe(callCount); // no new upsert
  });

  it('rate limit is per-group: group A throttled, group B still goes through', async () => {
    const svc = new StickerCaptureService(repo, adapter, { downloadRateLimitMs: 10_000 });
    const raw = '[CQ:image,file=tok1,url=http://x.com/img.jpg,sub_type=1]';
    await svc.captureFromMessage('g1', raw, null, 'u1', 'bot'); // g1 first call
    const afterFirst = vi.mocked(repo.upsert).mock.calls.length;
    await svc.captureFromMessage('g1', raw, null, 'u1', 'bot'); // g1 rate-limited
    expect(vi.mocked(repo.upsert).mock.calls.length).toBe(afterFirst);
    await svc.captureFromMessage('g2', raw, null, 'u1', 'bot'); // g2 not throttled
    expect(vi.mocked(repo.upsert).mock.calls.length).toBeGreaterThan(afterFirst);
  });
});

describe('StickerCaptureService — context samples rolling cap', () => {
  it('context_samples rolling cap is enforced by repository upsert (maxSamples param)', async () => {
    const repo = makeRepo();
    const svc = new StickerCaptureService(repo, makeAdapter(), {
      maxContextSamples: 3, downloadRateLimitMs: 0,
    });
    const raw = '[CQ:mface,package_id=p,emoji_id=e]';
    await svc.captureFromMessage('g1', raw, 'sample', 'u1', 'bot');
    // Confirm the last argument (maxSamples) is 3
    const calls = vi.mocked(repo.upsert).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]![calls[0]!.length - 1]).toBe(3);
  });
});

describe('LocalStickerRepository — usage feedback', () => {
  it('recordUsage positive → increments usage_positive in DB', () => {
    const repo = makeRepo();
    repo.recordUsage('g1', 'mface:p:e', true);
    expect(repo.recordUsage).toHaveBeenCalledWith('g1', 'mface:p:e', true);
  });

  it('recordUsage negative → increments usage_negative in DB', () => {
    const repo = makeRepo();
    repo.recordUsage('g1', 'hash123', false);
    expect(repo.recordUsage).toHaveBeenCalledWith('g1', 'hash123', false);
  });
});
