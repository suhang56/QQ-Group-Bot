/**
 * R6: Persona fabrication guard — canon-aware self-attribution gate.
 *
 * Bot's BANGDREAM_PERSONA canon (chat.ts:499-505): gender=女, age=22,
 * residence=西雅图/Seattle. Statements that match canon PASS; statements
 * that contradict canon BLOCK. Fields with no canon (height/weight)
 * continue to block any specific digit. Likes are an open list and are
 * never checked.
 *
 * Third-person (她22岁 / 他是男的) is R3 fact-retrieval territory — gate
 * requires 我/自己 anchor or a standalone short reply (len ≤ 15) of bare
 * gender (+ optional age) shape.
 *
 * Gate fire → { passed:false, reason:'persona-fabricated', replacement:'deflection' }.
 */

import type { SendGuard } from './send-guard-chain.js';
import { IDENTITY_DEFLECTIONS } from './identity-deflections.js';
import { stripCqReply } from './output-hard-gate.js';
import { createLogger } from './logger.js';

const logger = createLogger('persona-fabrication-guard');

/**
 * Canon source: src/modules/chat.ts:499-505 (BANGDREAM_PERSONA).
 * - gender / age / residence canon are checked
 * - height / weight have no canon → any specific digit blocks
 * - likes are open per user directive → never checked here
 * residence list is lowercase-normalized; comparison is case-insensitive
 * bidirectional substring (西雅图市 ⊇ 西雅图 → match; SEATTLE → seattle → match).
 */
const PERSONA_CANON = {
  gender: '女',
  age: 22,
  residence: ['西雅图', 'seattle'] as const,
} as const;

// Gender: 我/自己 + 是? + [男女] + (的|生|性), with compound-word lookahead so
// 女朋友 / 男生厕所 / 宿舍 / 生组 / 生气 etc don't fire.
const GENDER_RE =
  /(?:我|自己)\s*(?:是\s*)?([男女])(?:的|生|性)(?!朋友|厕所|宿舍|生组|生气|生)/u;

// Age: 我 + (是)? + \d{1,3} + 岁  — requires 岁 unit so 我22号去看演出 is safe.
const AGE_RE = /我\s*(?:是\s*)?(\d{1,3})\s*岁/u;

// Height / weight — no canon, anchored 我 + 身高|体重 + digit always blocks.
const METRIC_RE = /我\s*(?:身高|体重)\s*\d/u;

// Residence: 我 + (住|在) + (在)? + (NOT 这|那|在) + 2-15 char place.
const RESIDENCE_RE =
  /我\s*(?:住|在)\s*(?:在\s*)?(?!这|那|在)([一-龥a-zA-Z][一-龥a-zA-Z\s]{1,14})/u;

// Standalone short reply (whole-utterance, len ≤ 15): bare [男女] + opt
// (的|生|性) + opt digits + 岁 + opt punct. Falls through if canon-matching.
const STANDALONE_SHORT_RE =
  /^\s*([男女])(?:的|生|性)?\s*(?:(\d{1,3})\s*岁?)?\s*[。.!?~～]*\s*$/u;

function residenceMatchesCanon(place: string): boolean {
  const p = place.trim().toLowerCase();
  if (p === '') return false;
  for (const c of PERSONA_CANON.residence) {
    if (p.includes(c) || c.includes(p)) return true;
  }
  return false;
}

export function hasSelfPersonaFabrication(text: string): boolean {
  const s = stripCqReply(text);
  if (s === '') return false;

  // 1. Gender (anchored 我/自己) — block if captured ≠ canon.
  const gm = s.match(GENDER_RE);
  if (gm && gm[1] !== PERSONA_CANON.gender) return true;

  // 2. Age (我 anchored) — block if parsed ≠ canon.
  const am = s.match(AGE_RE);
  if (am) {
    const age = parseInt(am[1]!, 10);
    if (age !== PERSONA_CANON.age) return true;
  }

  // 3. Height / weight — always block any digit.
  if (METRIC_RE.test(s)) return true;

  // 4. Residence (anchored 我 + 住|在) — block if captured place not in canon.
  const rm = s.match(RESIDENCE_RE);
  if (rm) {
    if (!residenceMatchesCanon(rm[1]!)) return true;
  }

  // 5. Standalone short reply — bare [男女](+ opt age) — block if non-canon.
  if (s.length <= 15) {
    const sm = s.match(STANDALONE_SHORT_RE);
    if (sm) {
      const gender = sm[1]!;
      const ageStr = sm[2];
      if (gender !== PERSONA_CANON.gender) return true;
      if (ageStr !== undefined) {
        const age = parseInt(ageStr, 10);
        if (age !== PERSONA_CANON.age) return true;
      }
    }
  }

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
