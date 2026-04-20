import { describe, it, expect } from 'vitest';
import { buildReplayRow } from '../../scripts/eval/replay-runner-core.js';
import type { GoldLabel } from '../../scripts/eval/gold/types.js';
import type { ChatResult } from '../../src/utils/chat-result.js';

const gold: GoldLabel = {
  sampleId: '958751334:1',
  goldAct: 'direct_chat',
  goldDecision: 'reply',
  targetOk: true,
  factNeeded: false,
  allowBanter: true,
  allowSticker: false,
  labeledAt: '2026-04-20T00:00:00Z',
};

function makeReply(): ChatResult {
  return {
    kind: 'reply',
    text: '好的',
    meta: {
      decisionPath: 'normal',
      evasive: false,
      injectedFactIds: [5],
      matchedFactIds: [],
      usedVoiceCount: 0,
      usedFactHint: false,
      guardPath: 'hardened-regen',
      promptVariant: 'default',
    },
    reasonCode: 'ok',
  };
}

describe('buildReplayRow — serialization invariants', () => {
  const row = buildReplayRow({
    sampleId: gold.sampleId,
    category: 1,
    gold,
    triggerMessageId: 'TRG',
    result: makeReply(),
    durationMs: 12,
    violationTags: [],
    utteranceAct: 'unknown',
  });

  it('JSON.stringify produces no "undefined" tokens', () => {
    const s = JSON.stringify(row);
    expect(s).not.toContain('undefined');
  });

  it('all 20 fields are present as keys in the object', () => {
    const keys = Object.keys(row).sort();
    const expected = [
      'sampleId', 'category',
      'goldAct', 'goldDecision', 'factNeeded', 'allowBanter', 'allowSticker',
      'resultKind', 'reasonCode', 'utteranceAct', 'guardPath', 'targetMsgId',
      'usedFactHint', 'matchedFactIds', 'injectedFactIds',
      'replyText', 'promptVariant',
      'violationTags', 'errorMessage', 'durationMs',
    ].sort();
    expect(keys).toEqual(expected);
  });

  it('repeated stringify is byte-identical', () => {
    expect(JSON.stringify(row)).toBe(JSON.stringify(row));
  });

  it('error row: reasonCode null, errorMessage string, replyText null', () => {
    const errRow = buildReplayRow({
      sampleId: 's',
      category: 1,
      gold,
      triggerMessageId: 'TRG',
      result: { kind: 'error', errorMessage: 'timeout after 10000ms' },
      durationMs: 10000,
      violationTags: [],
      utteranceAct: 'none',
    });
    expect(errRow.reasonCode).toBeNull();
    expect(errRow.errorMessage).toBe('timeout after 10000ms');
    expect(errRow.replyText).toBeNull();
    expect(errRow.utteranceAct).toBe('none');
    expect(errRow.targetMsgId).toBe('TRG');
  });

  it('silent row: reasonCode string, replyText null, usedFactHint null', () => {
    const silentRow = buildReplayRow({
      sampleId: 's',
      category: 1,
      gold,
      triggerMessageId: 'TRG',
      result: {
        kind: 'silent',
        meta: { decisionPath: 'silent' },
        reasonCode: 'guard',
      },
      durationMs: 5,
      violationTags: [],
      utteranceAct: 'none',
    });
    expect(silentRow.reasonCode).toBe('guard');
    expect(silentRow.replyText).toBeNull();
    expect(silentRow.usedFactHint).toBeNull();
    expect(silentRow.matchedFactIds).toBeNull();
  });

  it('sticker row: replyText holds cqCode, utteranceAct is object_react', () => {
    const stRow = buildReplayRow({
      sampleId: 's',
      category: 1,
      gold,
      triggerMessageId: 'TRG',
      result: {
        kind: 'sticker',
        cqCode: '[CQ:face,id=1]',
        meta: { decisionPath: 'sticker', key: 'k' },
        reasonCode: 'ok',
      },
      durationMs: 1,
      violationTags: [],
      utteranceAct: 'object_react',
    });
    expect(stRow.replyText).toBe('[CQ:face,id=1]');
    expect(stRow.utteranceAct).toBe('object_react');
    expect(stRow.matchedFactIds).toBeNull();
  });
});
