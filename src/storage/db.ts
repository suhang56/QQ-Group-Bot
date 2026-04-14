import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ClaudeModel } from '../ai/claude.js';

// ---- Domain types ----

export interface Message {
  id: number;
  groupId: string;
  userId: string;
  nickname: string;
  content: string;
  rawContent: string;
  timestamp: number;
  deleted: boolean;
}

export interface User {
  userId: string;
  groupId: string;
  nickname: string;
  styleSummary: string | null;
  lastSeen: number;
  role: 'owner' | 'admin' | 'member';
}

export interface ModerationRecord {
  id: number;
  msgId: string;
  groupId: string;
  userId: string;
  violation: boolean;
  severity: number | null;
  action: 'warn' | 'delete' | 'ban' | 'kick' | 'none';
  reason: string;
  appealed: 0 | 1 | 2;
  reversed: boolean;
  timestamp: number;
}

export interface GroupConfig {
  groupId: string;
  enabledModules: string[];
  autoMod: boolean;
  dailyPunishmentLimit: number;
  punishmentsToday: number;
  punishmentsResetDate: string;
  mimicActiveUserId: string | null;
  mimicStartedBy: string | null;
  chatTriggerKeywords: string[];
  chatTriggerAtOnly: boolean;
  chatDebounceMs: number;
  modConfidenceThreshold: number;
  modWhitelist: string[];
  appealWindowHours: number;
  kickConfirmModel: ClaudeModel;
  chatLoreEnabled: boolean;
  nameImagesEnabled: boolean;
  nameImagesCollectionTimeoutMs: number;
  nameImagesCollectionMax: number;
  nameImagesCooldownMs: number;
  nameImagesMaxPerName: number;
  chatAtMentionQueueMax: number;
  chatAtMentionBurstWindowMs: number;
  chatAtMentionBurstThreshold: number;
  repeaterEnabled: boolean;
  repeaterMinCount: number;
  repeaterCooldownMs: number;
  repeaterMinContentLength: number;
  repeaterMaxContentLength: number;
  nameImagesBlocklist: string[];
  loreUpdateEnabled: boolean;
  loreUpdateThreshold: number;
  loreUpdateCooldownMs: number;
  liveStickerCaptureEnabled: boolean;
  stickerLegendRefreshEveryMsgs: number;
  chatPersonaText: string | null;
  welcomeEnabled: boolean;
  idGuardEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NameImage {
  id: number;
  groupId: string;
  name: string;
  filePath: string;
  sourceFile: string | null;
  addedBy: string;
  addedAt: number;
}

export interface Rule {
  id: number;
  groupId: string;
  content: string;
  type: 'positive' | 'negative';
  source: 'manual' | 'announcement';
  embedding: Float32Array | null;
}

export interface GroupAnnouncement {
  id: number;
  groupId: string;
  noticeId: string;
  content: string;
  contentHash: string;
  fetchedAt: number;
  parsedRules: string[];
}

// ---- Repository interfaces ----

export interface TopUser {
  userId: string;
  nickname: string;
  count: number;
}

export interface IMessageRepository {
  insert(msg: Omit<Message, 'id'>, sourceMessageId?: string): Message;
  getRecent(groupId: string, limit: number): Message[];
  getByUser(groupId: string, userId: string, limit: number): Message[];
  sampleRandomHistorical(groupId: string, excludeNewestN: number, sampleSize: number): Message[];
  searchByKeywords(groupId: string, keywords: string[], limit: number): Message[];
  getTopUsers(groupId: string, limit: number): TopUser[];
  softDelete(msgId: string): void;
  findBySourceId(sourceMessageId: string): Message | null;
}

export interface IUserRepository {
  upsert(user: User): void;
  findById(userId: string, groupId: string): User | null;
  getAdminsByGroup(groupId: string, limit: number): User[];
}

export interface IModerationRepository {
  insert(record: Omit<ModerationRecord, 'id'>): ModerationRecord;
  findById(id: number): ModerationRecord | null;
  findByMsgId(msgId: string): ModerationRecord | null;
  findRecentByUser(userId: string, groupId: string, windowMs: number): ModerationRecord[];
  findRecentByGroup(groupId: string, windowMs: number): ModerationRecord[];
  findPendingAppeal(userId: string, groupId: string): ModerationRecord | null;
  update(id: number, patch: Partial<Pick<ModerationRecord, 'appealed' | 'reversed'>>): void;
  countWarnsByUser(userId: string, groupId: string, withinMs: number): number;
}

export interface IGroupConfigRepository {
  get(groupId: string): GroupConfig | null;
  upsert(config: GroupConfig): void;
  incrementPunishments(groupId: string): void;
  resetDailyPunishments(groupId: string): void;
}

export interface IRuleRepository {
  insert(rule: Omit<Rule, 'id'>): Rule;
  findById(id: number): Rule | null;
  getAll(groupId: string): Rule[];
  getPage(groupId: string, offset: number, limit: number): { rules: Rule[]; total: number };
  deleteBySource(groupId: string, source: Rule['source']): number;
}

export interface IAnnouncementRepository {
  upsert(ann: Omit<GroupAnnouncement, 'id'>): GroupAnnouncement;
  getByNoticeId(groupId: string, noticeId: string): GroupAnnouncement | null;
  getLatest(groupId: string): GroupAnnouncement | null;
}

export interface INameImageRepository {
  /** Returns null on dedup (source_file conflict) or cap reached (maxPerName exceeded). */
  insert(groupId: string, name: string, filePath: string, sourceFile: string | null, addedBy: string, maxPerName: number): NameImage | null;
  listByName(groupId: string, name: string): NameImage[];
  countByName(groupId: string, name: string): number;
  pickRandom(groupId: string, name: string): NameImage | null;
  getAllNames(groupId: string): string[];
}

export interface LiveSticker {
  id: number;
  groupId: string;
  key: string;
  type: 'mface' | 'image';
  cqCode: string;
  summary: string | null;
  count: number;
  firstSeen: number;
  lastSeen: number;
}

export interface ILiveStickerRepository {
  upsert(groupId: string, key: string, type: LiveSticker['type'], cqCode: string, summary: string | null, now: number): void;
  getTopByGroup(groupId: string, limit: number): LiveSticker[];
}

export interface IImageDescriptionRepository {
  get(fileKey: string): string | null;
  set(fileKey: string, description: string, now: number): void;
  purgeOlderThan(cutoffTs: number): number;
}

export interface IForwardCacheRepository {
  get(forwardId: string): { expandedText: string; nestedImageKeys: string[] } | null;
  put(forwardId: string, expandedText: string, nestedImageKeys: string[], now: number): void;
  deleteExpired(beforeTs: number): number;
}

export interface ImageModVerdict {
  fileKey: string;
  violation: boolean;
  severity: number;
  reason: string | null;
  ruleId: number | null;
  createdAt: number;
}

export interface IImageModCacheRepository {
  get(fileKey: string): ImageModVerdict | null;
  set(verdict: ImageModVerdict): void;
  purgeOlderThan(cutoffTs: number): number;
}

export interface BotReply {
  id: number;
  groupId: string;
  triggerMsgId: string | null;
  triggerUserNickname: string | null;
  triggerContent: string;
  botReply: string;
  module: string;
  sentAt: number;
  rating: number | null;
  ratingComment: string | null;
  ratedAt: number | null;
  wasEvasive: boolean;
}

export interface IBotReplyRepository {
  insert(row: Omit<BotReply, 'id' | 'rating' | 'ratingComment' | 'ratedAt' | 'wasEvasive'>): BotReply;
  getUnrated(groupId: string, limit: number): BotReply[];
  getRecent(groupId: string, limit: number): BotReply[];
  rate(id: number, rating: number, comment: string | null, now: number): void;
  /** Mark a previously-inserted reply as evasive (bot punted with "忘了" / "考我呢" / etc.). */
  markEvasive(id: number): void;
  /** Fetch a single bot reply by primary key. */
  getById(id: number): BotReply | null;
  /** List all evasive bot replies in a group emitted since `sinceTs` (epoch seconds), newest-first. */
  listEvasiveSince(groupId: string, sinceTs: number): BotReply[];
}

export interface LearnedFact {
  id: number;
  groupId: string;
  topic: string | null;
  fact: string;
  sourceUserId: string | null;
  sourceUserNickname: string | null;
  sourceMsgId: string | null;
  botReplyId: number | null;
  confidence: number;
  status: 'active' | 'superseded' | 'rejected';
  createdAt: number;
  updatedAt: number;
}

export interface ILearnedFactsRepository {
  insert(row: {
    groupId: string;
    topic: string | null;
    fact: string;
    sourceUserId: string | null;
    sourceUserNickname: string | null;
    sourceMsgId: string | null;
    botReplyId: number | null;
    confidence?: number;
  }): number;
  listActive(groupId: string, limit: number): LearnedFact[];
  markStatus(id: number, status: LearnedFact['status']): void;
  clearGroup(groupId: string): number;
  countActive(groupId: string): number;
}

export type ProposedAction = 'warn' | 'delete' | 'mute_10m' | 'mute_1h' | 'kick';
export type PendingStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface PendingModeration {
  id: number;
  groupId: string;
  msgId: string;
  userId: string;
  userNickname: string | null;
  content: string;
  severity: number;
  reason: string;
  proposedAction: ProposedAction;
  status: PendingStatus;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
}

export interface IPendingModerationRepository {
  queue(row: Omit<PendingModeration, 'id' | 'status' | 'decidedAt' | 'decidedBy'>): number;
  getById(id: number): PendingModeration | null;
  markStatus(id: number, status: PendingStatus, decidedBy?: string): void;
  expireOlderThan(cutoffSec: number): number;
  listPending(limit: number): PendingModeration[];
}

export interface IWelcomeLogRepository {
  record(groupId: string, userId: string, nowSec: number): void;
  lastWelcomeAt(groupId: string, userId: string): number | null;
}

export interface LocalSticker {
  id: number;
  groupId: string;
  key: string;
  type: 'image' | 'mface';
  localPath: string | null;
  cqCode: string;
  summary: string | null;
  contextSamples: string[];
  count: number;
  firstSeen: number;
  lastSeen: number;
  usagePositive: number;
  usageNegative: number;
}

export interface ILocalStickerRepository {
  upsert(
    groupId: string, key: string, type: LocalSticker['type'],
    localPath: string | null, cqCode: string, summary: string | null,
    contextSample: string | null, now: number, maxSamples: number,
  ): 'inserted' | 'updated';
  getTopByGroup(groupId: string, limit: number): LocalSticker[];
  recordUsage(groupId: string, key: string, positive: boolean): void;
}

// ---- Raw row types from SQLite ----

interface MessageRow {
  id: number; group_id: string; user_id: string; nickname: string;
  content: string; raw_content: string | null; timestamp: number; deleted: number; source_message_id: string | null;
}

interface UserRow {
  user_id: string; group_id: string; nickname: string;
  style_summary: string | null; last_seen: number; role: string;
}

interface ModerationRow {
  id: number; msg_id: string; group_id: string; user_id: string;
  violation: number; severity: number | null; action: string;
  reason: string; appealed: number; reversed: number; timestamp: number;
}

interface GroupConfigRow {
  group_id: string; enabled_modules: string; auto_mod: number;
  daily_punishment_limit: number; punishments_today: number;
  punishments_reset_date: string; mimic_active_user_id: string | null;
  mimic_started_by: string | null; chat_trigger_keywords: string;
  chat_trigger_at_only: number; chat_debounce_ms: number;
  mod_confidence_threshold: number; mod_whitelist: string;
  appeal_window_hours: number; kick_confirm_model: string;
  name_images_enabled: number; name_images_collection_timeout_ms: number;
  name_images_collection_max: number; name_images_cooldown_ms: number;
  name_images_max_per_name: number;
  chat_at_mention_queue_max: number;
  chat_at_mention_burst_window_ms: number;
  chat_at_mention_burst_threshold: number;
  repeater_enabled: number;
  repeater_min_count: number;
  repeater_cooldown_ms: number;
  repeater_min_content_length: number;
  repeater_max_content_length: number;
  name_images_blocklist: string;
  lore_update_enabled: number;
  lore_update_threshold: number;
  lore_update_cooldown_ms: number;
  live_sticker_capture_enabled: number;
  sticker_legend_refresh_every_msgs: number;
  chat_persona_text: string | null;
  welcome_enabled: number;
  id_guard_enabled: number;
  created_at: string; updated_at: string;
}

interface NameImageRow {
  id: number; group_id: string; name: string; file_path: string;
  source_file: string | null; added_by: string; added_at: number;
}

interface RuleRow {
  id: number; group_id: string; content: string; type: string; source: string; embedding_vec: Buffer | null;
}

interface AnnouncementRow {
  id: number; group_id: string; notice_id: string; content: string;
  content_hash: string; fetched_at: number; parsed_rules: string;
}

interface CountRow { count: number }

// ---- Mappers ----

function msgFromRow(row: MessageRow): Message {
  return {
    id: row.id, groupId: row.group_id, userId: row.user_id,
    nickname: row.nickname, content: row.content,
    rawContent: row.raw_content ?? row.content,
    timestamp: row.timestamp, deleted: row.deleted !== 0,
  };
}

function userFromRow(row: UserRow): User {
  return {
    userId: row.user_id, groupId: row.group_id, nickname: row.nickname,
    styleSummary: row.style_summary, lastSeen: row.last_seen,
    role: (row.role as 'owner' | 'admin' | 'member') ?? 'member',
  };
}

function modFromRow(row: ModerationRow): ModerationRecord {
  return {
    id: row.id, msgId: row.msg_id, groupId: row.group_id, userId: row.user_id,
    violation: row.violation !== 0,
    severity: row.severity,
    action: row.action as ModerationRecord['action'],
    reason: row.reason,
    appealed: row.appealed as 0 | 1 | 2,
    reversed: row.reversed !== 0,
    timestamp: row.timestamp,
  };
}

function configFromRow(row: GroupConfigRow): GroupConfig {
  return {
    groupId: row.group_id,
    enabledModules: row.enabled_modules.split(',').filter(Boolean),
    autoMod: row.auto_mod !== 0,
    dailyPunishmentLimit: row.daily_punishment_limit,
    punishmentsToday: row.punishments_today,
    punishmentsResetDate: row.punishments_reset_date,
    mimicActiveUserId: row.mimic_active_user_id,
    mimicStartedBy: row.mimic_started_by,
    chatTriggerKeywords: JSON.parse(row.chat_trigger_keywords) as string[],
    chatTriggerAtOnly: row.chat_trigger_at_only !== 0,
    chatDebounceMs: row.chat_debounce_ms,
    modConfidenceThreshold: row.mod_confidence_threshold,
    modWhitelist: JSON.parse(row.mod_whitelist) as string[],
    appealWindowHours: row.appeal_window_hours,
    kickConfirmModel: row.kick_confirm_model as ClaudeModel,
    chatLoreEnabled: true, // not persisted in DB; always default to enabled
    nameImagesEnabled: (row.name_images_enabled ?? 1) !== 0,
    nameImagesCollectionTimeoutMs: row.name_images_collection_timeout_ms ?? 120_000,
    nameImagesCollectionMax: row.name_images_collection_max ?? 20,
    nameImagesCooldownMs: row.name_images_cooldown_ms ?? 300_000,
    nameImagesMaxPerName: row.name_images_max_per_name ?? 50,
    chatAtMentionQueueMax: row.chat_at_mention_queue_max ?? 5,
    chatAtMentionBurstWindowMs: row.chat_at_mention_burst_window_ms ?? 30_000,
    chatAtMentionBurstThreshold: row.chat_at_mention_burst_threshold ?? 3,
    repeaterEnabled: (row.repeater_enabled ?? 1) !== 0,
    repeaterMinCount: row.repeater_min_count ?? 3,
    repeaterCooldownMs: row.repeater_cooldown_ms ?? 600_000,
    repeaterMinContentLength: row.repeater_min_content_length ?? 2,
    repeaterMaxContentLength: row.repeater_max_content_length ?? 100,
    nameImagesBlocklist: JSON.parse(row.name_images_blocklist ?? '[]') as string[],
    loreUpdateEnabled: (row.lore_update_enabled ?? 1) !== 0,
    loreUpdateThreshold: row.lore_update_threshold ?? 200,
    loreUpdateCooldownMs: row.lore_update_cooldown_ms ?? 1_800_000,
    liveStickerCaptureEnabled: (row.live_sticker_capture_enabled ?? 1) !== 0,
    stickerLegendRefreshEveryMsgs: row.sticker_legend_refresh_every_msgs ?? 50,
    chatPersonaText: row.chat_persona_text ?? null,
    welcomeEnabled: (row.welcome_enabled ?? 1) !== 0,
    idGuardEnabled: (row.id_guard_enabled ?? 1) !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nameImageFromRow(row: NameImageRow): NameImage {
  return {
    id: row.id, groupId: row.group_id, name: row.name,
    filePath: row.file_path, sourceFile: row.source_file,
    addedBy: row.added_by, addedAt: row.added_at,
  };
}

function ruleFromRow(row: RuleRow): Rule {
  let embedding: Float32Array | null = null;
  if (row.embedding_vec) {
    embedding = new Float32Array(row.embedding_vec.buffer, row.embedding_vec.byteOffset, row.embedding_vec.byteLength / 4);
  }
  return {
    id: row.id, groupId: row.group_id, content: row.content,
    type: row.type as 'positive' | 'negative',
    source: (row.source ?? 'manual') as Rule['source'],
    embedding,
  };
}

function announcementFromRow(row: AnnouncementRow): GroupAnnouncement {
  return {
    id: row.id, groupId: row.group_id, noticeId: row.notice_id,
    content: row.content, contentHash: row.content_hash,
    fetchedAt: row.fetched_at,
    parsedRules: JSON.parse(row.parsed_rules) as string[],
  };
}

// ---- Repository implementations ----

class MessageRepository implements IMessageRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(msg: Omit<Message, 'id'>, sourceMessageId?: string): Message {
    const sid = sourceMessageId ?? null;
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO messages (group_id, user_id, nickname, content, raw_content, timestamp, deleted, source_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const result = stmt.run(msg.groupId, msg.userId, msg.nickname, msg.content, msg.rawContent ?? null, msg.timestamp, msg.deleted ? 1 : 0, sid);
    // id=0 signals the row was ignored (duplicate source_message_id)
    const id = (result as { changes: number }).changes > 0 ? Number(result.lastInsertRowid) : 0;
    return { ...msg, id };
  }

  getRecent(groupId: string, limit: number): Message[] {
    const rows = this.db.prepare(
      'SELECT * FROM messages WHERE group_id = ? AND deleted = 0 ORDER BY timestamp DESC LIMIT ?'
    ).all(groupId, limit) as unknown as MessageRow[];
    return rows.map(msgFromRow);
  }

  getByUser(groupId: string, userId: string, limit: number): Message[] {
    const rows = this.db.prepare(
      'SELECT * FROM messages WHERE group_id = ? AND user_id = ? AND deleted = 0 ORDER BY timestamp DESC LIMIT ?'
    ).all(groupId, userId, limit) as unknown as MessageRow[];
    return rows.map(msgFromRow);
  }

  sampleRandomHistorical(groupId: string, excludeNewestN: number, sampleSize: number): Message[] {
    if (sampleSize <= 0) return [];
    const rows = this.db.prepare(
      `SELECT * FROM messages
       WHERE group_id = ? AND deleted = 0
         AND id NOT IN (
           SELECT id FROM messages WHERE group_id = ? AND deleted = 0
           ORDER BY timestamp DESC LIMIT ?
         )
       ORDER BY RANDOM() LIMIT ?`
    ).all(groupId, groupId, excludeNewestN, sampleSize) as unknown as MessageRow[];
    return rows.map(msgFromRow);
  }

  searchByKeywords(groupId: string, keywords: string[], limit: number): Message[] {
    if (keywords.length === 0) return [];
    const capped = keywords.slice(0, 5);
    const likes = capped.map(() => 'content LIKE ?').join(' OR ');
    const params = [groupId, ...capped.map(k => `%${k}%`), limit] as Parameters<typeof this.db.prepare>[0][];
    const rows = this.db.prepare(
      `SELECT * FROM messages WHERE group_id = ? AND deleted = 0 AND (${likes}) ORDER BY timestamp DESC LIMIT ?`
    ).all(...(params as unknown as [string, ...string[]])) as unknown as MessageRow[];
    return rows.map(msgFromRow);
  }

  getTopUsers(groupId: string, limit: number): TopUser[] {
    const rows = this.db.prepare(
      `SELECT user_id, nickname, COUNT(*) as count
       FROM messages WHERE group_id = ? AND deleted = 0
       GROUP BY user_id ORDER BY count DESC LIMIT ?`
    ).all(groupId, limit) as unknown as { user_id: string; nickname: string; count: number }[];
    return rows.map(r => ({ userId: r.user_id, nickname: r.nickname, count: r.count }));
  }

  softDelete(msgId: string): void {
    this.db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run(Number(msgId));
  }

  findBySourceId(sourceMessageId: string): Message | null {
    const row = this.db.prepare(
      'SELECT * FROM messages WHERE source_message_id = ? LIMIT 1'
    ).get(sourceMessageId) as MessageRow | undefined;
    return row ? msgFromRow(row) : null;
  }
}

class UserRepository implements IUserRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(user: User): void {
    this.db.prepare(`
      INSERT INTO users (user_id, group_id, nickname, style_summary, last_seen, role)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, group_id) DO UPDATE SET
        nickname = excluded.nickname,
        style_summary = excluded.style_summary,
        last_seen = excluded.last_seen,
        role = excluded.role
    `).run(user.userId, user.groupId, user.nickname, user.styleSummary, user.lastSeen, user.role ?? 'member');
  }

  findById(userId: string, groupId: string): User | null {
    const row = this.db.prepare(
      'SELECT * FROM users WHERE user_id = ? AND group_id = ?'
    ).get(userId, groupId) as unknown as UserRow | undefined;
    return row ? userFromRow(row) : null;
  }

  getAdminsByGroup(groupId: string, limit: number): User[] {
    const rows = this.db.prepare(
      "SELECT * FROM users WHERE group_id = ? AND role IN ('admin','owner') LIMIT ?"
    ).all(groupId, limit) as unknown as UserRow[];
    return rows.map(userFromRow);
  }
}

class ModerationRepository implements IModerationRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(record: Omit<ModerationRecord, 'id'>): ModerationRecord {
    const stmt = this.db.prepare(`
      INSERT INTO moderation_log (msg_id, group_id, user_id, violation, severity, action, reason, appealed, reversed, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      record.msgId, record.groupId, record.userId,
      record.violation ? 1 : 0, record.severity, record.action,
      record.reason, record.appealed, record.reversed ? 1 : 0, record.timestamp
    );
    return { ...record, id: Number(result.lastInsertRowid) };
  }

  findById(id: number): ModerationRecord | null {
    const row = this.db.prepare('SELECT * FROM moderation_log WHERE id = ?').get(id) as unknown as ModerationRow | undefined;
    return row ? modFromRow(row) : null;
  }

  findByMsgId(msgId: string): ModerationRecord | null {
    const row = this.db.prepare('SELECT * FROM moderation_log WHERE msg_id = ? LIMIT 1').get(msgId) as unknown as ModerationRow | undefined;
    return row ? modFromRow(row) : null;
  }

  findRecentByUser(userId: string, groupId: string, windowMs: number): ModerationRecord[] {
    const since = Math.floor(Date.now() / 1000) - Math.floor(windowMs / 1000);
    const rows = this.db.prepare(
      'SELECT * FROM moderation_log WHERE user_id = ? AND group_id = ? AND timestamp >= ? ORDER BY timestamp DESC'
    ).all(userId, groupId, since) as unknown as ModerationRow[];
    return rows.map(modFromRow);
  }

  findRecentByGroup(groupId: string, windowMs: number): ModerationRecord[] {
    const since = Math.floor(Date.now() / 1000) - Math.floor(windowMs / 1000);
    const rows = this.db.prepare(
      'SELECT * FROM moderation_log WHERE group_id = ? AND timestamp >= ? ORDER BY timestamp DESC'
    ).all(groupId, since) as unknown as ModerationRow[];
    return rows.map(modFromRow);
  }

  findPendingAppeal(userId: string, groupId: string): ModerationRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM moderation_log WHERE user_id = ? AND group_id = ? AND appealed = 0 ORDER BY timestamp DESC LIMIT 1'
    ).get(userId, groupId) as unknown as ModerationRow | undefined;
    return row ? modFromRow(row) : null;
  }

  update(id: number, patch: Partial<Pick<ModerationRecord, 'appealed' | 'reversed'>>): void {
    if (patch.appealed !== undefined) {
      this.db.prepare('UPDATE moderation_log SET appealed = ? WHERE id = ?').run(patch.appealed, id);
    }
    if (patch.reversed !== undefined) {
      this.db.prepare('UPDATE moderation_log SET reversed = ? WHERE id = ?').run(patch.reversed ? 1 : 0, id);
    }
  }

  countWarnsByUser(userId: string, groupId: string, withinMs: number): number {
    const since = Math.floor(Date.now() / 1000) - Math.floor(withinMs / 1000);
    const row = this.db.prepare(
      "SELECT COUNT(*) as count FROM moderation_log WHERE user_id = ? AND group_id = ? AND action = 'warn' AND timestamp >= ?"
    ).get(userId, groupId, since) as unknown as CountRow;
    return row.count;
  }
}

class GroupConfigRepository implements IGroupConfigRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(groupId: string): GroupConfig | null {
    const row = this.db.prepare('SELECT * FROM group_config WHERE group_id = ?').get(groupId) as unknown as GroupConfigRow | undefined;
    return row ? configFromRow(row) : null;
  }

  upsert(config: GroupConfig): void {
    this.db.prepare(`
      INSERT INTO group_config (
        group_id, enabled_modules, auto_mod, daily_punishment_limit, punishments_today,
        punishments_reset_date, mimic_active_user_id, mimic_started_by,
        chat_trigger_keywords, chat_trigger_at_only, chat_debounce_ms,
        mod_confidence_threshold, mod_whitelist, appeal_window_hours,
        kick_confirm_model,
        name_images_enabled, name_images_collection_timeout_ms,
        name_images_collection_max, name_images_cooldown_ms, name_images_max_per_name,
        name_images_blocklist,
        lore_update_enabled, lore_update_threshold, lore_update_cooldown_ms,
        live_sticker_capture_enabled, sticker_legend_refresh_every_msgs,
        chat_persona_text, welcome_enabled, id_guard_enabled,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(group_id) DO UPDATE SET
        enabled_modules = excluded.enabled_modules,
        auto_mod = excluded.auto_mod,
        daily_punishment_limit = excluded.daily_punishment_limit,
        punishments_today = excluded.punishments_today,
        punishments_reset_date = excluded.punishments_reset_date,
        mimic_active_user_id = excluded.mimic_active_user_id,
        mimic_started_by = excluded.mimic_started_by,
        chat_trigger_keywords = excluded.chat_trigger_keywords,
        chat_trigger_at_only = excluded.chat_trigger_at_only,
        chat_debounce_ms = excluded.chat_debounce_ms,
        mod_confidence_threshold = excluded.mod_confidence_threshold,
        mod_whitelist = excluded.mod_whitelist,
        appeal_window_hours = excluded.appeal_window_hours,
        kick_confirm_model = excluded.kick_confirm_model,
        name_images_enabled = excluded.name_images_enabled,
        name_images_collection_timeout_ms = excluded.name_images_collection_timeout_ms,
        name_images_collection_max = excluded.name_images_collection_max,
        name_images_cooldown_ms = excluded.name_images_cooldown_ms,
        name_images_max_per_name = excluded.name_images_max_per_name,
        name_images_blocklist = excluded.name_images_blocklist,
        lore_update_enabled = excluded.lore_update_enabled,
        lore_update_threshold = excluded.lore_update_threshold,
        lore_update_cooldown_ms = excluded.lore_update_cooldown_ms,
        live_sticker_capture_enabled = excluded.live_sticker_capture_enabled,
        sticker_legend_refresh_every_msgs = excluded.sticker_legend_refresh_every_msgs,
        chat_persona_text = excluded.chat_persona_text,
        welcome_enabled = excluded.welcome_enabled,
        id_guard_enabled = excluded.id_guard_enabled,
        updated_at = excluded.updated_at
    `).run(
      config.groupId,
      config.enabledModules.join(','),
      config.autoMod ? 1 : 0,
      config.dailyPunishmentLimit,
      config.punishmentsToday,
      config.punishmentsResetDate,
      config.mimicActiveUserId,
      config.mimicStartedBy,
      JSON.stringify(config.chatTriggerKeywords),
      config.chatTriggerAtOnly ? 1 : 0,
      config.chatDebounceMs,
      config.modConfidenceThreshold,
      JSON.stringify(config.modWhitelist),
      config.appealWindowHours,
      config.kickConfirmModel,
      (config.nameImagesEnabled ?? true) ? 1 : 0,
      config.nameImagesCollectionTimeoutMs ?? 120_000,
      config.nameImagesCollectionMax ?? 20,
      config.nameImagesCooldownMs ?? 300_000,
      config.nameImagesMaxPerName ?? 50,
      JSON.stringify(config.nameImagesBlocklist ?? []),
      (config.loreUpdateEnabled ?? true) ? 1 : 0,
      config.loreUpdateThreshold ?? 200,
      config.loreUpdateCooldownMs ?? 1_800_000,
      (config.liveStickerCaptureEnabled ?? true) ? 1 : 0,
      config.stickerLegendRefreshEveryMsgs ?? 50,
      config.chatPersonaText ?? null,
      (config.welcomeEnabled ?? true) ? 1 : 0,
      (config.idGuardEnabled ?? true) ? 1 : 0,
      config.createdAt,
      config.updatedAt,
    );
  }

  incrementPunishments(groupId: string): void {
    this.db.prepare(
      'UPDATE group_config SET punishments_today = punishments_today + 1, updated_at = ? WHERE group_id = ?'
    ).run(new Date().toISOString(), groupId);
  }

  resetDailyPunishments(groupId: string): void {
    this.db.prepare(
      "UPDATE group_config SET punishments_today = 0, punishments_reset_date = ?, updated_at = ? WHERE group_id = ?"
    ).run(new Date().toISOString().slice(0, 10), new Date().toISOString(), groupId);
  }
}

class RuleRepository implements IRuleRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(rule: Omit<Rule, 'id'>): Rule {
    let embBuf: Buffer | null = null;
    if (rule.embedding) {
      const f = rule.embedding;
      // Use byteOffset+byteLength to slice the view correctly — avoids writing the parent
      // buffer when `f` is a view (e.g. produced by ruleFromRow after a DB read-back).
      embBuf = Buffer.from(new Uint8Array(f.buffer, f.byteOffset, f.byteLength));
    }
    const source = rule.source ?? 'manual';
    const result = this.db.prepare(
      'INSERT INTO rules (group_id, content, type, source, embedding_vec) VALUES (?, ?, ?, ?, ?)'
    ).run(rule.groupId, rule.content, rule.type, source, embBuf);
    return { ...rule, source, id: Number(result.lastInsertRowid) };
  }

  deleteBySource(groupId: string, source: Rule['source']): number {
    const result = this.db.prepare(
      'DELETE FROM rules WHERE group_id = ? AND source = ?'
    ).run(groupId, source);
    return (result as { changes: number }).changes;
  }

  findById(id: number): Rule | null {
    const row = this.db.prepare('SELECT * FROM rules WHERE id = ?').get(id) as unknown as RuleRow | undefined;
    return row ? ruleFromRow(row) : null;
  }

  getAll(groupId: string): Rule[] {
    const rows = this.db.prepare('SELECT * FROM rules WHERE group_id = ?').all(groupId) as unknown as RuleRow[];
    return rows.map(ruleFromRow);
  }

  getPage(groupId: string, offset: number, limit: number): { rules: Rule[]; total: number } {
    const total = (this.db.prepare('SELECT COUNT(*) as count FROM rules WHERE group_id = ?').get(groupId) as unknown as CountRow).count;
    const rows = this.db.prepare('SELECT * FROM rules WHERE group_id = ? LIMIT ? OFFSET ?').all(groupId, limit, offset) as unknown as RuleRow[];
    return { rules: rows.map(ruleFromRow), total };
  }
}

class AnnouncementRepository implements IAnnouncementRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(ann: Omit<GroupAnnouncement, 'id'>): GroupAnnouncement {
    const result = this.db.prepare(`
      INSERT INTO group_announcements (group_id, notice_id, content, content_hash, fetched_at, parsed_rules)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(group_id, notice_id) DO UPDATE SET
        content = excluded.content,
        content_hash = excluded.content_hash,
        fetched_at = excluded.fetched_at,
        parsed_rules = excluded.parsed_rules
    `).run(
      ann.groupId, ann.noticeId, ann.content, ann.contentHash,
      ann.fetchedAt, JSON.stringify(ann.parsedRules)
    );
    const id = Number(result.lastInsertRowid) || (
      (this.db.prepare('SELECT id FROM group_announcements WHERE group_id = ? AND notice_id = ?')
        .get(ann.groupId, ann.noticeId) as { id: number }).id
    );
    return { ...ann, id };
  }

  getByNoticeId(groupId: string, noticeId: string): GroupAnnouncement | null {
    const row = this.db.prepare(
      'SELECT * FROM group_announcements WHERE group_id = ? AND notice_id = ?'
    ).get(groupId, noticeId) as unknown as AnnouncementRow | undefined;
    return row ? announcementFromRow(row) : null;
  }

  getLatest(groupId: string): GroupAnnouncement | null {
    const row = this.db.prepare(
      'SELECT * FROM group_announcements WHERE group_id = ? ORDER BY fetched_at DESC LIMIT 1'
    ).get(groupId) as unknown as AnnouncementRow | undefined;
    return row ? announcementFromRow(row) : null;
  }
}

class NameImageRepository implements INameImageRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(groupId: string, name: string, filePath: string, sourceFile: string | null, addedBy: string, maxPerName: number): NameImage | null {
    const addedAt = Math.floor(Date.now() / 1000);
    // Enforce cap at the repository layer — single-row count check before insert
    const current = this.countByName(groupId, name);
    if (current >= maxPerName) return null;
    let lastId: number;
    if (sourceFile !== null) {
      // Use INSERT OR IGNORE — returns 0 changes on dedup
      const result = this.db.prepare(
        'INSERT OR IGNORE INTO name_images (group_id, name, file_path, source_file, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(groupId, name, filePath, sourceFile, addedBy, addedAt) as { changes: number; lastInsertRowid: number };
      if (result.changes === 0) return null;
      lastId = result.lastInsertRowid;
    } else {
      const result = this.db.prepare(
        'INSERT INTO name_images (group_id, name, file_path, source_file, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(groupId, name, filePath, null, addedBy, addedAt) as { lastInsertRowid: number };
      lastId = result.lastInsertRowid;
    }
    const row = this.db.prepare(
      'SELECT * FROM name_images WHERE id = ?'
    ).get(lastId) as unknown as NameImageRow;
    return nameImageFromRow(row);
  }

  listByName(groupId: string, name: string): NameImage[] {
    const rows = this.db.prepare(
      'SELECT * FROM name_images WHERE group_id = ? AND name = ? ORDER BY added_at DESC'
    ).all(groupId, name) as unknown as NameImageRow[];
    return rows.map(nameImageFromRow);
  }

  countByName(groupId: string, name: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM name_images WHERE group_id = ? AND name = ?'
    ).get(groupId, name) as unknown as CountRow;
    return row.count;
  }

  pickRandom(groupId: string, name: string): NameImage | null {
    const row = this.db.prepare(
      'SELECT * FROM name_images WHERE group_id = ? AND name = ? ORDER BY RANDOM() LIMIT 1'
    ).get(groupId, name) as unknown as NameImageRow | undefined;
    return row ? nameImageFromRow(row) : null;
  }

  getAllNames(groupId: string): string[] {
    const rows = this.db.prepare(
      'SELECT DISTINCT name FROM name_images WHERE group_id = ? ORDER BY name'
    ).all(groupId) as unknown as { name: string }[];
    return rows.map(r => r.name);
  }
}

class LiveStickerRepository implements ILiveStickerRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(groupId: string, key: string, type: LiveSticker['type'], cqCode: string, summary: string | null, now: number): void {
    this.db.prepare(`
      INSERT INTO live_stickers (group_id, key, type, cq_code, summary, count, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(group_id, key) DO UPDATE SET
        count = count + 1,
        last_seen = excluded.last_seen
    `).run(groupId, key, type, cqCode, summary, now, now);
  }

  getTopByGroup(groupId: string, limit: number): LiveSticker[] {
    const rows = this.db.prepare(
      'SELECT * FROM live_stickers WHERE group_id = ? ORDER BY count DESC LIMIT ?'
    ).all(groupId, limit) as unknown as Array<{
      id: number; group_id: string; key: string; type: string;
      cq_code: string; summary: string | null; count: number;
      first_seen: number; last_seen: number;
    }>;
    return rows.map(r => ({
      id: r.id, groupId: r.group_id, key: r.key,
      type: r.type as LiveSticker['type'], cqCode: r.cq_code,
      summary: r.summary, count: r.count,
      firstSeen: r.first_seen, lastSeen: r.last_seen,
    }));
  }
}

class ImageDescriptionRepository implements IImageDescriptionRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(fileKey: string): string | null {
    const row = this.db.prepare(
      'SELECT description FROM image_descriptions WHERE file_key = ?'
    ).get(fileKey) as unknown as { description: string } | undefined;
    return row?.description ?? null;
  }

  set(fileKey: string, description: string, now: number): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO image_descriptions (file_key, description, created_at) VALUES (?, ?, ?)'
    ).run(fileKey, description, now);
  }

  purgeOlderThan(cutoffTs: number): number {
    const result = this.db.prepare(
      'DELETE FROM image_descriptions WHERE created_at < ?'
    ).run(cutoffTs) as { changes: number };
    return result.changes;
  }
}

class ImageModCacheRepository implements IImageModCacheRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(fileKey: string): ImageModVerdict | null {
    const row = this.db.prepare(
      'SELECT file_key, violation, severity, reason, rule_id, created_at FROM image_mod_cache WHERE file_key = ?'
    ).get(fileKey) as unknown as { file_key: string; violation: number; severity: number; reason: string | null; rule_id: number | null; created_at: number } | undefined;
    if (!row) return null;
    return {
      fileKey: row.file_key,
      violation: row.violation !== 0,
      severity: row.severity,
      reason: row.reason,
      ruleId: row.rule_id,
      createdAt: row.created_at,
    };
  }

  set(verdict: ImageModVerdict): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO image_mod_cache (file_key, violation, severity, reason, rule_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(verdict.fileKey, verdict.violation ? 1 : 0, verdict.severity, verdict.reason, verdict.ruleId, verdict.createdAt);
  }

  purgeOlderThan(cutoffTs: number): number {
    const result = this.db.prepare(
      'DELETE FROM image_mod_cache WHERE created_at < ?'
    ).run(cutoffTs) as { changes: number };
    return result.changes;
  }
}

class ForwardCacheRepository implements IForwardCacheRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(forwardId: string): { expandedText: string; nestedImageKeys: string[] } | null {
    const row = this.db.prepare(
      'SELECT expanded_text, nested_image_keys FROM forward_cache WHERE forward_id = ?'
    ).get(forwardId) as unknown as { expanded_text: string; nested_image_keys: string } | undefined;
    if (!row) return null;
    return {
      expandedText: row.expanded_text,
      nestedImageKeys: JSON.parse(row.nested_image_keys) as string[],
    };
  }

  put(forwardId: string, expandedText: string, nestedImageKeys: string[], now: number): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO forward_cache (forward_id, expanded_text, nested_image_keys, fetched_at) VALUES (?, ?, ?, ?)'
    ).run(forwardId, expandedText, JSON.stringify(nestedImageKeys), now);
  }

  deleteExpired(beforeTs: number): number {
    const result = this.db.prepare(
      'DELETE FROM forward_cache WHERE fetched_at < ?'
    ).run(beforeTs) as { changes: number };
    return result.changes;
  }
}

interface BotReplyRow {
  id: number; group_id: string; trigger_msg_id: string | null;
  trigger_user_nickname: string | null; trigger_content: string;
  bot_reply: string; module: string; sent_at: number;
  rating: number | null; rating_comment: string | null; rated_at: number | null;
  was_evasive: number | null;
}

function botReplyFromRow(r: BotReplyRow): BotReply {
  return {
    id: r.id, groupId: r.group_id, triggerMsgId: r.trigger_msg_id,
    triggerUserNickname: r.trigger_user_nickname, triggerContent: r.trigger_content,
    botReply: r.bot_reply, module: r.module, sentAt: r.sent_at,
    rating: r.rating, ratingComment: r.rating_comment, ratedAt: r.rated_at,
    wasEvasive: (r.was_evasive ?? 0) !== 0,
  };
}

class BotReplyRepository implements IBotReplyRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(row: Omit<BotReply, 'id' | 'rating' | 'ratingComment' | 'ratedAt' | 'wasEvasive'>): BotReply {
    const result = this.db.prepare(`
      INSERT INTO bot_replies (group_id, trigger_msg_id, trigger_user_nickname, trigger_content, bot_reply, module, sent_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(row.groupId, row.triggerMsgId ?? null, row.triggerUserNickname ?? null, row.triggerContent, row.botReply, row.module, row.sentAt);
    return { ...row, id: Number(result.lastInsertRowid), rating: null, ratingComment: null, ratedAt: null, wasEvasive: false };
  }

  getUnrated(groupId: string, limit: number): BotReply[] {
    const rows = this.db.prepare(
      'SELECT * FROM bot_replies WHERE group_id = ? AND rating IS NULL ORDER BY sent_at DESC LIMIT ?'
    ).all(groupId, limit) as unknown as BotReplyRow[];
    return rows.map(botReplyFromRow);
  }

  getRecent(groupId: string, limit: number): BotReply[] {
    const rows = this.db.prepare(
      'SELECT * FROM bot_replies WHERE group_id = ? ORDER BY sent_at DESC LIMIT ?'
    ).all(groupId, limit) as unknown as BotReplyRow[];
    return rows.map(botReplyFromRow);
  }

  rate(id: number, rating: number, comment: string | null, now: number): void {
    this.db.prepare(
      'UPDATE bot_replies SET rating = ?, rating_comment = ?, rated_at = ? WHERE id = ?'
    ).run(rating, comment ?? null, now, id);
  }

  markEvasive(id: number): void {
    this.db.prepare('UPDATE bot_replies SET was_evasive = 1 WHERE id = ?').run(id);
  }

  getById(id: number): BotReply | null {
    const row = this.db.prepare('SELECT * FROM bot_replies WHERE id = ?').get(id) as unknown as BotReplyRow | undefined;
    return row ? botReplyFromRow(row) : null;
  }

  listEvasiveSince(groupId: string, sinceTs: number): BotReply[] {
    const rows = this.db.prepare(
      'SELECT * FROM bot_replies WHERE group_id = ? AND was_evasive = 1 AND sent_at >= ? ORDER BY sent_at DESC'
    ).all(groupId, sinceTs) as unknown as BotReplyRow[];
    return rows.map(botReplyFromRow);
  }
}

interface LearnedFactRow {
  id: number; group_id: string; topic: string | null; fact: string;
  source_user_id: string | null; source_user_nickname: string | null;
  source_msg_id: string | null; bot_reply_id: number | null;
  confidence: number; status: string;
  created_at: number; updated_at: number;
}

function learnedFactFromRow(r: LearnedFactRow): LearnedFact {
  return {
    id: r.id, groupId: r.group_id, topic: r.topic, fact: r.fact,
    sourceUserId: r.source_user_id, sourceUserNickname: r.source_user_nickname,
    sourceMsgId: r.source_msg_id, botReplyId: r.bot_reply_id,
    confidence: r.confidence,
    status: (r.status as LearnedFact['status']) ?? 'active',
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

class LearnedFactsRepository implements ILearnedFactsRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(row: {
    groupId: string;
    topic: string | null;
    fact: string;
    sourceUserId: string | null;
    sourceUserNickname: string | null;
    sourceMsgId: string | null;
    botReplyId: number | null;
    confidence?: number;
  }): number {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db.prepare(`
      INSERT INTO learned_facts
        (group_id, topic, fact, source_user_id, source_user_nickname,
         source_msg_id, bot_reply_id, confidence, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      row.groupId, row.topic, row.fact,
      row.sourceUserId, row.sourceUserNickname, row.sourceMsgId,
      row.botReplyId, row.confidence ?? 1.0, now, now,
    );
    return Number(result.lastInsertRowid);
  }

  listActive(groupId: string, limit: number): LearnedFact[] {
    const rows = this.db.prepare(
      `SELECT * FROM learned_facts WHERE group_id = ? AND status = 'active' ORDER BY created_at DESC, id DESC LIMIT ?`
    ).all(groupId, limit) as unknown as LearnedFactRow[];
    return rows.map(learnedFactFromRow);
  }

  markStatus(id: number, status: LearnedFact['status']): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(
      'UPDATE learned_facts SET status = ?, updated_at = ? WHERE id = ?'
    ).run(status, now, id);
  }

  clearGroup(groupId: string): number {
    const result = this.db.prepare(
      'DELETE FROM learned_facts WHERE group_id = ?'
    ).run(groupId) as { changes: number };
    return result.changes;
  }

  countActive(groupId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as count FROM learned_facts WHERE group_id = ? AND status = 'active'`
    ).get(groupId) as unknown as CountRow;
    return row.count;
  }
}

class LocalStickerRepository implements ILocalStickerRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(
    groupId: string, key: string, type: LocalSticker['type'],
    localPath: string | null, cqCode: string, summary: string | null,
    contextSample: string | null, now: number, maxSamples: number,
  ): 'inserted' | 'updated' {
    const existing = this.db.prepare(
      'SELECT context_samples FROM local_stickers WHERE group_id = ? AND key = ?'
    ).get(groupId, key) as { context_samples: string } | undefined;

    if (!existing) {
      const samples = contextSample ? JSON.stringify([contextSample]) : '[]';
      this.db.prepare(`
        INSERT INTO local_stickers
          (group_id, key, type, local_path, cq_code, summary, context_samples, count, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(groupId, key, type, localPath ?? null, cqCode, summary ?? null, samples, now, now);
      return 'inserted';
    }

    // Update count, last_seen, and roll context_samples (cap at maxSamples)
    let samples: string[] = [];
    try { samples = JSON.parse(existing.context_samples) as string[]; } catch { /* ok */ }
    if (contextSample) {
      samples.push(contextSample);
      if (samples.length > maxSamples) samples = samples.slice(samples.length - maxSamples);
    }
    this.db.prepare(`
      UPDATE local_stickers SET count = count + 1, last_seen = ?, context_samples = ?
      WHERE group_id = ? AND key = ?
    `).run(now, JSON.stringify(samples), groupId, key);
    return 'updated';
  }

  getTopByGroup(groupId: string, limit: number): LocalSticker[] {
    const rows = this.db.prepare(`
      SELECT * FROM local_stickers WHERE group_id = ?
      ORDER BY (usage_positive - usage_negative) DESC, count DESC LIMIT ?
    `).all(groupId, limit) as unknown as Array<{
      id: number; group_id: string; key: string; type: string;
      local_path: string | null; cq_code: string; summary: string | null;
      context_samples: string; count: number; first_seen: number; last_seen: number;
      usage_positive: number; usage_negative: number;
    }>;
    return rows.map(r => ({
      id: r.id, groupId: r.group_id, key: r.key,
      type: r.type as LocalSticker['type'],
      localPath: r.local_path, cqCode: r.cq_code, summary: r.summary,
      contextSamples: (() => { try { return JSON.parse(r.context_samples) as string[]; } catch { return []; } })(),
      count: r.count, firstSeen: r.first_seen, lastSeen: r.last_seen,
      usagePositive: r.usage_positive, usageNegative: r.usage_negative,
    }));
  }

  recordUsage(groupId: string, key: string, positive: boolean): void {
    const col = positive ? 'usage_positive' : 'usage_negative';
    this.db.prepare(
      `UPDATE local_stickers SET ${col} = ${col} + 1 WHERE group_id = ? AND key = ?`
    ).run(groupId, key);
  }
}

interface PendingModerationRow {
  id: number; group_id: string; msg_id: string; user_id: string;
  user_nickname: string | null; content: string; severity: number;
  reason: string; proposed_action: string; status: string;
  created_at: number; decided_at: number | null; decided_by: string | null;
}

class PendingModerationRepository implements IPendingModerationRepository {
  constructor(private readonly db: DatabaseSync) {}

  private _row(r: PendingModerationRow): PendingModeration {
    return {
      id: r.id, groupId: r.group_id, msgId: r.msg_id, userId: r.user_id,
      userNickname: r.user_nickname, content: r.content, severity: r.severity,
      reason: r.reason, proposedAction: r.proposed_action as ProposedAction,
      status: r.status as PendingStatus, createdAt: r.created_at,
      decidedAt: r.decided_at, decidedBy: r.decided_by,
    };
  }

  queue(row: Omit<PendingModeration, 'id' | 'status' | 'decidedAt' | 'decidedBy'>): number {
    const result = this.db.prepare(
      `INSERT INTO pending_moderation
         (group_id, msg_id, user_id, user_nickname, content, severity, reason, proposed_action, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.groupId, row.msgId, row.userId, row.userNickname ?? null,
      row.content, row.severity, row.reason, row.proposedAction, row.createdAt,
    ) as { lastInsertRowid: number };
    return Number(result.lastInsertRowid);
  }

  getById(id: number): PendingModeration | null {
    const r = this.db.prepare('SELECT * FROM pending_moderation WHERE id = ?').get(id) as PendingModerationRow | undefined;
    return r ? this._row(r) : null;
  }

  markStatus(id: number, status: PendingStatus, decidedBy?: string): void {
    this.db.prepare(
      `UPDATE pending_moderation SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?`
    ).run(status, Math.floor(Date.now() / 1000), decidedBy ?? null, id);
  }

  expireOlderThan(cutoffSec: number): number {
    const result = this.db.prepare(
      `UPDATE pending_moderation SET status = 'expired', decided_at = ?
       WHERE status = 'pending' AND created_at < ?`
    ).run(Math.floor(Date.now() / 1000), cutoffSec) as { changes: number };
    return result.changes;
  }

  listPending(limit: number): PendingModeration[] {
    return (this.db.prepare(
      `SELECT * FROM pending_moderation WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?`
    ).all(limit) as unknown as PendingModerationRow[]).map(r => this._row(r));
  }
}

class WelcomeLogRepository implements IWelcomeLogRepository {
  constructor(private readonly db: DatabaseSync) {}

  record(groupId: string, userId: string, nowSec: number): void {
    this.db.prepare(
      'INSERT INTO welcome_log (group_id, user_id, welcomed_at) VALUES (?, ?, ?)'
    ).run(groupId, userId, nowSec);
  }

  lastWelcomeAt(groupId: string, userId: string): number | null {
    const row = this.db.prepare(
      'SELECT welcomed_at FROM welcome_log WHERE group_id = ? AND user_id = ? ORDER BY welcomed_at DESC LIMIT 1'
    ).get(groupId, userId) as { welcomed_at: number } | undefined;
    return row?.welcomed_at ?? null;
  }
}

// ---- Main Database class ----

export class Database {
  readonly messages: IMessageRepository;
  readonly users: IUserRepository;
  readonly moderation: IModerationRepository;
  readonly groupConfig: IGroupConfigRepository;
  readonly rules: IRuleRepository;
  readonly announcements: IAnnouncementRepository;
  readonly nameImages: INameImageRepository;
  readonly liveStickers: ILiveStickerRepository;
  readonly imageDescriptions: IImageDescriptionRepository;
  readonly imageModCache: IImageModCacheRepository;
  readonly forwardCache: IForwardCacheRepository;
  readonly botReplies: IBotReplyRepository;
  readonly localStickers: ILocalStickerRepository;
  readonly learnedFacts: ILearnedFactsRepository;
  readonly pendingModeration: IPendingModerationRepository;
  readonly welcomeLog: IWelcomeLogRepository;

  private readonly _db: DatabaseSync;

  constructor(dbPath: string) {
    this._db = new DatabaseSync(dbPath);
    this._db.exec('PRAGMA journal_mode = WAL;');
    this._db.exec('PRAGMA foreign_keys = ON;');
    this._applySchema();

    this.messages = new MessageRepository(this._db);
    this.users = new UserRepository(this._db);
    this.moderation = new ModerationRepository(this._db);
    this.groupConfig = new GroupConfigRepository(this._db);
    this.rules = new RuleRepository(this._db);
    this.announcements = new AnnouncementRepository(this._db);
    this.nameImages = new NameImageRepository(this._db);
    this.liveStickers = new LiveStickerRepository(this._db);
    this.imageDescriptions = new ImageDescriptionRepository(this._db);
    this.imageModCache = new ImageModCacheRepository(this._db);
    this.forwardCache = new ForwardCacheRepository(this._db);
    this.botReplies = new BotReplyRepository(this._db);
    this.localStickers = new LocalStickerRepository(this._db);
    this.learnedFacts = new LearnedFactsRepository(this._db);
    this.pendingModeration = new PendingModerationRepository(this._db);
    this.welcomeLog = new WelcomeLogRepository(this._db);
  }

  /** Execute arbitrary SQL — intended for bulk-import scripts and migrations only. */
  exec(sql: string): void {
    this._db.exec(sql);
  }

  close(): void {
    this._db.close();
  }

  private _applySchema(): void {
    const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));
    const sql = readFileSync(schemaPath, 'utf8');
    this._db.exec(sql);
    this._runMigrations();
  }

  private _runMigrations(): void {
    // ALTER TABLE: each wrapped in try/catch — SQLite throws "duplicate column" on existing DBs,
    // which is the correct idempotency signal for ADD COLUMN.
    for (const col of [
      'chat_lore_enabled INTEGER NOT NULL DEFAULT 1',
      'name_images_enabled INTEGER NOT NULL DEFAULT 1',
      'name_images_collection_timeout_ms INTEGER NOT NULL DEFAULT 120000',
      'name_images_collection_max INTEGER NOT NULL DEFAULT 20',
      'name_images_cooldown_ms INTEGER NOT NULL DEFAULT 300000',
      'name_images_max_per_name INTEGER NOT NULL DEFAULT 50',
      'chat_at_mention_queue_max INTEGER NOT NULL DEFAULT 5',
      'chat_at_mention_burst_window_ms INTEGER NOT NULL DEFAULT 30000',
      'chat_at_mention_burst_threshold INTEGER NOT NULL DEFAULT 3',
      'repeater_enabled INTEGER NOT NULL DEFAULT 1',
      'repeater_min_count INTEGER NOT NULL DEFAULT 3',
      'repeater_cooldown_ms INTEGER NOT NULL DEFAULT 600000',
      'repeater_min_content_length INTEGER NOT NULL DEFAULT 2',
      'repeater_max_content_length INTEGER NOT NULL DEFAULT 100',
      "name_images_blocklist TEXT NOT NULL DEFAULT '[]'",
      'lore_update_enabled INTEGER NOT NULL DEFAULT 1',
      'lore_update_threshold INTEGER NOT NULL DEFAULT 200',
      'lore_update_cooldown_ms INTEGER NOT NULL DEFAULT 1800000',
      'live_sticker_capture_enabled INTEGER NOT NULL DEFAULT 1',
      'sticker_legend_refresh_every_msgs INTEGER NOT NULL DEFAULT 50',
      'chat_persona_text TEXT',
    ]) {
      try { this._db.exec(`ALTER TABLE group_config ADD COLUMN ${col}`); } catch { /* already exists */ }
    }

    // name_images table — CREATE TABLE IF NOT EXISTS in schema.sql handles fresh installs,
    // but we repeat it here so existing DBs that predate schema.sql also get the table.
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS name_images (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id    TEXT    NOT NULL,
        name        TEXT    NOT NULL,
        file_path   TEXT    NOT NULL,
        source_file TEXT,
        added_by    TEXT    NOT NULL,
        added_at    INTEGER NOT NULL
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_name_images_group_name ON name_images(group_id, name)`);
    this._db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_name_images_source ON name_images(group_id, name, source_file) WHERE source_file IS NOT NULL`);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS live_stickers (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id    TEXT    NOT NULL,
        key         TEXT    NOT NULL,
        type        TEXT    NOT NULL,
        cq_code     TEXT    NOT NULL,
        summary     TEXT,
        count       INTEGER NOT NULL DEFAULT 1,
        first_seen  INTEGER NOT NULL,
        last_seen   INTEGER NOT NULL,
        UNIQUE(group_id, key)
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_live_stickers_group_count ON live_stickers(group_id, count DESC)`);

    // Add role column to users table for existing DBs
    try { this._db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'`); } catch { /* already exists */ }

    // bot_replies.was_evasive — added for self-learning module (Batch C / Change 4c).
    // Wrapped in try/catch to be idempotent on existing DBs that already have the column.
    try { this._db.exec(`ALTER TABLE bot_replies ADD COLUMN was_evasive INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }

    // learned_facts table — repeated here so existing DBs created before Batch C also get it.
    // schema.sql handles fresh installs; this branch covers upgrade-in-place. See
    // feedback_sqlite_schema_migration.md for why both paths matter.
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS learned_facts (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id             TEXT    NOT NULL,
        topic                TEXT,
        fact                 TEXT    NOT NULL,
        source_user_id       TEXT,
        source_user_nickname TEXT,
        source_msg_id        TEXT,
        bot_reply_id         INTEGER,
        confidence           REAL    NOT NULL DEFAULT 1.0,
        status               TEXT    NOT NULL DEFAULT 'active',
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_learned_facts_group_active ON learned_facts(group_id, status, created_at DESC)`);

    // pending_moderation table — Batch D human-in-loop approval flow.
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS pending_moderation (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id         TEXT    NOT NULL,
        msg_id           TEXT    NOT NULL,
        user_id          TEXT    NOT NULL,
        user_nickname    TEXT,
        content          TEXT    NOT NULL,
        severity         INTEGER NOT NULL,
        reason           TEXT    NOT NULL,
        proposed_action  TEXT    NOT NULL,
        status           TEXT    NOT NULL DEFAULT 'pending',
        created_at       INTEGER NOT NULL,
        decided_at       INTEGER,
        decided_by       TEXT
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_moderation_status ON pending_moderation(status, created_at)`);

    // welcome_enabled column on group_config — default on for all groups.
    try { this._db.exec(`ALTER TABLE group_config ADD COLUMN welcome_enabled INTEGER NOT NULL DEFAULT 1`); } catch { /* already exists */ }

    // welcome_log table — schema.sql handles fresh installs; migration covers existing DBs.
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS welcome_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id     TEXT    NOT NULL,
        user_id      TEXT    NOT NULL,
        welcomed_at  INTEGER NOT NULL
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_welcome_log_user ON welcome_log(group_id, user_id, welcomed_at DESC)`);

    // id_guard_enabled column on group_config — default ON (strict zero-tolerance).
    try { this._db.exec(`ALTER TABLE group_config ADD COLUMN id_guard_enabled INTEGER NOT NULL DEFAULT 1`); } catch { /* already exists */ }

    // image_mod_cache — verdicts from assessImage, keyed by sha256 file_key, TTL 7 days.
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS image_mod_cache (
        file_key   TEXT    PRIMARY KEY,
        violation  INTEGER NOT NULL,
        severity   INTEGER NOT NULL,
        reason     TEXT,
        rule_id    INTEGER,
        created_at INTEGER NOT NULL
      )
    `);

    // messages.raw_content — stores original CQ-code content for image context resolution.
    try { this._db.exec(`ALTER TABLE messages ADD COLUMN raw_content TEXT`); } catch { /* already exists */ }

    // forward_cache — pre-expanded 合并转发 content, keyed by forward_id, TTL 24h.
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS forward_cache (
        forward_id        TEXT    PRIMARY KEY,
        expanded_text     TEXT    NOT NULL,
        nested_image_keys TEXT    NOT NULL DEFAULT '[]',
        fetched_at        INTEGER NOT NULL
      )
    `);
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_forward_cache_fetched ON forward_cache(fetched_at)`);
  }
}
