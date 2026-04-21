/**
 * PR2: Harassment hard-gate — deterministic BLOCKED_TEMPLATES filter.
 *
 * Pure regex SendGuard appended after stickerLeakGuard in buildSendGuards().
 * No LLM, no regen. Input = bot outgoing text after CQ:reply strip. Lore-grep
 * carved ALLOWLIST carries single-token deflection responses (`炒你妈`, `滚蛋`)
 * that collide with fandom group voice; multi-token occurrences fall through
 * to the regex and block.
 *
 * Decision 5 Choice A: gate fire → { passed:false, reason:'hard-gate-blocked',
 * replacement:'neutral-ack' }. PR2 maps to `silent` kind via the 14 chat.ts
 * reasonCode sites; `neutral-ack` replacement field is reserved for PR2.1
 * mapper refactor that will wire pickNeutralAck() through.
 */

import type { SendGuard } from './send-guard-chain.js';
import { createLogger } from './logger.js';

const logger = createLogger('output-hard-gate');

export const BLOCKED_TEMPLATES: readonly RegExp[] = [
  /怡你妈/,
  /操你妈|草你妈|炒你妈/,
  /去死|去你妈的死/,
  /滚(?:蛋|开)/,
  /再@我(?:你)?试试/,
  /闭嘴|给我闭嘴/,
  /傻逼/,
  /脑子有问题/,
];

export const ALLOWLIST: readonly string[] = ['炒你妈', '滚蛋'];

const CQ_REPLY_RE = /\[CQ:reply[^\]]*\]/g;
const CQ_ANY_RE = /\[CQ:[^\]]*\]/g;

export function stripCqReply(text: string): string {
  return text.replace(CQ_REPLY_RE, '').replace(CQ_ANY_RE, '').trim();
}

export function hasHarassmentTemplate(text: string): boolean {
  const stripped = stripCqReply(text);
  if (stripped === '') return false;
  if (ALLOWLIST.includes(stripped.trim())) return false;
  for (const re of BLOCKED_TEMPLATES) {
    if (re.test(stripped)) return true;
  }
  return false;
}

export const harassmentHardGate: SendGuard = (text, ctx) => {
  const stripped = stripCqReply(text);
  if (stripped === '') return { passed: true, text };
  if (ALLOWLIST.includes(stripped.trim())) return { passed: true, text };
  for (const re of BLOCKED_TEMPLATES) {
    const match = re.exec(stripped);
    if (match) {
      logger.info(
        { groupId: ctx.groupId, term: match[0] },
        'hard-gate-blocked',
      );
      return { passed: false, reason: 'hard-gate-blocked', replacement: 'neutral-ack' };
    }
  }
  return { passed: true, text };
};
