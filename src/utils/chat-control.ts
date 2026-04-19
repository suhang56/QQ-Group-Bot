export const CHAT_SILENT_SKIP = '__CHAT_SILENT_SKIP__';
export function isChatSilentSkip(v: unknown): v is typeof CHAT_SILENT_SKIP {
  return v === CHAT_SILENT_SKIP;
}
