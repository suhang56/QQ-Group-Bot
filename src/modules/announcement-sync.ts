import { createHash } from 'node:crypto';
import type { INapCatAdapter } from '../adapter/napcat.js';
import type { IAnnouncementRepository, IRuleRepository } from '../storage/db.js';
import type { IClaudeClient } from '../ai/claude.js';
import type { ILearnerModule } from './learner.js';
import { createLogger } from '../utils/logger.js';

const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export interface AnnouncementSyncOptions {
  refreshIntervalMs?: number;
}

export class AnnouncementSyncModule {
  private readonly logger = createLogger('announcement-sync');
  private readonly refreshIntervalMs: number;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly adapter: INapCatAdapter,
    private readonly announcements: IAnnouncementRepository,
    private readonly rules: IRuleRepository,
    private readonly claude: IClaudeClient,
    private readonly learner: ILearnerModule,
    options: AnnouncementSyncOptions = {}
  ) {
    this.refreshIntervalMs = options.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
  }

  /** Sync announcements for all given groups, then start the hourly refresh timer. */
  async start(groupIds: string[]): Promise<void> {
    await this._syncAll(groupIds);
    this.intervalHandle = setInterval(() => {
      void this._syncAll(groupIds);
    }, this.refreshIntervalMs);
    this.logger.info({ groupCount: groupIds.length, intervalMs: this.refreshIntervalMs }, 'announcement-sync started');
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Sync announcements for a single group. Exposed for on-demand use and testing. */
  async syncGroup(groupId: string): Promise<void> {
    let notices;
    try {
      notices = await this.adapter.getGroupNotices(groupId);
    } catch (err) {
      this.logger.warn({ err, groupId }, 'Failed to fetch group notices — skipping');
      return;
    }

    if (notices.length === 0) {
      this.logger.debug({ groupId }, 'No announcements found');
      return;
    }

    for (const notice of notices) {
      if (!notice.message.trim()) continue;

      const contentHash = createHash('sha256').update(notice.message).digest('hex').slice(0, 16);
      const existing = this.announcements.getByNoticeId(groupId, notice.noticeId);

      if (existing && existing.contentHash === contentHash) {
        this.logger.debug({ groupId, noticeId: notice.noticeId }, 'Announcement unchanged — skipping re-parse');
        continue;
      }

      this.logger.info({ groupId, noticeId: notice.noticeId }, 'New/updated announcement — parsing rules');

      let parsedRules: string[];
      try {
        parsedRules = await this._parseRules(groupId, notice.message);
      } catch (err) {
        this.logger.warn({ err, groupId, noticeId: notice.noticeId }, 'Claude failed to parse announcement — storing with empty rules');
        parsedRules = [];
      }

      // Upsert the announcement record
      this.announcements.upsert({
        groupId,
        noticeId: notice.noticeId,
        content: notice.message,
        contentHash,
        fetchedAt: Math.floor(Date.now() / 1000),
        parsedRules,
      });

      if (parsedRules.length === 0) continue;

      // Replace old announcement-sourced rules with fresh ones
      const deleted = this.rules.deleteBySource(groupId, 'announcement');
      this.logger.debug({ groupId, deleted }, 'Cleared old announcement-sourced rules');

      for (const ruleText of parsedRules) {
        await this.learner.addRuleWithSource(groupId, ruleText, 'positive', 'announcement');
      }
      this.logger.info({ groupId, noticeId: notice.noticeId, ruleCount: parsedRules.length }, 'Announcement rules upserted');
    }
  }

  private async _syncAll(groupIds: string[]): Promise<void> {
    for (const groupId of groupIds) {
      await this.syncGroup(groupId);
    }
  }

  private async _parseRules(groupId: string, announcementText: string): Promise<string[]> {
    const response = await this.claude.complete({
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 1000,
      system: [{ text: '你是一个群规提取助手。从群公告中提取所有明确的群规，输出纯文本列表，每条规则单独一行，无序号无前缀。语义去重，只保留规则本身，不要解释。如果没有群规，输出空行。', cache: true }],
      messages: [{ role: 'user', content: `以下是群公告，提取所有群规（每条一行，语义去重）:\n\n${announcementText}` }],
    });

    const lines = response.text
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && l.length <= 500);

    this.logger.debug({ groupId, lineCount: lines.length }, 'Announcement rules parsed');
    return lines;
  }
}
