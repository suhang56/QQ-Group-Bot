import type { GroupConfig } from './storage/db.js';

export const RUNTIME_CHAT_MODEL = 'claude-sonnet-4-6' as const;
export const VISION_MODEL = 'claude-haiku-4-5-20251001' as const;

export const lurkerDefaults = {
  lurkerReplyChance: 0.15,
  lurkerCooldownMs: 90_000,
  burstWindowMs: 10_000,
  burstMinMessages: 5,
  chatSilenceBonusSec: 300,
  chatMinScore: 0.25,
  chatBurstWindowMs: 10_000,
  chatBurstCount: 5,
} as const;

export const chatHistoryDefaults = {
  chatRecentCount: 20,
  chatKeywordMatchCount: 15,
  chatContextWide: 50,
  chatContextMedium: 20,
  chatContextImmediate: 10,
  groupIdentityCacheTtlMs: 3_600_000, // 1 hour
  loreDirPath: 'data/lore',
  loreSizeCapBytes: 512 * 1024, // 512 KB hard cap before truncation warning
  chatStickerTopN: 20,          // top-N market_face stickers injected into system prompt
  stickersDirPath: 'data/stickers',
} as const;

export function defaultGroupConfig(groupId: string): GroupConfig {
  return {
    groupId,
    enabledModules: ['chat', 'mimic', 'moderator', 'learner'],
    autoMod: true,
    dailyPunishmentLimit: 10,
    punishmentsToday: 0,
    punishmentsResetDate: new Date().toISOString().slice(0, 10),
    mimicActiveUserId: null,
    mimicStartedBy: null,
    chatTriggerKeywords: [],
    chatTriggerAtOnly: false,
    chatDebounceMs: 200,
    modConfidenceThreshold: 0.7,
    modWhitelist: [],
    appealWindowHours: 24,
    kickConfirmModel: 'claude-opus-4-6',
    chatLoreEnabled: true,
    nameImagesEnabled: true,
    nameImagesCollectionTimeoutMs: 120_000,
    nameImagesCollectionMax: 20,
    nameImagesCooldownMs: 300_000,
    nameImagesMaxPerName: 50,
    chatAtMentionQueueMax: 5,
    chatAtMentionBurstWindowMs: 30_000,
    chatAtMentionBurstThreshold: 3,
    repeaterEnabled: true,
    repeaterMinCount: 3,
    repeaterCooldownMs: 600_000,
    repeaterMinContentLength: 2,
    repeaterMaxContentLength: 100,
    nameImagesBlocklist: [],
    loreUpdateEnabled: true,
    loreUpdateThreshold: 200,
    loreUpdateCooldownMs: 30 * 60 * 1000,
    liveStickerCaptureEnabled: true,
    stickerLegendRefreshEveryMsgs: 50,
    chatPersonaText: null,
    welcomeEnabled: true,
    idGuardEnabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
