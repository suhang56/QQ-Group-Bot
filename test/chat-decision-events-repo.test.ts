import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../src/storage/db.js';

function makeDb(): Database {
  return new Database(':memory:');
}

const BASE_EVENT = {
  group_id: 'g1',
  trigger_msg_id: 'msg1',
  target_msg_id: 'msg1',
  trigger_user_id: 'u1',
  result_kind: 'reply',
  reason_code: 'normal',
  decision_path: 'normal',
  guard_path: null,
  prompt_variant: 'default',
  sent_bot_reply_id: 42,
  reply_text: 'hello',
  used_fact_ids: '[1,2]',
  used_voice_count: 3,
  captured_at_sec: 1000000,
};

describe('ChatDecisionEventRepository', () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it('insert round-trip: all columns persist correctly', () => {
    const id = db.chatDecisionEvents.insert(BASE_EVENT);
    expect(id).toBeGreaterThan(0);
    const row = db.chatDecisionEvents.getById(id);
    expect(row).toBeDefined();
    expect(row!.group_id).toBe('g1');
    expect(row!.result_kind).toBe('reply');
    expect(row!.reason_code).toBe('normal');
    expect(row!.guard_path).toBeNull();
    expect(row!.used_fact_ids).toBe('[1,2]');
    expect(row!.used_voice_count).toBe(3);
    expect(row!.captured_at_sec).toBe(1000000);
    expect(row!.sent_bot_reply_id).toBe(42);
    expect(row!.reply_text).toBe('hello');
  });

  it('getById returns undefined for missing id', () => {
    expect(db.chatDecisionEvents.getById(9999)).toBeUndefined();
  });

  it('insert + effects placeholder + DELETE CASCADE removes effect row', () => {
    const id = db.chatDecisionEvents.insert(BASE_EVENT);
    db.chatDecisionEffects.insertPlaceholder(id, 'g1');
    const before = db.chatDecisionEffects.getRecentByGroup('g1', 10);
    // placeholder is unscored so won't appear in getRecentByGroup (scored only)
    // verify via getUnscored instead
    const unscored = db.chatDecisionEffects.getUnscored(BASE_EVENT.captured_at_sec + 1, 10);
    expect(unscored).toHaveLength(1);
    expect(unscored[0]!.decision_event_id).toBe(id);

    // delete parent event — cascade should remove child effect
    db.exec(`DELETE FROM chat_decision_events WHERE id = ${id}`);
    const after = db.chatDecisionEffects.getUnscored(BASE_EVENT.captured_at_sec + 1, 10);
    expect(after).toHaveLength(0);
    // suppress unused warning
    void before;
  });

  it('accepts nullable optional columns for silent kind', () => {
    const id = db.chatDecisionEvents.insert({
      group_id: 'g1',
      trigger_msg_id: null,
      target_msg_id: null,
      trigger_user_id: null,
      result_kind: 'silent',
      reason_code: 'guard',
      decision_path: null,
      guard_path: null,
      prompt_variant: null,
      sent_bot_reply_id: null,
      reply_text: null,
      used_fact_ids: null,
      used_voice_count: null,
      captured_at_sec: 1000000,
    });
    const row = db.chatDecisionEvents.getById(id);
    expect(row!.reply_text).toBeNull();
    expect(row!.sent_bot_reply_id).toBeNull();
    expect(row!.result_kind).toBe('silent');
  });
});

describe('ChatDecisionEffectRepository', () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  function insertEvent(capturedAtSec = 1000000): number {
    return db.chatDecisionEvents.insert({ ...BASE_EVENT, captured_at_sec: capturedAtSec });
  }

  it('insertPlaceholder creates row with all signals=0, score=null, scored_at_sec=null', () => {
    const evtId = insertEvent();
    db.chatDecisionEffects.insertPlaceholder(evtId, 'g1');
    const rows = db.chatDecisionEffects.getUnscored(1000001, 10);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.sig_explicit_negative).toBe(0);
    expect(r.sig_correction).toBe(0);
    expect(r.sig_ignored).toBe(0);
    expect(r.sig_continued_topic).toBe(0);
    expect(r.sig_target_user_replied).toBe(0);
    expect(r.sig_other_at_bot).toBe(0);
    expect(r.score).toBeNull();
    expect(r.scored_at_sec).toBeNull();
    expect(r.followup_msg_ids).toBeNull();
  });

  it('updateScored persists all signal columns + score + scored_at_sec', () => {
    const evtId = insertEvent();
    db.chatDecisionEffects.insertPlaceholder(evtId, 'g1');
    const [eff] = db.chatDecisionEffects.getUnscored(1000001, 10);
    db.chatDecisionEffects.updateScored(eff!.id, {
      sig_explicit_negative: 1,
      sig_correction: 0,
      sig_ignored: 0,
      sig_continued_topic: 1,
      sig_target_user_replied: 1,
      sig_other_at_bot: 0,
      followup_msg_ids: '["101","102"]',
      score: 0.3,
      scored_at_sec: 1000200,
    });
    const scored = db.chatDecisionEffects.getRecentByGroup('g1', 10);
    expect(scored).toHaveLength(1);
    const s = scored[0]!;
    expect(s.sig_explicit_negative).toBe(1);
    expect(s.sig_continued_topic).toBe(1);
    expect(s.sig_target_user_replied).toBe(1);
    expect(s.score).toBeCloseTo(0.3);
    expect(s.scored_at_sec).toBe(1000200);
    expect(s.followup_msg_ids).toBe('["101","102"]');
  });

  it('getUnscored respects cutoff: rows newer than cutoff are excluded', () => {
    const evtId1 = insertEvent(1000000);
    const evtId2 = insertEvent(1000300);
    db.chatDecisionEffects.insertPlaceholder(evtId1, 'g1');
    db.chatDecisionEffects.insertPlaceholder(evtId2, 'g1');
    // cutoff = 1000100 — only evtId1 (captured_at_sec=1000000) should appear
    const rows = db.chatDecisionEffects.getUnscored(1000100, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decision_event_id).toBe(evtId1);
  });

  it('getUnscored respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      const evtId = insertEvent(1000000 + i);
      db.chatDecisionEffects.insertPlaceholder(evtId, 'g1');
    }
    const rows = db.chatDecisionEffects.getUnscored(1001000, 3);
    expect(rows).toHaveLength(3);
  });

  it('ON DELETE CASCADE: delete parent event removes effect row', () => {
    const evtId = insertEvent();
    db.chatDecisionEffects.insertPlaceholder(evtId, 'g1');
    expect(db.chatDecisionEffects.getUnscored(1000001, 10)).toHaveLength(1);
    db.exec(`DELETE FROM chat_decision_events WHERE id = ${evtId}`);
    expect(db.chatDecisionEffects.getUnscored(1000001, 10)).toHaveLength(0);
  });
});

describe('MessageRepository.getAfter', () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  function insertMsg(groupId: string, userId: string, content: string, ts: number): void {
    db.messages.insert({ groupId, userId, nickname: 'nick', content, rawContent: content, timestamp: ts, deleted: false });
  }

  it('returns messages in group with timestamp > afterSec, ordered ASC', () => {
    insertMsg('g1', 'u1', 'a', 1000);
    insertMsg('g1', 'u1', 'b', 1002);
    insertMsg('g1', 'u1', 'c', 1005);
    const msgs = db.messages.getAfter('g1', 1001, 10);
    expect(msgs.map(m => m.content)).toEqual(['b', 'c']);
  });

  it('excludes messages exactly at afterSec (exclusive lower bound)', () => {
    insertMsg('g1', 'u1', 'x', 1000);
    const msgs = db.messages.getAfter('g1', 1000, 10);
    expect(msgs).toHaveLength(0);
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 5; i++) insertMsg('g1', 'u1', `m${i}`, 2000 + i);
    const msgs = db.messages.getAfter('g1', 1999, 3);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.content).toBe('m0');
  });

  it('excludes deleted messages', () => {
    insertMsg('g1', 'u1', 'visible', 1001);
    // insert and soft-delete
    const m = db.messages.insert({ groupId: 'g1', userId: 'u1', nickname: 'nick', content: 'deleted', rawContent: 'deleted', timestamp: 1002, deleted: false });
    db.messages.softDelete(String(m.id));
    const msgs = db.messages.getAfter('g1', 1000, 10);
    expect(msgs.map(m => m.content)).toEqual(['visible']);
  });

  it('returns empty array for unknown group', () => {
    insertMsg('g1', 'u1', 'x', 1000);
    const msgs = db.messages.getAfter('g99', 999, 10);
    expect(msgs).toHaveLength(0);
  });
});
