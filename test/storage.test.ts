import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../src/storage/db.js';

function makeDb(): Database {
  return new Database(':memory:');
}

// Helpers
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

describe('Database / MessageRepository', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('inserts and retrieves a message', () => {
    const msg = db.messages.insert({
      groupId: 'g1', userId: 'u1', nickname: 'Alice',
      content: 'hello', timestamp: nowSec(), deleted: false,
    });
    expect(msg.id).toBeGreaterThan(0);

    const recent = db.messages.getRecent('g1', 10);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.content).toBe('hello');
  });

  it('getRecent returns newest first and respects limit', () => {
    const ts = nowSec();
    for (let i = 0; i < 5; i++) {
      db.messages.insert({ groupId: 'g1', userId: 'u1', nickname: 'A', content: `m${i}`, timestamp: ts + i, deleted: false });
    }
    const recent = db.messages.getRecent('g1', 3);
    expect(recent).toHaveLength(3);
    expect(recent[0]!.content).toBe('m4');
  });

  it('getByUser filters by userId', () => {
    db.messages.insert({ groupId: 'g1', userId: 'u1', nickname: 'A', content: 'from-u1', timestamp: nowSec(), deleted: false });
    db.messages.insert({ groupId: 'g1', userId: 'u2', nickname: 'B', content: 'from-u2', timestamp: nowSec(), deleted: false });
    const msgs = db.messages.getByUser('g1', 'u1', 10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe('from-u1');
  });

  it('softDelete marks message deleted', () => {
    const msg = db.messages.insert({ groupId: 'g1', userId: 'u1', nickname: 'A', content: 'bye', timestamp: nowSec(), deleted: false });
    db.messages.softDelete(String(msg.id));
    // softDeleted messages excluded from getRecent
    const recent = db.messages.getRecent('g1', 10);
    expect(recent.every(m => !m.deleted)).toBe(true);
  });

  it('getRecent excludes deleted messages', () => {
    const m1 = db.messages.insert({ groupId: 'g1', userId: 'u1', nickname: 'A', content: 'keep', timestamp: nowSec(), deleted: false });
    const m2 = db.messages.insert({ groupId: 'g1', userId: 'u1', nickname: 'A', content: 'delete-me', timestamp: nowSec() + 1, deleted: false });
    db.messages.softDelete(String(m2.id));
    const recent = db.messages.getRecent('g1', 10);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.id).toBe(m1.id);
  });
});

describe('Database / UserRepository', () => {
  let db: Database;

  beforeEach(() => { db = makeDb(); });

  it('upsert inserts new user', () => {
    db.users.upsert({ userId: 'u1', groupId: 'g1', nickname: 'Alice', styleSummary: null, lastSeen: nowSec() });
    const user = db.users.findById('u1', 'g1');
    expect(user).not.toBeNull();
    expect(user!.nickname).toBe('Alice');
  });

  it('upsert updates existing user', () => {
    const ts = nowSec();
    db.users.upsert({ userId: 'u1', groupId: 'g1', nickname: 'Alice', styleSummary: null, lastSeen: ts });
    db.users.upsert({ userId: 'u1', groupId: 'g1', nickname: 'Alice2', styleSummary: 'casual', lastSeen: ts + 1 });
    const user = db.users.findById('u1', 'g1');
    expect(user!.nickname).toBe('Alice2');
    expect(user!.styleSummary).toBe('casual');
  });

  it('findById returns null for missing user', () => {
    expect(db.users.findById('nobody', 'g1')).toBeNull();
  });
});

describe('Database / ModerationRepository', () => {
  let db: Database;

  beforeEach(() => { db = makeDb(); });

  it('inserts and retrieves moderation record by msgId', () => {
    const rec = db.moderation.insert({
      msgId: 'msg-1', groupId: 'g1', userId: 'u1',
      violation: true, severity: 2, action: 'ban',
      reason: 'spam', appealed: 0, reversed: false,
      timestamp: nowSec(),
    });
    expect(rec.id).toBeGreaterThan(0);
    const found = db.moderation.findByMsgId('msg-1');
    expect(found).not.toBeNull();
    expect(found!.action).toBe('ban');
  });

  it('findById returns null for missing record', () => {
    expect(db.moderation.findById(9999)).toBeNull();
  });

  it('findPendingAppeal returns unappealed record within window', () => {
    const ts = nowSec();
    db.moderation.insert({ msgId: 'msg-2', groupId: 'g1', userId: 'u2', violation: true, severity: 3, action: 'ban', reason: 'test', appealed: 0, reversed: false, timestamp: ts });
    const found = db.moderation.findPendingAppeal('u2', 'g1');
    expect(found).not.toBeNull();
  });

  it('findPendingAppeal returns null when already appealed', () => {
    const ts = nowSec();
    const rec = db.moderation.insert({ msgId: 'msg-3', groupId: 'g1', userId: 'u3', violation: true, severity: 2, action: 'ban', reason: 'test', appealed: 0, reversed: false, timestamp: ts });
    db.moderation.update(rec.id, { appealed: 1 });
    // appealed=1 means pending review — findPendingAppeal should NOT return already-appealed
    const found = db.moderation.findPendingAppeal('u3', 'g1');
    expect(found).toBeNull();
  });

  it('update patches appealed and reversed fields', () => {
    const rec = db.moderation.insert({ msgId: 'msg-4', groupId: 'g1', userId: 'u4', violation: true, severity: 1, action: 'warn', reason: 'minor', appealed: 0, reversed: false, timestamp: nowSec() });
    db.moderation.update(rec.id, { appealed: 1, reversed: true });
    const updated = db.moderation.findById(rec.id);
    expect(updated!.appealed).toBe(1);
    expect(updated!.reversed).toBe(true);
  });

  it('countWarnsByUser counts recent warns correctly', () => {
    const ts = nowSec();
    db.moderation.insert({ msgId: 'm1', groupId: 'g1', userId: 'u5', violation: true, severity: 1, action: 'warn', reason: '', appealed: 0, reversed: false, timestamp: ts });
    db.moderation.insert({ msgId: 'm2', groupId: 'g1', userId: 'u5', violation: true, severity: 1, action: 'warn', reason: '', appealed: 0, reversed: false, timestamp: ts - 1 });
    // Old record outside window
    db.moderation.insert({ msgId: 'm3', groupId: 'g1', userId: 'u5', violation: true, severity: 1, action: 'warn', reason: '', appealed: 0, reversed: false, timestamp: ts - 10000 });
    const count = db.moderation.countWarnsByUser('u5', 'g1', 5000 * 1000);
    expect(count).toBe(2);
  });

  it('findRecentByUser returns records within window', () => {
    const ts = nowSec();
    db.moderation.insert({ msgId: 'r1', groupId: 'g1', userId: 'u6', violation: true, severity: 2, action: 'ban', reason: '', appealed: 0, reversed: false, timestamp: ts });
    db.moderation.insert({ msgId: 'r2', groupId: 'g1', userId: 'u6', violation: true, severity: 2, action: 'ban', reason: '', appealed: 0, reversed: false, timestamp: ts - 10000 });
    const recent = db.moderation.findRecentByUser('u6', 'g1', 5000 * 1000);
    expect(recent).toHaveLength(1);
  });

  it('findRecentByGroup returns empty array for unknown group', () => {
    const result = db.moderation.findRecentByGroup('no-such-group', 999999 * 1000);
    expect(result).toEqual([]);
  });

  it('findRecentByGroup returns all records within wide window', () => {
    const ts = nowSec();
    db.moderation.insert({ msgId: 'fg1', groupId: 'g7', userId: 'u1', violation: true, severity: 1, action: 'warn', reason: '', appealed: 0, reversed: false, timestamp: ts });
    db.moderation.insert({ msgId: 'fg2', groupId: 'g7', userId: 'u2', violation: true, severity: 2, action: 'ban', reason: '', appealed: 0, reversed: false, timestamp: ts - 100 });
    const result = db.moderation.findRecentByGroup('g7', 999999 * 1000);
    expect(result).toHaveLength(2);
  });

  it('findRecentByGroup excludes records outside window', () => {
    const ts = nowSec();
    db.moderation.insert({ msgId: 'fg3', groupId: 'g8', userId: 'u1', violation: true, severity: 1, action: 'warn', reason: '', appealed: 0, reversed: false, timestamp: ts });
    db.moderation.insert({ msgId: 'fg4', groupId: 'g8', userId: 'u1', violation: true, severity: 1, action: 'warn', reason: '', appealed: 0, reversed: false, timestamp: ts - 10000 });
    const result = db.moderation.findRecentByGroup('g8', 5000 * 1000);
    expect(result).toHaveLength(1);
    expect(result[0]!.msgId).toBe('fg3');
  });

  it('findRecentByGroup does not return records from other groups', () => {
    const ts = nowSec();
    db.moderation.insert({ msgId: 'fg5', groupId: 'g9', userId: 'u1', violation: true, severity: 1, action: 'warn', reason: '', appealed: 0, reversed: false, timestamp: ts });
    db.moderation.insert({ msgId: 'fg6', groupId: 'g10', userId: 'u1', violation: true, severity: 1, action: 'warn', reason: '', appealed: 0, reversed: false, timestamp: ts });
    const result = db.moderation.findRecentByGroup('g9', 999999 * 1000);
    expect(result).toHaveLength(1);
    expect(result[0]!.msgId).toBe('fg5');
  });
});

describe('Database / GroupConfigRepository', () => {
  let db: Database;

  beforeEach(() => { db = makeDb(); });

  it('get returns null for unknown group', () => {
    expect(db.groupConfig.get('unknown')).toBeNull();
  });

  it('upsert inserts and get retrieves config', () => {
    const cfg = {
      groupId: 'g1',
      enabledModules: ['chat', 'mimic'],
      autoMod: true,
      dailyPunishmentLimit: 10,
      punishmentsToday: 0,
      punishmentsResetDate: '2026-04-13',
      mimicActiveUserId: null,
      mimicStartedBy: null,
      chatTriggerKeywords: [],
      chatTriggerAtOnly: false,
      chatDebounceMs: 2000,
      modConfidenceThreshold: 0.7,
      modWhitelist: [],
      appealWindowHours: 24,
      kickConfirmModel: 'claude-opus-4-6' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.groupConfig.upsert(cfg);
    const got = db.groupConfig.get('g1');
    expect(got).not.toBeNull();
    expect(got!.enabledModules).toEqual(['chat', 'mimic']);
    expect(got!.autoMod).toBe(true);
    expect(got!.modWhitelist).toEqual([]);
  });

  it('incrementPunishments adds 1 to punishmentsToday', () => {
    const cfg = {
      groupId: 'g2', enabledModules: ['chat'], autoMod: true,
      dailyPunishmentLimit: 5, punishmentsToday: 3,
      punishmentsResetDate: '2026-04-13',
      mimicActiveUserId: null, mimicStartedBy: null,
      chatTriggerKeywords: [], chatTriggerAtOnly: false,
      chatDebounceMs: 2000, modConfidenceThreshold: 0.7,
      modWhitelist: [], appealWindowHours: 24,
      kickConfirmModel: 'claude-opus-4-6' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.groupConfig.upsert(cfg);
    db.groupConfig.incrementPunishments('g2');
    expect(db.groupConfig.get('g2')!.punishmentsToday).toBe(4);
  });

  it('resetDailyPunishments sets punishmentsToday to 0', () => {
    db.groupConfig.upsert({
      groupId: 'g3', enabledModules: ['chat'], autoMod: true,
      dailyPunishmentLimit: 5, punishmentsToday: 7,
      punishmentsResetDate: '2026-04-12',
      mimicActiveUserId: null, mimicStartedBy: null,
      chatTriggerKeywords: [], chatTriggerAtOnly: false,
      chatDebounceMs: 2000, modConfidenceThreshold: 0.7,
      modWhitelist: [], appealWindowHours: 24,
      kickConfirmModel: 'claude-opus-4-6' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    db.groupConfig.resetDailyPunishments('g3');
    const cfg = db.groupConfig.get('g3')!;
    expect(cfg.punishmentsToday).toBe(0);
  });
});

describe('Database / RuleRepository', () => {
  let db: Database;

  beforeEach(() => { db = makeDb(); });

  it('inserts and finds rule by id', () => {
    const rule = db.rules.insert({ groupId: 'g1', content: 'no spam', type: 'positive', embedding: null });
    expect(rule.id).toBeGreaterThan(0);
    expect(db.rules.findById(rule.id)).not.toBeNull();
  });

  it('getAll returns rules for group', () => {
    db.rules.insert({ groupId: 'g1', content: 'rule1', type: 'positive', embedding: null });
    db.rules.insert({ groupId: 'g1', content: 'rule2', type: 'negative', embedding: null });
    db.rules.insert({ groupId: 'g2', content: 'other', type: 'positive', embedding: null });
    const rules = db.rules.getAll('g1');
    expect(rules).toHaveLength(2);
  });

  it('getPage paginates correctly', () => {
    for (let i = 0; i < 5; i++) {
      db.rules.insert({ groupId: 'g1', content: `rule${i}`, type: 'positive', embedding: null });
    }
    const page = db.rules.getPage('g1', 0, 3);
    expect(page.total).toBe(5);
    expect(page.rules).toHaveLength(3);
    const page2 = db.rules.getPage('g1', 3, 3);
    expect(page2.rules).toHaveLength(2);
  });
});
