/**
 * Repository implementations for meme_graph and phrase_candidates tables.
 * Extracted to separate file for clarity and testability.
 */

import { DatabaseSync } from 'node:sqlite';
import type { MemeGraphEntry, IMemeGraphRepo, PhraseCandidateRow, IPhraseCandidatesRepo } from './db.js';
import { cosineSimilarity } from './embeddings.js';

// ---- Row mappers ----

function memeGraphFromRow(row: {
  id: number; group_id: string; canonical: string; variants: string;
  meaning: string; origin_event: string | null; origin_msg_id: string | null;
  origin_user_id: string | null; origin_ts: number | null;
  first_seen_count: number; total_count: number; confidence: number;
  status: string; embedding_vec: Buffer | null; created_at: number; updated_at: number;
}): MemeGraphEntry {
  let variants: string[] = [];
  try {
    variants = JSON.parse(row.variants);
  } catch { /* malformed JSON, default to empty */ }

  let embeddingVec: number[] | null = null;
  if (row.embedding_vec) {
    try {
      const vec = JSON.parse(row.embedding_vec.toString('utf8'));
      embeddingVec = Array.isArray(vec) ? vec : null;
    } catch { /* malformed embedding */ }
  }

  return {
    id: row.id,
    groupId: row.group_id,
    canonical: row.canonical,
    variants,
    meaning: row.meaning,
    originEvent: row.origin_event,
    originMsgId: row.origin_msg_id,
    originUserId: row.origin_user_id,
    originTs: row.origin_ts,
    firstSeenCount: row.first_seen_count,
    totalCount: row.total_count,
    confidence: row.confidence,
    status: row.status as 'active' | 'demoted' | 'manual_edit',
    embeddingVec,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function phraseCandidateFromRow(row: {
  group_id: string; content: string; gram_len: number; count: number;
  contexts: string; last_inference_count: number; meaning: string | null;
  is_jargon: number; promoted: number; created_at: number; updated_at: number;
}): PhraseCandidateRow {
  let contexts: string[] = [];
  try {
    contexts = JSON.parse(row.contexts);
  } catch { /* malformed JSON */ }

  return {
    groupId: row.group_id,
    content: row.content,
    gramLen: row.gram_len,
    count: row.count,
    contexts,
    lastInferenceCount: row.last_inference_count,
    meaning: row.meaning,
    isJargon: row.is_jargon,
    promoted: row.promoted,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---- MemeGraphRepository ----

export class MemeGraphRepository implements IMemeGraphRepo {
  constructor(private db: DatabaseSync) {}

  insert(entry: Omit<MemeGraphEntry, 'id'>): number {
    const result = this.db.prepare(`
      INSERT INTO meme_graph
        (group_id, canonical, variants, meaning, origin_event, origin_msg_id,
         origin_user_id, origin_ts, first_seen_count, total_count, confidence,
         status, embedding_vec, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.groupId,
      entry.canonical,
      JSON.stringify(entry.variants),
      entry.meaning,
      entry.originEvent ?? null,
      entry.originMsgId ?? null,
      entry.originUserId ?? null,
      entry.originTs ?? null,
      entry.firstSeenCount,
      entry.totalCount,
      entry.confidence,
      entry.status,
      entry.embeddingVec ? JSON.stringify(entry.embeddingVec) : null,
      entry.createdAt,
      entry.updatedAt,
    ) as { lastInsertRowid: number };
    return Number(result.lastInsertRowid);
  }

  update(id: number, fields: Partial<Pick<MemeGraphEntry,
    'variants' | 'meaning' | 'originEvent' | 'originMsgId' |
    'originUserId' | 'originTs' | 'totalCount' | 'confidence' |
    'status' | 'embeddingVec'>>): void {
    // Check if entry exists and if status is manual_edit (which freezes canonical + meaning)
    const current = this.db.prepare('SELECT status FROM meme_graph WHERE id = ?').get(id) as
      { status: string } | undefined;

    if (!current) return; // entry doesn't exist, silent no-op

    if (current.status === 'manual_edit') {
      // manual_edit freezes canonical + meaning, but allows variants, total_count, and other mutable fields
      // Filter out any attempts to change meaning
      const filtered = { ...fields };
      delete filtered.meaning;
      if (Object.keys(filtered).length === 0) return; // nothing else to update
      fields = filtered;
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (fields.variants !== undefined) {
      updates.push('variants = ?');
      values.push(JSON.stringify(fields.variants));
    }
    if (fields.meaning !== undefined && current.status !== 'manual_edit') {
      updates.push('meaning = ?');
      values.push(fields.meaning);
    }
    if (fields.originEvent !== undefined) {
      updates.push('origin_event = ?');
      values.push(fields.originEvent ?? null);
    }
    if (fields.originMsgId !== undefined) {
      updates.push('origin_msg_id = ?');
      values.push(fields.originMsgId ?? null);
    }
    if (fields.originUserId !== undefined) {
      updates.push('origin_user_id = ?');
      values.push(fields.originUserId ?? null);
    }
    if (fields.originTs !== undefined) {
      updates.push('origin_ts = ?');
      values.push(fields.originTs ?? null);
    }
    if (fields.totalCount !== undefined) {
      updates.push('total_count = ?');
      values.push(fields.totalCount);
    }
    if (fields.confidence !== undefined) {
      updates.push('confidence = ?');
      values.push(fields.confidence);
    }
    if (fields.status !== undefined) {
      updates.push('status = ?');
      values.push(fields.status);
    }
    if (fields.embeddingVec !== undefined) {
      updates.push('embedding_vec = ?');
      values.push(fields.embeddingVec ? JSON.stringify(fields.embeddingVec) : null);
    }

    if (updates.length === 0) return; // nothing to update

    updates.push('updated_at = ?');
    values.push(Math.floor(Date.now() / 1000));
    values.push(id);

    const sql = `UPDATE meme_graph SET ${updates.join(', ')} WHERE id = ?`;
    (this.db.prepare(sql) as unknown as { run(...args: unknown[]): void }).run(...values);
  }

  findByCanonical(groupId: string, canonical: string): MemeGraphEntry | null {
    const row = this.db.prepare(
      'SELECT * FROM meme_graph WHERE group_id = ? AND canonical = ?'
    ).get(groupId, canonical) as unknown;
    if (!row) return null;
    return memeGraphFromRow(row as Parameters<typeof memeGraphFromRow>[0]);
  }

  findByVariant(groupId: string, term: string): MemeGraphEntry[] {
    const rows = this.db.prepare(
      `SELECT * FROM meme_graph WHERE group_id = ? AND (
        canonical LIKE ? OR variants LIKE ?
      )`
    ).all(groupId, `%${term}%`, `%${term}%`) as unknown[];

    return rows
      .map(r => memeGraphFromRow(r as Parameters<typeof memeGraphFromRow>[0]))
      .filter(entry => {
        // Double-check: canonical or any variant contains the term
        if (entry.canonical.includes(term)) return true;
        for (const variant of entry.variants) {
          if (variant.includes(term)) return true;
        }
        return false;
      });
  }

  listActive(groupId: string, limit: number): MemeGraphEntry[] {
    const rows = this.db.prepare(
      `SELECT * FROM meme_graph WHERE group_id = ? AND status IN ('active', 'manual_edit')
       ORDER BY updated_at DESC LIMIT ?`
    ).all(groupId, limit) as unknown[];
    return rows.map(r => memeGraphFromRow(r as Parameters<typeof memeGraphFromRow>[0]));
  }

  findSimilarActive(
    groupId: string,
    queryEmbedding: number[],
    threshold: number,
    limit: number,
  ): MemeGraphEntry[] {
    const candidates = this.listActiveWithEmbeddings(groupId);
    const scored: Array<{ entry: MemeGraphEntry; sim: number }> = [];
    for (const entry of candidates) {
      if (!entry.embeddingVec) continue;
      const sim = cosineSimilarity(queryEmbedding, entry.embeddingVec);
      if (sim >= threshold) {
        scored.push({ entry, sim });
      }
    }
    scored.sort((a, b) => b.sim - a.sim);
    return scored.slice(0, limit).map(s => s.entry);
  }

  listActiveWithEmbeddings(groupId: string): MemeGraphEntry[] {
    const rows = this.db.prepare(
      `SELECT * FROM meme_graph WHERE group_id = ? AND status IN ('active', 'manual_edit')
       AND embedding_vec IS NOT NULL ORDER BY updated_at DESC`
    ).all(groupId) as unknown[];
    return rows.map(r => memeGraphFromRow(r as Parameters<typeof memeGraphFromRow>[0]));
  }

  listNullEmbedding(groupId: string, limit: number): MemeGraphEntry[] {
    const rows = this.db.prepare(
      `SELECT * FROM meme_graph WHERE group_id = ? AND embedding_vec IS NULL
       ORDER BY updated_at DESC LIMIT ?`
    ).all(groupId, limit) as unknown[];
    return rows.map(r => memeGraphFromRow(r as Parameters<typeof memeGraphFromRow>[0]));
  }

  findById(id: number): MemeGraphEntry | null {
    const row = this.db.prepare('SELECT * FROM meme_graph WHERE id = ?').get(id) as unknown;
    if (!row) return null;
    return memeGraphFromRow(row as Parameters<typeof memeGraphFromRow>[0]);
  }

  adminEdit(id: number, fields: Partial<Pick<MemeGraphEntry,
    'canonical' | 'variants' | 'meaning' | 'status'>>): void {
    const updates: string[] = [];
    const values: unknown[] = [];

    if (fields.canonical !== undefined) {
      updates.push('canonical = ?');
      values.push(fields.canonical);
    }
    if (fields.variants !== undefined) {
      updates.push('variants = ?');
      values.push(JSON.stringify(fields.variants));
    }
    if (fields.meaning !== undefined) {
      updates.push('meaning = ?');
      values.push(fields.meaning);
    }

    // Always set status to 'manual_edit' when admin edits
    updates.push('status = ?');
    values.push('manual_edit');

    updates.push('updated_at = ?');
    values.push(Math.floor(Date.now() / 1000));
    values.push(id);

    const sql = `UPDATE meme_graph SET ${updates.join(', ')} WHERE id = ?`;
    (this.db.prepare(sql) as unknown as { run(...args: unknown[]): void }).run(...values);
  }
}

// ---- PhraseCandidatesRepository ----

export class PhraseCandidatesRepository implements IPhraseCandidatesRepo {
  constructor(private db: DatabaseSync) {}

  upsert(groupId: string, content: string, gramLen: number,
         context: string, nowSec: number): void {
    const existing = this.db.prepare(
      'SELECT contexts, count FROM phrase_candidates WHERE group_id = ? AND content = ? AND gram_len = ?'
    ).get(groupId, content, gramLen) as { contexts: string; count: number } | undefined;

    if (existing) {
      let contexts: string[];
      try {
        contexts = JSON.parse(existing.contexts);
      } catch {
        contexts = [];
      }

      // Cap contexts at 10, drop oldest
      const MAX_CONTEXTS = 10;
      if (contexts.length >= MAX_CONTEXTS) {
        contexts = contexts.slice(contexts.length - MAX_CONTEXTS + 1);
      }
      contexts.push(context);

      this.db.prepare(
        `UPDATE phrase_candidates SET count = count + 1, contexts = ?, updated_at = ?
         WHERE group_id = ? AND content = ? AND gram_len = ?`
      ).run(JSON.stringify(contexts), nowSec, groupId, content, gramLen);
    } else {
      this.db.prepare(
        `INSERT INTO phrase_candidates
          (group_id, content, gram_len, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, 0, NULL, 0, 0, ?, ?)`
      ).run(groupId, content, gramLen, JSON.stringify([context]), nowSec, nowSec);
    }
  }

  findAtThreshold(groupId: string, thresholds: number[],
                  limit: number): PhraseCandidateRow[] {
    const placeholders = thresholds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT * FROM phrase_candidates
      WHERE group_id = ? AND count IN (${placeholders})
        AND count > last_inference_count
      ORDER BY count DESC
      LIMIT ?
    `).all(groupId, ...thresholds, limit) as unknown[];

    return rows.map(r => phraseCandidateFromRow(r as Parameters<typeof phraseCandidateFromRow>[0]));
  }

  updateInference(groupId: string, content: string,
                  meaning: string | null, isJargon: boolean,
                  count: number, nowSec: number): void {
    this.db.prepare(
      `UPDATE phrase_candidates
       SET meaning = ?, is_jargon = ?, last_inference_count = ?, updated_at = ?
       WHERE group_id = ? AND content = ?`
    ).run(meaning, isJargon ? 1 : 0, count, nowSec, groupId, content);
  }

  listUnpromoted(groupId: string): PhraseCandidateRow[] {
    const rows = this.db.prepare(
      `SELECT * FROM phrase_candidates
       WHERE group_id = ? AND is_jargon = 1 AND promoted = 0
       ORDER BY count DESC`
    ).all(groupId) as unknown[];

    return rows.map(r => phraseCandidateFromRow(r as Parameters<typeof phraseCandidateFromRow>[0]));
  }

  markPromoted(groupId: string, content: string, gramLen: number, nowSec: number): void {
    this.db.prepare(
      `UPDATE phrase_candidates
       SET promoted = 1, updated_at = ?
       WHERE group_id = ? AND content = ? AND gram_len = ?`
    ).run(nowSec, groupId, content, gramLen);
  }
}
