import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RelationshipTracker } from '../src/modules/relationship-tracker.js';
import type { IClaudeClient } from '../src/ai/claude.js';
import type { IMessageRepository, IUserRepository, Message, User } from '../src/storage/db.js';
import type { Logger } from 'pino';

const silentLogger = {
  warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(),
} as unknown as Logger;

const GROUP = 'g1';
const NOW_MS = 1700000000000;
const NOW_SEC = 1700000000;

function makeMsg(
  userId: string, nickname: string, content: string,
  timestamp = NOW_SEC, rawContent?: string,
): Message {
  return {
    id: 0, groupId: GROUP, userId, nickname, content,
    rawContent: rawContent ?? content, timestamp, deleted: false,
  };
}

// ---- Mock factories ----

function makeMsgRepo(msgs: Message[]): IMessageRepository {
  return {
    getRecent: vi.fn().mockReturnValue(msgs),
    getByUser: vi.fn().mockImplementation((_gid: string, uid: string, _limit: number) =>
      msgs.filter(m => m.userId === uid),
    ),
  } as unknown as IMessageRepository;
}

function makeUserRepo(users: User[] = []): IUserRepository {
  return {
    findById: vi.fn().mockImplementation((uid: string, _gid: string) =>
      users.find(u => u.userId === uid) ?? null,
    ),
  } as unknown as IUserRepository;
}

function makeClaudeWith(response: string): IClaudeClient {
  return {
    complete: vi.fn().mockResolvedValue({
      text: response, inputTokens: 10, outputTokens: 10,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    }),
  } as unknown as IClaudeClient;
}

interface MockDb {
  execCalls: { sql: string; params: unknown[] }[];
  queryCalls: { sql: string; params: unknown[] }[];
  queryResults: Map<string, unknown[]>;
  dbExec: (sql: string, ...params: unknown[]) => void;
  dbQuery: <T>(sql: string, ...params: unknown[]) => T[];
}

function makeMockDb(): MockDb {
  const execCalls: { sql: string; params: unknown[] }[] = [];
  const queryCalls: { sql: string; params: unknown[] }[] = [];
  const queryResults = new Map<string, unknown[]>();

  return {
    execCalls,
    queryCalls,
    queryResults,
    dbExec: (sql: string, ...params: unknown[]) => {
      execCalls.push({ sql, params });
    },
    dbQuery: <T>(sql: string, ...params: unknown[]): T[] => {
      queryCalls.push({ sql, params });
      // Match by substring in the SQL for flexibility
      for (const [key, val] of queryResults) {
        if (sql.includes(key)) return val as T[];
      }
      return [] as T[];
    },
  };
}

function makeTracker(overrides: Partial<{
  msgs: Message[];
  users: User[];
  claudeResponse: string;
  db: MockDb;
}> = {}) {
  const msgs = overrides.msgs ?? [];
  const users = overrides.users ?? [];
  const claude = makeClaudeWith(overrides.claudeResponse ?? '{}');
  const db = overrides.db ?? makeMockDb();

  const tracker = new RelationshipTracker({
    messages: makeMsgRepo(msgs),
    users: makeUserRepo(users),
    claude,
    activeGroups: [GROUP],
    logger: silentLogger,
    enabled: true,
    now: () => NOW_MS,
    dbExec: db.dbExec,
    dbQuery: db.dbQuery,
    statsIntervalMs: 60_000,
    inferenceIntervalMs: 60_000,
  });

  return { tracker, claude, db };
}

// ============================================================================
// updateStats
// ============================================================================

describe('RelationshipTracker.updateStats', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('does nothing on empty messages', () => {
    const { tracker, db } = makeTracker({ msgs: [] });
    tracker.updateStats(GROUP);
    expect(db.execCalls).toHaveLength(0);
  });

  it('detects reply pattern when adjacent msgs from different users within 60s', () => {
    const msgs = [
      // getRecent returns DESC — so most recent first
      makeMsg('u2', 'Bob', 'hello back', NOW_SEC + 30),
      makeMsg('u1', 'Alice', 'hello', NOW_SEC),
    ];
    const { tracker, db } = makeTracker({ msgs });
    tracker.updateStats(GROUP);

    // After reversing to chronological: Alice(NOW_SEC) → Bob(NOW_SEC+30)
    // Bob replied to Alice — so from=u2, to=u1 should have reply=1
    const upsert = db.execCalls.find(c =>
      c.params.includes('u2') && c.params.includes('u1'),
    );
    expect(upsert).toBeDefined();
    // params: groupId, fromUser, toUser, reply, mention, nameRef, nowSec
    expect(upsert!.params[3]).toBe(1); // reply_count
  });

  it('does NOT count reply when time gap > 60s', () => {
    const msgs = [
      makeMsg('u2', 'Bob', 'hello back', NOW_SEC + 120),
      makeMsg('u1', 'Alice', 'hello', NOW_SEC),
    ];
    const { tracker, db } = makeTracker({ msgs });
    tracker.updateStats(GROUP);
    // No interactions should be recorded — gap > 60s
    expect(db.execCalls).toHaveLength(0);
  });

  it('does NOT count reply when same user sends consecutive messages', () => {
    const msgs = [
      makeMsg('u1', 'Alice', 'message 2', NOW_SEC + 10),
      makeMsg('u1', 'Alice', 'message 1', NOW_SEC),
    ];
    const { tracker, db } = makeTracker({ msgs });
    tracker.updateStats(GROUP);
    expect(db.execCalls).toHaveLength(0);
  });

  it('detects @-mentions from rawContent CQ codes', () => {
    const msgs = [
      makeMsg('u1', 'Alice', '你好啊Bob', NOW_SEC, '你好啊[CQ:at,qq=12345]'),
    ];
    const { tracker, db } = makeTracker({ msgs });
    tracker.updateStats(GROUP);

    const upsert = db.execCalls.find(c =>
      c.params.includes('u1') && c.params.includes('12345'),
    );
    expect(upsert).toBeDefined();
    expect(upsert!.params[4]).toBe(1); // mention_count
  });

  it('detects multiple @-mentions in one message', () => {
    const raw = '大家好 [CQ:at,qq=111] [CQ:at,qq=222]';
    const msgs = [makeMsg('u1', 'Alice', '大家好', NOW_SEC, raw)];
    const { tracker, db } = makeTracker({ msgs });
    tracker.updateStats(GROUP);

    const upsert111 = db.execCalls.find(c => c.params.includes('111'));
    const upsert222 = db.execCalls.find(c => c.params.includes('222'));
    expect(upsert111).toBeDefined();
    expect(upsert222).toBeDefined();
  });

  it('ignores self-mentions', () => {
    const msgs = [
      makeMsg('12345', 'Alice', '我@自己', NOW_SEC, '我[CQ:at,qq=12345]'),
    ];
    const { tracker, db } = makeTracker({ msgs });
    tracker.updateStats(GROUP);
    expect(db.execCalls).toHaveLength(0);
  });

  it('detects name references when content contains another user nickname', () => {
    const msgs = [
      // Two users so nickname map is built
      makeMsg('u2', 'BobName', 'something', NOW_SEC + 1),
      makeMsg('u1', 'Alice', '我觉得BobName说得对', NOW_SEC),
    ];
    const { tracker, db } = makeTracker({ msgs });
    tracker.updateStats(GROUP);

    // u1 references u2 by name
    const upsert = db.execCalls.find(c =>
      c.params.includes('u1') && c.params.includes('u2') && (c.params[5] as number) > 0,
    );
    expect(upsert).toBeDefined();
    expect(upsert!.params[5]).toBe(1); // name_ref_count
  });

  it('skips single-character nicknames to avoid noise', () => {
    const msgs = [
      makeMsg('u2', 'X', 'something', NOW_SEC + 1),
      makeMsg('u1', 'Alice', 'X marks the spot', NOW_SEC),
    ];
    const { tracker, db } = makeTracker({ msgs });
    tracker.updateStats(GROUP);

    // Should not have a nameRef for single-char nickname
    const nameRefUpsert = db.execCalls.find(c =>
      c.params.includes('u1') && c.params.includes('u2') && (c.params[5] as number) > 0,
    );
    expect(nameRefUpsert).toBeUndefined();
  });

  it('name reference matching is case-insensitive', () => {
    const msgs = [
      makeMsg('u2', 'Bob', 'hi', NOW_SEC + 1),
      makeMsg('u1', 'Alice', '我觉得bob说得对', NOW_SEC),
    ];
    const { tracker, db } = makeTracker({ msgs });
    tracker.updateStats(GROUP);

    const nameRef = db.execCalls.find(c =>
      c.params.includes('u1') && c.params.includes('u2') && (c.params[5] as number) > 0,
    );
    expect(nameRef).toBeDefined();
  });

  it('accumulates multiple interaction types for the same pair', () => {
    // u1 replies to 99999 AND mentions 99999 by name in the same message
    // Use numeric userId since CQ:at qq= requires digits
    const msgs = [
      makeMsg('11111', 'Alice', '我同意BobNick的观点', NOW_SEC + 10, '我同意BobNick的观点[CQ:at,qq=99999]'),
      makeMsg('99999', 'BobNick', 'some opinion', NOW_SEC),
    ];
    const { tracker, db } = makeTracker({ msgs });
    tracker.updateStats(GROUP);

    // 11111→99999 should have: reply=1, mention=1, nameRef=1
    const upsert = db.execCalls.find(c =>
      c.params[1] === '11111' && c.params[2] === '99999',
    );
    expect(upsert).toBeDefined();
    expect(upsert!.params[3]).toBe(1); // reply
    expect(upsert!.params[4]).toBe(1); // mention
    expect(upsert!.params[5]).toBe(1); // nameRef
  });
});

// ============================================================================
// inferRelationships
// ============================================================================

describe('RelationshipTracker.inferRelationships', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('skips when no pairs have > 5 interactions', async () => {
    const db = makeMockDb();
    // interaction_stats query returns empty
    const { tracker, claude } = makeTracker({ db });
    await tracker.inferRelationships(GROUP);
    expect((claude.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('calls LLM for pairs with > 5 interactions and upserts result', async () => {
    const db = makeMockDb();
    db.queryResults.set('interaction_stats', [
      { from_user: 'u1', to_user: 'u2', reply_count: 10, mention_count: 3, name_ref_count: 0 },
    ]);

    const msgs = [
      makeMsg('u1', 'Alice', 'hello bob', NOW_SEC),
      makeMsg('u2', 'Bob', 'hi alice', NOW_SEC + 10),
      makeMsg('u1', 'Alice', 'how are you', NOW_SEC + 20),
      makeMsg('u2', 'Bob', 'good thanks', NOW_SEC + 30),
      makeMsg('u1', 'Alice', 'great', NOW_SEC + 40),
    ];

    const llmResponse = JSON.stringify({
      fromUser: 'u1', toUser: 'u2',
      type: '铁磁/密友', strength: 0.85,
      evidence: '经常聊天互动',
    });

    const users: User[] = [
      { userId: 'u1', groupId: GROUP, nickname: 'Alice', styleSummary: null, lastSeen: NOW_SEC, role: 'member' },
      { userId: 'u2', groupId: GROUP, nickname: 'Bob', styleSummary: null, lastSeen: NOW_SEC, role: 'member' },
    ];

    const { tracker, claude } = makeTracker({ msgs, users, claudeResponse: llmResponse, db });
    await tracker.inferRelationships(GROUP);

    expect((claude.complete as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);

    // Should upsert into social_relations
    const insertCall = db.execCalls.find(c => c.sql.includes('social_relations'));
    expect(insertCall).toBeDefined();
    expect(insertCall!.params).toContain('u1');
    expect(insertCall!.params).toContain('u2');
    expect(insertCall!.params).toContain('铁磁/密友');
    expect(insertCall!.params).toContain(0.85);
  });

  it('falls back to 普通群友 for invalid relation type', async () => {
    const db = makeMockDb();
    db.queryResults.set('interaction_stats', [
      { from_user: 'u1', to_user: 'u2', reply_count: 10, mention_count: 0, name_ref_count: 0 },
    ]);

    const msgs = [
      makeMsg('u1', 'Alice', 'msg1', NOW_SEC),
      makeMsg('u2', 'Bob', 'msg2', NOW_SEC + 10),
      makeMsg('u1', 'Alice', 'msg3', NOW_SEC + 20),
      makeMsg('u2', 'Bob', 'msg4', NOW_SEC + 30),
      makeMsg('u1', 'Alice', 'msg5', NOW_SEC + 40),
    ];

    const llmResponse = JSON.stringify({
      fromUser: 'u1', toUser: 'u2',
      type: '完全自创的类型', strength: 0.5,
      evidence: 'test',
    });

    const { tracker, db: mockDb } = makeTracker({ msgs, claudeResponse: llmResponse, db });
    await tracker.inferRelationships(GROUP);

    const insertCall = mockDb.execCalls.find(c => c.sql.includes('social_relations'));
    expect(insertCall).toBeDefined();
    expect(insertCall!.params).toContain('普通群友');
  });

  it('clamps strength to [0, 1] range', async () => {
    const db = makeMockDb();
    db.queryResults.set('interaction_stats', [
      { from_user: 'u1', to_user: 'u2', reply_count: 10, mention_count: 0, name_ref_count: 0 },
    ]);

    const msgs = [
      makeMsg('u1', 'Alice', 'm1', NOW_SEC),
      makeMsg('u2', 'Bob', 'm2', NOW_SEC + 10),
      makeMsg('u1', 'Alice', 'm3', NOW_SEC + 20),
      makeMsg('u2', 'Bob', 'm4', NOW_SEC + 30),
      makeMsg('u1', 'Alice', 'm5', NOW_SEC + 40),
    ];

    const llmResponse = JSON.stringify({
      fromUser: 'u1', toUser: 'u2',
      type: '铁磁/密友', strength: 1.5,
      evidence: 'too strong',
    });

    const { tracker, db: mockDb } = makeTracker({ msgs, claudeResponse: llmResponse, db });
    await tracker.inferRelationships(GROUP);

    const insertCall = mockDb.execCalls.find(c => c.sql.includes('social_relations'));
    expect(insertCall).toBeDefined();
    // strength should be clamped to 1.0
    const strengthIdx = insertCall!.params.indexOf(1.0);
    expect(strengthIdx).toBeGreaterThan(-1);
  });

  it('handles LLM returning unparseable response gracefully', async () => {
    const db = makeMockDb();
    db.queryResults.set('interaction_stats', [
      { from_user: 'u1', to_user: 'u2', reply_count: 10, mention_count: 0, name_ref_count: 0 },
    ]);

    const msgs = [
      makeMsg('u1', 'Alice', 'm1', NOW_SEC),
      makeMsg('u2', 'Bob', 'm2', NOW_SEC + 10),
      makeMsg('u1', 'Alice', 'm3', NOW_SEC + 20),
      makeMsg('u2', 'Bob', 'm4', NOW_SEC + 30),
      makeMsg('u1', 'Alice', 'm5', NOW_SEC + 40),
    ];

    const { tracker, db: mockDb } = makeTracker({
      msgs,
      claudeResponse: 'I cannot analyze this text in a meaningful way.',
      db,
    });

    await tracker.inferRelationships(GROUP);

    // Should not crash, and no social_relations upsert
    const insertCall = mockDb.execCalls.find(c => c.sql.includes('social_relations'));
    expect(insertCall).toBeUndefined();
  });

  it('handles LLM returning JSON with missing fields', async () => {
    const db = makeMockDb();
    db.queryResults.set('interaction_stats', [
      { from_user: 'u1', to_user: 'u2', reply_count: 10, mention_count: 0, name_ref_count: 0 },
    ]);

    const msgs = [
      makeMsg('u1', 'A', 'm1', NOW_SEC),
      makeMsg('u2', 'B', 'm2', NOW_SEC + 10),
      makeMsg('u1', 'A', 'm3', NOW_SEC + 20),
      makeMsg('u2', 'B', 'm4', NOW_SEC + 30),
      makeMsg('u1', 'A', 'm5', NOW_SEC + 40),
    ];

    // Missing 'type' field
    const { tracker, db: mockDb } = makeTracker({
      msgs,
      claudeResponse: JSON.stringify({ fromUser: 'u1', toUser: 'u2', strength: 0.5 }),
      db,
    });

    await tracker.inferRelationships(GROUP);

    const insertCall = mockDb.execCalls.find(c => c.sql.includes('social_relations'));
    expect(insertCall).toBeUndefined();
  });

  it('skips pair when fewer than 5 messages available', async () => {
    const db = makeMockDb();
    db.queryResults.set('interaction_stats', [
      { from_user: 'u1', to_user: 'u2', reply_count: 10, mention_count: 0, name_ref_count: 0 },
    ]);

    // Only 3 messages
    const msgs = [
      makeMsg('u1', 'Alice', 'm1', NOW_SEC),
      makeMsg('u2', 'Bob', 'm2', NOW_SEC + 10),
    ];

    const { tracker, claude } = makeTracker({ msgs, db });
    await tracker.inferRelationships(GROUP);

    expect((claude.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('truncates overly long evidence strings', async () => {
    const db = makeMockDb();
    db.queryResults.set('interaction_stats', [
      { from_user: 'u1', to_user: 'u2', reply_count: 10, mention_count: 0, name_ref_count: 0 },
    ]);

    const msgs = Array.from({ length: 10 }, (_, i) =>
      makeMsg(i % 2 === 0 ? 'u1' : 'u2', i % 2 === 0 ? 'A' : 'B', `msg${i}`, NOW_SEC + i),
    );

    const longEvidence = 'a'.repeat(500);
    const llmResponse = JSON.stringify({
      fromUser: 'u1', toUser: 'u2',
      type: '互怼/欢喜冤家', strength: 0.7,
      evidence: longEvidence,
    });

    const { tracker, db: mockDb } = makeTracker({ msgs, claudeResponse: llmResponse, db });
    await tracker.inferRelationships(GROUP);

    const insertCall = mockDb.execCalls.find(c => c.sql.includes('social_relations'));
    expect(insertCall).toBeDefined();
    const evidenceParam = insertCall!.params[5] as string;
    expect(evidenceParam.length).toBeLessThanOrEqual(200);
  });
});

// ============================================================================
// getRelevantRelations
// ============================================================================

describe('RelationshipTracker.getRelevantRelations', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns empty array for empty userIds', () => {
    const { tracker } = makeTracker();
    const result = tracker.getRelevantRelations(GROUP, []);
    expect(result).toEqual([]);
  });

  it('queries and maps rows correctly', () => {
    const db = makeMockDb();
    db.queryResults.set('social_relations', [
      {
        group_id: GROUP, from_user: 'u1', to_user: 'u2',
        relation_type: '铁磁/密友', strength: 0.9,
        evidence: '经常一起聊天', updated_at: NOW_SEC,
      },
    ]);

    const { tracker } = makeTracker({ db });
    const result = tracker.getRelevantRelations(GROUP, ['u1']);

    expect(result).toHaveLength(1);
    expect(result[0]!.fromUser).toBe('u1');
    expect(result[0]!.toUser).toBe('u2');
    expect(result[0]!.relationType).toBe('铁磁/密友');
    expect(result[0]!.strength).toBe(0.9);
    expect(result[0]!.evidence).toBe('经常一起聊天');
  });
});

// ============================================================================
// formatRelationsForPrompt
// ============================================================================

describe('RelationshipTracker.formatRelationsForPrompt', () => {
  it('returns empty string for no relations', () => {
    const { tracker } = makeTracker();
    expect(tracker.formatRelationsForPrompt([], new Map())).toBe('');
  });

  it('formats relations with nicknames', () => {
    const { tracker } = makeTracker();
    const relations = [
      {
        groupId: GROUP, fromUser: 'u1', toUser: 'u2',
        relationType: '互怼/欢喜冤家', strength: 0.8,
        evidence: '互骂但关系好', updatedAt: NOW_SEC,
      },
    ];
    const nicknames = new Map([['u1', 'Alice'], ['u2', 'Bob']]);
    const result = tracker.formatRelationsForPrompt(relations, nicknames);

    expect(result).toContain('## 群友关系');
    expect(result).toContain('Alice 和 Bob 的关系：互怼/欢喜冤家（互骂但关系好）');
  });

  it('uses userId when nickname not in map', () => {
    const { tracker } = makeTracker();
    const relations = [
      {
        groupId: GROUP, fromUser: 'u1', toUser: 'u2',
        relationType: '普通群友', strength: 0.5,
        evidence: null, updatedAt: NOW_SEC,
      },
    ];
    const result = tracker.formatRelationsForPrompt(relations, new Map());
    expect(result).toContain('u1 和 u2 的关系：普通群友');
    // No evidence parentheses when evidence is null
    expect(result).not.toContain('（');
  });
});

// ============================================================================
// start / dispose
// ============================================================================

describe('RelationshipTracker lifecycle', () => {
  it('start does nothing when disabled', () => {
    const db = makeMockDb();
    const tracker = new RelationshipTracker({
      messages: makeMsgRepo([]),
      users: makeUserRepo(),
      claude: makeClaudeWith('{}'),
      activeGroups: [GROUP],
      logger: silentLogger,
      enabled: false,
      now: () => NOW_MS,
      dbExec: db.dbExec,
      dbQuery: db.dbQuery,
    });

    tracker.start();
    // No timers should be set — dispose should be safe
    tracker.dispose();
  });

  it('dispose clears all timers', () => {
    const { tracker } = makeTracker();
    tracker.start();
    // Should not throw
    tracker.dispose();
    tracker.dispose(); // double dispose is safe
  });
});

// ============================================================================
// Edge cases
// ============================================================================

describe('RelationshipTracker edge cases', () => {
  it('handles messages with empty content', () => {
    const msgs = [
      makeMsg('u2', 'Bob', '', NOW_SEC + 10),
      makeMsg('u1', 'Alice', '', NOW_SEC),
    ];
    const { tracker } = makeTracker({ msgs });
    // Should not throw
    tracker.updateStats(GROUP);
  });

  it('handles messages with null rawContent', () => {
    const msgs = [
      { id: 0, groupId: GROUP, userId: 'u1', nickname: 'Alice', content: 'hello', rawContent: null as unknown as string, timestamp: NOW_SEC, deleted: false },
    ];
    const { tracker } = makeTracker({ msgs: msgs as Message[] });
    // Should fall back to content for @-mention parsing
    tracker.updateStats(GROUP);
  });

  it('handles many users in a single stats run', () => {
    // 20 users, each sending one message 10s apart
    const msgs = Array.from({ length: 20 }, (_, i) =>
      makeMsg(`u${i}`, `User${i}`, `hello from ${i}`, NOW_SEC + i * 10),
    ).reverse(); // DESC order

    const { tracker, db } = makeTracker({ msgs });
    tracker.updateStats(GROUP);

    // Adjacent pairs should produce reply counts
    expect(db.execCalls.length).toBeGreaterThan(0);
  });

  it('relation type partial matching works (e.g. "铁磁" matches "铁磁/密友")', async () => {
    const db = makeMockDb();
    db.queryResults.set('interaction_stats', [
      { from_user: 'u1', to_user: 'u2', reply_count: 10, mention_count: 0, name_ref_count: 0 },
    ]);

    const msgs = Array.from({ length: 10 }, (_, i) =>
      makeMsg(i % 2 === 0 ? 'u1' : 'u2', i % 2 === 0 ? 'A' : 'B', `msg${i}`, NOW_SEC + i),
    );

    // LLM returns just "铁磁" without the full "铁磁/密友"
    const llmResponse = JSON.stringify({
      fromUser: 'u1', toUser: 'u2',
      type: '铁磁', strength: 0.9,
      evidence: 'test',
    });

    const { tracker, db: mockDb } = makeTracker({ msgs, claudeResponse: llmResponse, db });
    await tracker.inferRelationships(GROUP);

    const insertCall = mockDb.execCalls.find(c => c.sql.includes('social_relations'));
    expect(insertCall).toBeDefined();
    expect(insertCall!.params).toContain('铁磁/密友');
  });

  it('handles negative strength from LLM', async () => {
    const db = makeMockDb();
    db.queryResults.set('interaction_stats', [
      { from_user: 'u1', to_user: 'u2', reply_count: 10, mention_count: 0, name_ref_count: 0 },
    ]);

    const msgs = Array.from({ length: 10 }, (_, i) =>
      makeMsg(i % 2 === 0 ? 'u1' : 'u2', i % 2 === 0 ? 'A' : 'B', `msg${i}`, NOW_SEC + i),
    );

    const llmResponse = JSON.stringify({
      fromUser: 'u1', toUser: 'u2',
      type: '敌对', strength: -0.5,
      evidence: 'test',
    });

    const { tracker, db: mockDb } = makeTracker({ msgs, claudeResponse: llmResponse, db });
    await tracker.inferRelationships(GROUP);

    const insertCall = mockDb.execCalls.find(c => c.sql.includes('social_relations'));
    expect(insertCall).toBeDefined();
    // strength should be clamped to 0
    expect(insertCall!.params[4]).toBe(0);
  });

  it('handles strength as string from LLM (non-number → skipped)', async () => {
    const db = makeMockDb();
    db.queryResults.set('interaction_stats', [
      { from_user: 'u1', to_user: 'u2', reply_count: 10, mention_count: 0, name_ref_count: 0 },
    ]);

    const msgs = Array.from({ length: 10 }, (_, i) =>
      makeMsg(i % 2 === 0 ? 'u1' : 'u2', i % 2 === 0 ? 'A' : 'B', `msg${i}`, NOW_SEC + i),
    );

    const llmResponse = JSON.stringify({
      fromUser: 'u1', toUser: 'u2',
      type: '普通群友', strength: 'high',
      evidence: 'test',
    });

    const { tracker, db: mockDb } = makeTracker({ msgs, claudeResponse: llmResponse, db });
    await tracker.inferRelationships(GROUP);

    // Should be skipped — strength is not a number
    const insertCall = mockDb.execCalls.find(c => c.sql.includes('social_relations'));
    expect(insertCall).toBeUndefined();
  });
});

// ============================================================================
// getBotUserRelation (M6.5)
// ============================================================================

describe('RelationshipTracker.getBotUserRelation', () => {
  const BOT = 'bot-999';
  const USER = 'u-42';
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns hydrated SocialRelation when user→bot row exists', () => {
    const db = makeMockDb();
    db.queryResults.set('social_relations', [{
      group_id: GROUP, from_user: USER, to_user: BOT,
      relation_type: '铁磁/密友', strength: 0.8,
      evidence: '经常调侃', updated_at: NOW_SEC,
    }]);
    const { tracker } = makeTracker({ db });

    const rel = tracker.getBotUserRelation(GROUP, BOT, USER);
    expect(rel).not.toBeNull();
    expect(rel!.relationType).toBe('铁磁/密友');
    expect(rel!.strength).toBe(0.8);
    expect(rel!.fromUser).toBe(USER);
    expect(rel!.toUser).toBe(BOT);
    expect(rel!.evidence).toBe('经常调侃');
  });

  it('issues query with from_user=userId and to_user=botUserId (user→bot edge as bilateral proxy)', () => {
    const db = makeMockDb();
    const { tracker } = makeTracker({ db });

    tracker.getBotUserRelation(GROUP, BOT, USER);
    const q = db.queryCalls.find(c => c.sql.includes('social_relations'));
    expect(q).toBeDefined();
    // Params: groupId, fromUser(=USER), toUser(=BOT)
    expect(q!.params).toEqual([GROUP, USER, BOT]);
  });

  it('returns null when bot and user ids coincide', () => {
    const db = makeMockDb();
    const { tracker } = makeTracker({ db });
    expect(tracker.getBotUserRelation(GROUP, BOT, BOT)).toBeNull();
    // Short-circuit — no db query issued
    expect(db.queryCalls).toHaveLength(0);
  });

  it('returns null when no matching row exists', () => {
    const db = makeMockDb();
    // empty queryResults — dbQuery returns []
    const { tracker } = makeTracker({ db });
    expect(tracker.getBotUserRelation(GROUP, BOT, USER)).toBeNull();
  });

  it('is group-scoped (query includes group_id param)', () => {
    const db = makeMockDb();
    const { tracker } = makeTracker({ db });
    tracker.getBotUserRelation('other-group', BOT, USER);
    const q = db.queryCalls.find(c => c.sql.includes('social_relations'));
    expect(q!.params[0]).toBe('other-group');
    expect(q!.sql).toMatch(/group_id\s*=\s*\?/);
  });
});
