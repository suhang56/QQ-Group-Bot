/** @deprecated Replaced by ChatResult discriminated union (kind: 'silent'). Remove after P1 is merged. */
export const CHAT_SILENT_SKIP = '__CHAT_SILENT_SKIP__';
/** @deprecated */
export function isChatSilentSkip(v: unknown): v is typeof CHAT_SILENT_SKIP {
  return v === CHAT_SILENT_SKIP;
}
