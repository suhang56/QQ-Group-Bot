import type { IClaudeClient } from '../ai/claude.js';
import type { IMessageRepository, IUserRepository } from '../storage/db.js';
import type { Logger } from 'pino';
import { createLogger } from '../utils/logger.js';
import { extractJson } from '../utils/json-extract.js';
import { REFLECTION_MODEL } from '../config.js';

// ---- Types ----

export interface InteractionStat {
  groupId: string;
  fromUser: string;
  toUser: string;
  replyCount: number;
  mentionCount: number;
  nameRefCount: number;
  lastUpdated: number;
}

export interface SocialRelation {
  groupId: string;
  fromUser: string;
  toUser: string;
  relationType: string;
  strength: number;
  evidence: string | null;
  updatedAt: number;
}

const VALID_RELATION_TYPES = [
  '铁磁/密友', '互怼/欢喜冤家', 'CP/暧昧', '前辈后辈',
  '普通群友', '冷淡', '敌对', '崇拜/粉丝',
] as const;

interface LlmRelationResult {
  fromUser: string;
  toUser: string;
  type: string;
  strength: number;
  evidence: string;
}

export interface RelationshipTrackerOptions {
  messages: IMessageRepository;
  users: IUserRepository;
  claude: IClaudeClient;
  activeGroups: string[];
  logger?: Logger;
  statsIntervalMs?: number;
  inferenceIntervalMs?: number;
  enabled?: boolean;
  /** Injected for testing */
  now?: () => number;
  /** Injected for testing — wraps db.exec */
  dbExec: (sql: string, ...params: unknown[]) => void;
  /** Injected for testing — wraps db prepared query for reads */
  dbQuery: <T>(sql: string, ...params: unknown[]) => T[];
}

// ---- Helpers ----

const AT_MENTION_RE = /\[CQ:at,qq=(\d+)]/g;

function extractAtMentions(rawContent: string): string[] {
  const mentions: string[] = [];
  let match: RegExpExecArray | null;
  AT_MENTION_RE.lastIndex = 0;
  while ((match = AT_MENTION_RE.exec(rawContent)) !== null) {
    mentions.push(match[1]!);
  }
  return mentions;
}

// ---- Class ----

export class RelationshipTracker {
  private readonly messages: IMessageRepository;
  private readonly users: IUserRepository;
  private readonly claude: IClaudeClient;
  private readonly activeGroups: string[];
  private readonly logger: Logger;
  private readonly statsIntervalMs: number;
  private readonly inferenceIntervalMs: number;
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly dbExec: (sql: string, ...params: unknown[]) => void;
  private readonly dbQuery: <T>(sql: string, ...params: unknown[]) => T[];

  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private inferenceTimer: ReturnType<typeof setInterval> | null = null;
  private firstStatsTimer: ReturnType<typeof setTimeout> | null = null;
  private firstInferenceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: RelationshipTrackerOptions) {
    this.messages = opts.messages;
    this.users = opts.users;
    this.claude = opts.claude;
    this.activeGroups = opts.activeGroups;
    this.logger = opts.logger ?? createLogger('relationship-tracker');
    this.statsIntervalMs = opts.statsIntervalMs ?? 60 * 60_000; // 1 hour
    this.inferenceIntervalMs = opts.inferenceIntervalMs ?? 24 * 60 * 60_000; // 24 hours
    this.enabled = opts.enabled ?? true;
    this.now = opts.now ?? (() => Date.now());
    this.dbExec = opts.dbExec;
    this.dbQuery = opts.dbQuery;
  }

  start(): void {
    if (!this.enabled) return;

    // Hourly stats update — delayed 2min on startup to avoid boot storm
    this.firstStatsTimer = setTimeout(() => {
      this._runStats().catch(err => this.logger.error({ err }, 'relationship stats run failed'));
    }, 2 * 60_000);
    this.firstStatsTimer.unref?.();

    this.statsTimer = setInterval(() => {
      this._runStats().catch(err => this.logger.error({ err }, 'relationship stats run failed'));
    }, this.statsIntervalMs);
    this.statsTimer.unref?.();

    // Daily inference — delayed 10min on startup
    this.firstInferenceTimer = setTimeout(() => {
      this._runInference().catch(err => this.logger.error({ err }, 'relationship inference run failed'));
    }, 10 * 60_000);
    this.firstInferenceTimer.unref?.();

    this.inferenceTimer = setInterval(() => {
      this._runInference().catch(err => this.logger.error({ err }, 'relationship inference run failed'));
    }, this.inferenceIntervalMs);
    this.inferenceTimer.unref?.();

    this.logger.info('relationship-tracker started');
  }

  dispose(): void {
    if (this.firstStatsTimer) { clearTimeout(this.firstStatsTimer); this.firstStatsTimer = null; }
    if (this.firstInferenceTimer) { clearTimeout(this.firstInferenceTimer); this.firstInferenceTimer = null; }
    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
    if (this.inferenceTimer) { clearInterval(this.inferenceTimer); this.inferenceTimer = null; }
  }

  // ---- Stats collection (hourly, no LLM) ----

  async _runStats(): Promise<void> {
    for (const groupId of this.activeGroups) {
      try {
        this.updateStats(groupId);
      } catch (err) {
        this.logger.error({ err, groupId }, 'relationship stats group run failed');
      }
    }
  }

  updateStats(groupId: string): void {
    const recent = this.messages.getRecent(groupId, 500);
    if (recent.length === 0) return;

    // getRecent returns DESC — reverse to chronological order
    const msgs = [...recent].reverse();

    // Build nickname map: userId -> nickname (from message data)
    const nicknameMap = new Map<string, string>();
    for (const m of msgs) {
      if (m.nickname && !nicknameMap.has(m.userId)) {
        nicknameMap.set(m.userId, m.nickname);
      }
    }

    // Accumulate counts: key = "fromUser|toUser"
    const counts = new Map<string, { reply: number; mention: number; nameRef: number }>();

    const getOrCreate = (from: string, to: string) => {
      if (from === to) return null; // no self-interactions
      const key = `${from}|${to}`;
      let entry = counts.get(key);
      if (!entry) {
        entry = { reply: 0, mention: 0, nameRef: 0 };
        counts.set(key, entry);
      }
      return entry;
    };

    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]!;

      // 1. Reply pattern: adjacent messages from different users within 60s
      if (i > 0) {
        const prev = msgs[i - 1]!;
        if (prev.userId !== msg.userId && Math.abs(msg.timestamp - prev.timestamp) <= 60) {
          const entry = getOrCreate(msg.userId, prev.userId);
          if (entry) entry.reply++;
        }
      }

      // 2. @-mentions from rawContent
      const rawContent = msg.rawContent ?? msg.content;
      const mentioned = extractAtMentions(rawContent);
      for (const mentionedId of mentioned) {
        if (mentionedId === msg.userId) continue;
        const entry = getOrCreate(msg.userId, mentionedId);
        if (entry) entry.mention++;
      }

      // 3. Name references: check if content contains other users' nicknames
      const contentLower = msg.content.toLowerCase();
      for (const [userId, nickname] of nicknameMap) {
        if (userId === msg.userId) continue;
        if (nickname.length < 2) continue; // skip single-char nicknames (too noisy)
        if (contentLower.includes(nickname.toLowerCase())) {
          const entry = getOrCreate(msg.userId, userId);
          if (entry) entry.nameRef++;
        }
      }
    }

    // Upsert into interaction_stats
    const nowSec = Math.floor(this.now() / 1000);
    for (const [key, stat] of counts) {
      const [fromUser, toUser] = key.split('|') as [string, string];
      this.dbExec(
        `INSERT INTO interaction_stats (group_id, from_user, to_user, reply_count, mention_count, name_ref_count, last_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_id, from_user, to_user) DO UPDATE SET
           reply_count = reply_count + excluded.reply_count,
           mention_count = mention_count + excluded.mention_count,
           name_ref_count = name_ref_count + excluded.name_ref_count,
           last_updated = excluded.last_updated`,
        groupId, fromUser, toUser, stat.reply, stat.mention, stat.nameRef, nowSec,
      );
    }

    this.logger.info({ groupId, pairCount: counts.size }, 'relationship stats updated');
  }

  // ---- Relationship inference (daily, uses LLM) ----

  async _runInference(): Promise<void> {
    for (const groupId of this.activeGroups) {
      try {
        await this.inferRelationships(groupId);
      } catch (err) {
        this.logger.error({ err, groupId }, 'relationship inference group run failed');
      }
    }
  }

  async inferRelationships(groupId: string): Promise<void> {
    // Find pairs with total interactions > 5
    const pairs = this.dbQuery<{
      from_user: string; to_user: string;
      reply_count: number; mention_count: number; name_ref_count: number;
    }>(
      `SELECT from_user, to_user, reply_count, mention_count, name_ref_count
       FROM interaction_stats
       WHERE group_id = ? AND (reply_count + mention_count + name_ref_count) > 5
       ORDER BY (reply_count + mention_count + name_ref_count) DESC
       LIMIT 50`,
      groupId,
    );

    if (pairs.length === 0) {
      this.logger.debug({ groupId }, 'no significant interaction pairs for inference');
      return;
    }

    // Build nickname lookup for prompt
    const userIds = new Set<string>();
    for (const p of pairs) {
      userIds.add(p.from_user);
      userIds.add(p.to_user);
    }

    const nicknameMap = new Map<string, string>();
    for (const uid of userIds) {
      const user = this.users.findById(uid, groupId);
      if (user) nicknameMap.set(uid, user.nickname);
    }

    // Process each pair
    for (const pair of pairs) {
      try {
        await this._inferPair(groupId, pair.from_user, pair.to_user, nicknameMap);
      } catch (err) {
        this.logger.warn({ err, groupId, from: pair.from_user, to: pair.to_user }, 'pair inference failed');
      }
    }

    this.logger.info({ groupId, pairCount: pairs.length }, 'relationship inference completed');
  }

  private async _inferPair(
    groupId: string,
    fromUser: string,
    toUser: string,
    nicknameMap: Map<string, string>,
  ): Promise<void> {
    // Get recent messages between this pair
    const fromMsgs = this.messages.getByUser(groupId, fromUser, 100);
    const toMsgs = this.messages.getByUser(groupId, toUser, 100);

    // Merge and sort chronologically, keeping only messages near each other
    const allMsgs = [...fromMsgs, ...toMsgs]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-100);

    if (allMsgs.length < 5) return;

    const fromNick = nicknameMap.get(fromUser) ?? fromUser;
    const toNick = nicknameMap.get(toUser) ?? toUser;

    const msgText = allMsgs
      .map(m => `[${m.nickname}]: ${m.content}`)
      .join('\n');

    const prompt = `分析以下两位群友的关系。

群友 A: ${fromNick} (ID: ${fromUser})
群友 B: ${toNick} (ID: ${toUser})

他们最近的对话：
${msgText}

请判断 A 对 B 的关系类型和亲密度。

关系类型（选一个）：
- 铁磁/密友：非常亲近，经常聊天
- 互怼/欢喜冤家：经常互骂但关系好
- CP/暧昧：有暧昧互动
- 前辈后辈：有明确的上下级/前后辈关系
- 普通群友：一般的群友关系
- 冷淡：很少互动
- 敌对：真的不合
- 崇拜/粉丝：一方崇拜另一方

输出 JSON（不要其他内容）：
{
  "fromUser": "${fromUser}",
  "toUser": "${toUser}",
  "type": "关系类型",
  "strength": 0.5,
  "evidence": "简短证据描述（30字以内）"
}

strength 范围 0.0-1.0，越高越强。`;

    const resp = await this.claude.complete({
      model: REFLECTION_MODEL,
      maxTokens: 300,
      system: [{ text: '你是一个社交关系分析助手。只输出 JSON，不要其他内容。', cache: true }],
      messages: [{ role: 'user', content: prompt }],
    });

    const result = extractJson<LlmRelationResult>(resp.text);
    if (!result || !result.type || typeof result.strength !== 'number') {
      this.logger.warn({ groupId, fromUser, toUser, raw: resp.text }, 'LLM returned unparseable relation result');
      return;
    }

    // Validate relation type
    const relType = VALID_RELATION_TYPES.find(t => result.type.includes(t.split('/')[0]!)) ?? '普通群友';
    const strength = Math.max(0, Math.min(1, result.strength));
    const evidence = typeof result.evidence === 'string' ? result.evidence.slice(0, 200) : null;

    const nowSec = Math.floor(this.now() / 1000);
    this.dbExec(
      `INSERT INTO social_relations (group_id, from_user, to_user, relation_type, strength, evidence, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(group_id, from_user, to_user) DO UPDATE SET
         relation_type = excluded.relation_type,
         strength = excluded.strength,
         evidence = excluded.evidence,
         updated_at = excluded.updated_at`,
      groupId, fromUser, toUser, relType, strength, evidence, nowSec,
    );
  }

  // ---- Query API ----

  getRelevantRelations(groupId: string, userIds: string[]): SocialRelation[] {
    if (userIds.length === 0) return [];

    const placeholders = userIds.map(() => '?').join(',');
    const rows = this.dbQuery<{
      group_id: string; from_user: string; to_user: string;
      relation_type: string; strength: number; evidence: string | null; updated_at: number;
    }>(
      `SELECT * FROM social_relations
       WHERE group_id = ? AND (from_user IN (${placeholders}) OR to_user IN (${placeholders}))
       ORDER BY strength DESC
       LIMIT 5`,
      groupId, ...userIds, ...userIds,
    );

    return rows.map(r => ({
      groupId: r.group_id,
      fromUser: r.from_user,
      toUser: r.to_user,
      relationType: r.relation_type,
      strength: r.strength,
      evidence: r.evidence,
      updatedAt: r.updated_at,
    }));
  }

  formatRelationsForPrompt(relations: SocialRelation[], nicknameMap: Map<string, string>): string {
    if (relations.length === 0) return '';

    const lines = relations.map(r => {
      const fromName = nicknameMap.get(r.fromUser) ?? r.fromUser;
      const toName = nicknameMap.get(r.toUser) ?? r.toUser;
      const evidenceStr = r.evidence ? `（${r.evidence}）` : '';
      return `${fromName} 和 ${toName} 的关系：${r.relationType}${evidenceStr}`;
    });

    return `## 群友关系\n${lines.join('\n')}`;
  }
}
