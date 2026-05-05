import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../src/storage/db.js';
import { ChatDecisionTracker } from '../src/modules/chat-decision-tracker.js';
import type { CaptureContext } from '../src/modules/chat-decision-tracker.js';
import type { ChatResult } from '../src/utils/chat-result.js';
import type { ShadowClassifierResult } from '../src/modules/llm-shadow-classifier.js';
import { initLogger, createLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

function makeDb(): Database { return new Database(':memory:'); }

function makeTracker(db: Database): ChatDecisionTracker {
  return new ChatDecisionTracker({
    events: db.chatDecisionEvents,
    effects: db.chatDecisionEffects,
    messages: db.messages,
    logger: createLogger('test'),
  });
}

const BASE_CTX: CaptureContext = {
  groupId: 'g1',
  triggerMsgId: 'msg1',
  targetMsgId: 'msg1',
  triggerUserId: 'u1',
  sentBotReplyId: null,
  nowSec: 1_000_000,
};

function makeReplyResult(shadow?: Promise<ShadowClassifierResult>): ChatResult {
  return {
    kind: 'reply',
    text: 'hi',
    reasonCode: 'normal',
    meta: {
      decisionPath: 'normal',
      promptVariant: 'default',
      utteranceActShadowPromise: shadow,
      evasive: false,
      injectedFactIds: [],
      matchedFactIds: [],
      usedVoiceCount: 0,
      usedFactHint: false,
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise(r => setImmediate(r));
}

describe('ChatDecisionTracker — R4.5 shadow integration', () => {
  let db: Database;
  let tracker: ChatDecisionTracker;

  beforeEach(() => {
    db = makeDb();
    tracker = makeTracker(db);
  });

  it('case 1: resolved shadow promise UPDATEs row', async () => {
    const promise = Promise.resolve<ShadowClassifierResult>({ act: 'chime_in', conf: 0.9, latencyMs: 600 });
    tracker.captureDecision(makeReplyResult(promise), BASE_CTX);

    const rowsBefore = db.chatDecisionEffects.getUnscored(1_000_001, 10);
    expect(rowsBefore).toHaveLength(1);
    const eventId = rowsBefore[0]!.decision_event_id;

    await flushMicrotasks();

    const evt = db.chatDecisionEvents.getById(eventId)!;
    expect(evt.utterance_act_shadow).toBe('chime_in');
    expect(evt.utterance_act_shadow_conf).toBe(0.9);
    expect(evt.utterance_act_shadow_latency_ms).toBe(600);
  });

  it('case 2: undefined shadow promise leaves shadow cols NULL', async () => {
    tracker.captureDecision(makeReplyResult(undefined), BASE_CTX);
    await flushMicrotasks();

    const rows = db.chatDecisionEffects.getUnscored(1_000_001, 10);
    const evt = db.chatDecisionEvents.getById(rows[0]!.decision_event_id)!;
    expect(evt.utterance_act_shadow).toBeNull();
    expect(evt.utterance_act_shadow_conf).toBeNull();
    expect(evt.utterance_act_shadow_latency_ms).toBeNull();
  });

  it('case 3: timeout-shaped result (act null, latency populated) lands in row', async () => {
    const promise = Promise.resolve<ShadowClassifierResult>({ act: null, conf: null, latencyMs: 1500 });
    tracker.captureDecision(makeReplyResult(promise), BASE_CTX);
    await flushMicrotasks();

    const rows = db.chatDecisionEffects.getUnscored(1_000_001, 10);
    const evt = db.chatDecisionEvents.getById(rows[0]!.decision_event_id)!;
    expect(evt.utterance_act_shadow).toBeNull();
    expect(evt.utterance_act_shadow_conf).toBeNull();
    expect(evt.utterance_act_shadow_latency_ms).toBe(1500);
  });

  it('case 4: updateShadow throwing does not crash; subsequent inserts unaffected', async () => {
    // Wrap repo.updateShadow to throw once, then revert.
    const origUpdate = db.chatDecisionEvents.updateShadow.bind(db.chatDecisionEvents);
    let threw = false;
    db.chatDecisionEvents.updateShadow = (id, shadow) => {
      if (!threw) { threw = true; throw new Error('locked'); }
      origUpdate(id, shadow);
    };

    const p1 = Promise.resolve<ShadowClassifierResult>({ act: 'chime_in', conf: 0.9, latencyMs: 100 });
    tracker.captureDecision(makeReplyResult(p1), BASE_CTX);
    await flushMicrotasks();

    // Second insert should still succeed.
    const p2 = Promise.resolve<ShadowClassifierResult>({ act: 'direct_chat', conf: 0.8, latencyMs: 200 });
    tracker.captureDecision(makeReplyResult(p2), { ...BASE_CTX, triggerMsgId: 'msg2', nowSec: 1_000_001 });
    await flushMicrotasks();

    const rows = db.chatDecisionEffects.getUnscored(1_000_002, 10);
    expect(rows).toHaveLength(2);
    // First row's UPDATE was swallowed → shadow stays NULL
    const evt1 = db.chatDecisionEvents.getById(rows[0]!.decision_event_id)!;
    expect(evt1.utterance_act_shadow).toBeNull();
    // Second row's UPDATE goes through
    const evt2 = db.chatDecisionEvents.getById(rows[1]!.decision_event_id)!;
    expect(evt2.utterance_act_shadow).toBe('direct_chat');
  });

  it('case 5: two concurrent captures with separate promises do not cross-contaminate', async () => {
    const p1 = Promise.resolve<ShadowClassifierResult>({ act: 'chime_in', conf: 0.9, latencyMs: 100 });
    const p2 = Promise.resolve<ShadowClassifierResult>({ act: 'direct_chat', conf: 0.7, latencyMs: 200 });
    tracker.captureDecision(makeReplyResult(p1), BASE_CTX);
    tracker.captureDecision(makeReplyResult(p2), { ...BASE_CTX, triggerMsgId: 'msg2', nowSec: 1_000_001 });
    await flushMicrotasks();

    const rows = db.chatDecisionEffects.getUnscored(1_000_002, 10);
    expect(rows).toHaveLength(2);
    const acts = rows
      .map(r => db.chatDecisionEvents.getById(r.decision_event_id)!.utterance_act_shadow)
      .sort();
    expect(acts).toEqual(['chime_in', 'direct_chat']);
  });

  it('case 6: late-resolving promise still UPDATEs the correct row', async () => {
    let resolveLater!: (v: ShadowClassifierResult) => void;
    const slow: Promise<ShadowClassifierResult> = new Promise(res => { resolveLater = res; });
    tracker.captureDecision(makeReplyResult(slow), BASE_CTX);

    const rows = db.chatDecisionEffects.getUnscored(1_000_001, 10);
    const eventId = rows[0]!.decision_event_id;
    const evtBefore = db.chatDecisionEvents.getById(eventId)!;
    expect(evtBefore.utterance_act_shadow).toBeNull();

    resolveLater({ act: 'object_react', conf: 0.6, latencyMs: 750 });
    await flushMicrotasks();

    const evtAfter = db.chatDecisionEvents.getById(eventId)!;
    expect(evtAfter.utterance_act_shadow).toBe('object_react');
    expect(evtAfter.utterance_act_shadow_conf).toBe(0.6);
    expect(evtAfter.utterance_act_shadow_latency_ms).toBe(750);
  });
});
