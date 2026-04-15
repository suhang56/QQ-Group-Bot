import type { GroupMessage, PrivateMessage, INapCatAdapter } from '../adapter/napcat.js';
import type { Database, GroupConfig, ProposedAction } from '../storage/db.js';
import type { RateLimiter } from './rateLimiter.js';
import type { IChatModule } from '../modules/chat.js';
import type { MimicModule } from '../modules/mimic.js';
import type { ModeratorModule } from '../modules/moderator.js';
import type { NameImagesModule } from '../modules/name-images.js';
import type { LoreUpdater } from '../modules/lore-updater.js';
import type { StickerCaptureService } from '../modules/sticker-capture.js';
import type { SelfLearningModule } from '../modules/self-learning.js';
import type { IdCardGuard } from '../modules/id-guard.js';
import type { SequenceGuard } from '../modules/sequence-guard.js';
import type { VisionService } from '../modules/vision.js';
import { extractTokens } from '../modules/chat.js';
import { BotErrorCode } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { defaultGroupConfig } from '../config.js';
import { resolveAtTarget } from '../utils/cqcode.js';
import { expandForwards, purgeExpiredForwardCache } from './forward-expand.js';

const MAX_SPLIT_LINES = 3;
const MOD_APPROVAL_ADMIN = process.env['MOD_APPROVAL_ADMIN'] ?? '2331924739';
const MOD_DM_HOURLY_CAP = 20;
const MOD_EXPIRY_SEC = 600; // 10 minutes
// Users allowed to have free-form private chat with the bot.
// These users hit the full ChatModule pipeline (using their configured group's knowledge base).
const PRIVATE_CHAT_USERS = new Map<string, string>(
  // userId → groupId (which group's lore/facts/persona to use)
  (process.env['PRIVATE_CHAT_USERS']?.split(',').filter(Boolean).map(p => {
    const [uid, gid] = p.split(':');
    return [uid!, gid ?? '958751334'] as [string, string];
  })) ?? [['1424791852', '958751334']]
);
const APPEAL_HOURLY_CAP_PER_USER = 3;
const PRIVATE_CHAT_HOURLY_CAP_PER_USER = 300;
const SPLIT_DELAY_MIN_MS = 30;
const SPLIT_DELAY_MAX_MS = 80;

/** Split a reply on newlines, cap at MAX_SPLIT_LINES, drop empty lines. */
export function splitReply(text: string): string[] {
  // Collapse any \n inside [CQ:...] blocks so multi-line CQ codes become atomic tokens
  let flattened = text.replace(/\[CQ:[^\]]*\]/gs, (cq) => cq.replace(/\s*\n\s*/g, ''));
  // Strip duplicate/stray ] that immediately follows a CQ code (with optional whitespace)
  // e.g. [CQ:mface,...]] or [CQ:mface,...] ] → [CQ:mface,...]
  flattened = flattened.replace(/(\[CQ:[^\]]*\])\s*\]+/g, '$1');
  // Strip trailing unmatched lone bracket lines (not part of a CQ code)
  const stripped = flattened.replace(/\n+[\[\]]\s*$/g, '');
  const lines = stripped.split('\n').map(l => l.trim()).filter(l => {
    if (l.length === 0) return false;
    // Drop lines that are only brackets, parens, punctuation, or whitespace
    if (/^[\s\[\]()（）【】｜|\-—\.。,，!！?？「」『』〔〕［］]+$/.test(l)) return false;
    // Belt-and-suspenders: drop any <skip> line that postProcess may have missed
    if (/^\s*<\s*skip\s*>\s*$/i.test(l)) return false;
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
  // OneBot encodes CQ code parameter values with HTML entities (& → &amp;,
  // [ → &#91;, ] → &#93;, , → &#44;). Some upstream paths (forward-expand,
  // nested quotes) re-escape on top of that, producing &amp;amp;. Decode
  // both layers before returning the URL.
  let url = m[1];
  url = url.replace(/&amp;amp;/g, '&').replace(/&amp;/g, '&');
  url = url.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',');
  try { url = decodeURIComponent(url); } catch { /* URI already plain */ }
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
  private loreUpdater: LoreUpdater | null = null;
  private stickerCapture: StickerCaptureService | null = null;
  private selfLearning: SelfLearningModule | null = null;
  private idGuard: IdCardGuard | null = null;
  private sequenceGuard: SequenceGuard | null = null;
  private visionService: VisionService | null = null;
  private forwardPurgeInterval: ReturnType<typeof setInterval> | null = null;

  // Repeater cooldown: key = `${groupId}:${content}`, value = last-triggered timestamp
  private readonly repeaterCooldown = new Map<string, number>();

  // @-mention queue: per-group list of pending mentions waiting for in-flight to complete
  private readonly atMentionQueue = new Map<string, QueuedMention[]>();
  // @-mention burst tracking: per-group timestamps of recent @-mention replies
  private readonly atReplyTimestamps = new Map<string, number[]>();
  // in-flight lock for @-mention queue processing (separate from ChatModule's lock)
  private readonly atInFlight = new Set<string>();
  // pending harvest timers per group: prevents overlap
  private readonly harvestTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // D7: rate limit — track DMs sent to admin this hour
  private modDmCount = 0;
  private modDmHourStart = Math.floor(Date.now() / 3600000);
  // D5: expiry sweep interval
  private expiryInterval: ReturnType<typeof setInterval> | null = null;

  // Appeals: in-memory pending appeal store. Short-lived — admin responds
  // within minutes/hours typically, and bot restarts clear the queue.
  private readonly pendingAppeals = new Map<number, {
    userId: string; nickname: string; text: string; createdAt: number;
  }>();
  private nextAppealId = 1;
  // Per-user appeal rate limit: userId → count in current hour
  private readonly appealCounts = new Map<string, number>();
  private appealCountHour = Math.floor(Date.now() / 3600000);

  constructor(
    private readonly db: Database,
    private readonly adapter: INapCatAdapter,
    private readonly rateLimiter: RateLimiter,
    private readonly botUserId?: string,
  ) {
    this._registerCommands();
    this.expiryInterval = setInterval(() => {
      const expired = this.db.pendingModeration.expireOlderThan(Math.floor(Date.now() / 1000) - MOD_EXPIRY_SEC);
      if (expired > 0) this.logger.info({ expired }, 'pending moderation rows expired');
    }, 60_000);
    this.expiryInterval.unref?.();

    this.forwardPurgeInterval = setInterval(() => {
      const purged = purgeExpiredForwardCache(this.db.forwardCache);
      if (purged > 0) this.logger.info({ purged }, 'forward cache entries purged');
    }, 3_600_000);
    this.forwardPurgeInterval.unref?.();
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

  setLoreUpdater(updater: LoreUpdater): void {
    this.loreUpdater = updater;
  }

  setStickerCapture(svc: StickerCaptureService): void {
    this.stickerCapture = svc;
  }

  setSelfLearning(sl: SelfLearningModule): void {
    this.selfLearning = sl;
  }

  setIdGuard(guard: IdCardGuard): void {
    this.idGuard = guard;
  }

  setSequenceGuard(guard: SequenceGuard): void {
    this.sequenceGuard = guard;
  }

  setVisionService(vision: VisionService): void {
    this.visionService = vision;
  }

  dispose(): void {
    for (const timer of this.harvestTimers.values()) clearTimeout(timer);
    this.harvestTimers.clear();
    if (this.expiryInterval) { clearInterval(this.expiryInterval); this.expiryInterval = null; }
    if (this.forwardPurgeInterval) { clearInterval(this.forwardPurgeInterval); this.forwardPurgeInterval = null; }
    this.atMentionQueue.clear();
    this.atInFlight.clear();
    this.sequenceGuard?.dispose();
  }

  async dispatch(msg: GroupMessage): Promise<void> {
    try {
      this.logger.trace({ messageId: msg.messageId, groupId: msg.groupId, userId: msg.userId }, 'dispatching message');

      const config = this.db.groupConfig.get(msg.groupId) ?? this._defaultConfig(msg.groupId);

      // Expand 合并转发 blocks so downstream pipeline sees message text
      if (msg.rawContent.includes('[CQ:forward,')) {
        try {
          const expanded = await expandForwards(
            msg.rawContent, this.adapter, this.db.forwardCache, msg.groupId, this.logger,
          );
          const expandedText = expanded.replace(/\[CQ:[^\]]+\]/g, '').trim();
          if (expandedText) msg = { ...msg, content: msg.content ? `${msg.content}\n${expandedText}` : expandedText };
        } catch (err) {
          this.logger.warn({ err, messageId: msg.messageId }, 'forward expand in dispatch failed — ignored');
        }
      }

      // ID card guard — runs first, before any persistence or downstream modules
      if (this.idGuard && config.idGuardEnabled) {
        const blocked = await this.idGuard.check(msg).catch(err => {
          this.logger.error({ err, messageId: msg.messageId }, 'idGuard check failed');
          return false;
        });
        if (blocked) return;
      }

      // Passive image describe — fire-and-forget so all images/mface stickers
      // get cached regardless of chat reply. Both [CQ:image,...] and
      // [CQ:mface,...] (QQ market stickers) are handled by the vision module.
      if (this.visionService && /\[CQ:(image|mface),/.test(msg.rawContent)) {
        void this.visionService.describeFromMessage(
          msg.groupId, msg.rawContent, msg.userId, this.botUserId ?? '',
        ).catch(err => this.logger.warn({ err: String(err), messageId: msg.messageId }, 'passive describe failed'));
      }

      // Sequence guard — cross-message 接龙 relay detection
      if (this.sequenceGuard) {
        const seqHit = await this.sequenceGuard.check(msg).catch(err => {
          this.logger.error({ err, messageId: msg.messageId }, 'sequenceGuard check failed');
          return false;
        });
        if (seqHit) return;
      }

      // Lore updater tick: increment per-group counter, fire async update if threshold hit
      this.loreUpdater?.tick(msg.groupId, config);

      // Text moderator — fire-and-forget so chat pipeline doesn't wait for the
      // moderation Claude call. Moderation still reaches admin DM on violation,
      // just on its own schedule. This halves p50 latency for chat replies.
      if (this.moderatorModule && config.autoMod && !msg.content.trim().startsWith('/')) {
        this.moderatorModule.assess(msg, config).then(verdict => {
          if (verdict.violation && verdict.severity !== null && verdict.severity >= 1) {
            void this._queueModerationApproval(msg, verdict.severity, verdict.reason);
          }
        }).catch(err => this.logger.warn({ err, messageId: msg.messageId }, 'moderator assess failed'));
      }

      // Image moderator — runs after text check; id-guard already returned if it blocked the message.
      // Skip when the sender is actively in name-image collection mode —
      // those uploads are the admin curating their own library, not new
      // content that needs moderation.
      const inNameImageCollection =
        this.nameImagesModule?.getCollectionTarget(msg.groupId, msg.userId) != null;
      const imageFileKey = _extractImageFile(msg.rawContent);
      if (imageFileKey && this.moderatorModule && config.autoMod && !inNameImageCollection) {
        void this._assessImageAsync(msg, imageFileKey);
      }

      // Nested images inside expanded forwards
      if (
        msg.rawContent.includes('[CQ:forward,') &&
        this.moderatorModule &&
        config.autoMod &&
        !inNameImageCollection
      ) {
        const cachedExpanded = this.db.forwardCache.get(
          (msg.rawContent.match(/\[CQ:forward,id=([^\],]+)/)?.[1] ?? '').trim(),
        );
        if (cachedExpanded?.nestedImageKeys?.length) {
          for (const key of cachedExpanded.nestedImageKeys) {
            void this._assessImageAsync(msg, key);
          }
        }
      }

      // Persist message and upsert user
      this.db.messages.insert({
        groupId: msg.groupId,
        userId: msg.userId,
        nickname: msg.nickname,
        content: msg.content,
        rawContent: msg.rawContent,
        timestamp: msg.timestamp,
        deleted: false,
      });

      this.db.users.upsert({
        userId: msg.userId,
        groupId: msg.groupId,
        nickname: msg.nickname,
        styleSummary: null,
        lastSeen: msg.timestamp,
        role: msg.role ?? 'member',
      });

      // Live sticker capture: record mface + image stickers (sub_type=1) seen in the wild
      if (config.liveStickerCaptureEnabled) {
        this._captureLiveStickers(msg);
      }

      // Local sticker learning: download image stickers, track mfaces with context
      if (this.stickerCapture && msg.rawContent.match(/\[CQ:(image|mface),/)) {
        const recent2 = this.db.messages.getRecent(msg.groupId, 2).map(m => m.content).filter(Boolean);
        const { StickerCaptureService: Svc } = await import('../modules/sticker-capture.js');
        const contextSample = Svc.buildContextSample(recent2);
        this.stickerCapture.captureFromMessage(
          msg.groupId, msg.rawContent, contextSample, msg.userId, this.botUserId ?? '',
        ).catch(err => this.logger.warn({ err, groupId: msg.groupId }, 'sticker capture failed'));
      }

      // Tick sticker legend refresh counter (rebuilds sticker section every N messages)
      this.chatModule?.tickStickerRefresh(msg.groupId);

      // Admin speech mirroring: record admin/owner messages for tone reference
      if ((msg.role === 'admin' || msg.role === 'owner') && msg.content.trim()) {
        this.chatModule?.noteAdminActivity(msg.groupId, msg.userId, msg.nickname, msg.content);
      }

      // Self-learning: detect corrections when user reply-quotes a bot_reply row
      if (this.selfLearning) {
        const replyMatch = msg.rawContent.match(/\[CQ:reply,id=(\d+)\]/);
        if (replyMatch) {
          const quotedId = parseInt(replyMatch[1]!, 10);
          const botReply = this.db.botReplies.getById(quotedId);
          if (botReply && botReply.groupId === msg.groupId) {
            void this.selfLearning.detectCorrection({
              groupId: msg.groupId,
              botReplyId: botReply.id,
              correctionMsg: { content: msg.content, userId: msg.userId, nickname: msg.nickname, messageId: msg.messageId },
            }).then(result => {
              if (result) this.logger.info({ groupId: msg.groupId, factId: result }, 'correction learned');
            }).catch(err => {
              this.logger.warn({ err, groupId: msg.groupId }, 'detectCorrection failed — ignored');
            });
          }
        } else if (msg.userId !== (this.botUserId ?? '')) {
          // Top-level correction: no reply-quote, but the user may still be pushing back
          // on the most recent bot reply in this group. Feature C in fact-quality batch.
          try {
            const recent = this.db.botReplies.getRecent(msg.groupId, 1);
            const last = recent[0];
            if (last && last.module === 'chat' && (Math.floor(Date.now() / 1000) - last.sentAt) <= 60) {
              this.selfLearning.handleTopLevelCorrection({
                groupId: msg.groupId,
                content: msg.content,
                priorBotReply: { id: last.id, content: last.botReply, trigger: last.triggerContent },
              });
            }
          } catch (err) {
            this.logger.warn({ err, groupId: msg.groupId }, 'handleTopLevelCorrection failed — ignored');
          }
        }
      }

      // Command routing — admin/owner only at router level; /appeal and read-only fact commands open to all
      const trimmed = msg.content.trim();
      const isAdmin = msg.role === 'admin' || msg.role === 'owner';
      const peekCmd = trimmed.startsWith('/') ? (trimmed.slice(1).split(/\s+/)[0]?.toLowerCase() ?? '') : '';
      const openCmds = new Set(['appeal', 'facts', 'fact_reject', 'fact_clear', 'add', 'add_stop']);
      if (trimmed.startsWith('/') && (isAdmin || openCmds.has(peekCmd))) {
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
            } catch (err) {
              this.logger.warn(
                { err: String(err), groupId: msg.groupId, target },
                'image-capture: saveImage failed',
              );
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

      // Name-image trigger: fires only when the entire message IS a known name (exact match after trim).
      // When a name-image trigger resolves (whether or not the image is actually sent due to cooldown/
      // burst guard), we MUST short-circuit the rest of the pipeline so the chat module doesn't also
      // generate a reply to what is effectively a user invoking the bot's picture-posting feature.
      // Otherwise the chat module sees "just a name" and emits noise like "啊?" next to the picture.
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
            // Whether we sent an image or skipped due to burst/cooldown, the user's intent was to
            // invoke the picture-posting feature — chat should NOT also react to the same message.
            return;
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
        rawContent: m.rawContent,
        timestamp: m.timestamp,
      }));

      if (this.mimicModule) {
        const activeUserId = this.mimicModule.getActiveMimicUser(msg.groupId);
        if (activeUserId) {
          const result = await this.mimicModule.generateMimic(msg.groupId, activeUserId, msg.content, recentMsgs);
          if (result.ok) {
            await this._sendReply(msg.groupId, result.text, undefined, {
              module: 'mimic',
              triggerMsgId: msg.messageId,
              triggerUserId: msg.userId,
              triggerUserNickname: msg.nickname,
              triggerContent: msg.content,
            });
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
            const wasEvasive = this.chatModule.getEvasiveFlagForLastReply(msg.groupId);
            const injectedFactIds = this.chatModule.getInjectedFactIdsForLastReply(msg.groupId);
            const botReplyId = await this._sendReply(msg.groupId, reply, undefined, {
              module: 'chat',
              triggerMsgId: msg.messageId,
              triggerUserId: msg.userId,
              triggerUserNickname: msg.nickname,
              triggerContent: msg.content,
            });
            if (botReplyId !== null && this.selfLearning && injectedFactIds.length > 0) {
              this.selfLearning.rememberInjection(msg.groupId, botReplyId, injectedFactIds);
            }
            if (wasEvasive && botReplyId !== null && this.selfLearning) {
              if (botReplyId !== null) {
                try { this.db.botReplies.markEvasive(botReplyId); } catch { /* non-fatal */ }
              }
              this._scheduleHarvest(msg.groupId, botReplyId, msg.content);
              // Online lookup fires immediately in parallel with the 60s harvest timer
              void this.selfLearning.researchOnline({
                groupId: msg.groupId,
                evasiveBotReplyId: botReplyId,
                originalTrigger: msg.content,
              }).catch(err => this.logger.debug({ err, groupId: msg.groupId }, 'researchOnline rejected'));
            }
          }
        }
      }

    } catch (err) {
      this.logger.fatal({ err, messageId: msg.messageId }, 'Unhandled error in router.dispatch');
    }
  }

  /** Send a reply as one or more messages (split on newlines), with typing delay between lines.
   *  replyToMsgId is only prepended to the FIRST send (quote-reply), continuation lines go plain.
   *  logCtx, when provided, logs the reply to bot_replies and marks continuity for the trigger user.
   *  Returns the bot_replies row id when logCtx is provided, otherwise null. */
  private async _sendReply(
    groupId: string,
    text: string,
    replyToMsgId?: number,
    logCtx?: { module: string; triggerMsgId?: string; triggerUserId?: string; triggerUserNickname?: string; triggerContent: string },
  ): Promise<number | null> {
    const lines = splitReply(text);
    if (lines.length === 0) return null;
    if (lines.length > MAX_SPLIT_LINES) {
      this.logger.info({ groupId, totalLines: text.split('\n').length }, 'reply truncated to 3 lines');
    }
    for (let i = 0; i < lines.length; i++) {
      await new Promise(r => setTimeout(r, randomDelay()));
      const msgId = await this.adapter.send(groupId, lines[i]!, i === 0 ? replyToMsgId : undefined);
      if (msgId !== null && this.chatModule) {
        this.chatModule.recordOutgoingMessage(groupId, msgId);
      }
    }
    if (logCtx) {
      if (logCtx.triggerUserId && this.chatModule) {
        this.chatModule.markReplyToUser(groupId, logCtx.triggerUserId);
      }
      try {
        const row = this.db.botReplies.insert({
          groupId,
          triggerMsgId: logCtx.triggerMsgId ?? null,
          triggerUserNickname: logCtx.triggerUserNickname ?? null,
          triggerContent: logCtx.triggerContent,
          botReply: lines.join('\n'),
          module: logCtx.module,
          sentAt: Math.floor(Date.now() / 1000),
        });
        return row.id;
      } catch { /* non-fatal */ }
    }
    return null;
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
        let reply = await this.chatModule.generateReply(groupId, item.msg, recentMsgs);

        // Safety net: @-mention must never result in total silence. If chat
        // returned null (Claude skip / opt-out / echo), send a minimal
        // deflection so the user who @-ed sees an ack instead of nothing.
        if (!reply) {
          const AT_FALLBACK = ['啊?', '咋了', '啥事', '?', '怎么了', '叫我干嘛', '什么'];
          reply = AT_FALLBACK[Math.floor(Math.random() * AT_FALLBACK.length)]!;
          this.logger.info({ groupId, userId: item.msg.userId }, '@-mention fallback deflection — chat returned null');
        }

        await this._sendReply(groupId, reply, item.sourceMsgId, {
          module: 'chat',
          triggerMsgId: item.msg.messageId,
          triggerUserId: item.msg.userId,
          triggerUserNickname: item.msg.nickname,
          triggerContent: item.msg.content,
        });
        timestamps.push(Date.now());
        this.atReplyTimestamps.set(groupId, timestamps);
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

  private _scheduleHarvest(groupId: string, botReplyId: number, originalTrigger: string): void {
    // Dedup: cancel any existing harvest timer for this group
    const existing = this.harvestTimers.get(groupId);
    if (existing !== undefined) clearTimeout(existing);

    const evasiveSentAt = Math.floor(Date.now() / 1000);
    const timer = setTimeout(() => {
      this.harvestTimers.delete(groupId);
      if (!this.selfLearning) return;

      const recent = this.db.messages.getRecent(groupId, 30).filter(m =>
        m.timestamp > evasiveSentAt && m.userId !== (this.botUserId ?? ''),
      );

      const triggerTokens = extractTokens(originalTrigger);
      const overlapping = recent.filter(m => {
        const mTokens = extractTokens(m.content);
        let overlap = 0;
        for (const t of triggerTokens) {
          if (mTokens.has(t)) overlap++;
        }
        return overlap >= 2;
      });

      if (overlapping.length === 0) return;

      void this.selfLearning.harvestPassiveKnowledge({
        groupId,
        evasiveBotReplyId: botReplyId,
        originalTrigger,
        followups: overlapping.map(m => ({ content: m.content, userId: m.userId, nickname: m.nickname, messageId: String(m.id) })),
      }).catch(err => {
        this.logger.warn({ err, groupId }, 'harvestPassiveKnowledge failed — ignored');
      });
    }, 60_000);

    timer.unref?.();
    this.harvestTimers.set(groupId, timer);
  }

  private _captureLiveStickers(msg: GroupMessage): void {
    const now = Math.floor(Date.now() / 1000);
    const raw = msg.rawContent;

    // Match all [CQ:mface,...] segments.
    // summary= values may contain brackets (e.g. summary=[哎]) which break [^\]]+ matching.
    // We use a greedy match up to the last ] on the same line and then rebuild a clean cqCode.
    for (const match of raw.matchAll(/\[CQ:mface,(.*?)\](?!\])/g)) {
      const attrStr = match[1]!;
      const attrs: Record<string, string> = {};
      // Parse key=value pairs; values may contain [ or ] so split on comma only before known keys
      for (const part of attrStr.split(/,(?=[a-z_]+=)/)) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        attrs[part.slice(0, eq)!] = part.slice(eq + 1);
      }
      const pkg = attrs['package_id'] ?? attrs['emoji_package_id'] ?? attrs['pkg'] ?? '';
      const id = attrs['emoji_id'] ?? attrs['id'] ?? '';
      if (!pkg || !id) continue;
      const key = `mface:${pkg}:${id}`;
      // Strip brackets from summary so it doesn't break CQ syntax when echoed back
      const rawSummary = attrs['summary'] ?? attrs['text'] ?? null;
      const summary = rawSummary ? rawSummary.replace(/^\[|\]$/g, '') : null;
      // Rebuild a well-formed cqCode without bracket-wrapped summary
      const cleanAttrs = attrStr.replace(/(?<=(?:^|,)(?:summary|text)=)\[([^\]]*)\](?=,|$)/g, '$1');
      const cleanCqCode = `[CQ:mface,${cleanAttrs}]`;
      this.db.liveStickers.upsert(msg.groupId, key, 'mface', cleanCqCode, summary, now);
    }

    // Match [CQ:image,...] with sub_type=1 (sticker subtype only)
    for (const match of raw.matchAll(/\[CQ:image,([^\]]+)\]/g)) {
      const attrs = Object.fromEntries(
        match[1]!.split(',').map(p => p.split('=') as [string, string])
      );
      if (attrs['sub_type'] !== '1') continue;
      const fileUnique = attrs['file_unique'] ?? attrs['file'] ?? '';
      if (!fileUnique) continue;
      const key = `image:${fileUnique}`;
      this.db.liveStickers.upsert(msg.groupId, key, 'image', match[0]!, null, now);
    }
  }

  private _mapSeverityToAction(severity: number): ProposedAction {
    if (severity <= 3) return 'warn';
    if (severity === 4) return 'mute_10m';
    return 'kick';
  }

  private async _assessImageAsync(msg: GroupMessage, fileKey: string): Promise<void> {
    if (!this.moderatorModule) return;

    // Download image bytes via adapter
    let imageBytes: Buffer | null = null;
    try {
      const info = await this.adapter.getImage(fileKey);
      if (info.base64) {
        imageBytes = Buffer.from(info.base64, 'base64');
      } else if (info.url) {
        const resp = await fetch(info.url);
        if (resp.ok) imageBytes = Buffer.from(await resp.arrayBuffer());
      }
    } catch (err) {
      this.logger.warn({ err, groupId: msg.groupId, fileKey }, 'image download failed — skipping image mod check');
      return;
    }
    if (!imageBytes) {
      this.logger.warn({ groupId: msg.groupId, fileKey }, 'no image bytes available — skipping image mod check');
      return;
    }

    const { createHash } = await import('node:crypto');
    const hashedKey = createHash('sha256').update(fileKey).digest('hex');

    let verdict;
    try {
      verdict = await this.moderatorModule.assessImage({
        userId: msg.userId,
        nickname: msg.nickname,
        messageId: msg.messageId,
        groupId: msg.groupId,
        fileKey: hashedKey,
      }, imageBytes);
    } catch (err) {
      this.logger.error({ err, groupId: msg.groupId, fileKey }, 'assessImage failed — fail-safe');
      return;
    }

    if (!verdict.violation || verdict.severity === null || verdict.severity < 1) return;

    const imageMsg = { ...msg, content: `[图片] ${verdict.reason}` };

    if (verdict.severity >= 5) {
      // Full-ID match: auto-delete immediately, then inform admin
      try { await this.adapter.deleteMsg(msg.messageId); } catch (err) {
        this.logger.error({ err, messageId: msg.messageId }, 'image auto-delete failed');
      }
      try {
        this.db.moderation.insert({
          msgId: msg.messageId, groupId: msg.groupId, userId: msg.userId,
          violation: true, severity: 5, action: 'delete',
          reason: verdict.reason, appealed: 0, reversed: false, timestamp: msg.timestamp,
        });
      } catch (err) {
        this.logger.error({ err }, 'image auto-delete moderation insert failed');
      }
      const dmText = `[自动删除] 群 ${msg.groupId} 用户 ${msg.nickname}(${msg.userId}) 图片含完整泄露身份证号，已自动删除。\n原因: ${verdict.reason}\n消息ID: ${msg.messageId}`;
      await this.adapter.sendPrivateMessage(MOD_APPROVAL_ADMIN, dmText).catch(err =>
        this.logger.error({ err }, 'image auto-delete admin inform DM failed'),
      );
      this.logger.info({ groupId: msg.groupId, userId: msg.userId, messageId: msg.messageId }, 'image auto-deleted (severity 5)');
    } else if (verdict.severity >= 4) {
      // Region-prefix match: queue for admin approval
      void this._queueModerationApproval(imageMsg, verdict.severity, verdict.reason);
    } else {
      // Severity 1-3: log only — record in moderation_log but take no action
      try {
        this.db.moderation.insert({
          msgId: msg.messageId, groupId: msg.groupId, userId: msg.userId,
          violation: true, severity: verdict.severity, action: 'none',
          reason: verdict.reason, appealed: 0, reversed: false, timestamp: msg.timestamp,
        });
      } catch (err) {
        this.logger.error({ err }, 'image log-only moderation insert failed');
      }
      this.logger.info({ groupId: msg.groupId, userId: msg.userId, severity: verdict.severity, reason: verdict.reason }, 'image mod log-only (sev 1-3)');
    }
  }

  private async _queueModerationApproval(msg: GroupMessage, severity: number, reason: string): Promise<void> {
    // D7: rate limit — reset hourly
    const nowHour = Math.floor(Date.now() / 3600000);
    if (nowHour !== this.modDmHourStart) { this.modDmCount = 0; this.modDmHourStart = nowHour; }
    if (this.modDmCount >= MOD_DM_HOURLY_CAP) {
      this.logger.info({ groupId: msg.groupId, userId: msg.userId }, 'mod DM hourly cap reached — observe only');
      return;
    }

    const proposedAction = this._mapSeverityToAction(severity);
    const nowSec = Math.floor(Date.now() / 1000);
    let pendingId: number;
    try {
      pendingId = this.db.pendingModeration.queue({
        groupId: msg.groupId, msgId: msg.messageId,
        userId: msg.userId, userNickname: msg.nickname,
        content: msg.content, severity, reason,
        proposedAction, createdAt: nowSec,
      });
    } catch (err) {
      this.logger.error({ err, groupId: msg.groupId }, 'failed to queue pending moderation');
      return;
    }

    const groupName = msg.groupId;
    const actionLabel: Record<ProposedAction, string> = {
      warn: '删除+警告', delete: '仅删除', mute_10m: '禁言10分钟', mute_1h: '禁言1小时', kick: '移出群聊',
    };
    const dmText = `[审核 #${pendingId}] 群 ${groupName}(${msg.groupId})
用户 ${msg.nickname}(${msg.userId}) 发了：
> ${msg.content}

疑似违规：${reason}
严重度 ${severity}/5
建议处理：${actionLabel[proposedAction]}

10 分钟内回复 /approve ${pendingId} 或 /reject ${pendingId} 决定，超时自动忽略。`;

    try {
      const result = await this.adapter.sendPrivateMessage(MOD_APPROVAL_ADMIN, dmText);
      if (result === null) {
        this.logger.error({ pendingId, groupId: msg.groupId }, 'failed to DM admin — pending row queued but admin not notified');
      } else {
        this.modDmCount++;
        this.logger.info({ pendingId, groupId: msg.groupId, userId: msg.userId, severity, proposedAction }, 'moderation queued, admin DM sent');
      }
    } catch (err) {
      this.logger.error({ err, pendingId, groupId: msg.groupId }, 'sendPrivateMessage threw — admin not notified');
    }
  }

  /** Returns true if this user has a mute within the last 48 hours. */
  private _userHasRecentMute(userId: string): boolean {
    const cutoff = Math.floor(Date.now() / 1000) - 48 * 3600;
    try {
      const row = (this.db as unknown as { _db: { prepare(s: string): { get(...a: unknown[]): unknown } } })._db
        .prepare("SELECT 1 as x FROM moderation_log WHERE user_id = ? AND action LIKE 'mute%' AND timestamp > ? LIMIT 1")
        .get(userId, cutoff) as { x: number } | undefined;
      return !!row;
    } catch { return false; }
  }

  // Per-user rate limit for private chat
  private readonly privateChatCounts = new Map<string, number>();
  private privateChatHour = Math.floor(Date.now() / 3600000);
  // Per-user short-term DM history (last 12 turns) for conversational context
  private readonly privateChatHistory = new Map<string, Array<{ role: 'user' | 'assistant'; content: string; ts: number }>>();

  private async _handlePrivateChat(msg: PrivateMessage, groupId: string): Promise<void> {
    const text = msg.content.trim();
    if (text.length === 0) return;

    // Rate limit
    const nowHour = Math.floor(Date.now() / 3600000);
    if (nowHour !== this.privateChatHour) { this.privateChatCounts.clear(); this.privateChatHour = nowHour; }
    const cnt = this.privateChatCounts.get(msg.userId) ?? 0;
    if (cnt >= PRIVATE_CHAT_HOURLY_CAP_PER_USER) {
      this.logger.info({ userId: msg.userId }, 'private chat rate limited');
      return;
    }
    this.privateChatCounts.set(msg.userId, cnt + 1);

    if (!this.chatModule) {
      this.logger.warn('private chat: chatModule not set');
      return;
    }

    // Append user turn to per-user history
    const history = this.privateChatHistory.get(msg.userId) ?? [];
    history.push({ role: 'user', content: text, ts: Date.now() });
    // Cap history at 12 turns (6 user + 6 assistant)
    while (history.length > 12) history.shift();
    this.privateChatHistory.set(msg.userId, history);

    try {
      const reply = await this.chatModule.generatePrivateReply(groupId, msg.userId, msg.nickname, history);
      if (!reply) return;
      // Append assistant turn
      history.push({ role: 'assistant', content: reply, ts: Date.now() });
      while (history.length > 12) history.shift();
      this.privateChatHistory.set(msg.userId, history);
      // Send as single DM (no split — private chat allows longer replies)
      await this.adapter.sendPrivateMessage(msg.userId, reply);
      this.logger.info({ userId: msg.userId, groupId, replyLen: reply.length }, 'private chat reply sent');
    } catch (err) {
      this.logger.error({ err, userId: msg.userId }, 'private chat reply failed');
    }
  }

  private async _handleAppealFromUser(msg: PrivateMessage): Promise<void> {
    const text = msg.content.trim();
    if (text.length === 0) return;
    if (text.length > 500) {
      await this.adapter.sendPrivateMessage(msg.userId, '申诉内容过长，请精简到 500 字以内。').catch(() => { /* ignore */ });
      return;
    }

    // Rate limit per user
    const nowHour = Math.floor(Date.now() / 3600000);
    if (nowHour !== this.appealCountHour) { this.appealCounts.clear(); this.appealCountHour = nowHour; }
    const cnt = this.appealCounts.get(msg.userId) ?? 0;
    if (cnt >= APPEAL_HOURLY_CAP_PER_USER) {
      this.logger.info({ userId: msg.userId }, 'appeal rate limited — dropping');
      await this.adapter.sendPrivateMessage(msg.userId, '申诉过于频繁，请一小时后再试。').catch(() => { /* ignore */ });
      return;
    }
    this.appealCounts.set(msg.userId, cnt + 1);

    const appealId = this.nextAppealId++;
    this.pendingAppeals.set(appealId, {
      userId: msg.userId, nickname: msg.nickname ?? msg.userId,
      text, createdAt: Date.now(),
    });

    // Lookup user's most recent mute for context
    const recent = (this.db as unknown as { _db: { prepare(s: string): { all(...a: unknown[]): unknown[] } } })._db
      .prepare("SELECT group_id, action, reason, timestamp FROM moderation_log WHERE user_id = ? ORDER BY timestamp DESC LIMIT 1")
      .all(msg.userId) as Array<{ group_id: string; action: string; reason: string; timestamp: number }>;
    const ctxLine = recent.length > 0
      ? `最近处罚：群 ${recent[0]!.group_id}，${recent[0]!.action}，原因：${recent[0]!.reason.slice(0, 80)}`
      : '无最近处罚记录';

    const dm = `[申诉 #${appealId}] 用户 ${msg.nickname}(${msg.userId}) 发来申诉：
${text}

${ctxLine}

/appeal_approve ${appealId} 解除禁言
/appeal_reject ${appealId} 驳回申诉`;

    try {
      await this.adapter.sendPrivateMessage(MOD_APPROVAL_ADMIN, dm);
      await this.adapter.sendPrivateMessage(msg.userId, `申诉已提交（编号 #${appealId}），管理员会尽快处理。`).catch(() => { /* ignore */ });
      this.logger.info({ appealId, userId: msg.userId }, 'appeal forwarded to admin');
    } catch (err) {
      this.logger.error({ err, appealId, userId: msg.userId }, 'failed to forward appeal to admin');
      // Still keep the pending entry so admin can /appeals to see it later if DM recovers
    }
  }

  async dispatchPrivate(msg: PrivateMessage): Promise<void> {
    const isAdmin = msg.userId === MOD_APPROVAL_ADMIN;
    const privateChatGroupId = PRIVATE_CHAT_USERS.get(msg.userId);
    const hasRecentMute = this._userHasRecentMute(msg.userId);

    if (!isAdmin && !privateChatGroupId && !hasRecentMute) {
      this.logger.debug({ userId: msg.userId }, 'private message from unauthorized user — ignored');
      return;
    }

    // Private-chat user: route to conversational chat using their group's knowledge base
    if (!isAdmin && privateChatGroupId) {
      await this._handlePrivateChat(msg, privateChatGroupId);
      return;
    }

    // Muted user appeal flow: forward message to admin for decision
    if (!isAdmin) {
      await this._handleAppealFromUser(msg);
      return;
    }

    const text = msg.content.trim();
    const logger = this.logger;

    const reply = async (t: string) => {
      await this.adapter.sendPrivateMessage(MOD_APPROVAL_ADMIN, t);
    };

    // Admin appeal commands
    const appealApproveMatch = /^\/appeal_approve\s+(\d+)$/i.exec(text);
    const appealRejectMatch = /^\/appeal_reject\s+(\d+)$/i.exec(text);
    if (appealApproveMatch ?? appealRejectMatch) {
      const id = parseInt((appealApproveMatch ?? appealRejectMatch)![1]!, 10);
      const appeal = this.pendingAppeals.get(id);
      if (!appeal) { await reply(`找不到申诉 #${id}。`); return; }
      if (appealRejectMatch) {
        this.pendingAppeals.delete(id);
        await reply(`已拒绝申诉 #${id}（用户 ${appeal.nickname}）。`);
        logger.info({ id, userId: appeal.userId }, 'appeal rejected by admin');
        return;
      }
      // Approve: find user's most recent mute and unmute in that group
      const recent = (this.db as unknown as { _db: { prepare(s: string): { all(...a: unknown[]): unknown[] } } })._db
        .prepare("SELECT group_id, action, timestamp FROM moderation_log WHERE user_id = ? AND action LIKE 'mute%' ORDER BY timestamp DESC LIMIT 1")
        .all(appeal.userId) as Array<{ group_id: string; action: string; timestamp: number }>;
      if (recent.length === 0) {
        await reply(`申诉 #${id} 已批准，但未找到该用户的禁言记录，请手动处理。`);
        this.pendingAppeals.delete(id);
        return;
      }
      const mutedGroupId = recent[0]!.group_id;
      try {
        await this.adapter.ban(mutedGroupId, appeal.userId, 0);
        await reply(`已解除禁言：申诉 #${id} 用户 ${appeal.nickname} 群 ${mutedGroupId}。`);
        logger.info({ id, userId: appeal.userId, groupId: mutedGroupId }, 'appeal approved — user unmuted');
        // Notify the user that their appeal was approved
        try {
          await this.adapter.sendPrivateMessage(appeal.userId, '你的申诉已通过，禁言已解除。');
        } catch { /* non-fatal */ }
      } catch (err) {
        logger.error({ err, id, userId: appeal.userId }, 'failed to unmute after appeal approve');
        await reply(`申诉 #${id} 已批准但解除禁言失败：${String(err)}`);
      }
      this.pendingAppeals.delete(id);
      return;
    }

    if (text === '/appeals') {
      if (this.pendingAppeals.size === 0) {
        await reply('无待处理申诉。');
      } else {
        const lines = [...this.pendingAppeals.entries()].map(([id, a]) =>
          `#${id} ${a.nickname}(${a.userId}): ${a.text.slice(0, 50)}`
        ).join('\n');
        await reply(`待处理申诉：\n${lines}`);
      }
      return;
    }

    if (text === '/pending') {
      const rows = this.db.pendingModeration.listPending(10);
      if (rows.length === 0) {
        await reply('无待处理审核。');
      } else {
        const lines = rows.map(r =>
          `#${r.id} [严重度${r.severity}] 群${r.groupId} 用户${r.userNickname ?? r.userId}: ${r.content.slice(0, 30)}…`
        ).join('\n');
        await reply(`待处理审核（最近10条）：\n${lines}`);
      }
      return;
    }

    if (text === '/help') {
      await reply('/approve <id> — 执行建议处理\n/reject <id> — 拒绝，不处理\n/pending — 查看待处理列表\n/appeals — 查看待处理申诉\n/appeal_approve <id> — 批准申诉并解除禁言\n/appeal_reject <id> — 驳回申诉\n/mod_on — 开启所有群的自动审核\n/mod_off — 关闭所有群的自动审核（仅观察）\n/welcome_on <groupId> — 开启该群欢迎消息\n/welcome_off <groupId> — 关闭该群欢迎消息\n/idguard_on <groupId> — 开启该群身份证拦截\n/idguard_off <groupId> — 关闭该群身份证拦截\n/cache_clear_images — 清除图片审核缓存（规则更新后使用）');
      return;
    }

    if (text === '/mod_on' || text === '/mod_off') {
      const enable = text === '/mod_on';
      const configs = this.db.groupConfig;
      // Fetch all known groups from messages table and update their config
      const groups = (this.db as unknown as { _db: { prepare(s: string): { all(): { group_id: string }[] } } })._db
        .prepare('SELECT DISTINCT group_id FROM group_config').all() as { group_id: string }[];
      for (const { group_id } of groups) {
        const cfg = configs.get(group_id);
        if (cfg) configs.upsert({ ...cfg, autoMod: enable });
      }
      await reply(`已${enable ? '开启' : '关闭'}所有群的自动审核。`);
      logger.info({ enable, groupCount: groups.length }, 'mod_on/mod_off by admin');
      return;
    }

    const idGuardToggleMatch = /^\/idguard_(on|off)\s+(\S+)$/i.exec(text);
    if (idGuardToggleMatch) {
      const enable = idGuardToggleMatch[1]!.toLowerCase() === 'on';
      const groupId = idGuardToggleMatch[2]!;
      const cfg = this.db.groupConfig.get(groupId);
      if (!cfg) {
        await reply(`找不到群 ${groupId} 的配置。`);
        return;
      }
      this.db.groupConfig.upsert({ ...cfg, idGuardEnabled: enable });
      await reply(`群 ${groupId} 身份证拦截已${enable ? '开启' : '关闭'}。`);
      logger.info({ groupId, enable }, 'idGuard toggle by admin');
      return;
    }

    const welcomeToggleMatch = /^\/welcome_(on|off)\s+(\S+)$/i.exec(text);
    if (welcomeToggleMatch) {
      const enable = welcomeToggleMatch[1]!.toLowerCase() === 'on';
      const groupId = welcomeToggleMatch[2]!;
      const cfg = this.db.groupConfig.get(groupId);
      if (!cfg) {
        await reply(`找不到群 ${groupId} 的配置。`);
        return;
      }
      this.db.groupConfig.upsert({ ...cfg, welcomeEnabled: enable });
      await reply(`群 ${groupId} 欢迎消息已${enable ? '开启' : '关闭'}。`);
      logger.info({ groupId, enable }, 'welcome toggle by admin');
      return;
    }

    if (text === '/cache_clear_images') {
      const purged = this.db.imageModCache.purgeOlderThan(Math.floor(Date.now() / 1000) + 1);
      await reply(`已清除 ${purged} 条图片审核缓存。`);
      logger.info({ purged }, 'image mod cache cleared by admin');
      return;
    }

    const approveMatch = /^\/approve\s+(\d+)$/i.exec(text);
    const rejectMatch = /^\/reject\s+(\d+)$/i.exec(text);

    if (approveMatch ?? rejectMatch) {
      const id = parseInt((approveMatch ?? rejectMatch)![1]!, 10);
      const row = this.db.pendingModeration.getById(id);

      if (!row) {
        await reply(`找不到审核 #${id}。`);
        return;
      }
      if (row.status !== 'pending') {
        await reply(`审核 #${id} 已失效（状态：${row.status}）。`);
        return;
      }

      if (rejectMatch) {
        this.db.pendingModeration.markStatus(id, 'rejected', MOD_APPROVAL_ADMIN);
        // Self-learning: record the (content, reason) as a false positive
        // example. Moderator will inject recent rejections into its prompt
        // so Qwen stops making the same wrong call.
        try {
          this.db.modRejections.insert({
            groupId: row.groupId,
            content: row.content,
            reason: row.reason,
            userNickname: row.userNickname,
            createdAt: Math.floor(Date.now() / 1000),
          });
        } catch (err) {
          logger.warn({ err, id }, 'failed to insert mod rejection for self-learning');
        }
        await reply(`已拒绝审核 #${id}（已存入误判样本，以后不会再犯类似错）。`);
        logger.info({ id, groupId: row.groupId, userId: row.userId }, 'moderation rejected by admin + recorded as false positive');
        return;
      }

      // Approve: execute action
      this.db.pendingModeration.markStatus(id, 'approved', MOD_APPROVAL_ADMIN);
      const config = this.db.groupConfig.get(row.groupId) ?? this._defaultConfig(row.groupId);
      if (!this.moderatorModule) {
        await reply(`审核 #${id} 已批准，但 moderatorModule 未加载，无法执行。`);
        return;
      }
      try {
        await this.moderatorModule.executePunishment(row, config);
        await reply(`已执行审核 #${id}：${row.proposedAction}（用户 ${row.userNickname ?? row.userId}）。`);
        logger.info({ id, groupId: row.groupId, userId: row.userId, action: row.proposedAction }, 'moderation approved + executed');
      } catch (err) {
        logger.error({ err, id }, 'executePunishment failed after approval');
        await reply(`审核 #${id} 已批准但执行失败，请手动处理。`);
      }
      return;
    }

    // Non-command private message from admin — ignore silently
    logger.debug({ userId: msg.userId, text: text.slice(0, 50) }, 'admin private non-command — ignored');
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
/facts                — 查看我学到的群知识

【知识管理】（仅管理员）
/fact_reject <ID>     — 拒绝某条知识条目
/fact_clear           — 清空本群所有知识

如有疑问请联系群管理员。`);
    });

    this.commands.set('rules', async (msg, args, _config) => {
      const pageArg = args[0] === 'page' ? parseInt(args[1] ?? '1', 10) : 1;
      const page = isNaN(pageArg) ? 1 : Math.max(1, pageArg);
      // Tight page size + per-rule truncation so a single NapCat send never
      // exceeds QQ's per-message limit (observed timeouts on ~4k char sends).
      const limit = 10;
      const offset = (page - 1) * limit;
      const perRuleCharCap = 100;

      const { rules, total } = this.db.rules.getPage(msg.groupId, offset, limit);

      if (total === 0) {
        await this.adapter.send(msg.groupId, '本群尚未配置任何群规。管理员可使用 /rule_add 添加。');
        return;
      }

      const start = offset + 1;
      const end = Math.min(offset + rules.length, total);
      const ruleLines = rules.map((r, i) => {
        const text = r.content.length > perRuleCharCap
          ? r.content.slice(0, perRuleCharCap) + '…'
          : r.content;
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

    this.commands.set('lore_refresh', async (msg, _args, config) => {
      if (!this.loreUpdater) {
        await this.adapter.send(msg.groupId, '群志功能未启用。');
        return;
      }
      await this.adapter.send(msg.groupId, '正在更新群志，请稍等...');
      await this.loreUpdater.forceUpdate(msg.groupId, config);
      await this.adapter.send(msg.groupId, '群志已更新完成。');
    });

    this.commands.set('persona', async (msg, args, config) => {
      if (msg.role !== 'admin' && msg.role !== 'owner') {
        await this.adapter.send(msg.groupId, '没有权限。只有管理员可以操作此指令。');
        return;
      }
      if (args.length === 0) {
        // Show current persona
        const current = config.chatPersonaText ?? null;
        if (current) {
          await this.adapter.send(msg.groupId, `当前自定义人格：\n${current}`);
        } else {
          await this.adapter.send(msg.groupId, '当前使用默认邦批人格。');
        }
        return;
      }
      if (args[0] === 'reset') {
        this.db.groupConfig.upsert({ ...config, chatPersonaText: null });
        this.chatModule?.invalidateLore(msg.groupId);
        await this.adapter.send(msg.groupId, '已重置为默认邦批人格。');
        return;
      }
      // Set custom persona text (rest of args joined as the text)
      const personaText = args.join(' ');
      this.db.groupConfig.upsert({ ...config, chatPersonaText: personaText });
      this.chatModule?.invalidateLore(msg.groupId);
      await this.adapter.send(msg.groupId, '人格已更新。');
    });

    this.commands.set('mood', async (msg, _args, _config) => {
      if (msg.role !== 'admin' && msg.role !== 'owner') {
        await this.adapter.send(msg.groupId, '没有权限。只有管理员可以操作此指令。');
        return;
      }
      if (!this.chatModule) {
        await this.adapter.send(msg.groupId, '聊天模块未启用。');
        return;
      }
      const tracker = this.chatModule.getMoodTracker();
      const mood = tracker.getMood(msg.groupId);
      const desc = tracker.describe(msg.groupId);
      await this.adapter.send(msg.groupId,
        `当前心情状态：${desc.label}\nvalence: ${mood.valence.toFixed(3)}  arousal: ${mood.arousal.toFixed(3)}\n语气倾向: ${desc.hints.join('、') || '（无）'}`
      );
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

    this.commands.set('facts', async (msg, _args, _config) => {
      const facts = this.db.learnedFacts.listActive(msg.groupId, 50);
      if (facts.length === 0) {
        await this.adapter.send(msg.groupId, '本群还没有学到任何知识，等群友来纠正我吧。');
        return;
      }
      const lines = facts.map(f => `[${f.id}] ${f.fact}`).join('\n');
      await this.adapter.send(msg.groupId, `本群已学到的知识（共 ${facts.length} 条）：\n${lines}`);
    });

    this.commands.set('fact_reject', async (msg, args, _config) => {
      if (msg.role !== 'admin' && msg.role !== 'owner') {
        await this.adapter.send(msg.groupId, '没有权限。只有管理员可以拒绝知识条目。');
        return;
      }
      const id = parseInt(args[0] ?? '', 10);
      if (isNaN(id)) {
        await this.adapter.send(msg.groupId, '用法：/fact_reject <ID>');
        return;
      }
      this.db.learnedFacts.markStatus(id, 'rejected');
      await this.adapter.send(msg.groupId, `已拒绝知识条目 #${id}，不再纳入参考。`);
    });

    this.commands.set('fact_clear', async (msg, _args, _config) => {
      if (msg.role !== 'admin' && msg.role !== 'owner') {
        await this.adapter.send(msg.groupId, '没有权限。只有管理员可以清空知识库。');
        return;
      }
      const count = this.db.learnedFacts.clearGroup(msg.groupId);
      await this.adapter.send(msg.groupId, `已清空本群知识库（共删除 ${count} 条）。`);
    });

    // Feature B — human-in-the-loop queue inspection for harvest/alias rows.
    // Admins and owners can see what's waiting; only the configured owner
    // (MOD_APPROVAL_ADMIN) can promote a row to 'active'.
    this.commands.set('facts_pending', async (msg, args, _config) => {
      if (msg.role !== 'admin' && msg.role !== 'owner') {
        await this.adapter.send(msg.groupId, '没有权限。只有管理员可以查看待审知识。');
        return;
      }
      const PAGE_SIZE = 10;
      const MAX_LINE_LEN = 120;
      const MAX_MSG_LEN = 4000;
      const pageRaw = parseInt(args[0] ?? '1', 10);
      const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
      const total = this.db.learnedFacts.countPending(msg.groupId);
      if (total === 0) {
        await this.adapter.send(msg.groupId, '待审队列为空。');
        return;
      }
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const pageClamped = Math.min(page, totalPages);
      const offset = (pageClamped - 1) * PAGE_SIZE;
      const rows = this.db.learnedFacts.listPending(msg.groupId, PAGE_SIZE, offset);
      const header = `待审知识 第 ${pageClamped}/${totalPages} 页（共 ${total} 条）：`;
      const lines: string[] = [header];
      let totalLen = header.length;
      for (const f of rows) {
        const confTag = `(${f.confidence.toFixed(2)})`;
        let body = `[${f.id}] ${confTag} ${f.fact}`;
        if (body.length > MAX_LINE_LEN) body = body.slice(0, MAX_LINE_LEN - 1) + '…';
        if (totalLen + 1 + body.length > MAX_MSG_LEN) break;
        lines.push(body);
        totalLen += 1 + body.length;
      }
      if (totalPages > 1) {
        const hint = `\n用法：/facts_pending [页码] ；通过：/fact_approve <ID>；拒绝：/fact_reject <ID>`;
        if (totalLen + hint.length <= MAX_MSG_LEN) lines.push(hint);
      } else {
        const hint = `\n通过：/fact_approve <ID>；拒绝：/fact_reject <ID>`;
        if (totalLen + hint.length <= MAX_MSG_LEN) lines.push(hint);
      }
      await this.adapter.send(msg.groupId, lines.join('\n'));
    });

    this.commands.set('fact_approve', async (msg, args, _config) => {
      if (msg.userId !== MOD_APPROVAL_ADMIN) {
        await this.adapter.send(msg.groupId, '没有权限。只有 bot 主人可以通过待审知识。');
        return;
      }
      const id = parseInt(args[0] ?? '', 10);
      if (isNaN(id)) {
        await this.adapter.send(msg.groupId, '用法：/fact_approve <ID>');
        return;
      }
      this.db.learnedFacts.markStatus(id, 'active');
      await this.adapter.send(msg.groupId, `已通过知识条目 #${id}，纳入参考。`);
    });

    this.commands.set('stickerfirst_on', async (msg, _args, config) => {
      if (msg.role !== 'admin' && msg.role !== 'owner') return;
      if (config.stickerFirstEnabled) {
        await this.adapter.send(msg.groupId, '表情包优先模式本来就是开着的。');
        return;
      }
      const stickerCount = this.db.localStickers.getTopByGroup(msg.groupId, 1).length;
      const updated = { ...config, stickerFirstEnabled: true, updatedAt: new Date().toISOString() };
      this.db.groupConfig.upsert(updated);
      if (stickerCount === 0) {
        await this.adapter.send(msg.groupId, '已开启，但本群暂无本地表情包记录，暂时只能发文字。');
      } else {
        await this.adapter.send(msg.groupId, '表情包优先模式已开启。当我有话说时，会优先找合适的表情包代替文字发送。');
      }
    });

    this.commands.set('stickerfirst_off', async (msg, _args, config) => {
      if (msg.role !== 'admin' && msg.role !== 'owner') return;
      if (!config.stickerFirstEnabled) {
        await this.adapter.send(msg.groupId, '表情包优先模式本来就是关着的。');
        return;
      }
      const updated = { ...config, stickerFirstEnabled: false, updatedAt: new Date().toISOString() };
      this.db.groupConfig.upsert(updated);
      await this.adapter.send(msg.groupId, '表情包优先模式已关闭，恢复正常文字回复。');
    });

    this.commands.set('stickerfirst_threshold', async (msg, args, config) => {
      if (msg.role !== 'admin' && msg.role !== 'owner') return;
      const raw = args[0];
      if (!raw) {
        await this.adapter.send(msg.groupId, '用法：/stickerfirst_threshold <0到1之间的数字>（如 /stickerfirst_threshold 0.3）');
        return;
      }
      const val = parseFloat(raw);
      if (!Number.isFinite(val) || val < 0.0 || val > 1.0) {
        await this.adapter.send(msg.groupId, '无效的阈值格式，必须是 0 到 1 之间的数字（如 /stickerfirst_threshold 0.3）。');
        return;
      }
      const updated = { ...config, stickerFirstThreshold: val, updatedAt: new Date().toISOString() };
      this.db.groupConfig.upsert(updated);
      await this.adapter.send(msg.groupId, `表情包匹配阈值已设为 ${val}。`);
    });

    this.commands.set('stickerfirst_status', async (msg, _args, config) => {
      if (msg.role !== 'admin' && msg.role !== 'owner') return;
      const stickers = this.db.localStickers.getTopByGroup(msg.groupId, 9999);
      const count = stickers.length;
      const onOff = config.stickerFirstEnabled ? 'ON' : 'OFF';
      // Last sticker sent time: not tracked at router level, report 暂无
      await this.adapter.send(msg.groupId,
        `【表情包优先模式状态】\n开关: ${onOff}\n匹配阈值: ${config.stickerFirstThreshold}\n本群本地表情包库大小: ${count} 张\n最近发送表情包时间: 暂无`);
    });
  }
}
