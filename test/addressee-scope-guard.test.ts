import { describe, it, expect } from 'vitest';
import { hasSpectatorJudgmentTemplate, isAddresseeScopeViolation } from '../src/utils/sentinel.js';

describe('hasSpectatorJudgmentTemplate', () => {
  it('detects 你们事真多 (exact)', () => expect(hasSpectatorJudgmentTemplate('你们事真多')).toBe(true));
  it('detects 你们事真多 with CJK whitespace (compact normalization)', () =>
    expect(hasSpectatorJudgmentTemplate('你们 事 真多')).toBe(true));
  it('detects 你们节目真多', () => expect(hasSpectatorJudgmentTemplate('你们节目真多')).toBe(true));
  it('detects 你们毛病都多', () => expect(hasSpectatorJudgmentTemplate('你们毛病都多')).toBe(true));
  it('detects 你们真能折腾', () => expect(hasSpectatorJudgmentTemplate('你们真能折腾')).toBe(true));
  it('detects 你们又来了', () => expect(hasSpectatorJudgmentTemplate('你们又来了')).toBe(true));
  it('detects 你们又开始了', () => expect(hasSpectatorJudgmentTemplate('你们又开始了')).toBe(true));
  it('detects 有病吧你们', () => expect(hasSpectatorJudgmentTemplate('有病吧你们')).toBe(true));
  it('detects 你们有病啊', () => expect(hasSpectatorJudgmentTemplate('你们有病啊')).toBe(true));
  it('detects 你们几个又来了', () => expect(hasSpectatorJudgmentTemplate('你们几个又来了')).toBe(true));

  it('returns false for 笑死 (fandom vocab, not spectator)', () => expect(hasSpectatorJudgmentTemplate('笑死')).toBe(false));
  it('returns false for empty string', () => expect(hasSpectatorJudgmentTemplate('')).toBe(false));
  it('returns false for normal reply', () => expect(hasSpectatorJudgmentTemplate('继续继续')).toBe(false));
  it('returns false for 你们好多朋友 (no pattern match)', () => expect(hasSpectatorJudgmentTemplate('你们好多朋友')).toBe(false));

  it('strips CQ codes before checking', () =>
    expect(hasSpectatorJudgmentTemplate('[CQ:at,qq=123] 你们事真多')).toBe(true));
  it('returns false for whitespace-only after CQ strip', () =>
    expect(hasSpectatorJudgmentTemplate('[CQ:image,file=x.jpg]')).toBe(false));
});

describe('isAddresseeScopeViolation', () => {
  it('returns true when spectator template + <3 speakers', () =>
    expect(isAddresseeScopeViolation('你们事真多', 2)).toBe(true));
  it('returns true when spectator template + 1 speaker', () =>
    expect(isAddresseeScopeViolation('你们又来了', 1)).toBe(true));
  it('returns false when spectator template + >=3 speakers', () =>
    expect(isAddresseeScopeViolation('你们事真多', 3)).toBe(false));
  it('returns false when not spectator template + <3 speakers', () =>
    expect(isAddresseeScopeViolation('笑死了', 1)).toBe(false));
  it('returns false for normal reply regardless of speakers', () =>
    expect(isAddresseeScopeViolation('继续继续', 0)).toBe(false));
});
