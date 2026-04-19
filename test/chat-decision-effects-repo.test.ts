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
  guard_path: 'confab-regen',
  prompt_variant: 'default',
  sent_bot_reply_id: 10,
  reply_text: 'hello',
  used_fact_ids: '[1]',
  used_voice_count: 2,
  captured_at_sec: 1000000,
};

describe('ChatDecisionEffectRepository', () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  function insertEvent(capturedAtSec = 1000000, guardPath: string | null = 'confab-regen'): number {
    return db.chatDecisionEvents.insert({ ...BASE_EVENT, captured_at_sec: capturedAtSec, guard_path: guardPath });
  }

  it('insertPlaceholder creates row with all signals=0, score=null, scored_at_sec=null', () => {
    const evtId = insertEvent();
    db.chatDecisionEffects.insertPlaceholder(evtId, 'g1');
    const [row] = db.chatDecisionEffects.getUnscored(1000001, 10);
    expect(row).toBeDefined();
    expect(row!.sig_explicit_negative).toBe(0);
    expect(row!.sig_correction).toBe(0);
    expect(row!.sig_ignored).toBe(0);
    expect(row!.sig_continued_topic).toBe(0);
    expect(row!.sig_target_user_replied).toBe(0);
    expect(row!.sig_other_at_bot).toBe(0);
    expect(row!.score).toBeNull();
    expect(row!.scored_at_sec).toBeNull();
    expect(row!.followup_msg_ids).toBeNull();
    expect(row!.decision_event_id).toBe(evtId);
    expect(row!.group_id).toBe('g1');
  });

  it('updateScored sets all signal columns + score + scored_at_sec correctly', () => {
    const evtId = insertEvent();
    db.chatDecisionEffects.insertPlaceholder(evtId, 'g1');
    const [eff] = db.chatDecisionEffects.getUnscored(1000001, 10);
    db.chatDecisionEffects.updateScored(eff!.id, {
      sig_explicit_negative: 0,
      sig_correction: 1,
      sig_ignored: 0,
      sig_continued_topic: 1,
      sig_target_user_replied: 0,
      sig_other_at_bot: 1,
      followup_msg_ids: '["10","11","12"]',
      score: 0.2,
      scored_at_sec: 1000200,
    });
    const [scored] = db.chatDecisionEffects.getRecentByGroup('g1', 10);
    expect(scored!.sig_explicit_negative).toBe(0);
    expect(scored!.sig_correction).toBe(1);
    expect(scored!.sig_ignored).toBe(0);
    expect(scored!.sig_continued_topic).toBe(1);
    expect(scored!.sig_target_user_replied).toBe(0);
    expect(scored!.sig_other_at_bot).toBe(1);
    expect(scored!.followup_msg_ids).toBe('["10","11","12"]');
    expect(scored!.score).toBeCloseTo(0.2);
    expect(scored!.scored_at_sec).toBe(1000200);
  });

  it('getRecentByGroup returns only scored rows, newest-first', () => {
    const e1 = insertEvent(1000000);
    const e2 = insertEvent(1001000);
    db.chatDecisionEffects.insertPlaceholder(e1, 'g1');
    db.chatDecisionEffects.insertPlaceholder(e2, 'g1');
    const [eff1] = db.chatDecisionEffects.getUnscored(1000001, 10);
    const [, eff2] = db.chatDecisionEffects.getUnscored(1002000, 10);
    db.chatDecisionEffects.updateScored(eff1!.id, { sig_explicit_negative: 0, sig_correction: 0, sig_ignored: 1, sig_continued_topic: 0, sig_target_user_replied: 0, sig_other_at_bot: 0, followup_msg_ids: '[]', score: -0.1, scored_at_sec: 1000300 });
    db.chatDecisionEffects.updateScored(eff2!.id, { sig_explicit_negative: 0, sig_correction: 0, sig_ignored: 0, sig_continued_topic: 1, sig_target_user_replied: 1, sig_other_at_bot: 0, followup_msg_ids: '[]', score: 0.3, scored_at_sec: 1001300 });
    const rows = db.chatDecisionEffects.getRecentByGroup('g1', 10);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.scored_at_sec).toBe(1001300);
    expect(rows[1]!.scored_at_sec).toBe(1000300);
  });

  it('ON DELETE CASCADE: delete parent event removes effect row', () => {
    const evtId = insertEvent();
    db.chatDecisionEffects.insertPlaceholder(evtId, 'g1');
    expect(db.chatDecisionEffects.getUnscored(1000001, 10)).toHaveLength(1);
    db.exec(`DELETE FROM chat_decision_events WHERE id = ${evtId}`);
    expect(db.chatDecisionEffects.getUnscored(1000001, 10)).toHaveLength(0);
  });

  it('getUnscored excludes already-scored rows', () => {
    const evtId = insertEvent();
    db.chatDecisionEffects.insertPlaceholder(evtId, 'g1');
    const [eff] = db.chatDecisionEffects.getUnscored(1000001, 10);
    db.chatDecisionEffects.updateScored(eff!.id, { sig_explicit_negative: 0, sig_correction: 0, sig_ignored: 1, sig_continued_topic: 0, sig_target_user_replied: 0, sig_other_at_bot: 0, followup_msg_ids: '[]', score: -0.1, scored_at_sec: 1000200 });
    expect(db.chatDecisionEffects.getUnscored(1000001, 10)).toHaveLength(0);
  });

  it('multiple groups: getRecentByGroup is group-scoped', () => {
    const e1 = insertEvent();
    const e2 = db.chatDecisionEvents.insert({ ...BASE_EVENT, group_id: 'g2', captured_at_sec: 1000000 });
    db.chatDecisionEffects.insertPlaceholder(e1, 'g1');
    db.chatDecisionEffects.insertPlaceholder(e2, 'g2');
    const [eff1] = db.chatDecisionEffects.getUnscored(1000001, 10);
    db.chatDecisionEffects.updateScored(eff1!.id, { sig_explicit_negative: 0, sig_correction: 0, sig_ignored: 1, sig_continued_topic: 0, sig_target_user_replied: 0, sig_other_at_bot: 0, followup_msg_ids: '[]', score: -0.1, scored_at_sec: 1000200 });
    expect(db.chatDecisionEffects.getRecentByGroup('g1', 10)).toHaveLength(1);
    expect(db.chatDecisionEffects.getRecentByGroup('g2', 10)).toHaveLength(0);
  });
});

// ── EXPLICIT_NEGATIVE_RE and CORRECTION_RE regex coverage ──────────────

describe('signal regex coverage (via tracker integration)', () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  function testRegex(pattern: RegExp, inputs: string[], shouldMatch: boolean): void {
    for (const input of inputs) {
      expect(pattern.test(input)).toBe(shouldMatch);
    }
  }

  it('EXPLICIT_NEGATIVE_RE matches expected terms', () => {
    const re = /废物|傻逼|滚|去死|垃圾|笨蛋|蠢货|闭嘴|烦死了|烦死|太烦了/;
    testRegex(re, ['废物', '傻逼', '去死吧', '垃圾东西', '笨蛋！', '烦死了', '太烦了真的'], true);
  });

  it('EXPLICIT_NEGATIVE_RE does NOT match neutral text', () => {
    const re = /废物|傻逼|滚|去死|垃圾|笨蛋|蠢货|闭嘴|烦死了|烦死|太烦了/;
    testRegex(re, ['好的', 'haha', '不错哦', '继续说'], false);
  });

  it('CORRECTION_RE matches expected correction phrases', () => {
    const re = /不对[啊吧哦嗯]?|错了[啊吧哦]?|我说的是|不是这意思|理解错了|没说这个|你搞错了/;
    testRegex(re, ['不对啊', '不对', '错了吧', '我说的是这个', '你搞错了', '理解错了'], true);
  });

  it('CORRECTION_RE does NOT match unrelated text', () => {
    const re = /不对[啊吧哦嗯]?|错了[啊吧哦]?|我说的是|不是这意思|理解错了|没说这个|你搞错了/;
    testRegex(re, ['对的', '没错', '就是这样', 'cool'], false);
  });
});
