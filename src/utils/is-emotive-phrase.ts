import { EMOTIVE_ALLOWLIST } from './emotive-stems.js';

const EMOTIVE_EXCLAMATION_RE =
  /^(?:烦|气|累|困|哭|崩|麻|无语|烦死|气死|累死|困死|麻了|崩了)(?:了|死了|啊|呀|吧|呢|哦)?$/u;

const EMOTIVE_INTENSIFIER_RE =
  /^(?:好|真|太|最|很)(?:烦|气|累|困|无语)(?:了|死了|啊|呀|吧|呢)?$/u;

const EMOTIVE_IMPERATIVE_RE =
  /^(?:不要|别|不准|别再).{0,6}(?:烦|吵|闹|说|回|叫|发|刷)/u;

export function isEmotivePhrase(term: unknown): boolean {
  if (typeof term !== 'string') return false;
  const s = term;
  if (s.length === 0 || s.trim().length === 0) return false;
  if (EMOTIVE_ALLOWLIST.has(s)) return false;
  if (EMOTIVE_EXCLAMATION_RE.test(s)) return true;
  if (EMOTIVE_INTENSIFIER_RE.test(s)) return true;
  if (EMOTIVE_IMPERATIVE_RE.test(s)) return true;
  return false;
}
