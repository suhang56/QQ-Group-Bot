/**
 * R2.5.1 Item 3 — annoyed-template-family consecutive cooldown.
 *
 * Distinct from R2.5 SF2 (which checks EMOTIVE_RE stems). This guard
 * recognizes a narrow family of "annoyed template" utterances — the exact
 * flavor of reply the bot leaks when it over-commits to 傲娇/annoyed voice
 * and then repeats variants across consecutive turns:
 *   烦死了 / 想屁吃呢 / 爱谁记谁记 / 你们别烦我 / 又来了 /
 *   你烦不烦 / 你复读机 / 爱谁记谁 / 想屁吃
 *
 * Fire condition: the current candidate contains any family token AND at
 * least 2 of the last 3 bot outputs also contained one. This is the
 * "consecutive escalation" gate — single-use is tsundere voice (legitimate),
 * but stacked uses snowball into empathy-echo loops.
 */

export const ANNOYED_TEMPLATE_FAMILY: readonly string[] = [
  '烦死了',
  '想屁吃呢',
  '爱谁记谁记',
  '你们别烦我',
  '又来了',
  '你烦不烦',
  '你复读机',
  '爱谁记谁',
  '想屁吃',
];

interface BotOutputLike {
  readonly text: string;
}

function _containsFamilyToken(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  for (const tok of ANNOYED_TEMPLATE_FAMILY) {
    if (text.includes(tok)) return true;
  }
  return false;
}

/**
 * True iff candidate contains a family token AND ≥2 of last-3 bot outputs
 * also contain one. Pure; inspects only the final 3 entries of `recentBotOutputs`.
 */
export function isAnnoyedTemplateConsecutive(
  candidate: string,
  recentBotOutputs: ReadonlyArray<BotOutputLike>,
): boolean {
  if (!_containsFamilyToken(candidate)) return false;
  const last3 = recentBotOutputs.slice(-3);
  if (last3.length < 2) return false;
  let matches = 0;
  for (const entry of last3) {
    if (_containsFamilyToken(entry.text)) matches++;
  }
  return matches >= 2;
}
