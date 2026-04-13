import type { IClaudeClient } from '../ai/claude.js';
import type { INapCatAdapter, GroupMessage } from '../adapter/napcat.js';
import type {
  IMessageRepository, IModerationRepository, IGroupConfigRepository,
  IRuleRepository, GroupConfig,
} from '../storage/db.js';
import { BotErrorCode, ClaudeApiError, ClaudeParseError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

export interface ModerationVerdict {
  violation: boolean;
  severity: 1 | 2 | 3 | 4 | 5 | null;
  reason: string;
  confidence: number;
}

export interface IModeratorModule {
  assess(msg: GroupMessage, config: GroupConfig): Promise<ModerationVerdict>;
}

export type AppealResult =
  | { ok: true; wasKick: boolean }
  | { ok: false; errorCode: BotErrorCode };

export type RuleAddResult =
  | { ok: true; ruleId: number }
  | { ok: false; errorCode: BotErrorCode };

export type FalsePositiveResult =
  | { ok: true }
  | { ok: false; errorCode: BotErrorCode };

const FAIL_SAFE_VERDICT: ModerationVerdict = { violation: false, severity: null, reason: '', confidence: 0 };
const SKIP_VERDICT: ModerationVerdict = { violation: false, severity: null, reason: 'skipped', confidence: 1 };

function isCQOnly(content: string): boolean {
  return /^\s*(\[CQ:[^\]]+\]\s*)+\s*$/.test(content);
}

function parseSonnetResponse(text: string): { violation: boolean; severity: number | null; reason: string; confidence: number } | null {
  try {
    const json = JSON.parse(text.trim()) as unknown;
    if (typeof json !== 'object' || json === null) return null;
    const j = json as Record<string, unknown>;
    if (typeof j['violation'] !== 'boolean') return null;
    return {
      violation: j['violation'] as boolean,
      severity: typeof j['severity'] === 'number' ? j['severity'] : null,
      reason: typeof j['reason'] === 'string' ? j['reason'] : '',
      confidence: typeof j['confidence'] === 'number' ? j['confidence'] : 0,
    };
  } catch {
    return null;
  }
}

export class ModeratorModule implements IModeratorModule {
  private readonly logger = createLogger('moderator');

  constructor(
    private readonly claude: IClaudeClient,
    private readonly adapter: INapCatAdapter,
    _messages: IMessageRepository,
    private readonly moderation: IModerationRepository,
    private readonly configs: IGroupConfigRepository,
    private readonly rules: IRuleRepository,
  ) { void _messages; }

  async assess(msg: GroupMessage, config: GroupConfig): Promise<ModerationVerdict> {
    // Safety rail 1: skip admins/owners and whitelisted users
    if (msg.role === 'admin' || msg.role === 'owner') {
      this.logger.info({ groupId: msg.groupId, userId: msg.userId, role: msg.role }, 'mod skip — admin/owner');
      return SKIP_VERDICT;
    }
    if (config.modWhitelist.includes(msg.userId)) {
      this.logger.info({ groupId: msg.groupId, userId: msg.userId }, 'mod skip — whitelist');
      return SKIP_VERDICT;
    }

    // Safety rail 6: skip empty/CQ-only content
    const trimmed = msg.content.trim();
    if (!trimmed || isCQOnly(trimmed)) {
      return SKIP_VERDICT;
    }

    // Build context
    const allRules = this.rules.getAll(msg.groupId);
    const rulesText = allRules.length > 0
      ? allRules.map((r, i) => `${i + 1}. ${r.content}`).join('\n')
      : '（暂无配置群规）';

    const recentOffenses = this.moderation.findRecentByUser(msg.userId, msg.groupId, 7 * 24 * 3600 * 1000);
    const offenseHistory = recentOffenses.length > 0
      ? recentOffenses.map(r => `- ${r.reason} (severity ${r.severity}, action: ${r.action})`).join('\n')
      : '（无近期违规记录）';

    // Build prompt — user content ONLY in user-role message (never system)
    const systemText = `你是一个群管理AI。请根据以下群规判断用户发送的消息是否违规。

【群规】
${rulesText}

请仅返回JSON，格式如下（不要添加任何其他文字）：
{"violation": true/false, "severity": 1-5 或 null, "reason": "原因", "confidence": 0-1}

severity说明：1=轻微, 2=一般, 3=严重, 4=很严重, 5=极严重（踢出）。violation=false时severity为null。`;

    const userText = `用户 ${msg.nickname}（${msg.userId}）发送的消息：
${msg.content}

该用户近期违规记录：
${offenseHistory}`;

    let parsed: ReturnType<typeof parseSonnetResponse>;

    try {
      const resp = await this.claude.complete({
        model: 'claude-sonnet-4-6',
        maxTokens: 200,
        system: [{ text: systemText, cache: true }],
        messages: [{ role: 'user', content: userText }],
      });
      parsed = parseSonnetResponse(resp.text);
      if (!parsed) {
        this.logger.error({ groupId: msg.groupId, raw: resp.text.slice(0, 100) }, 'Claude parse error in moderator');
        return FAIL_SAFE_VERDICT;
      }
    } catch (err) {
      if (err instanceof ClaudeApiError || err instanceof ClaudeParseError) {
        this.logger.error({ err, groupId: msg.groupId }, 'Claude API error in moderator — fail-safe');
        return FAIL_SAFE_VERDICT;
      }
      throw err;
    }

    const verdict: ModerationVerdict = {
      violation: parsed.violation,
      severity: (parsed.severity as 1 | 2 | 3 | 4 | 5 | null),
      reason: parsed.reason,
      confidence: parsed.confidence,
    };

    if (!parsed.violation || !parsed.severity) {
      this.moderation.insert({
        msgId: msg.messageId, groupId: msg.groupId, userId: msg.userId,
        violation: false, severity: null, action: 'none',
        reason: parsed.reason, appealed: 0, reversed: false,
        timestamp: msg.timestamp,
      });
      return verdict;
    }

    // Safety rail 2: daily cap check (read fresh from config)
    const freshConfig = this.configs.get(msg.groupId) ?? config;
    const today = new Date().toISOString().slice(0, 10);
    if (freshConfig.punishmentsResetDate !== today) {
      this.configs.resetDailyPunishments(msg.groupId);
      freshConfig.punishmentsToday = 0;
    }
    const atCap = freshConfig.punishmentsToday >= freshConfig.dailyPunishmentLimit;

    if (atCap) {
      this.logger.warn({ groupId: msg.groupId, userId: msg.userId }, 'daily cap reached — warn only');
      await this.adapter.send(msg.groupId,
        `@${msg.nickname} 今日自动处罚已达上限，你的违规行为（${parsed.reason}）已记录，请等待管理员处理。`);
      this.moderation.insert({
        msgId: msg.messageId, groupId: msg.groupId, userId: msg.userId,
        violation: true, severity: parsed.severity, action: 'none',
        reason: parsed.reason, appealed: 0, reversed: false,
        timestamp: msg.timestamp,
      });
      return verdict;
    }

    // Execute punishment
    await this._executePunishment(msg, parsed.severity, parsed.reason, config);
    return verdict;
  }

  private async _executePunishment(
    msg: GroupMessage,
    severity: number,
    reason: string,
    config: GroupConfig,
  ): Promise<void> {
    // Always delete the message first
    try {
      await this.adapter.deleteMsg(msg.messageId);
    } catch {
      this.logger.error({ groupId: msg.groupId, messageId: msg.messageId }, 'deleteMsg failed');
    }

    if (severity <= 2) {
      await this.adapter.send(msg.groupId,
        `@${msg.nickname} 你的消息因违反群规已被删除，请注意言行。\n原因：${reason}`);
      this.moderation.insert({
        msgId: msg.messageId, groupId: msg.groupId, userId: msg.userId,
        violation: true, severity, action: 'warn', reason,
        appealed: 0, reversed: false, timestamp: msg.timestamp,
      });
      this.configs.incrementPunishments(msg.groupId);
      this.logger.info({ groupId: msg.groupId, userId: msg.userId, severity, action: 'warn', reason }, 'punishment executed');
      return;
    }

    if (severity === 3) {
      await this.adapter.ban(msg.groupId, msg.userId, 600);
      await this.adapter.send(msg.groupId,
        `@${msg.nickname} 因违规已禁言10分钟。\n原因：${reason}\n如认为有误，可在24小时内发送 /appeal 申诉。`);
      this.moderation.insert({
        msgId: msg.messageId, groupId: msg.groupId, userId: msg.userId,
        violation: true, severity, action: 'ban', reason,
        appealed: 0, reversed: false, timestamp: msg.timestamp,
      });
      this.configs.incrementPunishments(msg.groupId);
      this.logger.info({ groupId: msg.groupId, userId: msg.userId, severity, action: 'ban', durationSeconds: 600, reason }, 'punishment executed');
      return;
    }

    if (severity === 4) {
      await this.adapter.ban(msg.groupId, msg.userId, 3600);
      await this.adapter.send(msg.groupId,
        `@${msg.nickname} 因严重违规已禁言1小时。\n原因：${reason}\n如认为有误，可在24小时内发送 /appeal 申诉。`);
      this.moderation.insert({
        msgId: msg.messageId, groupId: msg.groupId, userId: msg.userId,
        violation: true, severity, action: 'ban', reason,
        appealed: 0, reversed: false, timestamp: msg.timestamp,
      });
      this.configs.incrementPunishments(msg.groupId);
      this.logger.info({ groupId: msg.groupId, userId: msg.userId, severity, action: 'ban', durationSeconds: 3600, reason }, 'punishment executed');
      return;
    }

    // Severity 5: Opus double-check before kick
    const confirmed = await this._opusKickConfirm(msg, reason, config);
    if (confirmed && confirmed.severity !== null && confirmed.severity >= 5) {
      try {
        await this.adapter.kick(msg.groupId, msg.userId);
      } catch {
        this.logger.error({ groupId: msg.groupId, userId: msg.userId }, 'kick action failed');
      }
      await this.adapter.send(msg.groupId,
        `用户 ${msg.nickname}（${msg.userId}）因严重违规已被移出群聊。\n原因：${reason}`);
      this.moderation.insert({
        msgId: msg.messageId, groupId: msg.groupId, userId: msg.userId,
        violation: true, severity: 5, action: 'kick', reason,
        appealed: 0, reversed: false, timestamp: msg.timestamp,
      });
      this.configs.incrementPunishments(msg.groupId);
      this.logger.info({ groupId: msg.groupId, userId: msg.userId, severity: 5, action: 'kick', reason }, 'punishment executed');
    } else {
      // Opus downgraded — degrade to 1h ban
      await this.adapter.ban(msg.groupId, msg.userId, 3600);
      await this.adapter.send(msg.groupId,
        `@${msg.nickname} 因严重违规已禁言1小时。\n原因：${reason}\n如认为有误，可在24小时内发送 /appeal 申诉。`);
      this.moderation.insert({
        msgId: msg.messageId, groupId: msg.groupId, userId: msg.userId,
        violation: true, severity: 4, action: 'ban', reason,
        appealed: 0, reversed: false, timestamp: msg.timestamp,
      });
      this.configs.incrementPunishments(msg.groupId);
      this.logger.info({ groupId: msg.groupId, userId: msg.userId, severity: 4, action: 'ban', reason, note: 'opus-downgraded' }, 'punishment executed');
    }
  }

  private async _opusKickConfirm(
    msg: GroupMessage,
    reason: string,
    config: GroupConfig,
  ): Promise<{ violation: boolean; severity: number | null } | null> {
    try {
      const resp = await this.claude.complete({
        model: config.kickConfirmModel,
        maxTokens: 100,
        system: [{ text: `你是一名严格的群管理复核AI。请二次确认以下处罚是否必要，仅返回JSON：{"violation": true/false, "severity": 1-5 或 null}`, cache: true }],
        messages: [{ role: 'user', content: `原因：${reason}\n用户消息：${msg.content}` }],
      });
      const parsed = parseSonnetResponse(resp.text);
      return parsed;
    } catch (err) {
      this.logger.error({ err, groupId: msg.groupId }, 'Opus kick-confirm failed — downgrading');
      return null;
    }
  }

  async handleAppeal(msg: GroupMessage, config: GroupConfig): Promise<AppealResult> {
    const record = this.moderation.findPendingAppeal(msg.userId, msg.groupId);
    if (!record) {
      return { ok: false, errorCode: BotErrorCode.NO_PUNISHMENT_RECORD };
    }

    const windowSec = (config.appealWindowHours ?? 24) * 3600;
    const age = Math.floor(Date.now() / 1000) - record.timestamp;
    if (age > windowSec) {
      return { ok: false, errorCode: BotErrorCode.APPEAL_EXPIRED };
    }

    this.moderation.update(record.id, { appealed: 1, reversed: true });

    const wasKick = record.action === 'kick';

    if (!wasKick && record.action === 'ban') {
      try {
        await this.adapter.ban(msg.groupId, msg.userId, 0); // unban
      } catch {
        this.logger.error({ groupId: msg.groupId, userId: msg.userId }, 'unban during appeal failed');
      }
    }

    this.logger.info({ groupId: msg.groupId, userId: msg.userId, recordId: record.id, wasKick }, 'appeal approved');
    return { ok: true, wasKick };
  }

  async addRule(
    groupId: string,
    content: string,
    role: 'admin' | 'owner' | 'member',
  ): Promise<RuleAddResult> {
    if (role !== 'admin' && role !== 'owner') {
      return { ok: false, errorCode: BotErrorCode.PERMISSION_DENIED };
    }
    const rule = this.rules.insert({ groupId, content, type: 'positive', embedding: null });
    this.logger.info({ groupId, ruleId: rule.id }, 'rule added');
    return { ok: true, ruleId: rule.id };
  }

  async markFalsePositive(
    msgId: string,
    role: 'admin' | 'owner' | 'member',
  ): Promise<FalsePositiveResult> {
    if (role !== 'admin' && role !== 'owner') {
      return { ok: false, errorCode: BotErrorCode.PERMISSION_DENIED };
    }
    const record = this.moderation.findByMsgId(msgId);
    if (!record) {
      return { ok: false, errorCode: BotErrorCode.NO_PUNISHMENT_RECORD };
    }
    this.moderation.update(record.id, { reversed: true });
    this.logger.info({ msgId, recordId: record.id }, 'false positive marked');
    return { ok: true };
  }
}
