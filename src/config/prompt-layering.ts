import type { GroupConfig } from '../storage/db.js';

/**
 * R5: feature flag for prompt-assembler v2 (5-layer, act-driven priority).
 * Default FALSE everywhere — no production groups opted-in at merge time.
 *
 * Three precedence levels (highest first):
 * 1. per-group GroupConfig.chatPromptLayeringV2 = true
 * 2. process.env.CHAT_PROMPT_LAYERING_V2 = '1' (test/dev override)
 * 3. compile-time default = false
 */
export const CHAT_PROMPT_LAYERING_V2_ENV =
  process.env['CHAT_PROMPT_LAYERING_V2'] === '1';

export function isLayeringV2Enabled(
  groupConfig: GroupConfig | null | undefined,
): boolean {
  if (groupConfig?.chatPromptLayeringV2 === true) return true;
  return CHAT_PROMPT_LAYERING_V2_ENV;
}
