/**
 * Integration test: meme pipeline end-to-end.
 *
 * Seeds jargon/phrase candidates -> clusterer cycle -> asserts meme_graph
 * has expected canonical + variants + meaning + origin_event.
 *
 * Uses real DatabaseSync (in-memory SQLite) with mocked LLM.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MemeClusterer } from '../../src/modules/meme-clusterer.js';
import { MemeGraphRepository, PhraseCandidatesRepository } from '../../src/storage/meme-repos.js';
import type { IClaudeClient } from '../../src/ai/claude.js';
import type { Logger } from 'pino';

const silentLogger = {
  warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(),
} as unknown as Logger;

const NOW = 1700000000000;
const NOW_SEC = 1700000000;

function makeClaude(): IClaudeClient {
  return {
    complete: vi.fn().mockImplementation(async (opts: { messages: Array<{ content: string }> }) => {
      const userMsg = opts.messages[0]?.content ?? '';
      // Origin event extraction
      if (userMsg.includes('起源')) {
        return {
          text: JSON.stringify({ origin_event: 'U1 started using it on 2023-11-14 as a joke', origin_user: null }),
          inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
        };
      }
      return {
        text: '{}',
        inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
      };
    }),
  } as unknown as IClaudeClient;
}

describe('Meme Pipeline Integration', () => {
  let db: DatabaseSync;
  let memeGraph: MemeGraphRepository;
  let phraseCandidates: PhraseCandidatesRepository;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA journal_mode = WAL;');

    const schemaPath = fileURLToPath(new URL('../../src/storage/schema.sql', import.meta.url));
    const sql = readFileSync(schemaPath, 'utf8');
    db.exec(sql);

    memeGraph = new MemeGraphRepository(db);
    phraseCandidates = new PhraseCandidatesRepository(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it('end-to-end: seeded jargon candidate -> clusterer -> graph entry with origin', async () => {
    const ts = NOW_SEC;
    db.prepare(`
      INSERT INTO jargon_candidates
        (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('g1', 'testmeme', 10, JSON.stringify(['User says testmeme', 'Another testmeme usage']),
           10, 'group-specific slang meaning', 1, 0, ts, ts);

    const clusterer = new MemeClusterer({
      db,
      memeGraph,
      phraseCandidates,
      claude: makeClaude(),
      logger: silentLogger,
      now: () => NOW,
    });

    await clusterer.clusterAll('g1');

    const entries = memeGraph.listActive('g1', 10);
    expect(entries).toHaveLength(1);

    const entry = entries[0]!;
    expect(entry.canonical).toBe('testmeme');
    expect(entry.variants).toContain('testmeme');
    expect(entry.meaning).toBe('group-specific slang meaning');
    expect(entry.totalCount).toBe(10);
    expect(entry.confidence).toBeGreaterThan(0);
    expect(entry.status).toBe('active');

    // Verify candidate was marked promoted
    const jargonRow = db.prepare(
      'SELECT promoted FROM jargon_candidates WHERE group_id = ? AND content = ?'
    ).get('g1', 'testmeme') as { promoted: number };
    expect(jargonRow.promoted).toBe(1);
  });

  it('new entries include canonical in variants array', async () => {
    const ts = NOW_SEC;
    db.prepare(`
      INSERT INTO jargon_candidates
        (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('g1', 'hyw', 5, '["ctx"]', 5, 'hello slang', 1, 0, ts, ts);

    const clusterer = new MemeClusterer({
      db,
      memeGraph,
      phraseCandidates,
      claude: makeClaude(),
      logger: silentLogger,
      now: () => NOW,
      maxOriginInferPerCycle: 0,
    });

    await clusterer.clusterAll('g1');

    const entries = memeGraph.listActive('g1', 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.canonical).toBe('hyw');
    expect(entries[0]!.variants).toContain('hyw');
    expect(entries[0]!.variants).toHaveLength(1);
  });

  it('variant aggregation: multiple candidates cluster into one entry', async () => {
    const ts = NOW_SEC;
    db.prepare(`
      INSERT INTO jargon_candidates
        (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('g1', 'hyw', 5, '["ctx"]', 5, 'hello slang', 1, 0, ts, ts);

    const clusterer = new MemeClusterer({
      db,
      memeGraph,
      phraseCandidates,
      claude: makeClaude(),
      logger: silentLogger,
      now: () => NOW,
      maxOriginInferPerCycle: 0,
    });

    // Run once: creates graph entry for 'hyw'
    await clusterer.clusterAll('g1');

    let entries = memeGraph.listActive('g1', 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.canonical).toBe('hyw');

    // Now add a variant candidate (substring match: 'mmhyw' contains 'hyw')
    db.prepare(`
      INSERT INTO jargon_candidates
        (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('g1', 'mmhyw', 3, '["ctx"]', 3, 'mama hello slang', 1, 0, ts, ts);

    // Run again: should merge 'mmhyw' into existing 'hyw' entry
    await clusterer.clusterAll('g1');

    entries = memeGraph.listActive('g1', 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.variants).toContain('hyw');
    expect(entries[0]!.variants).toContain('mmhyw');
    expect(entries[0]!.totalCount).toBeGreaterThan(5);
  });

  it('manual_edit entries: meaning is not overwritten by clusterer', async () => {
    const ts = NOW_SEC;

    const entryId = memeGraph.insert({
      groupId: 'g1',
      canonical: 'hyw',
      variants: ['hyw'],
      meaning: 'admin-curated meaning',
      originEvent: null,
      originMsgId: null,
      originUserId: null,
      originTs: null,
      firstSeenCount: 5,
      totalCount: 5,
      confidence: 0.8,
      status: 'active',
      embeddingVec: null,
      createdAt: ts,
      updatedAt: ts,
    });
    memeGraph.adminEdit(entryId, { meaning: 'admin-curated meaning' });

    // Add a candidate that substring-matches 'hyw'
    db.prepare(`
      INSERT INTO jargon_candidates
        (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('g1', 'mmhyw', 3, '["ctx"]', 3, 'different meaning', 1, 0, ts, ts);

    const clusterer = new MemeClusterer({
      db,
      memeGraph,
      phraseCandidates,
      claude: makeClaude(),
      logger: silentLogger,
      now: () => NOW,
      maxOriginInferPerCycle: 0,
    });

    await clusterer.clusterAll('g1');

    const entry = memeGraph.findById(entryId)!;
    expect(entry.meaning).toBe('admin-curated meaning');
    expect(entry.status).toBe('manual_edit');
    expect(entry.variants).toContain('mmhyw');
  });

  it('phrase candidates are processed alongside jargon candidates', async () => {
    const ts = NOW_SEC;

    phraseCandidates.upsert('g1', 'test phrase', 3, 'ctx1', ts);
    db.prepare(
      'UPDATE phrase_candidates SET is_jargon = 1, count = 5, meaning = ? WHERE group_id = ? AND content = ?'
    ).run('a phrase meaning', 'g1', 'test phrase');

    const clusterer = new MemeClusterer({
      db,
      memeGraph,
      phraseCandidates,
      claude: makeClaude(),
      logger: silentLogger,
      now: () => NOW,
      maxOriginInferPerCycle: 0,
    });

    await clusterer.clusterAll('g1');

    const entries = memeGraph.listActive('g1', 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.canonical).toBe('test phrase');
    expect(entries[0]!.meaning).toBe('a phrase meaning');
    expect(entries[0]!.variants).toContain('test phrase');

    // Verify phrase candidate was marked promoted
    const phraseRows = phraseCandidates.listUnpromoted('g1');
    expect(phraseRows).toHaveLength(0);
  });
});
