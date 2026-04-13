import type { GroupConfig } from './storage/db.js';

export const lurkerDefaults = {
  lurkerReplyChance: 0.15,
  lurkerCooldownMs: 90_000,
  burstWindowMs: 10_000,
  burstMinMessages: 5,
} as const;

export const chatHistoryDefaults = {
  chatRecentCount: 20,
  chatHistoricalSampleCount: 15,
  chatKeywordMatchCount: 15,
  groupIdentityCacheTtlMs: 3_600_000, // 1 hour
  groupIdentityTopUsers: 20,
  loreDirPath: 'data/lore',
  loreSizeCapBytes: 512 * 1024, // 512 KB hard cap before truncation warning
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
    chatDebounceMs: 2000,
    modConfidenceThreshold: 0.7,
    modWhitelist: [],
    appealWindowHours: 24,
    kickConfirmModel: 'claude-opus-4-6',
    chatLoreEnabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
