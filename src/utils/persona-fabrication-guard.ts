/**
 * PR4: Persona fabrication guard — deterministic blacklist for bot self-claiming
 * hard attributes (gender / age / height / weight / address).
 *
 * Appended to buildSendGuards() after harassmentHardGate. Pure-regex, no LLM,
 * no regen. Input is bot outgoing text (post CQ:reply strip); third-person
 * statements (她22岁 / 他是男的) are R3 fact-retrieval territory and are NOT
 * blocked here — the gate requires a self-attribution anchor (我 / 自己) OR a
 * standalone short reply (len ≤ 15) of bare-attribute shape.
 *
 * Gate fire → { passed:false, reason:'persona-fabricated', replacement:'deflection' }.
 * Send-site mapping mirrors PR2 harassment — deferred `deflection` render maps
 * to `silent` kind with reasonCode 'persona-fabricated' for now.
 */

import type { SendGuard } from './send-guard-chain.js';
import { IDENTITY_DEFLECTIONS } from './identity-deflections.js';
import { stripCqReply } from './output-hard-gate.js';
import { createLogger } from './logger.js';

const logger = createLogger('persona-fabrication-guard');

/**
 * Patterns require a self-attribution anchor (我 or 自己) so third-person
 * statements like "她22岁" / "他是男的" fall through to R3 fact-retrieval.
 * Compound-word lookaheads on 男/女生 exclude 女朋友 / 男生厕所 / 宿舍 / 生组
 * etc. Address pattern requires ≥2 CJK and negative-lookahead on 这/那 so
 * "我住在这附近很久了" is NOT a fabrication claim.
 */
export const BLOCKED_SELF_ATTR_PATTERNS: readonly RegExp[] = [
  /我\s*(?:是\s*)?[女男](?:的|生|性)(?!朋友|厕所|宿舍|生组|生气|生)/,
  /我\s*\d{1,3}\s*岁/,
  /我\s*(?:身高|体重)\s*\d/,
  /我\s*住\s*(?:在\s*)?(?!这|那|在)[\u4e00-\u9fa5]{2,6}(?:市|区|县|省|里|附近)?/,
  /自己\s*(?:是\s*)?[女男](?:的|生|性)/,
];

/**
 * Standalone-short-reply: full-reply shape like "女的22岁" / "男的" where the
 * whole bot utterance is a bare attribute claim without the 我 / 自己 anchor.
 * Must be evaluated only when the full stripped reply is ≤ 15 chars — this
 * keeps the gate narrow and avoids matching embedded third-person mentions
 * ("她说她22岁了") or descriptive asides inside longer replies.
 */
const STANDALONE_SHORT_RE =
  /^\s*[女男](?:的|生|性)(?:\s*\d{1,3}\s*岁?)?\s*[。.!?~～]*\s*$/u;

export function hasSelfPersonaFabrication(text: string): boolean {
  const s = stripCqReply(text);
  if (s === '') return false;
  for (const re of BLOCKED_SELF_ATTR_PATTERNS) {
    if (re.test(s)) return true;
  }
  if (s.length <= 15 && STANDALONE_SHORT_RE.test(s)) return true;
  return false;
}

export function pickPersonaDeflection(): string {
  const pool = IDENTITY_DEFLECTIONS;
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx] ?? pool[0]!;
}

export const personaFabricationGuard: SendGuard = (text, ctx) => {
  if (!hasSelfPersonaFabrication(text)) return { passed: true, text };
  logger.info({ groupId: ctx.groupId }, 'persona-fabrication-blocked');
  return { passed: false, reason: 'persona-fabricated', replacement: 'deflection' };
};
