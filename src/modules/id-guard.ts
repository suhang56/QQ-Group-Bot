import type { INapCatAdapter } from '../adapter/napcat.js';
import type { GroupMessage } from '../adapter/napcat.js';
import type { IModerationRepository } from '../storage/db.js';
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
  vision: VisionService;
  botUserId: string;
  enabled: () => boolean;
}

export class IdCardGuard {
  private readonly logger = createLogger('id-guard');

  constructor(private readonly opts: IdGuardOptions) {}

  async check(msg: GroupMessage): Promise<boolean> {
    if (msg.userId === this.opts.botUserId) return false;
    if (!this.opts.enabled()) return false;

    // 1. Text check
    if (containsIdCardNumber(msg.content)) {
      const numbers = extractIdCards(msg.content);
      await this._act(msg, 'text', numbers);
      return true;
    }

    // 2. Image check — only if no text hit (avoid double-act)
    const fileToken = VisionService.extractFileToken(msg.rawContent);
    if (fileToken) {
      let hit: string | null = null;
      try {
        hit = await this.opts.vision.checkIdCard(fileToken);
      } catch (err) {
        this.logger.error({ err, groupId: msg.groupId, messageId: msg.messageId }, 'id-guard vision check failed — fail-safe, not blocking');
        return false;
      }
      if (hit) {
        await this._act(msg, 'image', [hit]);
        return true;
      }
    }

    return false;
  }

  private async _act(msg: GroupMessage, source: 'text' | 'image', numbers: string[]): Promise<void> {
    this.logger.warn({ groupId: msg.groupId, userId: msg.userId, messageId: msg.messageId, source, count: numbers.length }, 'ID card detected — deleting message');

    try {
      await this.opts.adapter.deleteMsg(msg.messageId);
    } catch (err) {
      this.logger.error({ err, messageId: msg.messageId }, 'id-guard deleteMsg failed');
    }

    try {
      this.opts.moderation.insert({
        msgId: msg.messageId,
        groupId: msg.groupId,
        userId: msg.userId,
        violation: true,
        severity: 5,
        action: 'delete',
        reason: `ID card detected (${source})`,
        appealed: 0,
        reversed: false,
        timestamp: msg.timestamp,
      });
    } catch (err) {
      this.logger.error({ err }, 'id-guard moderation_log insert failed');
    }
  }
}
