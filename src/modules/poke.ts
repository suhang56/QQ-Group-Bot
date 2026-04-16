import type { GroupPokeNotice, INapCatAdapter } from '../adapter/napcat.js';
import type { GroupConfig } from '../storage/db.js';
import { createLogger } from '../utils/logger.js';

const DEFAULT_REPLIES = [
  '干嘛戳我',
  '在呢',
  '别戳啦',
  '醒着呢',
  '戳一下就够了',
];

export interface IPokeModule {
  handle(notice: GroupPokeNotice, config: GroupConfig): Promise<void>;
}

interface PokeModuleOptions {
  adapter: INapCatAdapter;
  botUserId: string;
  replies?: string[];
  replyChance?: number;
  userCooldownMs?: number;
  groupCooldownMs?: number;
  burstWindowMs?: number;
  burstLimit?: number;
  burstMuteMs?: number;
  now?: () => number;
  random?: () => number;
}

export class PokeModule implements IPokeModule {
  private readonly logger = createLogger('poke');
  private readonly replies: string[];
  private readonly replyChance: number;
  private readonly userCooldownMs: number;
  private readonly groupCooldownMs: number;
  private readonly burstWindowMs: number;
  private readonly burstLimit: number;
  private readonly burstMuteMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly lastUserReplyAt = new Map<string, number>();
  private readonly lastGroupReplyAt = new Map<string, number>();
  private readonly userPokeTimes = new Map<string, number[]>();
  private readonly mutedUntil = new Map<string, number>();

  constructor(private readonly options: PokeModuleOptions) {
    this.replies = options.replies?.length ? options.replies : DEFAULT_REPLIES;
    this.replyChance = options.replyChance ?? 1;
    this.userCooldownMs = options.userCooldownMs ?? 15_000;
    this.groupCooldownMs = options.groupCooldownMs ?? 10_000;
    this.burstWindowMs = options.burstWindowMs ?? 60_000;
    this.burstLimit = options.burstLimit ?? 3;
    this.burstMuteMs = options.burstMuteMs ?? 5 * 60_000;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
  }

  async handle(notice: GroupPokeNotice, _config: GroupConfig): Promise<void> {
    if (!notice.groupId || !notice.userId || !notice.targetId) return;
    if (notice.userId === this.options.botUserId) return;

    const now = this.now();
    const userKey = `${notice.groupId}:${notice.userId}`;
    const muteUntil = this.mutedUntil.get(userKey) ?? 0;
    if (now < muteUntil) return;

    const recent = (this.userPokeTimes.get(userKey) ?? []).filter(t => now - t <= this.burstWindowMs);
    recent.push(now);
    this.userPokeTimes.set(userKey, recent);
    if (recent.length > this.burstLimit) {
      this.mutedUntil.set(userKey, now + this.burstMuteMs);
      this.logger.info({ groupId: notice.groupId, userId: notice.userId }, 'poke burst muted');
      return;
    }

    const lastUserReply = this.lastUserReplyAt.get(userKey);
    if (lastUserReply != null && now - lastUserReply < this.userCooldownMs) return;

    const lastGroupReply = this.lastGroupReplyAt.get(notice.groupId);
    if (lastGroupReply != null && now - lastGroupReply < this.groupCooldownMs) return;

    if (this.random() >= this.replyChance) return;

    const reply = this.pickReply();
    await this.options.adapter.send(notice.groupId, reply);
    this.lastUserReplyAt.set(userKey, now);
    this.lastGroupReplyAt.set(notice.groupId, now);
    this.logger.info({ groupId: notice.groupId, userId: notice.userId }, 'responded to poke');
  }

  private pickReply(): string {
    const index = Math.floor(this.random() * this.replies.length);
    return this.replies[Math.min(index, this.replies.length - 1)] ?? this.replies[0]!;
  }
}
