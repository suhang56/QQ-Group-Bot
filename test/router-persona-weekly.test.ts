/**
 * M8.1 — router admin DM command coverage for weekly cadence:
 *   - /persona_review: weekly rows appear first with [周级] tag
 *   - /persona_apply <id>: applying a weekly auto-rejects stale pending dailies
 *   - /persona_history: tags weekly vs daily in output
 *   - weekly TTL: 14d (vs daily 7d)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from '../src/core/router.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { Database } from '../src/storage/db.js';
import { defaultGroupConfig } from '../src/config.js';
import type { PrivateMessage, INapCatAdapter } from '../src/adapter/napcat.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

const ADMIN = process.env['MOD_APPROVAL_ADMIN'] ?? '2331924739';
const GROUP = 'g-persona-weekly';
const OLD = '你是一个邦多利 bot，说话轻快活泼。';
const NEW_D = '你是一个邦多利 bot，日级调整后偏温柔。';
const NEW_W = '你是一个邦多利 bot，周级整体调整后更温柔并跟着群友。';

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

function insertProp(
  db: Database,
  kind: 'daily' | 'weekly',
  overrides: Partial<{ createdAt: number; newPersonaText: string }> = {},
): number {
  return db.personaPatches.insert({
    groupId: GROUP,
    oldPersonaText: OLD,
    newPersonaText: overrides.newPersonaText ?? (kind === 'weekly' ? NEW_W : NEW_D),
    reasoning: kind === 'weekly' ? '[culture] 本周氛围温和' : '本日倾向温柔',
    diffSummary: '-a\n+b',
    kind,
    createdAt: overrides.createdAt ?? Math.floor(Date.now() / 1000),
  });
}

function setup(): { db: Database; adapter: INapCatAdapter; router: Router } {
  const db = new Database(':memory:');
  db.groupConfig.upsert({ ...defaultGroupConfig(GROUP), chatPersonaText: OLD });
  const adapter = makeAdapter();
  const rl = new RateLimiter();
  const router = new Router(db, adapter, rl);
  return { db, adapter, router };
}

function lastReply(adapter: INapCatAdapter): string {
  const calls = (adapter.sendPrivateMessage as ReturnType<typeof vi.fn>).mock.calls;
  return calls.at(-1)![1] as string;
}

describe('Router — M8.1 weekly persona admin commands', () => {
  let db: Database;
  let adapter: INapCatAdapter;
  let router: Router;

  beforeEach(() => {
    ({ db, adapter, router } = setup());
  });

  describe('/persona_review', () => {
    it('lists weekly proposals first with [周级] tag, then daily with [日级]', async () => {
      // Insert daily first (so by created_at it is older), then a weekly that
      // should still sort first due to kind tiebreaker.
      insertProp(db, 'daily', { createdAt: Math.floor(Date.now() / 1000) - 3600 });
      insertProp(db, 'weekly', { createdAt: Math.floor(Date.now() / 1000) - 7200 });
      await router.dispatchPrivate(makePrivate(`/persona_review ${GROUP}`));
      const reply = lastReply(adapter);
      expect(reply).toMatch(/\[周级\]/);
      expect(reply).toMatch(/\[日级\]/);
      const weeklyIdx = reply.indexOf('[周级]');
      const dailyIdx = reply.indexOf('[日级]');
      expect(weeklyIdx).toBeGreaterThanOrEqual(0);
      expect(weeklyIdx).toBeLessThan(dailyIdx);
    });
  });

  describe('/persona_history', () => {
    it('tags each row with [周级] or [日级]', async () => {
      insertProp(db, 'weekly', { createdAt: Math.floor(Date.now() / 1000) - 2 * 86400 });
      insertProp(db, 'daily', { createdAt: Math.floor(Date.now() / 1000) - 86400 });
      await router.dispatchPrivate(makePrivate(`/persona_history ${GROUP} 30`));
      const reply = lastReply(adapter);
      expect(reply).toMatch(/\[周级\]/);
      expect(reply).toMatch(/\[日级\]/);
    });
  });

  describe('/persona_apply (weekly)', () => {
    it('applying a weekly rejects pending dailies that predate the weekly created_at', async () => {
      const now = Math.floor(Date.now() / 1000);
      const staleDaily = insertProp(db, 'daily', { createdAt: now - 3 * 86400 });
      const weekly = insertProp(db, 'weekly', { createdAt: now - 86400 });

      await router.dispatchPrivate(makePrivate(`/persona_apply ${weekly}`));
      const reply = lastReply(adapter);
      expect(reply).toMatch(/已应用 \[周级\]/);

      // Applied
      expect(db.personaPatches.getById(weekly)!.status).toBe('approved');
      // repo.apply supersedes siblings, so staleDaily should now be superseded
      // (or rejected by rejectStaleDailiesBefore if created_at equal). Either
      // way it is NOT pending anymore.
      const staleStatus = db.personaPatches.getById(staleDaily)!.status;
      expect(staleStatus).not.toBe('pending');
    });
  });

  describe('weekly TTL of 14 days', () => {
    it('allows /persona_apply on a 10d-old weekly (daily would be expired at 7d cutoff)', async () => {
      const now = Math.floor(Date.now() / 1000);
      const id = insertProp(db, 'weekly', { createdAt: now - 10 * 86400 });
      await router.dispatchPrivate(makePrivate(`/persona_apply ${id}`));
      const reply = lastReply(adapter);
      // Should not hit the expired branch — should either apply or hit the
      // conflict-confirmation branch (both acceptable; failure mode is the
      // expired-branch).
      expect(reply).not.toMatch(/已超过.*过期/);
    });

    it('rejects /persona_apply on a 16d-old weekly (past 14d cap)', async () => {
      const now = Math.floor(Date.now() / 1000);
      const id = insertProp(db, 'weekly', { createdAt: now - 16 * 86400 });
      await router.dispatchPrivate(makePrivate(`/persona_apply ${id}`));
      const reply = lastReply(adapter);
      expect(reply).toMatch(/已超过.*过期/);
    });
  });
});
