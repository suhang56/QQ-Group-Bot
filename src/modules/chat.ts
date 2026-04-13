import type { IClaudeClient } from '../ai/claude.js';
import type { GroupMessage } from '../adapter/napcat.js';
import type { Database } from '../storage/db.js';
import { ClaudeApiError, ClaudeParseError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { lurkerDefaults, chatHistoryDefaults } from '../config.js';

export interface IChatModule {
  generateReply(groupId: string, triggerMessage: GroupMessage, recentMessages: GroupMessage[]): Promise<string | null>;
}

interface ChatOptions {
  debounceMs?: number;
  maxGroupRepliesPerMinute?: number;
  recentMessageCount?: number;
  chatRecentCount?: number;
  chatHistoricalSampleCount?: number;
  botUserId?: string;
  lurkerReplyChance?: number;
  lurkerCooldownMs?: number;
  burstWindowMs?: number;
  burstMinMessages?: number;
}

export class ChatModule implements IChatModule {
  private readonly logger = createLogger('chat');
  private readonly debounceMs: number;
  private readonly maxGroupRepliesPerMinute: number;
  private readonly recentMessageCount: number;
  private readonly historicalSampleCount: number;
  private readonly botUserId: string;
  private readonly lurkerReplyChance: number;
  private readonly lurkerCooldownMs: number;
  private readonly burstWindowMs: number;
  private readonly burstMinMessages: number;

  // debounce: groupId -> last trigger timestamp
  private readonly debounceMap = new Map<string, number>();
  // group reply counter: groupId -> { count, windowStart }
  private readonly groupReplyCount = new Map<string, { count: number; windowStart: number }>();
  // last proactive (non-mention) reply timestamp per group
  private readonly lastProactiveReply = new Map<string, number>();
  // in-flight lock: groups currently awaiting a Claude reply — prevents concurrent duplicate sends
  private readonly inFlightGroups = new Set<string>();

  constructor(
    private readonly claude: IClaudeClient,
    private readonly db: Database,
    options: ChatOptions = {}
  ) {
    this.debounceMs = options.debounceMs ?? 2000;
    this.maxGroupRepliesPerMinute = options.maxGroupRepliesPerMinute ?? 20;
    this.recentMessageCount = options.chatRecentCount ?? options.recentMessageCount ?? chatHistoryDefaults.chatRecentCount;
    this.historicalSampleCount = options.chatHistoricalSampleCount ?? chatHistoryDefaults.chatHistoricalSampleCount;
    this.botUserId = options.botUserId ?? '';
    this.lurkerReplyChance = options.lurkerReplyChance ?? lurkerDefaults.lurkerReplyChance;
    this.lurkerCooldownMs = options.lurkerCooldownMs ?? lurkerDefaults.lurkerCooldownMs;
    this.burstWindowMs = options.burstWindowMs ?? lurkerDefaults.burstWindowMs;
    this.burstMinMessages = options.burstMinMessages ?? lurkerDefaults.burstMinMessages;
  }

  async generateReply(
    groupId: string,
    triggerMessage: GroupMessage,
    recentMessages: GroupMessage[]
  ): Promise<string | null> {
    // Don't reply to bot's own mimic output
    if (triggerMessage.content.startsWith('[模仿')) {
      return null;
    }

    // Empty content after CQ stripping
    if (!triggerMessage.content.trim()) {
      return null;
    }

    // Group reply rate limit
    if (!this._checkGroupLimit(groupId)) {
      this.logger.warn({ groupId }, 'Group chat reply rate limit reached — silent');
      return null;
    }

    // Debounce: if another message came in within debounceMs, skip this one
    const now = Date.now();
    const lastTrigger = this.debounceMap.get(groupId);
    this.debounceMap.set(groupId, now);
    if (lastTrigger !== undefined && now - lastTrigger < this.debounceMs) {
      return null;
    }

    // In-flight lock: if a Claude reply is already being generated for this group,
    // drop this trigger. Prevents duplicate sends when two concurrent dispatches
    // (e.g. rapid @-mentions or NapCat retry) both pass the timestamp-based debounce
    // before either has set it (read-then-write race on the Map).
    if (this.inFlightGroups.has(groupId)) {
      this.logger.debug({ groupId }, 'Reply in-flight — dropping duplicate trigger');
      return null;
    }

    // Determine if this is a direct trigger (@mention or reply-to-bot)
    const isDirect = this._isMention(triggerMessage) || this._isReplyToBot(triggerMessage);

    if (!isDirect) {
      // Burst detection: if last N messages arrived within burstWindowMs, stay quiet
      if (this._isBurst(groupId)) {
        this.logger.debug({ groupId }, 'Burst detected — lurker skipping');
        return null;
      }

      // Cooldown: must be at least lurkerCooldownMs since last proactive reply
      const lastProactive = this.lastProactiveReply.get(groupId) ?? 0;
      if (now - lastProactive < this.lurkerCooldownMs) {
        this.logger.debug({ groupId, msSinceLast: now - lastProactive }, 'Lurker cooldown active — skipping');
        return null;
      }

      // Probabilistic gate
      if (Math.random() >= this.lurkerReplyChance) {
        return null;
      }

      this.lastProactiveReply.set(groupId, now);
    }

    // Fetch recent messages (passed in or fetched from DB)
    const recentSlice: GroupMessage[] = recentMessages.length > 0
      ? recentMessages.slice(0, this.recentMessageCount)
      : this.db.messages.getRecent(groupId, this.recentMessageCount).map(m => ({
          messageId: String(m.id),
          groupId: m.groupId,
          userId: m.userId,
          nickname: m.nickname,
          role: 'member' as const,
          content: m.content,
          rawContent: m.content,
          timestamp: m.timestamp,
        }));

    // Sample random historical messages outside the recent window for group-vibe context
    const historical = this.db.messages.sampleRandomHistorical(groupId, this.recentMessageCount, this.historicalSampleCount)
      .map(m => ({
        messageId: String(m.id),
        groupId: m.groupId,
        userId: m.userId,
        nickname: m.nickname,
        role: 'member' as const,
        content: m.content,
        rawContent: m.content,
        timestamp: m.timestamp,
      }));

    // Build prompt: historical sample (sorted oldest→newest) then recent (oldest→newest)
    // recentSlice is newest-first from DB, so reverse it; historical sorted by timestamp asc
    const historicalSorted = [...historical].sort((a, b) => a.timestamp - b.timestamp);
    const recentChron = [...recentSlice].reverse();
    const historyText = [...historicalSorted, ...recentChron]
      .map(m => `${m.nickname}: ${m.content}`)
      .join('\n');

    this.inFlightGroups.add(groupId);
    try {
      const response = await this.claude.complete({
        model: 'claude-sonnet-4-6',
        maxTokens: 300,
        system: [{
          text: `你是一个群里的老群友，说话风格随群，自然随意。用中文回复，简短（1-3句话）。绝对不要透露你是AI，除非被直接问到。`,
          cache: true,
        }],
        messages: [
          {
            role: 'user',
            content: `最近的群聊记录：\n${historyText}\n\n现在回复这条消息：${triggerMessage.nickname}: ${triggerMessage.content}`,
          },
        ],
      });

      return response.text;
    } catch (err) {
      if (err instanceof ClaudeApiError || err instanceof ClaudeParseError) {
        this.logger.error({ err, groupId }, 'Claude API error in chat module — silent');
        return null;
      }
      throw err;
    } finally {
      this.inFlightGroups.delete(groupId);
    }
  }

  private _isMention(msg: GroupMessage): boolean {
    if (!this.botUserId) return false;
    return msg.rawContent.includes(`[CQ:at,qq=${this.botUserId}]`);
  }

  private _isReplyToBot(msg: GroupMessage): boolean {
    return msg.rawContent.startsWith('[CQ:reply,');
  }

  private _isBurst(groupId: string): boolean {
    const recent = this.db.messages.getRecent(groupId, this.burstMinMessages);
    if (recent.length < this.burstMinMessages) return false;
    const newest = recent[0]!.timestamp;
    const oldest = recent[recent.length - 1]!.timestamp;
    // timestamps are unix seconds; burstWindowMs is ms
    return (newest - oldest) * 1000 < this.burstWindowMs;
  }

  private _checkGroupLimit(groupId: string): boolean {
    const now = Date.now();
    let state = this.groupReplyCount.get(groupId);
    if (!state || now - state.windowStart >= 60_000) {
      state = { count: 0, windowStart: now };
    }
    if (state.count >= this.maxGroupRepliesPerMinute) {
      this.groupReplyCount.set(groupId, state);
      return false;
    }
    this.groupReplyCount.set(groupId, { count: state.count + 1, windowStart: state.windowStart });
    return true;
  }
}
