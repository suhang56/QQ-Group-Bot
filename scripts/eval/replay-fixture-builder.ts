/**
 * R6.3 — Translate a SampledRow from the R6.1 benchmark into the
 * (groupId, triggerMessage, recentMessages) triple that
 * `ChatModule.generateReply(groupId, triggerMessage, recentMessages)` expects.
 *
 * See DEV-READY §5 for drift notes (role defaulted to 'member',
 * recentMessages.rawContent = content).
 */

import type { GroupMessage } from '../../src/adapter/napcat.js';
import type { SampledRow } from './types.js';

export interface ReplayFixture {
  groupId: string;
  triggerMessage: GroupMessage;
  recentMessages: GroupMessage[];
}

export function buildTriggerFromBenchmark(
  row: SampledRow,
  groupIdForReplay: string,
): ReplayFixture {
  const triggerMessage: GroupMessage = {
    messageId: row.sourceMessageId ?? String(row.messageId),
    groupId: groupIdForReplay,
    userId: row.userId,
    nickname: row.nickname,
    role: 'member',
    content: row.content,
    rawContent: row.rawContent ?? row.content,
    timestamp: row.timestamp,
  };
  const recentMessages: GroupMessage[] = row.triggerContext.map(cm => ({
    messageId: String(cm.id),
    groupId: groupIdForReplay,
    userId: cm.userId,
    nickname: cm.nickname,
    role: 'member',
    content: cm.content,
    rawContent: cm.content,
    timestamp: cm.timestamp,
  }));
  return { groupId: groupIdForReplay, triggerMessage, recentMessages };
}
