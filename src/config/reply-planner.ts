import type { GroupConfig } from '../storage/db.js';

/**
 * R9: feature flag for reply-planner-lite v1 (MUCA constraint layer).
 * Default OFF everywhere. Canary group `958751334` per R9 rollout playbook;
 * scope default 'direct-only' until canary stabilizes.
 *
 * Three precedence levels (highest first):
 * 1. per-group GroupConfig.chatPlannerLiteV1 = true
 * 2. process.env.R9_REPLYER_LITE_ENABLED = '1' (test/dev override)
 * 3. compile-time default = false
 */
export const R9_REPLYER_LITE_ENV =
  process.env['R9_REPLYER_LITE_ENABLED'] === '1';

export function isReplyerLiteEnabled(
  groupConfig: GroupConfig | null | undefined,
): boolean {
  if (groupConfig?.chatPlannerLiteV1 === true) return true;
  return R9_REPLYER_LITE_ENV;
}

export function replyerLiteScope(
  groupConfig: GroupConfig | null | undefined,
): 'direct-only' | 'all' {
  return groupConfig?.chatPlannerLiteScope ?? 'direct-only';
}
