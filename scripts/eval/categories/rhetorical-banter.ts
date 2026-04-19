import type { DbMessageRow } from '../types.js';

const BANTER_RE =
  /[？?!！]{2,}|哈{3,}|哦{3,}|嗯{3,}|好吧|果然|确实|真的|不是吧|居然|怎么可能|行吧|随便|无语|hhh|233|哈哈/;

const QUESTION_RE = /[？?]|什么|为什么|怎么|咋|有没有|可以吗|对吗|是吗/;

export function isRhetoricalBanter(row: DbMessageRow): boolean {
  const c = row.content.replace(/\[CQ:[^\]]*\]/g, '').trim();
  if (c.length === 0 || c.length > 60) return false;
  return BANTER_RE.test(c) || (QUESTION_RE.test(c) && c.length <= 20);
}
