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
 *
 * 2026-04-24: cao-family collapsed to phonetic IME family regex (操草炒吵淦艹肏);
 * sb-family expanded to 煞笔 + \bSB\b. See feedback_chinese_profanity_phonetic_family.md.
 */

import type { SendGuard } from './send-guard-chain.js';
import { createLogger } from './logger.js';

const logger = createLogger('output-hard-gate');

export const BLOCKED_TEMPLATES: readonly RegExp[] = [
  /怡你妈/,
  /(?:操|草|炒|吵|淦|艹|肏)(?:你|尼|拟)?(?:妈|马)/,
  /干你妈/,
  /你妈(?:的|逼)/,
  /妈的逼/,
  /去死|去你妈的死/,
  /滚(?:蛋|开)/,
  /再@我(?:你)?试试/,
  /闭嘴|给我闭嘴/,
  /傻逼|煞笔|\b[Ss][Bb]\b/,
  /脑子有问题/,
  /你有病吧|有病啊你|神经病(?!院)/,
  /nmd/,
  /尼玛/,
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
