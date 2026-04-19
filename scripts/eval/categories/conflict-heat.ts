import type { DbMessageRow, ContextMsg } from '../types.js';

const CONFLICT_RE =
  /滚|傻|蠢|笨|垃圾|废物|白痴|脑残|你去死|草你|卧槽|fuck|shit|nmsl|sb|nb|cnm|妈的|干你|操你/i;

export function isConflictHeat(
  row: DbMessageRow,
  context: ContextMsg[],
): boolean {
  const combined = [
    row.content,
    ...context.map(c => c.content),
  ].join(' ');
  return CONFLICT_RE.test(combined);
}
