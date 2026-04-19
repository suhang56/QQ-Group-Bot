import type { DbMessageRow, ContextMsg } from '../types.js';

const BOT_STATUS_RE = /禁言|策略|机器人|bot|关了|开了|休眠|屏蔽|封禁|管理员/i;

export function isBotStatusContext(
  row: DbMessageRow,
  context: ContextMsg[],
): boolean {
  const combined = [
    row.content,
    ...context.map(c => c.content),
  ].join(' ');
  return BOT_STATUS_RE.test(combined);
}
