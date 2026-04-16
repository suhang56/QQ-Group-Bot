/**
 * Jargon Provider: reads confirmed jargon from jargon_candidates table
 * and provides them as { term, explanation }[] for injection into the
 * identity core's slang dictionary section.
 */

import type { DatabaseSync } from 'node:sqlite';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('jargon-provider');

export interface JargonEntry {
  readonly term: string;
  readonly explanation: string;
}

interface JargonRow {
  content: string;
  meaning: string | null;
  count: number;
}

/**
 * Load confirmed jargon entries (is_jargon = 1 with a non-null meaning)
 * for a given group. Returns newest-by-count first, capped at `limit`.
 */
export function loadGroupJargon(
  rawDb: DatabaseSync,
  groupId: string,
  limit = 30,
): ReadonlyArray<JargonEntry> {
  let rows: JargonRow[];
  try {
    rows = rawDb.prepare(
      `SELECT content, meaning, count FROM jargon_candidates
       WHERE group_id = ? AND is_jargon = 1 AND meaning IS NOT NULL
       ORDER BY count DESC LIMIT ?`
    ).all(groupId, limit) as unknown as JargonRow[];
  } catch (err) {
    logger.warn({ err, groupId }, 'Failed to query jargon_candidates');
    return [];
  }

  return rows.map(r => ({
    term: r.content,
    explanation: r.meaning!,
  }));
}

/**
 * Format jargon entries into a markdown block suitable for injection
 * into the identity core / system prompt. Returns empty string if no jargon.
 */
export function formatJargonBlock(entries: ReadonlyArray<JargonEntry>): string {
  if (entries.length === 0) return '';
  const lines = entries.map(e => `- **${e.term}**: ${e.explanation}`);
  return `\n\n## 群里的黑话/梗（来自群聊学习）\n${lines.join('\n')}`;
}
