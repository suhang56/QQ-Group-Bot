import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Router } from '../src/core/router.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { Database } from '../src/storage/db.js';
import { defaultGroupConfig } from '../src/config.js';
import type { GroupMessage, INapCatAdapter } from '../src/adapter/napcat.js';
import { initLogger } from '../src/utils/logger.js';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

initLogger({ level: 'silent' });

function makeMsg(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    messageId: 'm1',
    groupId: 'g1',
    userId: 'u1',
    nickname: 'Admin',
    role: 'admin',
    content: '/stickerfirst_on',
    rawContent: '/stickerfirst_on',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeMockAdapter(): INapCatAdapter {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    ban: vi.fn().mockResolvedValue(undefined),
    kick: vi.fn().mockResolvedValue(undefined),
    deleteMsg: vi.fn().mockResolvedValue(undefined),
    sendPrivate: vi.fn().mockResolvedValue(undefined),
    sendPrivateMessage: vi.fn().mockResolvedValue(42),
    getGroupNotices: vi.fn().mockResolvedValue([]),
    getGroupInfo: vi.fn().mockResolvedValue({ groupId: 'g1', name: 'Test', description: '', memberCount: 1 }),
    getImage: vi.fn().mockResolvedValue({ filename: '', url: '', size: 0 }),
  };
}

describe('Router sticker-first commands', () => {
  let db: Database;
  let adapter: INapCatAdapter;
  let router: Router;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-router-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = new Database(dbPath);
    db.groupConfig.upsert(defaultGroupConfig('g1'));
    adapter = makeMockAdapter();
    router = new Router(db, adapter, new RateLimiter());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function getSentMessages(): string[] {
    return (adapter.send as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[1] as string
    );
  }

  // ── EC-15: non-admin silently ignored ──────────────────────────────────────

  it('EC-15: non-admin /stickerfirst_on is silently ignored', async () => {
    const msg = makeMsg({ role: 'member', content: '/stickerfirst_on', rawContent: '/stickerfirst_on' });
    await router.dispatch(msg);
    const sent = getSentMessages();
    const stickerReplies = sent.filter(txt =>
      txt.includes('表情包优先模式已开启') || txt.includes('本来就是开着')
    );
    expect(stickerReplies).toHaveLength(0);
    // Mode must NOT be enabled
    expect(db.groupConfig.get('g1')?.stickerFirstEnabled).toBe(false);
  });

  // ── /stickerfirst_on ───────────────────────────────────────────────────────

  it('EC-12: /stickerfirst_on enables mode when library is empty (warns)', async () => {
    const msg = makeMsg({ content: '/stickerfirst_on', rawContent: '/stickerfirst_on' });
    await router.dispatch(msg);
    const sent = getSentMessages();
    const found = sent.some(txt =>
      txt.includes('表情包优先模式已开启') || txt.includes('暂无本地表情包')
    );
    expect(found).toBe(true);
    expect(db.groupConfig.get('g1')?.stickerFirstEnabled).toBe(true);
  });

  it('EC-12 idempotent: /stickerfirst_on when already ON sends already-on message', async () => {
    db.groupConfig.upsert({ ...defaultGroupConfig('g1'), stickerFirstEnabled: true });
    const msg = makeMsg({ content: '/stickerfirst_on', rawContent: '/stickerfirst_on' });
    await router.dispatch(msg);
    const sent = getSentMessages();
    expect(sent.some(txt => txt.includes('本来就是开着'))).toBe(true);
  });

  // ── /stickerfirst_off ──────────────────────────────────────────────────────

  it('/stickerfirst_off disables mode and confirms', async () => {
    db.groupConfig.upsert({ ...defaultGroupConfig('g1'), stickerFirstEnabled: true });
    const msg = makeMsg({ content: '/stickerfirst_off', rawContent: '/stickerfirst_off' });
    await router.dispatch(msg);
    expect(db.groupConfig.get('g1')?.stickerFirstEnabled).toBe(false);
    const sent = getSentMessages();
    expect(sent.some(txt => txt.includes('已关闭'))).toBe(true);
  });

  it('EC-13 idempotent: /stickerfirst_off when already OFF sends already-off message', async () => {
    const msg = makeMsg({ content: '/stickerfirst_off', rawContent: '/stickerfirst_off' });
    await router.dispatch(msg);
    const sent = getSentMessages();
    expect(sent.some(txt => txt.includes('本来就是关着'))).toBe(true);
  });

  // ── /stickerfirst_threshold ────────────────────────────────────────────────

  it('EC-7: /stickerfirst_threshold 0.0 — valid boundary, sets threshold', async () => {
    const msg = makeMsg({ content: '/stickerfirst_threshold 0.0', rawContent: '/stickerfirst_threshold 0.0' });
    await router.dispatch(msg);
    expect(db.groupConfig.get('g1')?.stickerFirstThreshold).toBeCloseTo(0.0);
    const sent = getSentMessages();
    expect(sent.some(txt => txt.includes('阈值已设为'))).toBe(true);
  });

  it('EC-8: /stickerfirst_threshold 1.0 — valid boundary', async () => {
    const msg = makeMsg({ content: '/stickerfirst_threshold 1.0', rawContent: '/stickerfirst_threshold 1.0' });
    await router.dispatch(msg);
    expect(db.groupConfig.get('g1')?.stickerFirstThreshold).toBeCloseTo(1.0);
  });

  it('EC-9: /stickerfirst_threshold -0.1 — E030 below range', async () => {
    const msg = makeMsg({ content: '/stickerfirst_threshold -0.1', rawContent: '/stickerfirst_threshold -0.1' });
    await router.dispatch(msg);
    const sent = getSentMessages();
    expect(sent.some(txt => txt.includes('无效的阈值格式'))).toBe(true);
    expect(db.groupConfig.get('g1')?.stickerFirstThreshold).toBe(0.55);
  });

  it('EC-10: /stickerfirst_threshold 1.5 — E030 above range', async () => {
    const msg = makeMsg({ content: '/stickerfirst_threshold 1.5', rawContent: '/stickerfirst_threshold 1.5' });
    await router.dispatch(msg);
    const sent = getSentMessages();
    expect(sent.some(txt => txt.includes('无效的阈值格式'))).toBe(true);
  });

  it('EC-11: /stickerfirst_threshold abc — E030 non-numeric', async () => {
    const msg = makeMsg({ content: '/stickerfirst_threshold abc', rawContent: '/stickerfirst_threshold abc' });
    await router.dispatch(msg);
    const sent = getSentMessages();
    expect(sent.some(txt => txt.includes('无效的阈值格式'))).toBe(true);
  });

  it('/stickerfirst_threshold — no argument sends usage help', async () => {
    const msg = makeMsg({ content: '/stickerfirst_threshold', rawContent: '/stickerfirst_threshold' });
    await router.dispatch(msg);
    const sent = getSentMessages();
    expect(sent.some(txt => txt.includes('用法：/stickerfirst_threshold'))).toBe(true);
  });

  // ── /stickerfirst_status ───────────────────────────────────────────────────

  it('EC-16: /stickerfirst_status shows ON, threshold, library count', async () => {
    db.groupConfig.upsert({ ...defaultGroupConfig('g1'), stickerFirstEnabled: true, stickerFirstThreshold: 0.3 });
    const msg = makeMsg({ content: '/stickerfirst_status', rawContent: '/stickerfirst_status' });
    await router.dispatch(msg);
    const sent = getSentMessages();
    const statusMsg = sent.find(txt => txt.includes('表情包优先模式状态'));
    expect(statusMsg).toBeDefined();
    expect(statusMsg!).toContain('ON');
    expect(statusMsg!).toContain('0.3');
    expect(statusMsg!).toContain('0 张');
    expect(statusMsg!).toContain('暂无');
  });

  it('/stickerfirst_status shows OFF when mode disabled', async () => {
    const msg = makeMsg({ content: '/stickerfirst_status', rawContent: '/stickerfirst_status' });
    await router.dispatch(msg);
    const sent = getSentMessages();
    const statusMsg = sent.find(txt => txt.includes('表情包优先模式状态'));
    expect(statusMsg).toBeDefined();
    expect(statusMsg!).toContain('OFF');
  });

  it('/stickerfirst_status non-admin is silently ignored', async () => {
    const msg = makeMsg({ role: 'member', content: '/stickerfirst_status', rawContent: '/stickerfirst_status' });
    await router.dispatch(msg);
    const sent = getSentMessages();
    expect(sent.some(txt => txt.includes('表情包优先模式状态'))).toBe(false);
  });
});
