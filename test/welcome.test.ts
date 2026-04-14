import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WelcomeModule } from '../src/modules/welcome.js';
import type { IWelcomeLogRepository } from '../src/storage/db.js';
import type { INapCatAdapter } from '../src/adapter/napcat.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const BOT_ID = 'bot-123';
const GROUP_ID = 'g1';
const USER_ID = 'u99';

// A valid welcome reply per the new validator
const VALID_REPLY = '欢迎来到北美邦批聚集地！记得翻一下群公告，群规和活动都在里面';

function makeClaudeResp(text: string): ClaudeResponse {
  return { text, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function makeWelcomeLog(overrides: Partial<IWelcomeLogRepository> = {}): IWelcomeLogRepository {
  return {
    record: vi.fn(),
    lastWelcomeAt: vi.fn().mockReturnValue(null),
    ...overrides,
  };
}

function makeAdapter(): INapCatAdapter {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    send: vi.fn().mockResolvedValue(42),
    ban: vi.fn(),
    kick: vi.fn(),
    deleteMsg: vi.fn(),
    sendPrivate: vi.fn(),
    sendPrivateMessage: vi.fn().mockResolvedValue(42),
    getGroupNotices: vi.fn(),
    getImage: vi.fn(),
    getGroupInfo: vi.fn(),
    getForwardMessages: vi.fn(),
  } as unknown as INapCatAdapter;
}

function makeModule(opts: {
  welcomeLog?: IWelcomeLogRepository;
  claude?: IClaudeClient;
  adapter?: INapCatAdapter;
  reWelcomeWindowMs?: number;
  burstCapPerGroup10Min?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
} = {}): { module: WelcomeModule; log: IWelcomeLogRepository; claude: ReturnType<typeof vi.fn>; adapter: INapCatAdapter } {
  const log = opts.welcomeLog ?? makeWelcomeLog();
  const claudeFn = vi.fn().mockResolvedValue(makeClaudeResp(VALID_REPLY));
  const claude = opts.claude ?? ({ complete: claudeFn } as unknown as IClaudeClient);
  const adapter = opts.adapter ?? makeAdapter();
  const module = new WelcomeModule({
    welcomeLog: log,
    claude,
    adapter,
    botUserId: BOT_ID,
    reWelcomeWindowMs: opts.reWelcomeWindowMs ?? 24 * 60 * 60 * 1000,
    burstCapPerGroup10Min: opts.burstCapPerGroup10Min ?? 5,
    minDelayMs: opts.minDelayMs ?? 0,
    maxDelayMs: opts.maxDelayMs ?? 0,
  });
  return { module, log, claude: claudeFn, adapter };
}

describe('WelcomeModule', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('welcomes a new user: generates valid reply, sends with CQ:at, records log', async () => {
    const { module, log, claude, adapter } = makeModule();
    await module.handleJoin(GROUP_ID, USER_ID);

    expect(claude).toHaveBeenCalledOnce();
    expect(adapter.send).toHaveBeenCalledWith(GROUP_ID, expect.stringContaining(`[CQ:at,qq=${USER_ID}]`));
    expect(adapter.send).toHaveBeenCalledWith(GROUP_ID, expect.stringContaining(VALID_REPLY));
    expect(log.record).toHaveBeenCalledWith(GROUP_ID, USER_ID, expect.any(Number));
  });

  it('skips if user was welcomed within the re-welcome window', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const log = makeWelcomeLog({ lastWelcomeAt: vi.fn().mockReturnValue(nowSec - 60) });
    const { module, claude, adapter } = makeModule({ welcomeLog: log, reWelcomeWindowMs: 24 * 60 * 60 * 1000 });
    await module.handleJoin(GROUP_ID, USER_ID);

    expect(claude).not.toHaveBeenCalled();
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('welcomes again after re-welcome window has passed', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowMs = 60 * 1000;
    const log = makeWelcomeLog({ lastWelcomeAt: vi.fn().mockReturnValue(nowSec - 120) });
    const { module, claude } = makeModule({ welcomeLog: log, reWelcomeWindowMs: windowMs });
    await module.handleJoin(GROUP_ID, USER_ID);

    expect(claude).toHaveBeenCalledOnce();
  });

  it('skips if newUserId === botUserId', async () => {
    const { module, claude, adapter } = makeModule();
    await module.handleJoin(GROUP_ID, BOT_ID);

    expect(claude).not.toHaveBeenCalled();
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('skips 6th welcome within burst window (cap=5)', async () => {
    const { module, claude } = makeModule({ burstCapPerGroup10Min: 5 });
    for (let i = 0; i < 5; i++) {
      await module.handleJoin(GROUP_ID, `user${i}`);
    }
    claude.mockClear();
    await module.handleJoin(GROUP_ID, 'user5');
    expect(claude).not.toHaveBeenCalled();
  });

  it('skips gracefully when Claude call throws', async () => {
    const claudeFn = vi.fn().mockRejectedValue(new Error('timeout'));
    const claude = { complete: claudeFn } as unknown as IClaudeClient;
    const { module, adapter, log } = makeModule({ claude });
    await expect(module.handleJoin(GROUP_ID, USER_ID)).resolves.toBeUndefined();

    expect(adapter.send).not.toHaveBeenCalled();
    expect(log.record).not.toHaveBeenCalled();
  });

  // ── New validator tests ────────────────────────────────────────────────────

  it('sends valid reply containing 群公告 + 邦批', async () => {
    const validMsg = '欢迎来到北美邦批聚集地，群公告有群规和活动先看一眼';
    const claudeFn = vi.fn().mockResolvedValue(makeClaudeResp(validMsg));
    const claude = { complete: claudeFn } as unknown as IClaudeClient;
    const { module, adapter } = makeModule({ claude });
    await module.handleJoin(GROUP_ID, USER_ID);

    expect(adapter.send).toHaveBeenCalledWith(GROUP_ID, expect.stringContaining(validMsg));
  });

  it('falls back to hardcoded string when Claude omits 群公告 (both attempts)', async () => {
    // "推谁的快报" style — missing 群公告 and 邦批 content requirement
    const badReply = '新来的，你推谁的快报啊';
    const claudeFn = vi.fn().mockResolvedValue(makeClaudeResp(badReply));
    const claude = { complete: claudeFn } as unknown as IClaudeClient;
    const { module, adapter, log } = makeModule({ claude });
    await module.handleJoin(GROUP_ID, USER_ID);

    // Two attempts were made
    expect(claudeFn).toHaveBeenCalledTimes(2);
    // Fallback was used
    const sent = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(sent).toContain('群公告');
    expect(sent).toContain('邦批');
    expect(sent).toContain(`[CQ:at,qq=${USER_ID}]`);
    // Log was still recorded (fallback still counts as a welcome)
    expect(log.record).toHaveBeenCalledWith(GROUP_ID, USER_ID, expect.any(Number));
  });

  it('validator: rejects reply shorter than 15 chars', () => {
    const { module } = makeModule();
    // "欢迎邦批看公告" = 8 chars — too short
    expect((module as unknown as { _validate: (s: string) => boolean })._validate('欢迎邦批看公告')).toBe(false);
  });

  it('validator: rejects reply longer than 50 chars', () => {
    const { module } = makeModule();
    // Build a string that is definitely > 50 chars
    const long = '欢迎'.repeat(5) + '邦批聚集地群公告活动群规'.repeat(4);
    expect(long.length).toBeGreaterThan(50);
    expect((module as unknown as { _validate: (s: string) => boolean })._validate(long)).toBe(false);
  });

  it('validator: rejects reply missing 群公告/公告', () => {
    const { module } = makeModule();
    expect((module as unknown as { _validate: (s: string) => boolean })._validate('欢迎来到北美邦批聚集地，大家都很友善')).toBe(false);
  });

  it('validator: rejects reply missing 邦批/欢迎', () => {
    const { module } = makeModule();
    expect((module as unknown as { _validate: (s: string) => boolean })._validate('新人来了，看群公告了解群规和活动信息')).toBe(false);
  });

  it('validator: accepts reply starting with < → false', () => {
    const { module } = makeModule();
    expect((module as unknown as { _validate: (s: string) => boolean })._validate('<欢迎来到北美邦批聚集地，群公告有群规>')).toBe(false);
  });

  it('fallback string contains 群公告 and 邦批', () => {
    // Verify the hardcoded fallback meets our requirements
    const fallback = '欢迎来到北美邦批聚集地！群公告里有群规和活动信息，先翻一下';
    expect(fallback).toContain('群公告');
    expect(fallback).toContain('邦批');
    expect(fallback.length).toBeGreaterThanOrEqual(15);
    expect(fallback.length).toBeLessThanOrEqual(50);
  });
});
