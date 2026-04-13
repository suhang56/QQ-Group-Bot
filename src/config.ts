import type { GroupConfig } from './storage/db.js';

export const lurkerDefaults = {
  lurkerReplyChance: 0.15,
  lurkerCooldownMs: 90_000,
  burstWindowMs: 10_000,
  burstMinMessages: 5,
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
