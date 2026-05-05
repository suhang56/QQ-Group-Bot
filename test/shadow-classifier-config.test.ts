import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { GroupConfig } from '../src/storage/db.js';

function stubConfig(overrides: Partial<GroupConfig> = {}): GroupConfig {
  return {
    groupId: 'g1',
    enabledModules: [],
    autoMod: false,
    dailyPunishmentLimit: 0,
    punishmentsToday: 0,
    punishmentsResetDate: '',
    mimicActiveUserId: null,
    mimicStartedBy: null,
    chatTriggerKeywords: [],
    chatTriggerAtOnly: false,
    chatDebounceMs: 0,
    modConfidenceThreshold: 0,
    modWhitelist: [],
    appealWindowHours: 0,
    kickConfirmModel: 'claude-haiku-4-5-20251001',
    chatLoreEnabled: true,
    nameImagesEnabled: false,
    nameImagesCollectionTimeoutMs: 0,
    nameImagesCollectionMax: 0,
    nameImagesCooldownMs: 0,
    nameImagesMaxPerName: 0,
    chatAtMentionQueueMax: 0,
    chatAtMentionBurstWindowMs: 0,
    chatAtMentionBurstThreshold: 0,
    repeaterEnabled: false,
    repeaterMinCount: 0,
    repeaterCooldownMs: 0,
    repeaterMinContentLength: 0,
    repeaterMaxContentLength: 0,
    nameImagesBlocklist: [],
    loreUpdateEnabled: false,
    loreUpdateThreshold: 0,
    loreUpdateCooldownMs: 0,
    liveStickerCaptureEnabled: false,
    stickerLegendRefreshEveryMsgs: 0,
    chatPersonaText: null,
    activeCharacterId: null,
    charStartedBy: null,
    welcomeEnabled: false,
    idGuardEnabled: false,
    stickerFirstEnabled: false,
    stickerFirstThreshold: 0,
    chatInterestCategories: [],
    chatInterestMinHits: 0,
    airReadingEnabled: false,
    addresseeGraphEnabled: false,
    linkAcrossGroups: false,
    chatPromptLayeringV2: false,
    chatPromptShadowClassifierV1: false,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('isShadowClassifierEnabled', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env['CHAT_PROMPT_SHADOW_CLASSIFIER_V1'];
  });

  it('case 1: per-group flag true returns true', async () => {
    const { isShadowClassifierEnabled } = await import('../src/config/shadow-classifier.js');
    expect(isShadowClassifierEnabled(stubConfig({ chatPromptShadowClassifierV1: true }))).toBe(true);
  });

  it('case 2: per-group flag false (no env) returns false', async () => {
    const { isShadowClassifierEnabled } = await import('../src/config/shadow-classifier.js');
    expect(isShadowClassifierEnabled(stubConfig({ chatPromptShadowClassifierV1: false }))).toBe(false);
  });

  it('case 3: null groupConfig (no env) returns false', async () => {
    const { isShadowClassifierEnabled } = await import('../src/config/shadow-classifier.js');
    expect(isShadowClassifierEnabled(null)).toBe(false);
  });

  it('case 4: env override returns true when groupConfig is null', async () => {
    process.env['CHAT_PROMPT_SHADOW_CLASSIFIER_V1'] = '1';
    const { isShadowClassifierEnabled } = await import('../src/config/shadow-classifier.js');
    expect(isShadowClassifierEnabled(null)).toBe(true);
  });

  it('case 5: env override beats per-group false', async () => {
    process.env['CHAT_PROMPT_SHADOW_CLASSIFIER_V1'] = '1';
    const { isShadowClassifierEnabled } = await import('../src/config/shadow-classifier.js');
    expect(isShadowClassifierEnabled(stubConfig({ chatPromptShadowClassifierV1: false }))).toBe(true);
  });
});
