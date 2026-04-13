import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const faceMap = require('../data/qq-faces.json') as Record<string, string>;

export interface QQFace {
  id: number;
  name: string;
}

// Pre-built list sorted by id for deterministic order
const _faceList: QQFace[] = Object.entries(faceMap)
  .map(([id, name]) => ({ id: Number(id), name }))
  .sort((a, b) => a.id - b.id);

/** All known QQ face entries. */
export function faceList(): QQFace[] {
  return _faceList;
}

/** Extract face ids present in a raw CQ-encoded message. */
export function parseFaces(rawContent: string): number[] {
  const ids: number[] = [];
  for (const match of rawContent.matchAll(/\[CQ:face,id=(\d+)[^\]]*\]/g)) {
    ids.push(Number(match[1]));
  }
  return ids;
}

/** Render a face as a CQ code for outgoing messages. */
export function renderFace(id: number): string {
  return `[CQ:face,id=${id}]`;
}

/**
 * The 40 most contextually useful faces for chat replies.
 * Intentionally curated — not the full 300+ list.
 * Format: "[id]name" per entry, space-separated.
 * Keep total length ≤ 2KB for prompt cache budget.
 *
 * TODO (Phase 2): add custom 表情包/marketface support sourced from group history
 */
export const FACE_LEGEND = [
  [14, '微笑'], [178, '斜眼笑'], [13, '呲牙'], [21, '可爱'], [20, '偷笑'],
  [5, '流泪'], [9, '大哭'], [4, '得意'], [6, '害羞'], [16, '酷'],
  [100, '坏笑'], [108, '亲亲'], [281, '笑哭'], [277, '亲亲'], [305, '好的'],
  [82, '点赞'], [88, '差劲'], [198, '摊手'], [199, '捂脸'], [200, '机智'],
  [195, '笑哭'], [196, 'doge'], [285, '思考'], [105, '委屈'], [11, '发怒'],
  [219, '生气'], [34, '晕'], [103, '哈欠'], [25, '困'], [50, '献吻'],
  [83, '握手'], [84, '胜利'], [89, '爱你'], [252, '加油'], [91, 'OK'],
  [30, '奋斗'], [183, '点头'], [184, '摇头'], [98, '抱抱'], [22, '白眼'],
].map(([id, name]) => `[${id}]${name}`).join(' ');
