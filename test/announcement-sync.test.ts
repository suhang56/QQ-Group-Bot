import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnnouncementSyncModule } from '../src/modules/announcement-sync.js';
import type { INapCatAdapter, GroupNotice } from '../src/adapter/napcat.js';
import type { IAnnouncementRepository, IRuleRepository, GroupAnnouncement } from '../src/storage/db.js';
import type { ILearnerModule, AddRuleResult } from '../src/modules/learner.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

function makeMockAdapter(notices: GroupNotice[] = []): INapCatAdapter {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    send: vi.fn(),
    ban: vi.fn(),
    kick: vi.fn(),
    deleteMsg: vi.fn(),
    sendPrivate: vi.fn(),
    getGroupNotices: vi.fn().mockResolvedValue(notices),
  };
}

function makeMockClaude(text = '不得发广告\n禁止辱骂他人\n严禁黄赌毒'): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text, inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0,
    } satisfies ClaudeResponse),
  };
}

function makeMockAnnouncements(): IAnnouncementRepository {
  const store = new Map<string, GroupAnnouncement>();
  return {
    upsert: vi.fn().mockImplementation((ann: Omit<GroupAnnouncement, 'id'>) => {
      const key = `${ann.groupId}:${ann.noticeId}`;
      const record = { ...ann, id: store.size + 1 };
      store.set(key, record);
      return record;
    }),
    getByNoticeId: vi.fn().mockImplementation((groupId: string, noticeId: string) => {
      return store.get(`${groupId}:${noticeId}`) ?? null;
    }),
    getLatest: vi.fn().mockReturnValue(null),
  };
}

function makeMockRules(): IRuleRepository {
  return {
    insert: vi.fn().mockImplementation((rule) => ({ ...rule, id: 1 })),
    findById: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    getPage: vi.fn(),
    deleteBySource: vi.fn().mockReturnValue(0),
  };
}

function makeMockLearner(): ILearnerModule {
  return {
    addRule: vi.fn().mockResolvedValue({ ok: true, ruleId: 1 } satisfies AddRuleResult),
    addRuleWithSource: vi.fn().mockResolvedValue({ ok: true, ruleId: 1 } satisfies AddRuleResult),
    markFalsePositive: vi.fn(),
    retrieveExamples: vi.fn().mockResolvedValue([]),
  };
}

function makeNotice(overrides: Partial<GroupNotice> = {}): GroupNotice {
  return {
    noticeId: 'n1',
    senderId: 'u-admin',
    publishTime: Math.floor(Date.now() / 1000),
    message: '群规：1.不得发广告 2.禁止辱骂',
    ...overrides,
  };
}

describe('AnnouncementSyncModule', () => {
  let adapter: INapCatAdapter;
  let annRepo: IAnnouncementRepository;
  let rulesRepo: IRuleRepository;
  let claude: IClaudeClient;
  let learner: ILearnerModule;

  beforeEach(() => {
    adapter = makeMockAdapter();
    annRepo = makeMockAnnouncements();
    rulesRepo = makeMockRules();
    claude = makeMockClaude();
    learner = makeMockLearner();
  });

  // 1. Empty announcement → no rules added
  it('empty announcement list: no rules added, no Claude call', async () => {
    vi.mocked(adapter.getGroupNotices).mockResolvedValue([]);
    const mod = new AnnouncementSyncModule(adapter, annRepo, rulesRepo, claude, learner);
    await mod.syncGroup('g1');
    expect(claude.complete).not.toHaveBeenCalled();
    expect(learner.addRuleWithSource).not.toHaveBeenCalled();
  });

  // 1b. Announcement with empty message → skipped
  it('announcement with empty message: skipped silently', async () => {
    vi.mocked(adapter.getGroupNotices).mockResolvedValue([makeNotice({ message: '  ' })]);
    const mod = new AnnouncementSyncModule(adapter, annRepo, rulesRepo, claude, learner);
    await mod.syncGroup('g1');
    expect(claude.complete).not.toHaveBeenCalled();
  });

  // 2. Unchanged announcement (same notice_id + content hash) → no re-parse
  it('unchanged announcement: same hash → no re-parse, no rule upsert', async () => {
    const notice = makeNotice();
    vi.mocked(adapter.getGroupNotices).mockResolvedValue([notice]);

    const mod = new AnnouncementSyncModule(adapter, annRepo, rulesRepo, claude, learner);
    // First sync — parses and caches
    await mod.syncGroup('g1');
    expect(claude.complete).toHaveBeenCalledTimes(1);

    vi.mocked(claude.complete).mockClear();
    vi.mocked(learner.addRuleWithSource).mockClear();

    // Second sync with same notice — getByNoticeId now returns the stored record
    await mod.syncGroup('g1');
    expect(claude.complete).not.toHaveBeenCalled();
    expect(learner.addRuleWithSource).not.toHaveBeenCalled();
  });

  // 3. Updated announcement → old rules deleted, new ones inserted
  it('updated announcement (different content): old rules cleared, new ones inserted', async () => {
    const notice = makeNotice({ noticeId: 'n1', message: '旧公告内容' });
    vi.mocked(adapter.getGroupNotices).mockResolvedValue([notice]);
    const mod = new AnnouncementSyncModule(adapter, annRepo, rulesRepo, claude, learner);

    // First sync
    await mod.syncGroup('g1');
    expect(rulesRepo.deleteBySource).toHaveBeenCalledWith('g1', 'announcement');
    expect(learner.addRuleWithSource).toHaveBeenCalledWith('g1', '不得发广告', 'positive', 'announcement');

    vi.mocked(rulesRepo.deleteBySource).mockClear();
    vi.mocked(learner.addRuleWithSource).mockClear();
    vi.mocked(claude.complete).mockResolvedValue({
      text: '不许打广告\n禁止骂人',
      inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
    });

    // Update the notice content — same noticeId but different message
    const updatedNotice = makeNotice({ noticeId: 'n1', message: '新公告内容，规则更新了' });
    vi.mocked(adapter.getGroupNotices).mockResolvedValue([updatedNotice]);
    await mod.syncGroup('g1');

    expect(rulesRepo.deleteBySource).toHaveBeenCalledWith('g1', 'announcement');
    expect(learner.addRuleWithSource).toHaveBeenCalledWith('g1', '不许打广告', 'positive', 'announcement');
    expect(learner.addRuleWithSource).toHaveBeenCalledWith('g1', '禁止骂人', 'positive', 'announcement');
  });

  // 4. API failure → log warn, don't crash
  it('getGroupNotices API failure: logs warn, does not throw', async () => {
    vi.mocked(adapter.getGroupNotices).mockRejectedValue(new Error('network timeout'));
    const mod = new AnnouncementSyncModule(adapter, annRepo, rulesRepo, claude, learner);
    await expect(mod.syncGroup('g1')).resolves.not.toThrow();
    expect(claude.complete).not.toHaveBeenCalled();
  });

  // 4b. Claude API failure mid-parse → stores announcement with empty rules, doesn't throw
  it('Claude parse failure: announcement stored with empty rules, no crash', async () => {
    vi.mocked(adapter.getGroupNotices).mockResolvedValue([makeNotice()]);
    vi.mocked(claude.complete).mockRejectedValue(new Error('overloaded'));
    const mod = new AnnouncementSyncModule(adapter, annRepo, rulesRepo, claude, learner);
    await expect(mod.syncGroup('g1')).resolves.not.toThrow();
    expect(annRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ parsedRules: [] })
    );
    expect(learner.addRuleWithSource).not.toHaveBeenCalled();
  });

  // 5. Claude returns deduplicated rule list (prompt sends dedup instruction)
  it('Claude prompt includes dedup instruction', async () => {
    vi.mocked(adapter.getGroupNotices).mockResolvedValue([makeNotice()]);
    const mod = new AnnouncementSyncModule(adapter, annRepo, rulesRepo, claude, learner);
    await mod.syncGroup('g1');
    const call = vi.mocked(claude.complete).mock.calls[0]![0];
    const userMsg = call.messages[0]!.content;
    expect(userMsg).toContain('语义去重');
    expect(userMsg).toContain('提取所有群规');
  });
});
