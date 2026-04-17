import type { INapCatAdapter } from '../adapter/napcat.js';
import type { GroupMessage } from '../adapter/napcat.js';
import type { IModerationRepository, IPendingModerationRepository } from '../storage/db.js';
import { VisionService } from './vision.js';
import { createLogger } from '../utils/logger.js';

// 18-digit PRC ID: province(6) + YYYYMMDD(8) + seq(3) + check(digit|X)
const ID_18_RE = /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g;
// Legacy 15-digit: province(6) + YYMMDD(6) + seq(3)
const ID_15_RE = /(?<!\d)[1-9]\d{5}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}(?!\d)/g;

export function containsIdCardNumber(text: string): boolean {
  ID_18_RE.lastIndex = 0;
  ID_15_RE.lastIndex = 0;
  return ID_18_RE.test(text) || ID_15_RE.test(text);
}

export function extractIdCards(text: string): string[] {
  ID_18_RE.lastIndex = 0;
  ID_15_RE.lastIndex = 0;
  const m18 = text.match(new RegExp(ID_18_RE.source, 'g')) ?? [];
  const m15 = text.match(new RegExp(ID_15_RE.source, 'g')) ?? [];
  return [...new Set([...m18, ...m15])];
}

export interface IdGuardOptions {
  adapter: INapCatAdapter;
  moderation: IModerationRepository;
  pendingModeration: IPendingModerationRepository;
  vision: VisionService;
  adminUserId: string;
  botUserId: string;
  enabled: () => boolean;
}

export class IdCardGuard {
  private readonly logger = createLogger('id-guard');

  constructor(private readonly opts: IdGuardOptions) {}

  async check(msg: GroupMessage): Promise<boolean> {
    if (msg.userId === this.opts.botUserId) return false;
    if (!this.opts.enabled()) return false;

    // Text-only check
    if (containsIdCardNumber(msg.content)) {
      const numbers = extractIdCards(msg.content);
      await this._strictDelete(msg, `ID card detected in text (${numbers.length} found)`);
      return true;
    }

    // Image check — look for known-leak watchlist
    const fileToken = VisionService.extractFileToken(msg.rawContent);
    if (fileToken) {
      let hit: { what: 'full-id' | 'region-prefix'; evidence: string } | null = null;
      try {
        hit = await this.opts.vision.checkKnownLeaks(fileToken);
      } catch (err) {
        // Fail-safe: vision error does not block message
        this.logger.warn({ err, groupId: msg.groupId, messageId: msg.messageId }, 'id-guard vision check failed — skipping');
        return false;
      }

      if (!hit) return false;

      if (hit.what === 'full-id') {
        await this._strictDelete(msg, `已知泄露身份证号码 (图片): ${hit.evidence}`);
        return true;
      }

      if (hit.what === 'region-prefix') {
        await this._queueApproval(msg, hit.evidence);
        return true;
      }
    }

    return false;
  }

  private async _strictDelete(msg: GroupMessage, reason: string): Promise<void> {
    this.logger.warn({ groupId: msg.groupId, userId: msg.userId, messageId: msg.messageId, reason }, 'id-guard strict delete');

    try {
      await this.opts.adapter.deleteMsg(msg.messageId);
    } catch (err) {
      this.logger.error({ err, messageId: msg.messageId }, 'id-guard deleteMsg failed');
    }

    try {
      await this.opts.adapter.send(msg.groupId, `@${msg.nickname} 你的消息因含完整泄露身份证号被删除。\n原因：${reason}`);
    } catch (err) {
      this.logger.error({ err, groupId: msg.groupId }, 'id-guard announce failed');
    }

    try {
      this.opts.moderation.insert({
        msgId: msg.messageId,
        groupId: msg.groupId,
        userId: msg.userId,
        violation: true,
        severity: 5,
        action: 'delete',
        reason,
        appealed: 0,
        reversed: false,
        timestamp: msg.timestamp, originalContent: msg.content,
      });
    } catch (err) {
      this.logger.error({ err }, 'id-guard moderation insert failed');
    }
  }

  private async _queueApproval(msg: GroupMessage, evidence: string): Promise<void> {
    this.logger.warn({ groupId: msg.groupId, userId: msg.userId, messageId: msg.messageId, evidence }, 'id-guard region-prefix hit — queuing for approval');

    try {
      this.opts.pendingModeration.queue({
        msgId: msg.messageId,
        groupId: msg.groupId,
        userId: msg.userId,
        userNickname: msg.nickname,
        content: msg.rawContent,
        severity: 4,
        proposedAction: 'delete',
        reason: `疑似含有泄露身份证地区前缀 (310110): ${evidence}`,
        createdAt: msg.timestamp,
      });
    } catch (err) {
      this.logger.error({ err }, 'id-guard pendingModeration.queue failed');
    }

    try {
      const dmText = `[人工审核] 群 ${msg.groupId} 用户 ${msg.userId} 发送了疑似含有身份证地区前缀 (310110) 的图片。\n证据: ${evidence}\n消息ID: ${msg.messageId}`;
      await this.opts.adapter.sendPrivateMessage(this.opts.adminUserId, dmText);
    } catch (err) {
      this.logger.error({ err }, 'id-guard admin DM failed');
    }
  }
}
