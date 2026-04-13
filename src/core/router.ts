import type { GroupMessage, INapCatAdapter } from '../adapter/napcat.js';
import type { Database, GroupConfig } from '../storage/db.js';
import type { RateLimiter } from './rateLimiter.js';
import type { IChatModule } from '../modules/chat.js';
import type { MimicModule } from '../modules/mimic.js';
import { BotErrorCode } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { defaultGroupConfig } from '../config.js';

export interface IRouter {
  dispatch(msg: GroupMessage): Promise<void>;
}

export type CommandHandler = (
  msg: GroupMessage,
  args: string[],
  config: GroupConfig,
) => Promise<void>;

export class Router implements IRouter {
  private readonly logger = createLogger('router');
  private readonly commands = new Map<string, CommandHandler>();
  private chatModule: IChatModule | null = null;
  private mimicModule: MimicModule | null = null;

  constructor(
    private readonly db: Database,
    private readonly adapter: INapCatAdapter,
    private readonly rateLimiter: RateLimiter,
  ) {
    this._registerCommands();
  }

  setChat(chat: IChatModule): void {
    this.chatModule = chat;
  }

  setMimic(mimic: MimicModule): void {
    this.mimicModule = mimic;
  }

  async dispatch(msg: GroupMessage): Promise<void> {
    try {
      // Persist message and upsert user first
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

      this.logger.trace({ messageId: msg.messageId, groupId: msg.groupId, userId: msg.userId }, 'dispatching message');

      // Bot mimic output — skip to prevent loop
      if (msg.content.startsWith('[模仿')) {
        return;
      }

      // Command routing
      const trimmed = msg.content.trim();
      if (trimmed.startsWith('/')) {
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
          const config = this.db.groupConfig.get(msg.groupId) ?? this._defaultConfig(msg.groupId);
          await handler(msg, args, config);
        }
        // Unknown commands silently ignored
        return;
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
            await this.adapter.send(msg.groupId, result.text);
          }
          return;
        }
      }

      if (this.chatModule) {
        const reply = await this.chatModule.generateReply(msg.groupId, msg, recentMsgs);
        if (reply) {
          await this.adapter.send(msg.groupId, reply);
        }
      }
    } catch (err) {
      this.logger.fatal({ err, messageId: msg.messageId }, 'Unhandled error in router.dispatch');
    }
  }

  private _defaultConfig(groupId: string) {
    return defaultGroupConfig(groupId);
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

      // Parse @user from args[0]
      const atArg = args[0];
      if (!atArg || !atArg.startsWith('@')) {
        await this.adapter.send(msg.groupId, '用法：/mimic @群友 [话题]\n例如：/mimic @小明 今天吃了什么');
        return;
      }

      const targetUserId = atArg.slice(1);
      const topic = args.slice(1).join(' ') || null;

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

      const atArg = args[0];
      if (!atArg || !atArg.startsWith('@')) {
        await this.adapter.send(msg.groupId, '用法：/mimic_on @群友');
        return;
      }

      const targetUserId = atArg.slice(1);

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

    // Stubs for M4
    for (const cmd of ['rule_add', 'rule_false_positive', 'appeal']) {
      this.commands.set(cmd, async (msg, _args, _config) => {
        await this.adapter.send(msg.groupId, '此功能即将推出，敬请期待。');
      });
    }
  }
}
