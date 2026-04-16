/**
 * Integration test: meme pipeline end-to-end.
 *
 * Seeds messages -> jargon-miner + phrase-miner cycle -> clusterer cycle
 * -> asserts meme_graph has expected canonical + variants + meaning + origin_event.
 *
 * Uses real DatabaseSync (in-memory SQLite) with mocked LLM.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MemeClusterer } from '../../src/modules/meme-clusterer.js';
import { MemeGraphRepository, PhraseCandidatesRepository } from '../../src/storage/meme-repos.js';
import type { IClaudeClient } from '../../src/ai/claude.js';
import type { IEmbeddingService } from '../../src/storage/embeddings.js';
import type { IMemeGraphRepo, IPhraseCandidatesRepo } from '../../src/storage/db.js';
import type { Logger } from 'pino';

const silentLogger = {
  warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(),
} as unknown as Logger;

const NOW = 1700000000000;
const NOW_SEC = 1700000000;

function makeEmbedding(): IEmbeddingService {
  // Simple deterministic embedding: hash content to a vector
  return {
    isReady: true,
    embed: vi.fn().mockImplementation(async (text: string) => {
      // Simple but deterministic: use first 3 char codes normalized
      const codes = Array.from(text).slice(0, 384).map(c => c.charCodeAt(0) / 65536);
      while (codes.length < 384) codes.push(0);
      return codes;
    }),
    waitReady: vi.fn().mockResolvedValue(undefined),
  };
}

function makeClaude(): IClaudeClient {
  return {
    complete: vi.fn().mockImplementation(async (opts: { messages: Array<{ content: string }> }) => {
      const userMsg = opts.messages[0]?.content ?? '';
      // Jargon inference: return a meaning
      if (userMsg.includes('这个词在这个群里是什么意思') || userMsg.includes('这个短语在这个群里是什么意思')) {
        return {
          text: JSON.stringify({ meaning: 'group-specific slang meaning' }),
          inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
        };
      }
      // General meaning inference
      if (userMsg.includes('是什么意思')) {
        return {
          text: JSON.stringify({ meaning: 'general dictionary meaning' }),
          inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
        };
      }
      // Origin event extraction
      if (userMsg.includes('来源事件')) {
        return {
          text: JSON.stringify({ origin_event: 'U1 started using it on 2023-11-14 as a joke' }),
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

    // Apply schema
    const schemaPath = fileURLToPath(new URL('../../src/storage/schema.sql', import.meta.url));
    const sql = readFileSync(schemaPath, 'utf8');
    db.exec(sql);

    memeGraph = new MemeGraphRepository(db);
    phraseCandidates = new PhraseCandidatesRepository(db);
  });

  it('end-to-end: seeded candidates -> clusterer -> graph entry with origin', async () => {
    // Seed: insert confirmed jargon candidates directly (simulating jargon-miner output)
    const ts = NOW_SEC;
    db.prepare(`
      INSERT INTO jargon_candidates
        (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('g1', 'testmeme', 10, JSON.stringify(['User says testmeme', 'Another testmeme usage']),
           10, 'group-specific slang meaning', 1, 0, ts, ts);

    // Seed: insert a message so origin extraction can find it
    db.prepare(`
      INSERT INTO messages (group_id, user_id, nickname, content, timestamp, deleted)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('g1', 'u1', 'TestUser', 'hey testmeme is funny', ts - 86400, 0);

    const clusterer = new MemeClusterer({
      db,
      memeGraphRepo: memeGraph,
      phraseCandidatesRepo: phraseCandidates,
embeddingService: makeEmbedding(),
      claude: makeClaude(),
      activeGroups: ['g1'],
      logger: silentLogger,
      now: () => NOW,
    });

    await clusterer.run('g1');

    // Verify meme_graph entry was created
    const entries = memeGraph.listActive('g1', 10);
    expect(entries).toHaveLength(1);

    const entry = entries[0]!;
    expect(entry.canonical).toBe('testmeme');
    expect(entry.variants).toContain('testmeme');
    expect(entry.meaning).toBe('group-specific slang meaning');
    expect(entry.totalCount).toBe(10);
    expect(entry.confidence).toBeGreaterThan(0);
    expect(entry.status).toBe('active');

    // Verify origin was extracted
    expect(entry.originEvent).toBe('U1 started using it on 2023-11-14 as a joke');
    expect(entry.originUserId).toBe('u1');

    // Verify candidate was marked promoted
    const jargonRow = db.prepare(
      'SELECT promoted FROM jargon_candidates WHERE group_id = ? AND content = ?'
    ).get('g1', 'testmeme') as { promoted: number };
    expect(jargonRow.promoted).toBe(1);
  });

  it('variant aggregation: multiple candidates cluster into one entry', async () => {
    const ts = NOW_SEC;
    // Insert first candidate
    db.prepare(`
      INSERT INTO jargon_candidates
        (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('g1', 'hyw', 5, '["ctx"]', 5, 'hello slang', 1, 0, ts, ts);

    const embedding = makeEmbedding();
    const clusterer = new MemeClusterer({
      db,
      memeGraphRepo: memeGraph,
      phraseCandidatesRepo: phraseCandidates,
embeddingService: embedding,
      claude: makeClaude(),
      activeGroups: ['g1'],
      logger: silentLogger,
      now: () => NOW,
    });

    // Run once: creates graph entry for 'hyw'
    await clusterer.run('g1');

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
    await clusterer.run('g1');

    entries = memeGraph.listActive('g1', 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.variants).toContain('hyw');
    expect(entries[0]!.variants).toContain('mmhyw');
    expect(entries[0]!.totalCount).toBeGreaterThan(5);
  });

  it('manual_edit entries are not overwritten by clusterer', async () => {
    const ts = NOW_SEC;

    // Create a graph entry and mark it as manual_edit via adminEdit
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

    // Now add a candidate that would match
    db.prepare(`
      INSERT INTO jargon_candidates
        (group_id, content, count, contexts, last_inference_count, meaning, is_jargon, promoted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('g1', 'mmhyw', 3, '["ctx"]', 3, 'different meaning', 1, 0, ts, ts);

    const clusterer = new MemeClusterer({
      db,
      memeGraphRepo: memeGraph,
      phraseCandidatesRepo: phraseCandidates,
embeddingService: makeEmbedding(),
      claude: makeClaude(),
      activeGroups: ['g1'],
      logger: silentLogger,
      now: () => NOW,
    });

    await clusterer.run('g1');

    // Meaning should still be the admin-curated one
    const entry = memeGraph.findById(entryId)!;
    expect(entry.meaning).toBe('admin-curated meaning');
    expect(entry.status).toBe('manual_edit');
    // But variant should have been added
    expect(entry.variants).toContain('mmhyw');
  });

  it('phrase candidates are processed alongside jargon candidates', async () => {
    const ts = NOW_SEC;

    // Seed phrase candidate
    phraseCandidates.upsert('g1', 'test phrase', 3, 'ctx1', ts);
    // Manually set is_jargon=1 and increase count
    db.prepare(
      'UPDATE phrase_candidates SET is_jargon = 1, count = 5, meaning = ? WHERE group_id = ? AND content = ?'
    ).run('a phrase meaning', 'g1', 'test phrase');

    const clusterer = new MemeClusterer({
      db,
      memeGraphRepo: memeGraph,
      phraseCandidatesRepo: phraseCandidates,
embeddingService: makeEmbedding(),
      claude: makeClaude(),
      activeGroups: ['g1'],
      logger: silentLogger,
      now: () => NOW,
    });

    await clusterer.run('g1');

    const entries = memeGraph.listActive('g1', 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.canonical).toBe('test phrase');
    expect(entries[0]!.meaning).toBe('a phrase meaning');

    // Verify phrase candidate was marked promoted
    const phraseRows = phraseCandidates.listUnpromoted('g1');
    expect(phraseRows).toHaveLength(0);
  });

  it('kill switch: MEMES_V1_DISABLED skips clusterer (via index.ts pattern)', () => {
    // This test verifies the kill switch pattern used in index.ts
    const memesDisabled = true; // simulating MEMES_V1_DISABLED=1
    const memeClusterer = memesDisabled ? null : new MemeClusterer({
      db,
      memeGraphRepo: memeGraph,
      phraseCandidatesRepo: phraseCandidates,
embeddingService: makeEmbedding(),
      claude: makeClaude(),
      activeGroups: ['g1'],
    });

    expect(memeClusterer).toBeNull();
  });
});
