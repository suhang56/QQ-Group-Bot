/**
 * R6.2.2 — CQ code → human-readable pretty-print for gold-label CLI display.
 *
 * Pure transform: no I/O, no stdlib imports. Two-phase:
 *   Phase 1 — walk CQ tokens, emit per family mapping table (DEV-READY §2).
 *   Phase 2 — apply 7 HTML-entity decodes to the whole emitted string (§3);
 *             `&amp;` runs LAST so double-encoded inputs decode one layer only.
 */

const CQ_RE = /\[CQ:([a-z]+)((?:,[^,\]]+=[^,\]]*)*)\]/g;

function parseAttrs(attrStr: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!attrStr) return out;
  const parts = attrStr.split(',').filter(p => p.length > 0);
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    out.set(p.slice(0, eq), p.slice(eq + 1));
  }
  return out;
}

/** Decode entities inline on a summary value, then strip wrapping `[..]` if both present. */
function decodeSummary(raw: string): string {
  const decoded = raw
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']');
  if (decoded.length >= 2 && decoded.startsWith('[') && decoded.endsWith(']')) {
    return decoded.slice(1, -1);
  }
  return decoded;
}

function renderOne(family: string, attrs: Map<string, string>, botQQ: string | null): string {
  switch (family) {
    case 'at': {
      const qq = attrs.get('qq') ?? '';
      if (qq === 'all') return '[@全体]';
      if (botQQ !== null && qq === botQQ) return '[@bot]';
      return `[@user:${qq}]`;
    }
    case 'image': {
      const s = attrs.get('summary');
      if (s === undefined) return '[img]';
      const decoded = decodeSummary(s);
      return decoded.length > 0 ? `[img:${decoded}]` : '[img]';
    }
    case 'mface': {
      const s = attrs.get('summary');
      if (s === undefined) return '[mface]';
      const decoded = decodeSummary(s);
      return decoded.length > 0 ? `[mface:${decoded}]` : '[mface]';
    }
    case 'face': {
      const id = attrs.get('id');
      return id !== undefined && id.length > 0 ? `[face:${id}]` : '[face]';
    }
    case 'reply': {
      const id = attrs.get('id');
      return id !== undefined && id.length > 0 ? `[reply:${id}]` : '[reply]';
    }
    case 'video':
      return '[video]';
    case 'record':
      return '[voice]';
    default:
      return `[cq:${family}]`;
  }
}

/** Phase 2: 7 entity decodes applied in order. `&amp;` LAST to prevent recursive decode. */
function entityDecode(s: string): string {
  return s
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * Rewrite CQ tokens in `rawContent` to compact human-readable forms, then
 * apply phase-2 entity decode on the full result. `botQQ=null` never coerces
 * any @-mention to `[@bot]`.
 */
export function prettyPrintCq(rawContent: string, botQQ: string | null): string {
  if (rawContent.length === 0) return '';
  CQ_RE.lastIndex = 0;
  const phase1 = rawContent.replace(CQ_RE, (_m, family: string, attrStr: string) => {
    const attrs = parseAttrs(attrStr);
    return renderOne(family, attrs, botQQ);
  });
  return entityDecode(phase1);
}
