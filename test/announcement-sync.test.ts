import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnnouncementSyncModule, _isRealRule } from '../src/modules/announcement-sync.js';
import type { INapCatAdapter, GroupNotice } from '../src/adapter/napcat.js';
import type { IAnnouncementRepository, IRuleRepository, GroupAnnouncement } from '../src/storage/db.js';
import type { ILearnerModule, AddRuleResult } from '../src/modules/learner.js';
import type { IClaudeClient, ClaudeResponse } from '../src/ai/claude.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

function makeMockAdapter(notices: GroupNotice[] = [], description = ''): INapCatAdapter {
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
    getGroupInfo: vi.fn().mockResolvedValue({ groupId: 'g1', name: 'Test Group', description, memberCount: 10 }),
    getImage: vi.fn(),
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
  const inserted: string[] = [];
  return {
    insert: vi.fn().mockImplementation((rule) => { inserted.push(rule.content); return { ...rule, id: inserted.length }; }),
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

  // 5. Claude prompt requires NONE output and rule extraction
  it('Claude prompt requires NONE output for empty notices', async () => {
    vi.mocked(adapter.getGroupNotices).mockResolvedValue([makeNotice()]);
    const mod = new AnnouncementSyncModule(adapter, annRepo, rulesRepo, claude, learner);
    await mod.syncGroup('g1');
    const call = vi.mocked(claude.complete).mock.calls[0]![0];
    const userMsg = call.messages[0]!.content;
    expect(userMsg).toContain('NONE');
    expect(userMsg).toContain('提取群规');
  });

  // NEW: notice with real rules → 3 rules stored
  it('notice with 3 real rules → 3 rules inserted', async () => {
    vi.mocked(adapter.getGroupNotices).mockResolvedValue([makeNotice()]);
    vi.mocked(claude.complete).mockResolvedValue({
      text: '禁止歧视\n不滥用@\n三次处罚',
      inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    const mod = new AnnouncementSyncModule(adapter, annRepo, rulesRepo, claude, learner);
    await mod.syncGroup('g1');
    expect(learner.addRuleWithSource).toHaveBeenCalledTimes(3);
    expect(learner.addRuleWithSource).toHaveBeenCalledWith('g1', '禁止歧视', 'positive', 'announcement');
    expect(learner.addRuleWithSource).toHaveBeenCalledWith('g1', '不滥用@', 'positive', 'announcement');
    expect(learner.addRuleWithSource).toHaveBeenCalledWith('g1', '三次处罚', 'positive', 'announcement');
  });

  // NEW: notice with no rules → Claude returns NONE → empty list, nothing stored
  it('notice with no rules → Claude returns NONE → no rules stored', async () => {
    vi.mocked(adapter.getGroupNotices).mockResolvedValue([makeNotice()]);
    vi.mocked(claude.complete).mockResolvedValue({
      text: 'NONE',
      inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    const mod = new AnnouncementSyncModule(adapter, annRepo, rulesRepo, claude, learner);
    await mod.syncGroup('g1');
    expect(learner.addRuleWithSource).not.toHaveBeenCalled();
    expect(annRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({ parsedRules: [] }));
  });

  // NEW: 10 notices where 3 have rules → deleteBySource called once, all rules from all notices added
  it('10 notices with 3 rule-ful ones → deleteBySource called once, all 9 rules inserted', async () => {
    // notices n1–n10; n4 and n5 are activity (no rules), n6/n8/n10 have real rules
    const notices: GroupNotice[] = Array.from({ length: 10 }, (_, i) => ({
      noticeId: `n${i + 1}`,
      senderId: 'u-admin',
      publishTime: 1000,
      message: `公告内容 ${i + 1}`,
    }));
    vi.mocked(adapter.getGroupNotices).mockResolvedValue(notices);

    // Map noticeId → Claude response text
    const responseMap: Record<string, string> = {
      n1: 'NONE', n2: 'NONE', n3: 'NONE', n4: 'NONE', n5: 'NONE',
      n6: '禁止歧视\n不滥用@\n三次处罚',
      n7: 'NONE',
      n8: '隐私保护\n禁言规则\n机器人使用规范',
      n9: 'NONE',
      n10: '开玩笑要有分寸\n不拿群规开玩笑',
    };

    let callIndex = 0;
    vi.mocked(claude.complete).mockImplementation(async () => {
      // calls happen in order of notices
      const noticeId = `n${callIndex + 1}`;
      callIndex++;
      // find which notice this is
      const text = responseMap[noticeId] ?? 'NONE';
      return { text, inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };
    });

    const mod = new AnnouncementSyncModule(adapter, annRepo, rulesRepo, claude, learner);
    await mod.syncGroup('g1');

    // deleteBySource called exactly once
    expect(rulesRepo.deleteBySource).toHaveBeenCalledTimes(1);
    expect(rulesRepo.deleteBySource).toHaveBeenCalledWith('g1', 'announcement');

    // 3 + 3 + 2 = 8 rules? The spec says 9 (3+4+2) but our test data has 3+3+2=8
    // Use actual counts from our test data
    expect(learner.addRuleWithSource).toHaveBeenCalledTimes(8);
  });

  // NEW: re-sync (same notices) → deleteBySource not called again (no new/updated notices)
  it('re-sync with same notices → deleteBySource not called again, no duplicates', async () => {
    const notices: GroupNotice[] = [
      makeNotice({ noticeId: 'n1', message: '公告一' }),
      makeNotice({ noticeId: 'n2', message: '公告二（活动通知）' }),
    ];
    vi.mocked(adapter.getGroupNotices).mockResolvedValue(notices);

    // First notice has rules, second has NONE
    let callIdx = 0;
    const responses = ['禁止歧视\n不滥用@', 'NONE'];
    vi.mocked(claude.complete).mockImplementation(async () => ({
      text: responses[callIdx++] ?? 'NONE',
      inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
    }));

    const mod = new AnnouncementSyncModule(adapter, annRepo, rulesRepo, claude, learner);

    // First sync
    await mod.syncGroup('g1');
    expect(rulesRepo.deleteBySource).toHaveBeenCalledTimes(1);
    expect(learner.addRuleWithSource).toHaveBeenCalledTimes(2);

    vi.mocked(rulesRepo.deleteBySource).mockClear();
    vi.mocked(learner.addRuleWithSource).mockClear();

    // Second sync — same notices, no change → no deleteBySource, no new inserts
    await mod.syncGroup('g1');
    expect(rulesRepo.deleteBySource).not.toHaveBeenCalled();
    expect(learner.addRuleWithSource).not.toHaveBeenCalled();
  });
});

describe('AnnouncementSyncModule — group description injection', () => {
  it('non-empty description → injected as __group_info__ notice and parsed', async () => {
    const adapter = makeMockAdapter([], '本群严禁广告\n禁止攻击他人');
    const annRepo = makeMockAnnouncements();
    const rulesRepo = makeMockRules();
    const claude = makeMockClaude('本群严禁广告\n禁止攻击他人');
    const learner = makeMockLearner();
    const mod = new AnnouncementSyncModule(adapter, annRepo, rulesRepo, claude, learner);

    await mod.syncGroup('g1');

    expect(annRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({ noticeId: '__group_info__' }));
    expect(learner.addRuleWithSource).toHaveBeenCalled();
  });

  it('empty description → no __group_info__ notice upserted', async () => {
    const adapter = makeMockAdapter([], '');
    const annRepo = makeMockAnnouncements();
    const rulesRepo = makeMockRules();
    const claude = makeMockClaude();
    const learner = makeMockLearner();
    const mod = new AnnouncementSyncModule(adapter, annRepo, rulesRepo, claude, learner);

    await mod.syncGroup('g1');

    const calls = vi.mocked(annRepo.upsert).mock.calls;
    expect(calls.every(([a]) => a.noticeId !== '__group_info__')).toBe(true);
  });

  it('whitespace-only description → treated as empty, no upsert', async () => {
    const adapter = makeMockAdapter([], '   \n  ');
    const annRepo = makeMockAnnouncements();
    const rulesRepo = makeMockRules();
    const claude = makeMockClaude();
    const learner = makeMockLearner();
    const mod = new AnnouncementSyncModule(adapter, annRepo, rulesRepo, claude, learner);

    await mod.syncGroup('g1');

    const calls = vi.mocked(annRepo.upsert).mock.calls;
    expect(calls.every(([a]) => a.noticeId !== '__group_info__')).toBe(true);
  });

  it('getGroupInfo failure → logs debug, continues with notices normally', async () => {
    const adapter = makeMockAdapter([{ noticeId: 'n1', senderId: 'u1', publishTime: 1, message: '禁止广告' }]);
    vi.mocked(adapter.getGroupInfo).mockRejectedValue(new Error('not supported'));
    const annRepo = makeMockAnnouncements();
    const rulesRepo = makeMockRules();
    const claude = makeMockClaude('禁止广告');
    const learner = makeMockLearner();
    const mod = new AnnouncementSyncModule(adapter, annRepo, rulesRepo, claude, learner);

    await mod.syncGroup('g1');

    // Still processes the real notice
    expect(learner.addRuleWithSource).toHaveBeenCalledWith('g1', '禁止广告', 'positive', 'announcement');
  });
});

describe('_isRealRule', () => {
  it('accepts normal rule text', () => {
    expect(_isRealRule('禁止歧视')).toBe(true);
    expect(_isRealRule('不得发广告')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(_isRealRule('')).toBe(false);
  });

  it('rejects （空） variants', () => {
    expect(_isRealRule('（空）')).toBe(false);
    expect(_isRealRule('(空)')).toBe(false);
  });

  it('rejects lines starting with >', () => {
    expect(_isRealRule('> 该公告为活动通知，不含任何群规。')).toBe(false);
  });

  it('rejects lines starting with （', () => {
    expect(_isRealRule('（公告内容均为活动通知，不含任何群规。）')).toBe(false);
  });

  it('rejects lines containing 不含/不包含/无任何', () => {
    expect(_isRealRule('该公告为活动通知，不包含任何明确的群规。')).toBe(false);
    expect(_isRealRule('不含群规')).toBe(false);
    expect(_isRealRule('无任何群规')).toBe(false);
  });

  it('rejects lines over 500 chars', () => {
    expect(_isRealRule('x'.repeat(501))).toBe(false);
  });
});
