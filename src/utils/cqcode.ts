const AT_REGEX = /\[CQ:at,qq=(\d+)[^\]]*\]/g;

/** Extract all QQ UIDs from CQ:at codes in a raw message string. */
export function parseAtMentions(raw: string): string[] {
  const uids: string[] = [];
  let m: RegExpExecArray | null;
  AT_REGEX.lastIndex = 0;
  while ((m = AT_REGEX.exec(raw)) !== null) {
    uids.push(m[1]!);
  }
  return uids;
}

/**
 * Resolve the @-target UID from a command invocation.
 * Checks CQ:at codes in rawContent first (QQ sends @-mentions as CQ codes,
 * not plain text), then falls back to a plain numeric UID in the args array.
 * Returns null if neither is present.
 */
export function resolveAtTarget(rawContent: string, args: string[]): string | null {
  const fromCQ = parseAtMentions(rawContent);
  if (fromCQ.length > 0) return fromCQ[0]!;

  // Fallback: plain numeric UID typed by the user (e.g. /mimic_on 1301931012)
  const plainUid = args.find(a => /^\d+$/.test(a));
  if (plainUid) return plainUid;

  // Legacy: @-prefixed text (e.g. /mimic_on @1301931012)
  const atArg = args.find(a => a.startsWith('@'));
  if (atArg) return atArg.slice(1);

  return null;
}
