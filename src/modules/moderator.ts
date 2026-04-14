import type { IClaudeClient } from '../ai/claude.js';
import type { INapCatAdapter, GroupMessage } from '../adapter/napcat.js';
import type {
  IMessageRepository, IModerationRepository, IGroupConfigRepository,
  IRuleRepository, GroupConfig, PendingModeration,
} from '../storage/db.js';
import type { ILearnerModule } from './learner.js';
import { BotErrorCode, ClaudeApiError, ClaudeParseError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { RUNTIME_CHAT_MODEL } from '../config.js';

// Short banter words/patterns that are normal Chinese group chat — skip moderation entirely
const BANTER_WHITELIST = new Set([
  '操', '草', '艹', '卧槽', '牛逼', '傻逼', '垃圾', '脑子有病',
  '啊', '啊?', '什么', '哈哈', '哈哈哈', 'tmd', 'mmp', 'wcnm', 'nmsl',
]);

const CONFIDENCE_THRESHOLD = 0.75;
const ACTION_SEVERITY_THRESHOLD = 3; // sev 1-2 → log only, sev 3+ → action

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

export function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced && fenced[1]) return fenced[1].trim();
  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) return raw.slice(jsonStart, jsonEnd + 1);
  return raw.trim();
}

function parseSonnetResponse(text: string): { violation: boolean; severity: number | null; reason: string; confidence: number } | null {
  try {
    const json = JSON.parse(extractJson(text)) as unknown;
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
    private readonly messages: IMessageRepository,
    private readonly moderation: IModerationRepository,
    private readonly configs: IGroupConfigRepository,
    private readonly rules: IRuleRepository,
    private readonly learner: ILearnerModule | null = null,
  ) {}

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

    // Safety rail 7: banter whitelist — short common words are normal group chat, skip Claude
    if (trimmed.length <= 3 || BANTER_WHITELIST.has(trimmed.toLowerCase())) {
      this.logger.debug({ groupId: msg.groupId, content: trimmed }, 'mod skip — banter whitelist');
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

    // Conversation context: last 5 messages including the trigger
    const recentMsgs = this.messages.getRecent(msg.groupId, 5);
    // getRecent returns newest-first; reverse for chronological display
    const contextLines = [...recentMsgs].reverse()
      .map(m => `[${m.nickname}]: ${m.content}`)
      .join('\n');

    // Retrieve RAG examples from learner (fail-safe: empty if disabled or not ready)
    let ragExamples: string[] = [];
    if (this.learner) {
      try {
        const examples = await this.learner.retrieveExamples(msg.groupId, trimmed, 5);
        ragExamples = examples.map((r, i) => `${i + 1}. [${r.type}] ${r.content}`);
      } catch {
        this.logger.warn({ groupId: msg.groupId }, 'learner.retrieveExamples failed — proceeding without RAG');
      }
    }

    const ragSection = ragExamples.length > 0
      ? `\n相关违规示例（供参考，置于同等重视度）：\n${ragExamples.join('\n')}`
      : '';

    // Build prompt — user content ONLY in user-role message (never system)
    const systemText = `你是一个群管理AI。请根据群规判断最后一条消息是否违规。

【群规】
${rulesText}

注意：
- 日常玩笑、粗口、互怼都是正常的中文群聊方式，不算违规
- 严重侮辱性攻击、人身攻击特定人、发布违禁内容、明显恶意才算违规
- 如果不确定，倾向于判定非违规（confidence < ${CONFIDENCE_THRESHOLD}）
- 群友之间熟悉的调侃、梗、自嘲都是正常的

请仅返回JSON，格式如下（不要添加任何其他文字）：
{"violation": true/false, "severity": 1-5 或 null, "reason": "原因", "confidence": 0-1}

severity说明：1=轻微, 2=一般, 3=严重, 4=很严重, 5=极严重（踢出）。violation=false时severity为null。`;

    const userText = `以下是最近的聊天记录（最后一条是需要判定的消息）：

${contextLines}

需要判定的消息：${msg.nickname}（${msg.userId}）说：${msg.content}

该用户近期违规记录：
${offenseHistory}${ragSection}`;

    let parsed: ReturnType<typeof parseSonnetResponse>;

    try {
      const resp = await this.claude.complete({
        model: RUNTIME_CHAT_MODEL,
        maxTokens: 200,
        system: [{ text: systemText, cache: true }],
        messages: [{ role: 'user', content: userText }],
      });
      parsed = parseSonnetResponse(resp.text);
      if (!parsed) {
        this.logger.error({ groupId: msg.groupId, raw: resp.text.slice(0, 200) }, 'Claude parse error in moderator');
        return FAIL_SAFE_VERDICT;
      }
      this.logger.debug({ groupId: msg.groupId, violation: parsed.violation, severity: parsed.severity }, 'Moderator parse ok');
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

    // Confidence gate: low-confidence violations are logged only, no action
    if (parsed.confidence < CONFIDENCE_THRESHOLD) {
      this.logger.info({ groupId: msg.groupId, userId: msg.userId, confidence: parsed.confidence, severity: parsed.severity }, 'mod low-confidence violation — log only');
      this.moderation.insert({
        msgId: msg.messageId, groupId: msg.groupId, userId: msg.userId,
        violation: true, severity: parsed.severity, action: 'none',
        reason: `[low-confidence ${parsed.confidence.toFixed(2)}] ${parsed.reason}`, appealed: 0, reversed: false,
        timestamp: msg.timestamp,
      });
      return verdict;
    }

    // Severity gate: sev 1-2 → log only, no user-visible action
    if (parsed.severity < ACTION_SEVERITY_THRESHOLD) {
      this.logger.info({ groupId: msg.groupId, userId: msg.userId, severity: parsed.severity, reason: parsed.reason }, 'mod sev 1-2 — log only, no action');
      this.moderation.insert({
        msgId: msg.messageId, groupId: msg.groupId, userId: msg.userId,
        violation: true, severity: parsed.severity, action: 'none',
        reason: parsed.reason, appealed: 0, reversed: false,
        timestamp: msg.timestamp,
      });
      return verdict;
    }

    // Violation confirmed with sufficient confidence and severity — log and return.
    // Action execution is now delegated to the admin-approval flow in the router.
    this.moderation.insert({
      msgId: msg.messageId, groupId: msg.groupId, userId: msg.userId,
      violation: true, severity: parsed.severity, action: 'none',
      reason: parsed.reason, appealed: 0, reversed: false,
      timestamp: msg.timestamp,
    });
    this.logger.info({ groupId: msg.groupId, userId: msg.userId, severity: parsed.severity, reason: parsed.reason }, 'violation queued for admin approval');
    return verdict;
  }

  /** Execute a punishment for an admin-approved pending moderation row. */
  async executePunishment(pending: PendingModeration, config: GroupConfig): Promise<void> {
    const fakeMsg: GroupMessage = {
      messageId: pending.msgId,
      groupId: pending.groupId,
      userId: pending.userId,
      nickname: pending.userNickname ?? pending.userId,
      role: 'member',
      content: pending.content,
      rawContent: pending.content,
      timestamp: pending.createdAt,
    };
    await this._executePunishment(fakeMsg, pending.severity, pending.reason, config);
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

    // sev 3: delete + warn (no ban)
    if (severity === 3) {
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

    // sev 4: mute 10 minutes
    if (severity === 4) {
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

  async handleAppeal(msg: GroupMessage, config: GroupConfig, targetUserId?: string): Promise<AppealResult> {
    // findPendingAppeal queries WHERE appealed=0, so already-appealed records are not returned.
    // A second appeal attempt naturally surfaces as NO_PUNISHMENT_RECORD (E007).
    const subjectId = targetUserId ?? msg.userId;
    const record = this.moderation.findPendingAppeal(subjectId, msg.groupId);
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
        await this.adapter.ban(msg.groupId, subjectId, 0); // unban
      } catch {
        this.logger.error({ groupId: msg.groupId, userId: subjectId }, 'unban during appeal failed');
      }
    }

    this.logger.info({ groupId: msg.groupId, userId: subjectId, recordId: record.id, wasKick }, 'appeal approved');
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
    const rule = this.rules.insert({ groupId, content, type: 'positive', source: 'manual', embedding: null });
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
