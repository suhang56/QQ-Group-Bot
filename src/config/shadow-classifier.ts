import type { GroupConfig } from '../storage/db.js';

/**
 * R4.5: feature flag for LLM shadow classifier on chat.ts:2830.
 * Default FALSE everywhere — no production groups opted-in at merge time.
 *
 * Three precedence levels (highest first):
 * 1. per-group GroupConfig.chatPromptShadowClassifierV1 = true
 * 2. process.env.CHAT_PROMPT_SHADOW_CLASSIFIER_V1 = '1' (test/dev override)
 * 3. compile-time default = false
 */
export const CHAT_PROMPT_SHADOW_CLASSIFIER_V1_ENV =
  process.env['CHAT_PROMPT_SHADOW_CLASSIFIER_V1'] === '1';

export function isShadowClassifierEnabled(
  groupConfig: GroupConfig | null | undefined,
): boolean {
  if (groupConfig?.chatPromptShadowClassifierV1 === true) return true;
  return CHAT_PROMPT_SHADOW_CLASSIFIER_V1_ENV;
}
