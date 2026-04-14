import type { INapCatAdapter, GroupMessage } from '../adapter/napcat.js';
import type { IPendingModerationRepository } from '../storage/db.js';
import { createLogger } from '../utils/logger.js';

const BUFFER_SIZE = 15;
const WINDOW_SEC = 5 * 60; // 5 minutes

// All substrings of the leaked ID to watch for in concatenated digit streams
const TARGETS = [
  '310110199701093724', // full 18-digit ID
  '199701093724',       // last 12 digits (birth+seq+check)
  '19970109',           // birth date
  '310110',             // region code
];

interface BufEntry {
  userId: string;
  nickname: string;
  messageId: string;
  content: string;
  timestamp: number;
}

export interface SequenceGuardOptions {
  adapter: INapCatAdapter;
  pendingModeration: IPendingModerationRepository;
  adminUserId: string;
  botUserId: string;
}

export class SequenceGuard {
  private readonly logger = createLogger('sequence-guard');
  private readonly bufferByGroup = new Map<string, BufEntry[]>();

  constructor(private readonly opts: SequenceGuardOptions) {}

  async check(msg: GroupMessage): Promise<boolean> {
    if (msg.userId === this.opts.botUserId) return false;

    const buf = this.bufferByGroup.get(msg.groupId) ?? [];

    buf.push({
      userId: msg.userId,
      nickname: msg.nickname,
      messageId: msg.messageId,
      content: msg.content,
      timestamp: msg.timestamp,
    });

    // Expire entries older than WINDOW_SEC
    const cutoff = msg.timestamp - WINDOW_SEC;
    while (buf.length > 0 && buf[0]!.timestamp < cutoff) buf.shift();

    // Cap buffer size
    while (buf.length > BUFFER_SIZE) buf.shift();

    this.bufferByGroup.set(msg.groupId, buf);

    // Concatenate digits only from all buffered messages
    const digits = buf.map(e => e.content.replace(/[^\d]/g, '')).join('');

    for (const target of TARGETS) {
      if (digits.includes(target)) {
        const contributors = buf.filter(e => /\d/.test(e.content));
        await this._flag(msg, target, contributors);
        // Clear buffer so the same relay doesn't re-fire
        this.bufferByGroup.set(msg.groupId, []);
        return true;
      }
    }

    return false;
  }

  private async _flag(triggerMsg: GroupMessage, target: string, contributors: BufEntry[]): Promise<void> {
    this.logger.warn({ groupId: triggerMsg.groupId, target, contributors: contributors.map(c => c.userId) }, '接龙 sequence detected');

    const chain = contributors
      .map(c => `  ${c.nickname}(${c.userId}): ${c.content}`)
      .join('\n');
    const reason = `接龙重建 ${target}:\n${chain}`;

    try {
      this.opts.pendingModeration.queue({
        msgId: triggerMsg.messageId,
        groupId: triggerMsg.groupId,
        userId: triggerMsg.userId,
        userNickname: triggerMsg.nickname,
        content: `[接龙] ${triggerMsg.content}`,
        severity: 5,
        proposedAction: 'delete',
        reason,
        createdAt: triggerMsg.timestamp,
      });
    } catch (err) {
      this.logger.error({ err }, 'sequence-guard pendingModeration.queue failed');
    }

    try {
      const userList = [...new Set(contributors.map(c => `${c.nickname}(${c.userId})`))].join(', ');
      const dmText = `[接龙警报] 群 ${triggerMsg.groupId} 检测到跨消息重建 ${target}。\n参与者: ${userList}\n消息链:\n${chain}\n\n触发消息ID: ${triggerMsg.messageId}`;
      await this.opts.adapter.sendPrivateMessage(this.opts.adminUserId, dmText);
    } catch (err) {
      this.logger.error({ err }, 'sequence-guard admin DM failed');
    }
  }

  dispose(): void {
    this.bufferByGroup.clear();
  }
}
