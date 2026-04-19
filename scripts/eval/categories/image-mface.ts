import type { DbMessageRow } from '../types.js';

const IMAGE_CQ_RE = /\[CQ:(?:image|mface|face)[^\]]*\]/;

export function isImageMface(row: DbMessageRow): boolean {
  const raw = row.raw_content ?? row.content;
  return IMAGE_CQ_RE.test(raw);
}
