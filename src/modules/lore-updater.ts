import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { IClaudeClient } from '../ai/claude.js';
import type { IMessageRepository } from '../storage/db.js';
import type { GroupConfig } from '../storage/db.js';
import type { IChatModule } from './chat.js';
import { ClaudeApiError, ClaudeParseError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('lore-updater');

// Max messages to include in prompt; trim to this if 200 msgs + existing lore is too large
const MAX_MESSAGES_IN_PROMPT = 150;
// Startup grace period before first update allowed
const STARTUP_GRACE_MS = 5 * 60 * 1000;

const startupTime = Date.now();

export interface LoreUpdaterOptions {
  loreDirPath?: string;
}

export class LoreUpdater {
  private readonly loreDirPath: string;
  // per-group message counters
  private readonly counters = new Map<string, number>();
  // per-group last-update timestamps (for cooldown)
  private readonly lastUpdated = new Map<string, number>();
  // in-flight guard: don't double-trigger
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly claude: IClaudeClient,
    private readonly messages: IMessageRepository,
    private readonly chatModule: IChatModule | null = null,
    options: LoreUpdaterOptions = {},
  ) {
    this.loreDirPath = options.loreDirPath ?? 'data/lore';
  }

  /** Call on every incoming message BEFORE other processing. Returns true if update was kicked off. */
  tick(groupId: string, config: GroupConfig): boolean {
    if (!config.loreUpdateEnabled) return false;

    const count = (this.counters.get(groupId) ?? 0) + 1;
    this.counters.set(groupId, count);

    if (count < config.loreUpdateThreshold) return false;

    // Reset counter regardless — even if we skip due to cooldown/grace/in-flight
    this.counters.set(groupId, 0);

    // Startup grace
    if (Date.now() - startupTime < STARTUP_GRACE_MS) {
      logger.debug({ groupId }, 'lore update skipped — startup grace');
      return false;
    }

    // Cooldown
    const last = this.lastUpdated.get(groupId) ?? 0;
    if (Date.now() - last < config.loreUpdateCooldownMs) {
      logger.debug({ groupId, msSinceLast: Date.now() - last }, 'lore update skipped — cooldown');
      return false;
    }

    // In-flight guard
    if (this.inFlight.has(groupId)) {
      logger.debug({ groupId }, 'lore update skipped — in-flight');
      return false;
    }

    void this._runUpdate(groupId, config);
    return true;
  }

  /** Force an immediate update regardless of counter/cooldown (for /lore_refresh). */
  async forceUpdate(groupId: string, config: GroupConfig): Promise<void> {
    if (this.inFlight.has(groupId)) {
      logger.info({ groupId }, 'lore force-update skipped — already in-flight');
      return;
    }
    this.counters.set(groupId, 0);
    await this._runUpdate(groupId, config);
  }

  getCounter(groupId: string): number {
    return this.counters.get(groupId) ?? 0;
  }

  private async _runUpdate(groupId: string, config: GroupConfig): Promise<void> {
    this.inFlight.add(groupId);
    const t0 = Date.now();
    try {
      const recentMsgs = this.messages.getRecent(groupId, config.loreUpdateThreshold);
      const msgCount = Math.min(recentMsgs.length, MAX_MESSAGES_IN_PROMPT);
      const msgsToUse = [...recentMsgs].reverse().slice(-msgCount);

      const lorePath = path.join(this.loreDirPath, `${groupId}.md`);
      const existingLore = existsSync(lorePath) ? readFileSync(lorePath, 'utf8') : '';
      const oldSize = Buffer.byteLength(existingLore, 'utf8');

      const msgLines = msgsToUse.map(m => `[${m.nickname}]: ${m.content}`).join('\n');

      const loreSection = existingLore.trim()
        ? `以下是群的现有群志：\n---\n${existingLore}\n---\n\n`
        : '（该群暂无群志，请从以下聊天记录中初步整理。）\n\n';

      const prompt = `${loreSection}以下是该群最近 ${msgCount} 条聊天记录：\n${msgLines}\n\n---\n请基于新消息更新群志：\n1. 如果有新出现的群友（之前没在档案里的），添加到"常驻群友"\n2. 如果有新的梗/黑话/群内事件，添加到对应词典\n3. 如果已有条目需要补充新信息，扩展该条目\n4. 保留所有原有内容，不要删除已有记录\n5. 输出完整的新版群志 markdown，不要添加任何前缀或说明文字`;

      const resp = await this.claude.complete({
        model: 'claude-sonnet-4-6',
        maxTokens: 8000,
        system: [{ text: '你是群组记录员，负责维护群志文档。直接输出 markdown 内容，不要任何前缀。', cache: true }],
        messages: [{ role: 'user', content: prompt }],
      });

      const newLore = resp.text.trim();
      if (!newLore) {
        logger.warn({ groupId }, 'lore update: Claude returned empty response — skipping write');
        return;
      }

      // Atomic write: .tmp then rename
      mkdirSync(this.loreDirPath, { recursive: true });
      const tmpPath = `${lorePath}.tmp`;
      writeFileSync(tmpPath, newLore, 'utf8');
      renameSync(tmpPath, lorePath);

      const newSize = Buffer.byteLength(newLore, 'utf8');
      this.lastUpdated.set(groupId, Date.now());

      // Invalidate chat module caches
      this.chatModule?.invalidateLore(groupId);

      logger.info({
        groupId,
        oldSizeKb: (oldSize / 1024).toFixed(1),
        newSizeKb: (newSize / 1024).toFixed(1),
        msgsProcessed: msgCount,
        tookMs: Date.now() - t0,
      }, 'lore updated');
    } catch (err) {
      if (err instanceof ClaudeApiError || err instanceof ClaudeParseError) {
        logger.error({ err, groupId }, 'lore update failed — Claude API error, skipping cycle');
        return;
      }
      logger.error({ err, groupId }, 'lore update failed — unexpected error');
    } finally {
      this.inFlight.delete(groupId);
    }
  }
}
