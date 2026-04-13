import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LoreUpdater } from '../src/modules/lore-updater.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import type { IMessageRepository, GroupConfig } from '../src/storage/db.js';
import type { IChatModule } from '../src/modules/chat.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

function makeConfig(overrides: Partial<GroupConfig> = {}): GroupConfig {
  return {
    groupId: 'g1',
    enabledModules: [],
    autoMod: false,
    dailyPunishmentLimit: 10,
    punishmentsToday: 0,
    punishmentsResetDate: '2026-01-01',
    mimicActiveUserId: null,
    mimicStartedBy: null,
    chatTriggerKeywords: [],
    chatTriggerAtOnly: false,
    chatDebounceMs: 2000,
    modConfidenceThreshold: 0.7,
    modWhitelist: [],
    appealWindowHours: 24,
    kickConfirmModel: 'claude-opus-4-6',
    chatLoreEnabled: true,
    nameImagesEnabled: false,
    nameImagesCollectionTimeoutMs: 120_000,
    nameImagesCollectionMax: 20,
    nameImagesCooldownMs: 300_000,
    nameImagesMaxPerName: 50,
    chatAtMentionQueueMax: 5,
    chatAtMentionBurstWindowMs: 30_000,
    chatAtMentionBurstThreshold: 3,
    repeaterEnabled: false,
    repeaterMinCount: 3,
    repeaterCooldownMs: 600_000,
    repeaterMinContentLength: 2,
    repeaterMaxContentLength: 100,
    nameImagesBlocklist: [],
    loreUpdateEnabled: true,
    loreUpdateThreshold: 200,
    loreUpdateCooldownMs: 1_800_000,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMessages(n: number): ReturnType<IMessageRepository['getRecent']> {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    groupId: 'g1',
    userId: `u${i % 5}`,
    nickname: `User${i % 5}`,
    content: `message ${i}`,
    timestamp: 1000 + i,
    deleted: false,
  }));
}

function makeMessageRepo(msgs: ReturnType<IMessageRepository['getRecent']> = []): IMessageRepository {
  return {
    insert: vi.fn(),
    getRecent: vi.fn().mockReturnValue(msgs),
    getByUser: vi.fn().mockReturnValue([]),
    sampleRandomHistorical: vi.fn().mockReturnValue([]),
    searchByKeywords: vi.fn().mockReturnValue([]),
    getTopUsers: vi.fn().mockReturnValue([]),
    softDelete: vi.fn(),
  };
}

function makeClaude(response = '# Updated Lore\n\nSome content'): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text: response,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
  };
}

function makeChatModule(): IChatModule {
  return {
    generateReply: vi.fn().mockResolvedValue(null),
    recordOutgoingMessage: vi.fn(),
    invalidateLore: vi.fn(),
    tickStickerRefresh: vi.fn(),
  };
}

describe('LoreUpdater', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('199 messages → no update triggered', () => {
    const claude = makeClaude();
    const msgRepo = makeMessageRepo(makeMessages(199));
    const updater = new LoreUpdater(claude, msgRepo, null, { loreDirPath: tmpDir });
    const config = makeConfig({ loreUpdateThreshold: 200 });

    for (let i = 0; i < 199; i++) updater.tick('g1', config);

    expect(claude.complete).not.toHaveBeenCalled();
    expect(updater.getCounter('g1')).toBe(199);
  });

  it('200 messages → counter resets to 0 (update attempted)', async () => {
    vi.useFakeTimers();
    // Fast-forward past startup grace
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);

    const claude = makeClaude();
    const msgRepo = makeMessageRepo(makeMessages(200));
    const updater = new LoreUpdater(claude, msgRepo, null, { loreDirPath: tmpDir });
    const config = makeConfig({ loreUpdateThreshold: 200, loreUpdateCooldownMs: 0 });

    for (let i = 0; i < 200; i++) updater.tick('g1', config);

    // Counter resets on threshold hit
    expect(updater.getCounter('g1')).toBe(0);

    // Let the async update settle
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it('second update within cooldown → skipped', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);

    const claude = makeClaude();
    const msgRepo = makeMessageRepo(makeMessages(200));
    const chatMod = makeChatModule();
    const updater = new LoreUpdater(claude, msgRepo, chatMod, { loreDirPath: tmpDir });
    // Use a long cooldown — 30 min
    const config = makeConfig({ loreUpdateThreshold: 200, loreUpdateCooldownMs: 30 * 60 * 1000 });

    // First batch of 200
    for (let i = 0; i < 200; i++) updater.tick('g1', config);
    await vi.runAllTimersAsync();

    const callsAfterFirst = (claude.complete as ReturnType<typeof vi.fn>).mock.calls.length;

    // Second batch of 200 immediately (within cooldown)
    for (let i = 0; i < 200; i++) updater.tick('g1', config);
    await vi.runAllTimersAsync();

    // Should not have been called again
    expect((claude.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst);

    vi.useRealTimers();
  });

  it('Claude API error → update fails gracefully, no file written', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);

    const claude: IClaudeClient = {
      complete: vi.fn().mockRejectedValue(new Error('API error')),
    };
    const msgRepo = makeMessageRepo(makeMessages(200));
    const updater = new LoreUpdater(claude, msgRepo, null, { loreDirPath: tmpDir });
    const config = makeConfig({ loreUpdateThreshold: 200, loreUpdateCooldownMs: 0 });

    for (let i = 0; i < 200; i++) updater.tick('g1', config);
    await vi.runAllTimersAsync();

    // No lore file should be written
    expect(fs.existsSync(path.join(tmpDir, 'g1.md'))).toBe(false);
    // Counter was reset to 0 at tick-time
    expect(updater.getCounter('g1')).toBe(0);

    vi.useRealTimers();
  });

  it('update writes lore file and invalidates chat module cache', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);

    const newLore = '# Group Lore\n\n## Members\n- User0\n- User1';
    const claude = makeClaude(newLore);
    const msgRepo = makeMessageRepo(makeMessages(200));
    const chatMod = makeChatModule();
    const updater = new LoreUpdater(claude, msgRepo, chatMod, { loreDirPath: tmpDir });
    const config = makeConfig({ loreUpdateThreshold: 200, loreUpdateCooldownMs: 0 });

    for (let i = 0; i < 200; i++) updater.tick('g1', config);
    await vi.runAllTimersAsync();

    // File written
    const lorePath = path.join(tmpDir, 'g1.md');
    expect(fs.existsSync(lorePath)).toBe(true);
    expect(fs.readFileSync(lorePath, 'utf8')).toBe(newLore);

    // Cache invalidated
    expect(chatMod.invalidateLore).toHaveBeenCalledWith('g1');

    vi.useRealTimers();
  });

  it('existing lore is preserved in prompt context', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);

    // Write existing lore
    const existingLore = '# Old Lore\n\n## Members\n- OldUser';
    fs.writeFileSync(path.join(tmpDir, 'g1.md'), existingLore);

    const claude = makeClaude('# Updated Lore\n\n## Members\n- OldUser\n- NewUser');
    const msgRepo = makeMessageRepo(makeMessages(200));
    const updater = new LoreUpdater(claude, msgRepo, null, { loreDirPath: tmpDir });
    const config = makeConfig({ loreUpdateThreshold: 200, loreUpdateCooldownMs: 0 });

    for (let i = 0; i < 200; i++) updater.tick('g1', config);
    await vi.runAllTimersAsync();

    // Claude was called with existing lore in the prompt
    const call = (claude.complete as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const userContent = call?.messages?.[0]?.content as string;
    expect(userContent).toContain('Old Lore');
    expect(userContent).toContain('OldUser');

    vi.useRealTimers();
  });

  it('forceUpdate triggers update immediately regardless of counter', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);

    const claude = makeClaude();
    const msgRepo = makeMessageRepo(makeMessages(5));
    const chatMod = makeChatModule();
    const updater = new LoreUpdater(claude, msgRepo, chatMod, { loreDirPath: tmpDir });
    const config = makeConfig({ loreUpdateThreshold: 200, loreUpdateCooldownMs: 0 });

    // Only 5 messages counted — well below threshold
    for (let i = 0; i < 5; i++) updater.tick('g1', config);
    expect(claude.complete).not.toHaveBeenCalled();

    // Force update
    await updater.forceUpdate('g1', config);
    expect(claude.complete).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });

  it('startup grace: update skipped if bot started < 5 min ago', () => {
    // Do NOT fast-forward time — bot just started
    const claude = makeClaude();
    const msgRepo = makeMessageRepo(makeMessages(200));
    const updater = new LoreUpdater(claude, msgRepo, null, { loreDirPath: tmpDir });
    const config = makeConfig({ loreUpdateThreshold: 200, loreUpdateCooldownMs: 0 });

    for (let i = 0; i < 200; i++) updater.tick('g1', config);

    // Counter reset but Claude should not have been called (startup grace)
    expect(claude.complete).not.toHaveBeenCalled();
  });
});
