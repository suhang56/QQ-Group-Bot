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
  const claudeFn = vi.fn().mockResolvedValue(makeClaudeResp('嗨嗨，新来的'));
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
  it('welcomes a new user: generates reply, sends with CQ:at, records log', async () => {
    const { module, log, claude, adapter } = makeModule();
    await module.handleJoin(GROUP_ID, USER_ID);

    expect(claude).toHaveBeenCalledOnce();
    expect(adapter.send).toHaveBeenCalledWith(GROUP_ID, expect.stringContaining(`[CQ:at,qq=${USER_ID}]`));
    expect(adapter.send).toHaveBeenCalledWith(GROUP_ID, expect.stringContaining('嗨嗨，新来的'));
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

  it('drops welcome when Claude returns empty string', async () => {
    const claudeFn = vi.fn().mockResolvedValue(makeClaudeResp(''));
    const claude = { complete: claudeFn } as unknown as IClaudeClient;
    const { module, adapter, log } = makeModule({ claude });
    await module.handleJoin(GROUP_ID, USER_ID);

    expect(adapter.send).not.toHaveBeenCalled();
    expect(log.record).not.toHaveBeenCalled();
  });

  it('drops welcome when Claude returns output starting with "<"', async () => {
    const claudeFn = vi.fn().mockResolvedValue(makeClaudeResp('<skip>'));
    const claude = { complete: claudeFn } as unknown as IClaudeClient;
    const { module, adapter, log } = makeModule({ claude });
    await module.handleJoin(GROUP_ID, USER_ID);

    expect(adapter.send).not.toHaveBeenCalled();
    expect(log.record).not.toHaveBeenCalled();
  });

  it('drops welcome when Claude returns output > 80 chars', async () => {
    const longText = '嗨'.repeat(81);
    const claudeFn = vi.fn().mockResolvedValue(makeClaudeResp(longText));
    const claude = { complete: claudeFn } as unknown as IClaudeClient;
    const { module, adapter, log } = makeModule({ claude });
    await module.handleJoin(GROUP_ID, USER_ID);

    expect(adapter.send).not.toHaveBeenCalled();
    expect(log.record).not.toHaveBeenCalled();
  });

  it('skips gracefully when Claude call throws', async () => {
    const claudeFn = vi.fn().mockRejectedValue(new Error('timeout'));
    const claude = { complete: claudeFn } as unknown as IClaudeClient;
    const { module, adapter, log } = makeModule({ claude });
    await expect(module.handleJoin(GROUP_ID, USER_ID)).resolves.toBeUndefined();

    expect(adapter.send).not.toHaveBeenCalled();
    expect(log.record).not.toHaveBeenCalled();
  });
});
