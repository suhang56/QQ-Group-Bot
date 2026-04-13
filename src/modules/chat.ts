import type { IClaudeClient } from '../ai/claude.js';
import type { GroupMessage } from '../adapter/napcat.js';
import type { Database } from '../storage/db.js';
import { ClaudeApiError, ClaudeParseError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

export interface IChatModule {
  generateReply(groupId: string, triggerMessage: GroupMessage, recentMessages: GroupMessage[]): Promise<string | null>;
}

interface ChatOptions {
  debounceMs?: number;
  maxGroupRepliesPerMinute?: number;
  recentMessageCount?: number;
}

export class ChatModule implements IChatModule {
  private readonly logger = createLogger('chat');
  private readonly debounceMs: number;
  private readonly maxGroupRepliesPerMinute: number;
  private readonly recentMessageCount: number;

  // debounce: groupId -> last trigger timestamp
  private readonly debounceMap = new Map<string, number>();
  // group reply counter: groupId -> { count, windowStart }
  private readonly groupReplyCount = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly claude: IClaudeClient,
    private readonly db: Database,
    options: ChatOptions = {}
  ) {
    this.debounceMs = options.debounceMs ?? 2000;
    this.maxGroupRepliesPerMinute = options.maxGroupRepliesPerMinute ?? 20;
    this.recentMessageCount = options.recentMessageCount ?? 20;
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

    // Fetch history from DB if recentMessages not provided
    const history = recentMessages.length > 0
      ? recentMessages
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

    const historyText = history
      .slice(0, this.recentMessageCount)
      .reverse()
      .map(m => `${m.nickname}: ${m.content}`)
      .join('\n');

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
    }
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
