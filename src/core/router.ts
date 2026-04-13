import type { GroupMessage, INapCatAdapter } from '../adapter/napcat.js';
import type { Database, GroupConfig } from '../storage/db.js';
import type { RateLimiter } from './rateLimiter.js';
import type { IChatModule } from '../modules/chat.js';
import type { MimicModule } from '../modules/mimic.js';
import type { ModeratorModule } from '../modules/moderator.js';
import type { NameImagesModule } from '../modules/name-images.js';
import { BotErrorCode } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { defaultGroupConfig } from '../config.js';
import { resolveAtTarget } from '../utils/cqcode.js';

const MAX_SPLIT_LINES = 3;
const SPLIT_DELAY_MIN_MS = 100;
const SPLIT_DELAY_MAX_MS = 300;

/** Split a reply on newlines, cap at MAX_SPLIT_LINES, drop empty lines. */
export function splitReply(text: string): string[] {
  // Collapse any \n inside [CQ:...] blocks so multi-line CQ codes become atomic tokens
  const flattened = text.replace(/\[CQ:[^\]]*\]/gs, (cq) => cq.replace(/\s*\n\s*/g, ''));
  // Strip trailing unmatched lone bracket lines (not part of a CQ code)
  const stripped = flattened.replace(/\n+[\[\]]\s*$/g, '');
  const lines = stripped.split('\n').map(l => l.trim()).filter(l => {
    if (l.length === 0) return false;
    // Drop lines that are only brackets, parens, punctuation, or whitespace
    if (/^[\s\[\]()（）【】｜|\-—\.。,，!！?？「」『』〔〕［］]+$/.test(l)) return false;
    return true;
  });
  return lines.slice(0, MAX_SPLIT_LINES);
}

function randomDelay(): number {
  return SPLIT_DELAY_MIN_MS + Math.floor(Math.random() * (SPLIT_DELAY_MAX_MS - SPLIT_DELAY_MIN_MS));
}

/** Extract the first image URL from a rawContent string containing [CQ:image,...,url=X,...]. */
export function _extractImageUrl(rawContent: string): string | null {
  const m = rawContent.match(/\[CQ:image,[^\]]*url=([^,\]]+)/);
  if (!m || !m[1]) return null;
  const url = decodeURIComponent(m[1]);
  return url.startsWith('http') ? url : null;
}

export function _extractImageFile(rawContent: string): string | null {
  const m = rawContent.match(/\[CQ:image,[^\]]*file=([^,\]]+)/);
  return m?.[1] ?? null;
}

export interface IRouter {
  dispatch(msg: GroupMessage): Promise<void>;
}

export type CommandHandler = (
  msg: GroupMessage,
  args: string[],
  config: GroupConfig,
) => Promise<void>;

interface QueuedMention {
  msg: GroupMessage;
  sourceMsgId: number; // OneBot message_id of the @-mention, for quote-reply
}

export class Router implements IRouter {
  private readonly logger = createLogger('router');
  private readonly commands = new Map<string, CommandHandler>();
  private chatModule: IChatModule | null = null;
  private mimicModule: MimicModule | null = null;
  private moderatorModule: ModeratorModule | null = null;
  private nameImagesModule: NameImagesModule | null = null;

  // Repeater cooldown: key = `${groupId}:${content}`, value = last-triggered timestamp
  private readonly repeaterCooldown = new Map<string, number>();

  // @-mention queue: per-group list of pending mentions waiting for in-flight to complete
  private readonly atMentionQueue = new Map<string, QueuedMention[]>();
  // @-mention burst tracking: per-group timestamps of recent @-mention replies
  private readonly atReplyTimestamps = new Map<string, number[]>();
  // in-flight lock for @-mention queue processing (separate from ChatModule's lock)
  private readonly atInFlight = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly adapter: INapCatAdapter,
    private readonly rateLimiter: RateLimiter,
    private readonly botUserId?: string,
  ) {
    this._registerCommands();
  }

  setChat(chat: IChatModule): void {
    this.chatModule = chat;
  }

  setMimic(mimic: MimicModule): void {
    this.mimicModule = mimic;
  }

  setModerator(moderator: ModeratorModule): void {
    this.moderatorModule = moderator;
  }

  setNameImages(nameImages: NameImagesModule): void {
    this.nameImagesModule = nameImages;
  }

  async dispatch(msg: GroupMessage): Promise<void> {
    try {
      this.logger.trace({ messageId: msg.messageId, groupId: msg.groupId, userId: msg.userId }, 'dispatching message');

      const config = this.db.groupConfig.get(msg.groupId) ?? this._defaultConfig(msg.groupId);

      // Moderator runs FIRST, before persistence
      if (this.moderatorModule && !msg.content.trim().startsWith('/')) {
        const verdict = await this.moderatorModule.assess(msg, config);
        if (verdict.violation && verdict.severity !== null && verdict.severity >= 1) {
          // Message was deleted — do not persist or route downstream
          return;
        }
      }

      // Persist message and upsert user
      this.db.messages.insert({
        groupId: msg.groupId,
        userId: msg.userId,
        nickname: msg.nickname,
        content: msg.content,
        timestamp: msg.timestamp,
        deleted: false,
      });

      this.db.users.upsert({
        userId: msg.userId,
        groupId: msg.groupId,
        nickname: msg.nickname,
        styleSummary: null,
        lastSeen: msg.timestamp,
      });

      // Command routing — admin/owner only at router level; /appeal is open to all roles
      const trimmed = msg.content.trim();
      const isAdmin = msg.role === 'admin' || msg.role === 'owner';
      const peekCmd = trimmed.startsWith('/') ? (trimmed.slice(1).split(/\s+/)[0]?.toLowerCase() ?? '') : '';
      if (trimmed.startsWith('/') && (isAdmin || peekCmd === 'appeal')) {
        const parts = trimmed.slice(1).split(/\s+/);
        const cmd = parts[0]?.toLowerCase() ?? '';
        const args = parts.slice(1);

        // Rate limit check for commands
        if (!this.rateLimiter.checkUser(msg.userId, cmd)) {
          const cooldown = this.rateLimiter.cooldownSecondsUser(msg.userId, cmd);
          await this.adapter.send(msg.groupId, `你的操作太频繁了，请等待 ${cooldown} 秒后再试。`);
          return;
        }

        const handler = this.commands.get(cmd);
        if (handler) {
          await handler(msg, args, config);
        }
        // Unknown commands silently ignored
        return;
      }

      // Image-capture hook: if sender is in collection mode and message contains an image
      if (this.nameImagesModule && config.nameImagesEnabled) {
        const target = this.nameImagesModule.getCollectionTarget(msg.groupId, msg.userId);
        if (target !== null && msg.rawContent.includes('[CQ:image,')) {
          const imageUrl = _extractImageUrl(msg.rawContent) ?? '';
          const cqFile = _extractImageFile(msg.rawContent) ?? '';
          const sourceFile = cqFile || imageUrl;
          if (cqFile || imageUrl) {
            try {
              const result = await this.nameImagesModule.saveImage(
                msg.groupId, target, imageUrl, sourceFile,
                msg.userId, config.nameImagesMaxPerName, cqFile,
              );
              if (result === 'cap_reached') {
                await this.adapter.send(msg.groupId, `${target} 的图片库已满（${config.nameImagesMaxPerName}张），请先清理再添加。`);
                this.nameImagesModule.stopCollecting(msg.groupId, msg.userId);
              } else if (result === 'dedup') {
                const count = this.nameImagesModule.countByName(msg.groupId, target);
                await this.adapter.send(msg.groupId, `这张图已经在 ${target} 的图片库里了（共${count}张）`);
              } else {
                const count = this.nameImagesModule.countByName(msg.groupId, target);
                await this.adapter.send(msg.groupId, `已保存到 ${target}（${count}张）`);
              }
            } catch {
              await this.adapter.send(msg.groupId, '图片下载失败，请稍后再试。');
            }
            return; // Skip chat/mimic pipeline for this message
          }
        }
      }

      // Repeater: join when 3+ distinct users just said the same thing
      if (msg.userId !== (this.botUserId ?? '')) {
        const repeated = await this._checkRepeater(msg, config);
        if (repeated) return;
      }

      // Name-image trigger: fires only when the entire message IS a known name (exact match after trim)
      if (this.nameImagesModule && config.nameImagesEnabled) {
        const trimmedContent = msg.content.trim();
        const blocklist = (config.nameImagesBlocklist ?? []).map(b => b.toLowerCase());
        if (!blocklist.includes(trimmedContent.toLowerCase())) {
          const names = this.nameImagesModule.getAllNames(msg.groupId);
          const exactName = names.find(n => n.toLowerCase() === trimmedContent.toLowerCase());
          if (exactName) {
            // Burst guard: skip if last 5 messages arrived within 10s
            const recent5 = this.db.messages.getRecent(msg.groupId, 5);
            const isBurst = recent5.length >= 5 &&
              (recent5[0]!.timestamp - recent5[recent5.length - 1]!.timestamp) * 1000 <= 10_000;
            if (!isBurst) {
              const ok = this.nameImagesModule.checkAndSetCooldown(msg.groupId, exactName, config.nameImagesCooldownMs);
              if (ok) {
                const image = this.nameImagesModule.pickRandom(msg.groupId, exactName);
                if (image) {
                  await this.adapter.send(msg.groupId, `[CQ:image,file=file:///${image.filePath.replace(/\\/g, '/')}]`);
                }
              }
            }
          }
        }
      }

      // Non-command: check mimic mode first, then chat
      const recentMsgs = this.db.messages.getRecent(msg.groupId, 20).map(m => ({
        messageId: String(m.id),
        groupId: m.groupId,
        userId: m.userId,
        nickname: m.nickname,
        role: 'member' as const,
        content: m.content,
        rawContent: m.content,
        timestamp: m.timestamp,
      }));

      if (this.mimicModule) {
        const activeUserId = this.mimicModule.getActiveMimicUser(msg.groupId);
        if (activeUserId) {
          const result = await this.mimicModule.generateMimic(msg.groupId, activeUserId, msg.content, recentMsgs);
          if (result.ok) {
            await this._sendReply(msg.groupId, result.text);
          }
          return;
        }
      }

      if (this.chatModule) {
        const isAtMention = this.botUserId
          ? msg.rawContent.includes(`[CQ:at,qq=${this.botUserId}]`)
          : false;

        if (isAtMention) {
          await this._enqueueAtMention(msg, config);
        } else {
          const reply = await this.chatModule.generateReply(msg.groupId, msg, recentMsgs);
          if (reply) {
            await this._sendReply(msg.groupId, reply);
          }
        }
      }

    } catch (err) {
      this.logger.fatal({ err, messageId: msg.messageId }, 'Unhandled error in router.dispatch');
    }
  }

  /** Send a reply as one or more messages (split on newlines), with typing delay between lines.
   *  replyToMsgId is only prepended to the FIRST send (quote-reply), continuation lines go plain. */
  private async _sendReply(groupId: string, text: string, replyToMsgId?: number): Promise<void> {
    const lines = splitReply(text);
    if (lines.length === 0) return;
    if (lines.length > MAX_SPLIT_LINES) {
      this.logger.info({ groupId, totalLines: text.split('\n').length }, 'reply truncated to 3 lines');
    }
    for (let i = 0; i < lines.length; i++) {
      const msgId = await this.adapter.send(groupId, lines[i]!, i === 0 ? replyToMsgId : undefined);
      if (msgId !== null && this.chatModule) {
        this.chatModule.recordOutgoingMessage(groupId, msgId);
      }
      if (i < lines.length - 1) {
        await new Promise(r => setTimeout(r, randomDelay()));
      }
    }
  }

  /** Enqueue an @-mention for serial processing, enforcing queue cap and burst skip. */
  private async _enqueueAtMention(msg: GroupMessage, config: GroupConfig): Promise<void> {
    const { groupId } = msg;
    const sourceMsgId = Number(msg.messageId);
    if (!sourceMsgId) return; // no valid msg id to quote

    const queue = this.atMentionQueue.get(groupId) ?? [];

    if (this.atInFlight.has(groupId)) {
      // In-flight — try to queue
      if (queue.length >= config.chatAtMentionQueueMax) {
        this.logger.debug({ groupId, queueLen: queue.length }, '@-mention dropped (queue full — play dead)');
        return;
      }
      queue.push({ msg, sourceMsgId });
      this.atMentionQueue.set(groupId, queue);
      return;
    }

    // No in-flight — process immediately
    await this._processAtMention({ msg, sourceMsgId }, config);
  }

  /** Process a single queued @-mention, then drain the queue. */
  private async _processAtMention(item: QueuedMention, config: GroupConfig): Promise<void> {
    const { groupId } = item.msg;
    this.atInFlight.add(groupId);
    try {
      // Burst skip: if we've replied to >= threshold @-mentions within the burst window,
      // skip every other one (alternating) to simulate can't-keep-up
      const now = Date.now();
      const timestamps = (this.atReplyTimestamps.get(groupId) ?? [])
        .filter(t => now - t < config.chatAtMentionBurstWindowMs);

      let shouldSkip = false;
      if (timestamps.length >= config.chatAtMentionBurstThreshold) {
        // Skip if the timestamps count is odd (alternate skip/process)
        shouldSkip = timestamps.length % 2 === 1;
        this.logger.debug({ groupId, recentReplies: timestamps.length }, shouldSkip ? 'burst mode — skipping @-mention' : 'burst mode — processing @-mention');
      }

      if (!shouldSkip && this.chatModule) {
        const recentMsgs = this.db.messages.getRecent(groupId, 20).map(m => ({
          messageId: String(m.id), groupId: m.groupId, userId: m.userId,
          nickname: m.nickname, role: 'member' as const,
          content: m.content, rawContent: m.content, timestamp: m.timestamp,
        }));
        const reply = await this.chatModule.generateReply(groupId, item.msg, recentMsgs);
        if (reply) {
          await this._sendReply(groupId, reply, item.sourceMsgId);
          timestamps.push(Date.now());
          this.atReplyTimestamps.set(groupId, timestamps);
        }
      }
    } finally {
      this.atInFlight.delete(groupId);

      // Drain queue: process next item if any
      const queue = this.atMentionQueue.get(groupId) ?? [];
      const next = queue.shift();
      if (queue.length === 0) {
        this.atMentionQueue.delete(groupId);
      } else {
        this.atMentionQueue.set(groupId, queue);
      }
      if (next) {
        const config = this.db.groupConfig.get(groupId) ?? this._defaultConfig(groupId);
        void this._processAtMention(next, config);
      }
    }
  }

  private _defaultConfig(groupId: string) {
    return defaultGroupConfig(groupId);
  }

  /** Returns true and sends the repeated content if 3+ distinct users just said the same thing. */
  private async _checkRepeater(msg: GroupMessage, config: GroupConfig): Promise<boolean> {
    if (!config.repeaterEnabled) return false;

    const content = msg.content.trim();
    if (content.length < config.repeaterMinContentLength) return false;
    if (content.length > config.repeaterMaxContentLength) return false;
    if (content.startsWith('/')) return false;
    if (msg.rawContent.includes('[CQ:at,')) return false;

    // Burst guard: skip during rapid-fire group activity
    const recent5 = this.db.messages.getRecent(msg.groupId, 5);
    const isBurst = recent5.length >= 5 &&
      (recent5[0]!.timestamp - recent5[recent5.length - 1]!.timestamp) * 1000 <= 10_000;
    if (isBurst) return false;

    // Strict: the last N messages in the group must ALL equal content AND come from N distinct non-bot users
    const recent = this.db.messages.getRecent(msg.groupId, config.repeaterMinCount);
    if (recent.length < config.repeaterMinCount) return false;
    if (!recent.every(m => m.content.trim() === content)) return false;
    const distinctUsers = new Set(recent.map(m => m.userId));
    if (distinctUsers.size < config.repeaterMinCount) return false;
    if (distinctUsers.has(this.botUserId ?? '')) return false;

    // Cooldown
    const key = `${msg.groupId}:${content}`;
    const last = this.repeaterCooldown.get(key);
    if (last !== undefined && Date.now() - last < config.repeaterCooldownMs) return false;
    this.repeaterCooldown.set(key, Date.now());

    await this.adapter.send(msg.groupId, content);
    this.logger.info({ groupId: msg.groupId, content }, '复读');
    return true;
  }

  private _registerCommands(): void {
    this.commands.set('help', async (msg, _args, _config) => {
      await this.adapter.send(msg.groupId, `欢迎使用群机器人！以下是所有可用指令：

【聊天 & 模仿】
/mimic @群友 [话题]   — 让我模仿某位群友的说话风格回复一句
/mimic_on @群友       — 开启持续模仿模式（全群生效，任何人可关闭）
/mimic_off            — 关闭当前的模仿模式

【群规 & 管理】（仅管理员）
/rule_add <描述>       — 添加一条群规或违规示例
/rule_false_positive <消息ID> — 标记一条 AI 误判，撤销对应处罚
/add <人名>            — 进入图片收集模式，接下来发的图存入该人名图片库
/add_stop             — 提前结束图片收集

【申诉】
/appeal               — 申诉你最近一次受到的处罚（处罚后24小时内有效）

【查看信息】
/rules                — 查看本群当前所有群规
/stats                — 查看本群近7天的统计数据

如有疑问请联系群管理员。`);
    });

    this.commands.set('rules', async (msg, args, _config) => {
      const pageArg = args[0] === 'page' ? parseInt(args[1] ?? '1', 10) : 1;
      const page = isNaN(pageArg) ? 1 : Math.max(1, pageArg);
      const limit = 20;
      const offset = (page - 1) * limit;

      const { rules, total } = this.db.rules.getPage(msg.groupId, offset, limit);

      if (total === 0) {
        await this.adapter.send(msg.groupId, '本群尚未配置任何群规。管理员可使用 /rule_add 添加。');
        return;
      }

      const start = offset + 1;
      const end = Math.min(offset + rules.length, total);
      const ruleLines = rules.map((r, i) => {
        const text = r.content.length > 200 ? r.content.slice(0, 200) + '...' : r.content;
        return `${offset + i + 1}. ${text}`;
      }).join('\n');

      let text = `本群当前群规（共 ${total} 条，显示第 ${start}–${end} 条）：\n\n${ruleLines}`;
      if (end < total) {
        text += `\n\n如需查看更多，发送 /rules page ${page + 1}`;
      }
      await this.adapter.send(msg.groupId, text);
    });

    this.commands.set('stats', async (msg, _args, config) => {
      const sevenDays = 7 * 24 * 3600;
      const recent = this.db.moderation.findRecentByGroup(msg.groupId, sevenDays * 1000);

      const cap = config.dailyPunishmentLimit;
      const punishmentsToday = config.punishmentsToday;
      const remaining = Math.max(0, cap - punishmentsToday);

      const violations = recent.filter(r => r.violation).length;
      const punishments = recent.filter(r => r.action !== 'none').length;
      const appeals = recent.filter(r => r.appealed > 0).length;
      const approved = recent.filter(r => r.reversed).length;
      const mimicUser = config.mimicActiveUserId;

      await this.adapter.send(msg.groupId, `本群近7天统计数据：
- 处理消息数：${this.db.messages.getRecent(msg.groupId, 9999).length}
- 检测违规数：${violations}
- 已执行处罚：${punishments}
- 申诉记录：${appeals}（${approved} 条获批）
- 今日剩余处罚配额：${remaining}/${cap}
- 当前模仿模式：${mimicUser ? `正在模仿 @${mimicUser}` : 'OFF'}`);
    });

    this.commands.set('mimic', async (msg, args, _config) => {
      if (!this.mimicModule) {
        await this.adapter.send(msg.groupId, '此功能即将推出，敬请期待。');
        return;
      }

      // Resolve @target from CQ:at code in rawContent (QQ sends mentions as CQ
      // codes, not plain text — stripped content loses them entirely)
      const targetUserId = resolveAtTarget(msg.rawContent, args);
      if (!targetUserId) {
        await this.adapter.send(msg.groupId, '用法：/mimic @群友 [话题]\n例如：/mimic @小明 今天吃了什么');
        return;
      }

      // Topic is everything after the command that isn't a CQ code or UID
      const topic = args.filter(a => !a.startsWith('@') && !/^\d{5,}$/.test(a)).join(' ') || null;

      const recentMsgs = this.db.messages.getRecent(msg.groupId, 20).map(m => ({
        messageId: String(m.id), groupId: m.groupId, userId: m.userId,
        nickname: m.nickname, role: 'member' as const,
        content: m.content, rawContent: m.content, timestamp: m.timestamp,
      }));

      const result = await this.mimicModule.generateMimic(msg.groupId, targetUserId, topic, recentMsgs);

      if (!result.ok) {
        if (result.errorCode === BotErrorCode.USER_NOT_FOUND) {
          await this.adapter.send(msg.groupId, `@${targetUserId} 在本群没有历史消息记录，无法进行模仿。`);
        } else if (result.errorCode === BotErrorCode.SELF_MIMIC) {
          await this.adapter.send(msg.groupId, '我没办法模仿我自己啦。');
        } else {
          await this.adapter.send(msg.groupId, 'AI 服务暂时不可用，请稍后再试。');
        }
        return;
      }

      let reply = '';
      if (this.mimicModule.isInsufficientHistory(result.historyCount)) {
        reply += `⚠️ 目前只有 ${result.historyCount} 条历史消息，模仿效果可能不准确。\n\n`;
      }
      reply += result.text;
      await this.adapter.send(msg.groupId, reply);
    });

    this.commands.set('mimic_on', async (msg, args, _config) => {
      if (!this.mimicModule) {
        await this.adapter.send(msg.groupId, '此功能即将推出，敬请期待。');
        return;
      }

      // Resolve @target from CQ:at code in rawContent
      const targetUserId = resolveAtTarget(msg.rawContent, args);
      if (!targetUserId) {
        await this.adapter.send(msg.groupId, '用法：/mimic_on @群友');
        return;
      }

      // Check target has history
      const userMsgs = this.db.messages.getByUser(msg.groupId, targetUserId, 1);
      if (userMsgs.length === 0) {
        await this.adapter.send(msg.groupId, `@${targetUserId} 在本群没有历史消息记录，无法开启模仿模式。`);
        return;
      }

      const nickname = userMsgs[0]!.nickname;
      const result = await this.mimicModule.startMimic(msg.groupId, targetUserId, nickname, msg.userId);

      if (result.replaced) {
        await this.adapter.send(msg.groupId,
          `已切换模仿目标：现在模仿 @${nickname} 的说话风格。使用 /mimic_off 可随时关闭。`);
      } else {
        await this.adapter.send(msg.groupId,
          `模仿模式已开启：本群之后的回复将模仿 @${nickname} 的说话风格。使用 /mimic_off 可随时关闭。`);
      }
    });

    this.commands.set('mimic_off', async (msg, _args, _config) => {
      if (!this.mimicModule) {
        await this.adapter.send(msg.groupId, '此功能即将推出，敬请期待。');
        return;
      }

      const result = await this.mimicModule.stopMimic(msg.groupId);
      if (result.wasActive) {
        await this.adapter.send(msg.groupId, '模仿模式已关闭，恢复正常聊天模式。');
      } else {
        await this.adapter.send(msg.groupId, '当前没有开启模仿模式，无需关闭。');
      }
    });

    this.commands.set('appeal', async (msg, args, config) => {
      if (!this.moderatorModule) {
        await this.adapter.send(msg.groupId, '此功能即将推出，敬请期待。');
        return;
      }

      // Parse optional @target from CQ:at code or plain UID
      const targetUserId = resolveAtTarget(msg.rawContent, args) ?? undefined;
      // resolveAtTarget falls back to plain UID or @-text; undefined means self-appeal
      const isAdmin = msg.role === 'admin' || msg.role === 'owner';

      // Members may only appeal their own punishment; only admins may target others
      if (targetUserId && targetUserId !== msg.userId && !isAdmin) {
        await this.adapter.send(msg.groupId, '你只能申诉自己的处罚。');
        return;
      }

      const result = await this.moderatorModule.handleAppeal(msg, config, targetUserId);
      if (!result.ok) {
        if (result.errorCode === BotErrorCode.NO_PUNISHMENT_RECORD) {
          await this.adapter.send(msg.groupId, '未找到你的近期处罚记录，无法发起申诉。');
        } else if (result.errorCode === BotErrorCode.APPEAL_EXPIRED) {
          await this.adapter.send(msg.groupId, '申诉窗口已关闭（仅限处罚后24小时内）。如有异议请直接联系管理员。');
        } else {
          await this.adapter.send(msg.groupId, '申诉处理失败，请稍后再试。');
        }
        return;
      }
      const subjectNickname = targetUserId ? targetUserId : msg.nickname;
      if (result.wasKick) {
        await this.adapter.send(msg.groupId,
          `@${subjectNickname} 申诉已批准，记录已更正。你已被移出群聊，无法自动恢复，请联系管理员重新邀请。`);
      } else {
        await this.adapter.send(msg.groupId,
          `@${subjectNickname} 申诉已批准，禁言已解除，处罚已撤销。`);
      }
    });

    this.commands.set('rule_add', async (msg, args, _config) => {
      if (!this.moderatorModule) {
        await this.adapter.send(msg.groupId, '此功能即将推出，敬请期待。');
        return;
      }
      if (msg.role !== 'admin' && msg.role !== 'owner') {
        await this.adapter.send(msg.groupId, '没有权限。只有管理员可以添加规则。');
        return;
      }
      const content = args.join(' ').trim();
      if (!content) {
        await this.adapter.send(msg.groupId, '规则描述不能为空，请重新输入。');
        return;
      }
      const result = await this.moderatorModule.addRule(msg.groupId, content, msg.role);
      if (result.ok) {
        const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;
        await this.adapter.send(msg.groupId, `规则已添加（ID: ${result.ruleId}）：${preview}`);
      } else {
        await this.adapter.send(msg.groupId, '规则保存失败，请稍后再试。');
      }
    });

    this.commands.set('add', async (msg, args, config) => {
      if (!this.nameImagesModule) {
        await this.adapter.send(msg.groupId, '此功能即将推出，敬请期待。');
        return;
      }
      if (!config.nameImagesEnabled) {
        await this.adapter.send(msg.groupId, '图片库功能已禁用。');
        return;
      }
      const name = args.join(' ').trim().replace(/[/\\..]+/g, '');
      if (!name) {
        await this.adapter.send(msg.groupId, '用法：/add <人名>\n例如：/add 西瓜');
        return;
      }
      const timeoutMs = config.nameImagesCollectionTimeoutMs;
      this.nameImagesModule.startCollecting(msg.groupId, msg.userId, name, timeoutMs);
      const minutes = Math.round(timeoutMs / 60_000);
      const count = this.nameImagesModule.countByName(msg.groupId, name);
      await this.adapter.send(msg.groupId,
        `好的，接下来 ${minutes} 分钟内你发的图片会存到 ${name} 的图片库（当前${count}张）。之后群里有人单独发 "${name}" 就会触发回图。发 /add_stop 可提前结束。`);
    });

    this.commands.set('add_stop', async (msg, _args, _config) => {
      if (!this.nameImagesModule) return;
      this.nameImagesModule.stopCollecting(msg.groupId, msg.userId);
      await this.adapter.send(msg.groupId, '已停止收集，图片库已保存。');
    });

    this.commands.set('add_block', async (msg, args, config) => {
      if (msg.role !== 'admin' && msg.role !== 'owner') {
        await this.adapter.send(msg.groupId, '没有权限。只有管理员可以操作此指令。');
        return;
      }
      const name = args.join(' ').trim();
      if (!name) {
        await this.adapter.send(msg.groupId, '用法：/add_block <人名>');
        return;
      }
      const blocklist = [...new Set([...(config.nameImagesBlocklist ?? []), name])];
      this.db.groupConfig.upsert({ ...config, nameImagesBlocklist: blocklist, updatedAt: new Date().toISOString() });
      await this.adapter.send(msg.groupId, `已将 "${name}" 加入图片触发屏蔽名单，发该名字不再触发图片库。`);
    });

    this.commands.set('add_unblock', async (msg, args, config) => {
      if (msg.role !== 'admin' && msg.role !== 'owner') {
        await this.adapter.send(msg.groupId, '没有权限。只有管理员可以操作此指令。');
        return;
      }
      const name = args.join(' ').trim();
      if (!name) {
        await this.adapter.send(msg.groupId, '用法：/add_unblock <人名>');
        return;
      }
      const blocklist = (config.nameImagesBlocklist ?? []).filter(b => b.toLowerCase() !== name.toLowerCase());
      this.db.groupConfig.upsert({ ...config, nameImagesBlocklist: blocklist, updatedAt: new Date().toISOString() });
      await this.adapter.send(msg.groupId, `已将 "${name}" 从屏蔽名单移除，发该名字将恢复触发图片库。`);
    });

    this.commands.set('rule_false_positive', async (msg, args, _config) => {
      if (!this.moderatorModule) {
        await this.adapter.send(msg.groupId, '此功能即将推出，敬请期待。');
        return;
      }
      if (msg.role !== 'admin' && msg.role !== 'owner') {
        await this.adapter.send(msg.groupId, '没有权限。只有管理员可以操作此指令。');
        return;
      }
      const msgId = args[0];
      if (!msgId) {
        await this.adapter.send(msg.groupId, '用法：/rule_false_positive <消息ID>');
        return;
      }
      const result = await this.moderatorModule.markFalsePositive(msgId, msg.role);
      if (result.ok) {
        await this.adapter.send(msg.groupId, `消息 ${msgId} 已标记为误判，处罚已撤销，已记录至学习库。`);
      } else if (!result.ok && result.errorCode === BotErrorCode.NO_PUNISHMENT_RECORD) {
        await this.adapter.send(msg.groupId, `未找到消息 ${msgId} 的审核记录，请确认 ID 是否正确。`);
      } else {
        await this.adapter.send(msg.groupId, '操作失败，请稍后再试。');
      }
    });
  }
}
