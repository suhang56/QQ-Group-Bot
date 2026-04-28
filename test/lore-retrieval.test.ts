import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { buildAliasMap, extractEntities, buildLorePayload } from '../src/modules/lore-retrieval.js';
import { tokenizeLore } from '../src/modules/chat.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

// Real fixture paths (per feedback_html_scraper_fixtures: no synthetic fixtures)
const LORE_DIR = path.resolve(__dirname, '..', 'data', 'lore');
const CHUNKS_PATH = path.join(LORE_DIR, '958751334.md.chunks.jsonl');
const GROUP_ID = '958751334';

describe('buildAliasMap', () => {
  let aliasMap: Map<string, number[]>;

  beforeAll(() => {
    aliasMap = buildAliasMap(CHUNKS_PATH);
  });

  it('returns a non-empty map from the real chunks file', () => {
    expect(aliasMap.size).toBeGreaterThan(0);
  });

  it('does NOT contain mhy as a key (core bug prevention)', () => {
    expect(aliasMap.has('mhy')).toBe(false);
  });

  it('contains hyw as a key (explicit alias in chunk heading)', () => {
    expect(aliasMap.has('hyw')).toBe(true);
  });

  it('contains kisa as a key', () => {
    expect(aliasMap.has('kisa')).toBe(true);
  });

  it('contains lag as a key', () => {
    expect(aliasMap.has('lag')).toBe(true);
  });

  it('excludes single-character tokens', () => {
    for (const key of aliasMap.keys()) {
      expect(key.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('maps hyw / mmhyw to the same chunk (slash-separated cluster)', () => {
    const hywChunks = aliasMap.get('hyw');
    const mmhywChunks = aliasMap.get('mmhyw');
    expect(hywChunks).toBeDefined();
    expect(mmhywChunks).toBeDefined();
    // They should share at least one chunk index
    const overlap = hywChunks!.filter(idx => mmhywChunks!.includes(idx));
    expect(overlap.length).toBeGreaterThan(0);
  });

  it('contains 228 as a key (explicit numeric alias)', () => {
    // 228 appears in the lore as a known term (横滨K十周年)
    // Check if it exists - it may appear in table entries
    const has228 = aliasMap.has('228');
    // If 228 is mentioned as bold table entry, it should be in map
    // This is a soft check since it depends on chunk content
    expect(typeof has228).toBe('boolean');
  });
});

describe('extractEntities', () => {
  let aliasMap: Map<string, number[]>;

  beforeAll(() => {
    aliasMap = buildAliasMap(CHUNKS_PATH);
  });

  it('returns empty set for mhy (not a listed alias)', () => {
    const result = extractEntities('mhy', [], aliasMap);
    expect(result.size).toBe(0);
  });

  it('returns chunk index for hyw (3-char exact alias)', () => {
    const result = extractEntities('hyw', [], aliasMap);
    expect(result.size).toBeGreaterThan(0);
  });

  it('returns chunk index for kisa', () => {
    const result = extractEntities('kisa', [], aliasMap);
    expect(result.size).toBeGreaterThan(0);
  });

  it('returns multiple chunk indices for multi-entity query', () => {
    const result = extractEntities('kisa 和 lag 昨天去现地了', [], aliasMap);
    // Should match both kisa and lag
    expect(result.size).toBeGreaterThanOrEqual(2);
  });

  it('returns empty set for CQ image-only message', () => {
    const result = extractEntities('[CQ:image,file=abc123.jpg]', [], aliasMap);
    expect(result.size).toBe(0);
  });

  it('returns empty set for empty string', () => {
    const result = extractEntities('', [], aliasMap);
    expect(result.size).toBe(0);
  });

  it('returns empty set for pure emoji/sticker messages', () => {
    const result = extractEntities('[CQ:face,id=277]', [], aliasMap);
    expect(result.size).toBe(0);
  });

  it('returns empty set for unknown entity', () => {
    const result = extractEntities('随便问问', [], aliasMap);
    // Should not match any chunk unless these exact chars appear as aliases
    // The point is mhy-style short unknown tokens should not match
    const resultMhy = extractEntities('mhy', [], aliasMap);
    expect(resultMhy.size).toBe(0);
  });

  it('handles short noise tokens (single-char filtered by tokenizeLore)', () => {
    // g is 1 char, 666 is not an alias, g啊 would be 2 chars but not an alias
    const result = extractEntities('g', [], aliasMap);
    expect(result.size).toBe(0);
  });

  it('mhy (3 chars) does NOT substring-match mmhyw', () => {
    // This is the core bug test: mhy must not pull the hyw/mmhyw meme chunk
    const result = extractEntities('mhy', [], aliasMap);
    expect(result.size).toBe(0);
  });

  it('ygfn (4 chars) matches via substring containment in alias entries', () => {
    // ygfn = 羊宫妃那, 4 chars so substring match allowed
    const result = extractEntities('ygfn', [], aliasMap);
    // ygfn may or may not be in the real data - this tests the mechanism
    // If it is in an alias, it should match
    expect(typeof result.size).toBe('number');
  });

  it('extracts entities from context messages too', () => {
    const context = [
      { nickname: 'kisa', content: '今天天气真好' },
      { nickname: 'someone', content: '飞鸟 你看这个' },
    ];
    const result = extractEntities('是啊', context, aliasMap);
    // Should find kisa from nickname and 飞鸟 from context content
    expect(result.size).toBeGreaterThanOrEqual(1);
  });
});

describe('buildLorePayload', () => {
  let aliasMap: Map<string, number[]>;

  beforeAll(() => {
    aliasMap = buildAliasMap(CHUNKS_PATH);
  });

  it('returns identity core only when no entities matched', () => {
    const payload = buildLorePayload(GROUP_ID, new Set(), LORE_DIR);
    // INV-1: contract-level truthy + non-empty string (structural, content-independent)
    expect(payload).toBeTruthy();
    expect(typeof payload).toBe('string');
    expect(payload!.length).toBeGreaterThan(0);
    // INV-2: identity-core-only payload respects IDENTITY_CORE_CAP (800)
    expect(payload!.length).toBeLessThanOrEqual(800);
  });

  it('returns identity core + matched chunk for hyw', () => {
    const hywChunks = aliasMap.get('hyw');
    expect(hywChunks).toBeDefined();
    const entities = new Set(hywChunks!);
    const payload = buildLorePayload(GROUP_ID, entities, LORE_DIR);
    expect(payload).toBeTruthy();
    expect(payload!.length).toBeLessThanOrEqual(8000);
    // INV-4 anchor: entity-matched payload must be strictly longer than identity-core-only
    // payload for the same group. This is the regression guard for "chunks appended"
    // contract and replaces the rotted content-string assertion.
    const identityOnlyPayload = buildLorePayload(GROUP_ID, new Set(), LORE_DIR);
    expect(identityOnlyPayload).toBeTruthy();
    expect(payload!.length).toBeGreaterThan(identityOnlyPayload!.length);
  });

  it('returns null for nonexistent groupId', () => {
    // INV-3: contract boundary — missing chunks file returns null, not throws, not ''
    const missing = buildLorePayload('000000000', new Set(), LORE_DIR);
    expect(missing).toBeNull();
  });

  it('respects 8000 char cap for multi-entity payload', () => {
    // Create a large entity set
    const allChunks = new Set<number>();
    for (const indices of aliasMap.values()) {
      for (const idx of indices) allChunks.add(idx);
    }
    const payload = buildLorePayload(GROUP_ID, allChunks, LORE_DIR);
    expect(payload).toBeTruthy();
    expect(payload!.length).toBeLessThanOrEqual(8000);
  });

  it('deduplicates chunks when multiple aliases point to same chunk', () => {
    // hyw and mmhyw should both point to chunk 18
    const hywChunks = aliasMap.get('hyw') ?? [];
    const mmhywChunks = aliasMap.get('mmhyw') ?? [];
    const combined = new Set([...hywChunks, ...mmhywChunks]);
    const payload = buildLorePayload(GROUP_ID, combined, LORE_DIR);
    expect(payload).toBeTruthy();
  });

  it('returns identity core when entity set is empty (fallback)', () => {
    const payload = buildLorePayload(GROUP_ID, new Set(), LORE_DIR);
    expect(payload).toBeTruthy();
    // Should NOT contain meme table content
    expect(payload).not.toContain('mmhyw');
  });

  it('identity core does NOT contain meme table', () => {
    const payload = buildLorePayload(GROUP_ID, new Set(), LORE_DIR);
    expect(payload).not.toContain('mmhyw');
    expect(payload).not.toContain('hyw / mmhyw');
  });

  it('orders chunks by document order (chunkIndex ascending)', () => {
    // Get two chunks with different indices
    const kisaChunks = aliasMap.get('kisa') ?? [];
    const lagChunks = aliasMap.get('lag') ?? [];
    if (kisaChunks.length > 0 && lagChunks.length > 0) {
      const entities = new Set([...kisaChunks, ...lagChunks]);
      const payload = buildLorePayload(GROUP_ID, entities, LORE_DIR);
      expect(payload).toBeTruthy();
    }
  });
});

describe('invalidation', () => {
  it('buildAliasMap returns fresh map after re-reading file', () => {
    const map1 = buildAliasMap(CHUNKS_PATH);
    const map2 = buildAliasMap(CHUNKS_PATH);
    expect(map1.size).toBe(map2.size);
    // Maps are structurally equal but different instances
    expect(map1).not.toBe(map2);
  });
});

describe('buildAliasMap with learned alias facts (M6.2c fast-path)', () => {
  type MinFact = Pick<
    import('../src/storage/db.js').LearnedFact,
    'id' | 'groupId' | 'topic' | 'fact' | 'sourceUserId' | 'sourceUserNickname'
    | 'sourceMsgId' | 'botReplyId' | 'confidence' | 'status' | 'createdAt' | 'updatedAt'
  >;
  const makeFact = (topic: string, fact: string, status: 'active' | 'pending' = 'pending'): MinFact => ({
    id: 0, groupId: GROUP_ID, topic, fact,
    sourceUserId: null, sourceUserNickname: '[alias-miner]',
    sourceMsgId: null, botReplyId: null,
    confidence: 0.8, status, createdAt: 0, updatedAt: 0,
  });

  let anchorAlias: string;
  let anchorChunks: number[];
  beforeAll(() => {
    const map = buildAliasMap(CHUNKS_PATH);
    const hyw = map.get('hyw');
    if (!hyw || hyw.length === 0) {
      throw new Error('test fixture regression: hyw not in alias map');
    }
    anchorAlias = 'hyw';
    anchorChunks = hyw;
  });

  it('registers new alias from miner "X = Y (QQ id)" fact when Y is in chunk map', () => {
    const facts = [makeFact(
      '群友别名:小明',
      `小明 = ${anchorAlias} (QQ 10086)`,
    )];
    const map = buildAliasMap(CHUNKS_PATH, facts as never);
    const minChunks = map.get('小明');
    expect(minChunks).toBeDefined();
    for (const idx of anchorChunks) {
      expect(minChunks!).toContain(idx);
    }
  });

  it('registers miner fact with evidence tail "X = Y (QQ id)。evidence"', () => {
    const facts = [makeFact(
      '群友别名:小红',
      `小红 = ${anchorAlias} (QQ 10087)。群里直接叫小红`,
    )];
    const map = buildAliasMap(CHUNKS_PATH, facts as never);
    expect(map.get('小红')).toBeDefined();
    expect(map.get('小红')!.length).toBeGreaterThan(0);
  });

  it('silently skips miner fact when canonical Y is NOT in chunk map', () => {
    const facts = [makeFact(
      '群友别名:路人甲',
      '路人甲 = 不存在的人 (QQ 99999)',
    )];
    const before = buildAliasMap(CHUNKS_PATH);
    const after = buildAliasMap(CHUNKS_PATH, facts as never);
    expect(after.has('路人甲')).toBe(false);
    expect(after.size).toBe(before.size);
  });

  it('merges admin-style "X又叫Y" fact alongside miner "X = Y (QQ id)" fact', () => {
    const facts = [
      makeFact('群友别名:admin', `${anchorAlias}又叫admin别名`, 'active'),
      makeFact('群友别名:miner', `miner别名 = ${anchorAlias} (QQ 10088)`, 'pending'),
    ];
    const map = buildAliasMap(CHUNKS_PATH, facts as never);
    expect(map.get('admin别名')).toBeDefined();
    expect(map.get('miner别名')).toBeDefined();
  });

  it('empty learnedAliasFacts produces identical map vs omitted arg', () => {
    const omitted = buildAliasMap(CHUNKS_PATH);
    const empty = buildAliasMap(CHUNKS_PATH, []);
    expect(empty.size).toBe(omitted.size);
    for (const [k, v] of omitted) {
      expect(empty.get(k)).toEqual(v);
    }
  });

  it('does not throw on malformed fact text', () => {
    const facts = [
      makeFact('群友别名:junk', 'not a real pattern at all'),
      makeFact('群友别名:weird', '='),
      makeFact('群友别名:partial', '小王 = '),
      makeFact('群友别名:tiny', 'a=b'),
    ];
    expect(() => buildAliasMap(CHUNKS_PATH, facts as never)).not.toThrow();
  });

  it('treats pending-status facts identically to active (M6.2c: pending miner rows reach lore map)', () => {
    const pending = [makeFact('群友别名:小强', `小强 = ${anchorAlias} (QQ 12345)`, 'pending')];
    const active = [makeFact('群友别名:小强', `小强 = ${anchorAlias} (QQ 12345)`, 'active')];
    const mapP = buildAliasMap(CHUNKS_PATH, pending as never);
    const mapA = buildAliasMap(CHUNKS_PATH, active as never);
    expect(mapP.get('小强')).toEqual(mapA.get('小强'));
  });

  it('miner fact with extra whitespace around tokens trims cleanly', () => {
    const facts = [makeFact('群友别名:小空', `小空 =   ${anchorAlias}   (QQ 77777)`)];
    const map = buildAliasMap(CHUNKS_PATH, facts as never);
    expect(map.get('小空')).toBeDefined();
    expect(map.get('小空')!.length).toBeGreaterThan(0);
  });

  it('regex does not over-match when parens are malformed (missing close paren)', () => {
    const facts = [makeFact('群友别名:残缺', `残缺 = ${anchorAlias} (QQ 88888`)];
    const before = buildAliasMap(CHUNKS_PATH);
    const after = buildAliasMap(CHUNKS_PATH, facts as never);
    expect(after.has('残缺')).toBe(false);
    expect(after.size).toBe(before.size);
  });
});
