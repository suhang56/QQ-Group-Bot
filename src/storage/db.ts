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
  timestamp: number;
  deleted: boolean;
}

export interface User {
  userId: string;
  groupId: string;
  nickname: string;
  styleSummary: string | null;
  lastSeen: number;
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
}

export interface IUserRepository {
  upsert(user: User): void;
  findById(userId: string, groupId: string): User | null;
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

// ---- Raw row types from SQLite ----

interface MessageRow {
  id: number; group_id: string; user_id: string; nickname: string;
  content: string; timestamp: number; deleted: number; source_message_id: string | null;
}

interface UserRow {
  user_id: string; group_id: string; nickname: string;
  style_summary: string | null; last_seen: number;
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
    timestamp: row.timestamp, deleted: row.deleted !== 0,
  };
}

function userFromRow(row: UserRow): User {
  return {
    userId: row.user_id, groupId: row.group_id, nickname: row.nickname,
    styleSummary: row.style_summary, lastSeen: row.last_seen,
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
      'INSERT OR IGNORE INTO messages (group_id, user_id, nickname, content, timestamp, deleted, source_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const result = stmt.run(msg.groupId, msg.userId, msg.nickname, msg.content, msg.timestamp, msg.deleted ? 1 : 0, sid);
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
}

class UserRepository implements IUserRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(user: User): void {
    this.db.prepare(`
      INSERT INTO users (user_id, group_id, nickname, style_summary, last_seen)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, group_id) DO UPDATE SET
        nickname = excluded.nickname,
        style_summary = excluded.style_summary,
        last_seen = excluded.last_seen
    `).run(user.userId, user.groupId, user.nickname, user.styleSummary, user.lastSeen);
  }

  findById(userId: string, groupId: string): User | null {
    const row = this.db.prepare(
      'SELECT * FROM users WHERE user_id = ? AND group_id = ?'
    ).get(userId, groupId) as unknown as UserRow | undefined;
    return row ? userFromRow(row) : null;
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
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

// ---- Main Database class ----

export class Database {
  readonly messages: IMessageRepository;
  readonly users: IUserRepository;
  readonly moderation: IModerationRepository;
  readonly groupConfig: IGroupConfigRepository;
  readonly rules: IRuleRepository;
  readonly announcements: IAnnouncementRepository;
  readonly nameImages: INameImageRepository;

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
  }
}
