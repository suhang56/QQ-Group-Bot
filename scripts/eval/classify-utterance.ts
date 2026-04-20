/**
 * R6.3 — Post-hoc UtteranceAct classifier.
 *
 * Pure, deterministic. Consumes ChatResult and returns a UtteranceAct label
 * used by the `meta-status-misclassified` violation tag. Intentionally naive
 * in R6.3 — `unknown` is a first-class citizen and does not itself trigger
 * any tag. See DESIGN-NOTE §5.
 */

import type { ChatResult } from '../../src/utils/chat-result.js';
import type { UtteranceAct } from './replay-types.js';

const META_STATUS_RE = /^(禁言|踢|警告|管理|群规|违规|删了|撤回|别在群里)/;
const RELAY_ECHO_RE = /^(接(\s|$)|1\s*$|\+1|收到\s*$|来了\s*$)/;
const BOT_STATUS_RE = /^(我|本喵|我的|这边)(在|刚刚|今天|没|还没|已经)/;

export function classifyUtterance(result: ChatResult): UtteranceAct {
  if (result.kind === 'silent' || result.kind === 'defer') return 'none';
  if (result.kind === 'sticker') return 'object_react';
  if (result.kind === 'fallback') return 'unknown';

  // reply path — strip [mock:...] sentinel prefix if present before classifying
  const raw = result.text ?? '';
  const stripped = raw.replace(/^\[mock:[0-9a-f]{8}\]\s*/, '').trim();
  if (META_STATUS_RE.test(stripped)) return 'meta_admin_status';
  if (RELAY_ECHO_RE.test(stripped)) return 'relay';
  if (BOT_STATUS_RE.test(stripped)) return 'bot_status_query';
  return 'unknown';
}
