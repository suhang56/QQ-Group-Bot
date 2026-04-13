import type { IClaudeClient } from '../ai/claude.js';
import type { IMessageRepository, IGroupConfigRepository, GroupConfig } from '../storage/db.js';
import type { GroupMessage } from '../adapter/napcat.js';
import { BotErrorCode, ClaudeApiError, ClaudeParseError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { defaultGroupConfig } from '../config.js';

export interface IMimicModule {
  generateMimic(
    groupId: string,
    targetUserId: string,
    topic: string | null,
    recentMessages: GroupMessage[]
  ): Promise<MimicResult>;
}

export type MimicResult =
  | { ok: true; text: string; historyCount: number }
  | { ok: false; errorCode: BotErrorCode };

export interface StartMimicResult {
  replaced: boolean;
  previousUserId: string | null;
}

export interface StopMimicResult {
  wasActive: boolean;
  previousUserId: string | null;
}

const INSUFFICIENT_THRESHOLD = 5;
const HISTORY_FETCH_LIMIT = 100;

export class MimicModule implements IMimicModule {
  private readonly logger = createLogger('mimic');

  constructor(
    private readonly claude: IClaudeClient,
    private readonly messages: IMessageRepository,
    private readonly configs: IGroupConfigRepository,
    private readonly botUserId: string,
  ) {}

  async generateMimic(
    groupId: string,
    targetUserId: string,
    topic: string | null,
    recentMessages: GroupMessage[]
  ): Promise<MimicResult> {
    if (targetUserId === this.botUserId) {
      return { ok: false, errorCode: BotErrorCode.SELF_MIMIC };
    }

    const userMsgs = this.messages.getByUser(groupId, targetUserId, HISTORY_FETCH_LIMIT);

    if (userMsgs.length === 0) {
      this.logger.warn({ groupId, targetUserId }, 'No history for mimic target — E002');
      return { ok: false, errorCode: BotErrorCode.USER_NOT_FOUND };
    }

    const historyCount = userMsgs.length;
    const fewShot = userMsgs
      .slice(0, 50)
      .reverse()
      .map(m => m.content)
      .join('\n');

    const recentContext = recentMessages
      .slice(0, 20)
      .reverse()
      .map(m => `${m.nickname}: ${m.content}`)
      .join('\n');

    const topicLine = topic ? `话题/触发消息：${topic}` : (
      recentContext ? `最近群聊：\n${recentContext}` : '随便说一句话'
    );

    try {
      const response = await this.claude.complete({
        model: 'claude-sonnet-4-6',
        maxTokens: 200,
        system: [{
          text: `你是一个模仿专家。请完全模仿用户提供的历史发言中的语气、用词习惯、句式风格，用中文回复一句话（1-2句）。不要加任何解释或前缀。`,
          cache: true,
        }],
        messages: [{ role: 'user', content: `以下是该群友的历史发言（每行一条）：\n${fewShot}\n\n${topicLine}` }],
      });

      const nickname = userMsgs[0]!.nickname;
      const text = response.text;

      this.logger.info({ groupId, targetUserId, targetNickname: nickname, historyCount, mimicPrefix: `[模仿 @${nickname}]` }, 'mimic generated');
      return { ok: true, text, historyCount };
    } catch (err) {
      if (err instanceof ClaudeApiError || err instanceof ClaudeParseError) {
        this.logger.warn({ err, groupId, targetUserId }, 'Claude error during mimic — fail-safe');
        return { ok: false, errorCode: BotErrorCode.CLAUDE_API_ERROR };
      }
      throw err;
    }
  }

  getActiveMimicUser(groupId: string): string | null {
    const config = this.configs.get(groupId);
    return config?.mimicActiveUserId ?? null;
  }

  async startMimic(
    groupId: string,
    targetUserId: string,
    targetNickname: string,
    startedBy: string,
  ): Promise<StartMimicResult> {
    const config = this.configs.get(groupId) ?? defaultGroupConfig(groupId);
    const previousUserId = config.mimicActiveUserId;
    const replaced = previousUserId !== null;

    const updated: GroupConfig = {
      ...config,
      mimicActiveUserId: targetUserId,
      mimicStartedBy: startedBy,
      updatedAt: new Date().toISOString(),
    };
    this.configs.upsert(updated);

    this.logger.info({ groupId, targetUserId, targetNickname, startedBy, replaced }, 'mimic_on');
    return { replaced, previousUserId };
  }

  async stopMimic(groupId: string): Promise<StopMimicResult> {
    const config = this.configs.get(groupId);
    const previousUserId = config?.mimicActiveUserId ?? null;

    if (!previousUserId) {
      return { wasActive: false, previousUserId: null };
    }

    const updated: GroupConfig = {
      ...(config ?? defaultGroupConfig(groupId)),
      mimicActiveUserId: null,
      mimicStartedBy: null,
      updatedAt: new Date().toISOString(),
    };
    this.configs.upsert(updated);

    this.logger.info({ groupId, previousUserId }, 'mimic_off');
    return { wasActive: true, previousUserId };
  }

  isInsufficientHistory(count: number): boolean {
    return count > 0 && count < INSUFFICIENT_THRESHOLD;
  }

}
