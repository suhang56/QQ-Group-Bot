/**
 * PR4: Shared pool for identity-probe and persona-fabrication deflections.
 *
 * Extracted to break the chat → send-guard-chain → persona-fabrication-guard → chat
 * cycle. chat.ts re-exports this const so existing `import { IDENTITY_DEFLECTIONS }
 * from '../modules/chat'` sites keep working without drift.
 */

export const IDENTITY_DEFLECTIONS: readonly string[] = [
  '啊？', '什么', '？？', '?', '啧',
  '问这个干嘛', '别研究这个', '自己猜', '不告诉你',
] as const;
