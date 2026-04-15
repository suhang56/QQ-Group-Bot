import type { GroupConfig } from './storage/db.js';

// ============================================================================
// LLM routing — per-module model names
// ----------------------------------------------------------------------------
// All values below are env-overridable. The ModelRouter dispatches by prefix:
//   qwen* / ollama:* / local:* → OllamaClient (local)
//   gemini*                    → GeminiClient (Google AI Studio)
//   gpt* / o1* / o3*           → OpenAIClient (future)
//   claude* and default        → ClaudeClient (via @anthropic-ai/claude-agent-sdk)
//
// To try a different model for any pipeline on a particular machine, set the
// matching env var in .env and restart. No code changes required.
// ============================================================================

/** Main group chat reply + deflections + mimic + welcome + announcements. */
export const RUNTIME_CHAT_MODEL = (process.env['CHAT_MODEL'] ?? 'claude-sonnet-4-6') as
  'claude-sonnet-4-6' | 'claude-haiku-4-5-20251001' | 'claude-opus-4-6';

/** Image describe + image moderation — always a Claude vision model. */
export const VISION_MODEL = (process.env['VISION_MODEL'] ?? 'claude-haiku-4-5-20251001') as
  'claude-haiku-4-5-20251001' | 'claude-sonnet-4-6' | 'claude-opus-4-6';

/** Text moderator (HIGH-volume: every non-command group message). */
export const MODERATOR_MODEL = process.env['MODERATOR_MODEL'] ?? 'qwen3:8b';

/** Self-reflection loop (hourly tuning.md generator). */
export const REFLECTION_MODEL = process.env['REFLECTION_MODEL'] ?? 'qwen3:8b';

/** Opportunistic harvest + unknown-term resolver (every 15min + daily deep). */
export const HARVEST_MODEL = process.env['HARVEST_MODEL'] ?? 'qwen3:8b';

/** Alias miner (every 2h — group member nickname discovery). */
export const ALIAS_MODEL = process.env['ALIAS_MODEL'] ?? 'qwen3:8b';

/** Lore updater (threshold-triggered, outputs full markdown doc). */
export const LORE_MODEL = process.env['LORE_MODEL'] ?? 'qwen3:8b';

/** Self-learning correction + harvest distillation. */
export const LEARN_MODEL = process.env['LEARN_MODEL'] ?? 'qwen3:8b';

/** Online research path — needs WebSearch tool, stays on Claude. */
export const RESEARCH_MODEL = process.env['RESEARCH_MODEL'] ?? 'claude-haiku-4-5-20251001';

/**
 * Layered chat routing: the "fast path" model used for low-stakes lurker-mode
 * replies (plain casual banter without @mention, reply-to-bot, admin, or
 * sensitive content). High-stakes triggers still go through RUNTIME_CHAT_MODEL.
 * See ChatModule._pickChatModel for the exact routing rules.
 */
export const CHAT_QWEN_MODEL = process.env['CHAT_QWEN_MODEL'] ?? 'qwen3:8b';

/**
 * Kill switch: set to '1' to force ALL chat calls through RUNTIME_CHAT_MODEL,
 * bypassing the layered router. Use this as emergency rollback if Qwen output
 * quality drops below acceptable on lurker-mode replies, without needing a
 * code change or redeploy.
 */
export const CHAT_QWEN_DISABLED = process.env['CHAT_QWEN_DISABLED'] === '1';

/** Ollama server endpoint. */
export const OLLAMA_BASE_URL = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';

/** Gemini OpenAI-compat endpoint (do not change unless Google moves it). */
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

/** Enable flags. Flip to 0 on machines that lack the provider. */
export const OLLAMA_ENABLED = process.env['OLLAMA_ENABLED'] !== '0';
export const GEMINI_ENABLED = !!process.env['GEMINI_API_KEY'];

export const lurkerDefaults = {
  lurkerReplyChance: 0.12,
  lurkerCooldownMs: 120_000,
  burstWindowMs: 10_000,
  burstMinMessages: 5,
  chatSilenceBonusSec: 420,
  chatMinScore: 0.45,
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
