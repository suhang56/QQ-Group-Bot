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

/**
 * Image describe + image moderation. Default gemini-2.5-flash because it's
 * ~3x faster than Claude Haiku vision (3-4s vs 10-12s per image) and cheap.
 * ModelRouter dispatches `gemini*` to GeminiClient, others to Claude.
 * Override via VISION_MODEL env var.
 */
export const VISION_MODEL = (process.env['VISION_MODEL'] ?? 'gemini-2.5-flash') as
  'gemini-2.5-flash' | 'gemini-2.5-pro' | 'claude-haiku-4-5-20251001' | 'claude-sonnet-4-6' | 'claude-opus-4-6' | (string & {});

/** Text moderator (HIGH-volume: every non-command group message). */
export const MODERATOR_MODEL = process.env['MODERATOR_MODEL'] ?? 'qwen3:8b';

/** Self-reflection loop (hourly tuning.md generator). */
export const REFLECTION_MODEL = process.env['REFLECTION_MODEL'] ?? 'gemini-2.5-flash';

/** Opportunistic harvest + unknown-term resolver (every 15min + daily deep). */
export const HARVEST_MODEL = process.env['HARVEST_MODEL'] ?? 'qwen3:8b';

/** Alias miner (every 2h — group member nickname discovery). */
export const ALIAS_MODEL = process.env['ALIAS_MODEL'] ?? 'qwen3:8b';

/** Jargon miner (piggybacks on harvest cycle — group-specific slang detection). */
export const JARGON_MODEL = process.env['JARGON_MODEL'] ?? 'qwen3:8b';

/** Lore updater (threshold-triggered, outputs full markdown doc). */
export const LORE_MODEL = process.env['LORE_MODEL'] ?? 'qwen3:8b';

/** Self-learning correction + harvest distillation. */
export const LEARN_MODEL = process.env['LEARN_MODEL'] ?? 'qwen3:8b';

/** Online research path — needs WebSearch tool, stays on Claude. */
export const RESEARCH_MODEL = process.env['RESEARCH_MODEL'] ?? 'claude-haiku-4-5-20251001';

/**
 * Layered chat routing: the "fast path" (lurker-mode) model used when a
 * trigger doesn't match any Sonnet-required rule. See ChatModule._pickChatModel
 * for the routing rules. Default qwen3:8b.
 */
export const CHAT_QWEN_MODEL = process.env['CHAT_QWEN_MODEL'] ?? 'qwen3:8b';

/** DeepSeek V3.2 — primary chat model (cost-optimized replacement for Sonnet on engaged paths). */
export const CHAT_DEEPSEEK_MODEL = process.env['CHAT_DEEPSEEK_MODEL'] ?? 'deepseek-chat';

/**
 * Kill switch. Set to '1' to force ALL chat calls through RUNTIME_CHAT_MODEL
 * bypassing the layered router. Emergency rollback — no code change required.
 */
export const CHAT_QWEN_DISABLED = process.env['CHAT_QWEN_DISABLED'] === '1';

/** Ollama server endpoint. */
export const OLLAMA_BASE_URL = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';

/** Gemini OpenAI-compat endpoint (do not change unless Google moves it). */
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

/** Enable flags. Flip to 0 on machines that lack the provider. */
export const OLLAMA_ENABLED = process.env['OLLAMA_ENABLED'] !== '0';
export const GEMINI_ENABLED = !!process.env['GEMINI_API_KEY'];
/** Lazy: read at call time so tests can toggle DEEPSEEK_API_KEY per-case. */
export const DEEPSEEK_ENABLED = (): boolean => !!process.env['DEEPSEEK_API_KEY'];

/** Kill switch for fact semantic retrieval. Set FACTS_RAG_DISABLED=1 to fall
 * back to the recency-based learned-fact injection path. Lazy-evaluated
 * (matches DEEPSEEK_ENABLED pattern) so tests can toggle per-case. */
export const FACTS_RAG_DISABLED = (): boolean => process.env['FACTS_RAG_DISABLED'] === '1';

/** Kill switch for memes-v1 pipeline. Set MEMES_V1_DISABLED=1 to disable:
 * (a) meme_graph retrieval in formatFactsForPrompt, (b) meme_graph term tick
 * in conversation-state. Lazy-evaluated so tests can toggle per-case. */
export const MEMES_V1_DISABLED = (): boolean => process.env['MEMES_V1_DISABLED'] === '1';

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
  chatContextWide: 30,
  chatContextMedium: 15,
  chatContextImmediate: 8,
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
    activeCharacterId: null,
    charStartedBy: null,
    welcomeEnabled: true,
    idGuardEnabled: true,
    stickerFirstEnabled: false,
    stickerFirstThreshold: 0.55,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
