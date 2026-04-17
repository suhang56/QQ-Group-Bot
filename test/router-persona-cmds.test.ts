import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from '../src/core/router.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { Database } from '../src/storage/db.js';
import { defaultGroupConfig } from '../src/config.js';
import type { PrivateMessage, INapCatAdapter } from '../src/adapter/napcat.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const ADMIN = process.env['MOD_APPROVAL_ADMIN'] ?? '2331924739';
const GROUP = 'g-persona-router';
const OLD = '你是一个邦多利 bot，说话轻快活泼，常用颜文字 (≧∇≦)。';
const NEW = '你是一个邦多利 bot，说话偏温柔克制，保留少量颜文字，更愿意跟着群友话题走。';
const REASON = '群里氛围偏温和，你倾向少用夸张颜文字。';

function makeAdapter(): INapCatAdapter {
  return {
    connect: vi.fn(), disconnect: vi.fn(), on: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    ban: vi.fn().mockResolvedValue(undefined), kick: vi.fn().mockResolvedValue(undefined),
    deleteMsg: vi.fn().mockResolvedValue(undefined),
    sendPrivate: vi.fn().mockResolvedValue(undefined),
    sendPrivateMessage: vi.fn().mockResolvedValue(42),
    getGroupNotices: vi.fn().mockResolvedValue([]),
    getGroupInfo: vi.fn().mockResolvedValue({ groupId: GROUP, name: 'g', description: '', memberCount: 1 }),
    getImage: vi.fn().mockResolvedValue({ filename: '', url: '', size: 0 }),
  } as unknown as INapCatAdapter;
}

function makePrivate(text: string, userId = ADMIN): PrivateMessage {
  return {
    messageId: 'm' + Math.random().toString(36).slice(2),
    userId, nickname: userId === ADMIN ? 'admin' : 'user',
    content: text, timestamp: Math.floor(Date.now() / 1000),
  };
}

function insertProposal(db: Database, overrides: Partial<{
  oldPersonaText: string | null;
  newPersonaText: string;
  reasoning: string;
  diffSummary: string;
  createdAt: number;
  groupId: string;
}> = {}): number {
  return db.personaPatches.insert({
    groupId: overrides.groupId ?? GROUP,
    oldPersonaText: 'oldPersonaText' in overrides ? overrides.oldPersonaText! : OLD,
    newPersonaText: overrides.newPersonaText ?? NEW,
    reasoning: overrides.reasoning ?? REASON,
    diffSummary: overrides.diffSummary ?? '-活泼\n+温柔',
    createdAt: overrides.createdAt ?? Math.floor(Date.now() / 1000),
  });
}

describe('Router — M6.6 persona admin commands', () => {
  let db: Database;
  let adapter: INapCatAdapter;
  let router: Router;
  let rl: RateLimiter;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = makeAdapter();
    rl = new RateLimiter();
    router = new Router(db, adapter, rl);
    db.groupConfig.upsert({ ...defaultGroupConfig(GROUP), chatPersonaText: OLD });
  });

  describe('/persona_review', () => {
    it('empty state → reports no pending proposals', async () => {
      await router.dispatchPrivate(makePrivate('/persona_review'));
      const lastCall = (adapter.sendPrivateMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      expect(lastCall[1]).toMatch(/没有待审/);
    });

    it('lists pending proposals newest first, with id + age + short reasoning', async () => {
      const now = Math.floor(Date.now() / 1000);
      const olderId = insertProposal(db, { createdAt: now - 7200, newPersonaText: NEW + ' v1' });
      const newerId = insertProposal(db, { createdAt: now - 300, newPersonaText: NEW + ' v2' });

      await router.dispatchPrivate(makePrivate(`/persona_review ${GROUP}`));
      const replyText = (adapter.sendPrivateMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as string;
      expect(replyText).toContain(`#${newerId}`);
      expect(replyText).toContain(`#${olderId}`);
      expect(replyText.indexOf(`#${newerId}`)).toBeLessThan(replyText.indexOf(`#${olderId}`));
      expect(replyText).toContain('/persona_diff');
    });

    it('non-admin is ignored entirely (no DM, no processing)', async () => {
      await router.dispatchPrivate(makePrivate('/persona_review', 'random-user-123'));
      expect(adapter.sendPrivateMessage).not.toHaveBeenCalled();
    });
  });

  describe('/persona_diff', () => {
    it('happy path returns reasoning + diff', async () => {
      const id = insertProposal(db);
      await router.dispatchPrivate(makePrivate(`/persona_diff ${id}`));
      const replyText = (adapter.sendPrivateMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as string;
      expect(replyText).toContain(`#${id}`);
      expect(replyText).toContain(REASON);
      expect(replyText).toContain('-活泼');
      expect(replyText).toContain('+温柔');
    });

    it('not found → friendly error', async () => {
      await router.dispatchPrivate(makePrivate('/persona_diff 9999'));
      const replyText = (adapter.sendPrivateMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as string;
      expect(replyText).toMatch(/找不到 persona 提案 #9999/);
    });

    it('expired pending proposal → expiry notice', async () => {
      const id = insertProposal(db, { createdAt: Math.floor(Date.now() / 1000) - 10 * 86400 });
      await router.dispatchPrivate(makePrivate(`/persona_diff ${id}`));
      const replyText = (adapter.sendPrivateMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as string;
      expect(replyText).toMatch(/已超过.*过期/);
    });
  });

  describe('/persona_apply', () => {
    it('applies pending proposal, updates group_config, marks approved, supersedes siblings', async () => {
      const target = insertProposal(db);
      const sibling = insertProposal(db, { newPersonaText: NEW + ' alt' });

      await router.dispatchPrivate(makePrivate(`/persona_apply ${target}`));
      const replyText = (adapter.sendPrivateMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as string;
      expect(replyText).toMatch(/已应用 persona 提案/);

      expect(db.personaPatches.getById(target)!.status).toBe('approved');
      expect(db.personaPatches.getById(sibling)!.status).toBe('superseded');
      expect(db.groupConfig.get(GROUP)!.chatPersonaText).toBe(NEW);
    });

    it('not-pending status is rejected with explanation', async () => {
      const id = insertProposal(db);
      db.personaPatches.reject(id, ADMIN, Math.floor(Date.now() / 1000));
      await router.dispatchPrivate(makePrivate(`/persona_apply ${id}`));
      const replyText = (adapter.sendPrivateMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as string;
      expect(replyText).toMatch(/不在 pending 状态/);
    });

    it('expired proposal → refuse', async () => {
      const id = insertProposal(db, { createdAt: Math.floor(Date.now() / 1000) - 10 * 86400 });
      await router.dispatchPrivate(makePrivate(`/persona_apply ${id}`));
      const replyText = (adapter.sendPrivateMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as string;
      expect(replyText).toMatch(/已超过.*过期/);
    });

    it('missing proposal id → usage hint', async () => {
      await router.dispatchPrivate(makePrivate('/persona_apply abc'));
      const replyText = (adapter.sendPrivateMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as string;
      expect(replyText).toMatch(/用法/);
    });

    it('empty-override case requires confirm=yes', async () => {
      db.groupConfig.upsert({ ...defaultGroupConfig(GROUP), chatPersonaText: null });
      const id = insertProposal(db, { oldPersonaText: null });

      await router.dispatchPrivate(makePrivate(`/persona_apply ${id}`));
      let replyText = (adapter.sendPrivateMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as string;
      expect(replyText).toMatch(/警告.*空 persona.*confirm=yes/);
      expect(db.personaPatches.getById(id)!.status).toBe('pending');

      await router.dispatchPrivate(makePrivate(`/persona_apply ${id} confirm=yes`));
      replyText = (adapter.sendPrivateMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as string;
      expect(replyText).toMatch(/已应用 persona 提案/);
      expect(db.personaPatches.getById(id)!.status).toBe('approved');
    });

    it('manual-edit conflict (current persona != oldPersonaText) requires confirm=yes', async () => {
      const id = insertProposal(db);
      // Admin (or someone) edited persona out of band between propose and apply.
      db.groupConfig.upsert({ ...defaultGroupConfig(GROUP), chatPersonaText: '你是完全不同的 bot 了，人工改过。' });

      await router.dispatchPrivate(makePrivate(`/persona_apply ${id}`));
      let replyText = (adapter.sendPrivateMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as string;
      expect(replyText).toMatch(/警告.*手动改过.*confirm=yes/);
      expect(db.personaPatches.getById(id)!.status).toBe('pending');

      await router.dispatchPrivate(makePrivate(`/persona_apply ${id} confirm=yes`));
      expect(db.personaPatches.getById(id)!.status).toBe('approved');
      expect(db.groupConfig.get(GROUP)!.chatPersonaText).toBe(NEW);
    });
  });

  describe('/persona_reject', () => {
    it('rejects pending proposal', async () => {
      const id = insertProposal(db);
      await router.dispatchPrivate(makePrivate(`/persona_reject ${id}`));
      expect(db.personaPatches.getById(id)!.status).toBe('rejected');
      const replyText = (adapter.sendPrivateMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as string;
      expect(replyText).toMatch(/已拒绝 persona 提案/);
    });

    it('not-found → friendly error', async () => {
      await router.dispatchPrivate(makePrivate('/persona_reject 9999'));
      const replyText = (adapter.sendPrivateMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as string;
      expect(replyText).toMatch(/找不到 persona 提案/);
    });

    it('non-pending status → refuse', async () => {
      const id = insertProposal(db);
      db.personaPatches.apply(id, ADMIN, Math.floor(Date.now() / 1000));
      await router.dispatchPrivate(makePrivate(`/persona_reject ${id}`));
      const replyText = (adapter.sendPrivateMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as string;
      expect(replyText).toMatch(/不在 pending 状态/);
    });
  });

  describe('/persona_history', () => {
    it('lists proposals across all statuses within the window', async () => {
      const now = Math.floor(Date.now() / 1000);
      // Order matters: reject the standalone row first, then apply (apply
      // supersedes any remaining pendings), then insert a fresh pending.
      const rejected = insertProposal(db, { createdAt: now - 86400, newPersonaText: NEW + ' rj' });
      db.personaPatches.reject(rejected, ADMIN, now);
      const approved = insertProposal(db, { createdAt: now - 2 * 86400 });
      db.personaPatches.apply(approved, ADMIN, now);
      const pending = insertProposal(db, { createdAt: now - 60, newPersonaText: NEW + ' pd' });

      await router.dispatchPrivate(makePrivate(`/persona_history ${GROUP} 30`));
      const replyText = (adapter.sendPrivateMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as string;
      expect(replyText).toContain(`#${approved}`);
      expect(replyText).toContain(`#${rejected}`);
      expect(replyText).toContain(`#${pending}`);
      expect(replyText).toContain('[approved]');
      expect(replyText).toContain('[rejected]');
      expect(replyText).toContain('[pending]');
    });

    it('empty window → friendly note', async () => {
      await router.dispatchPrivate(makePrivate(`/persona_history ${GROUP} 30`));
      const replyText = (adapter.sendPrivateMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as string;
      expect(replyText).toMatch(/无 persona 提案/);
    });
  });

  describe('rate limiting', () => {
    it('per-user cooldown kicks in after many back-to-back commands', async () => {
      insertProposal(db);
      // default limit is 10/min for non-special commands — exhaust it via persona key
      for (let i = 0; i < 10; i++) {
        rl.checkUser(ADMIN, 'persona');
      }
      await router.dispatchPrivate(makePrivate('/persona_review'));
      const replyText = (adapter.sendPrivateMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as string;
      expect(replyText).toMatch(/太频繁/);
    });
  });
});
