import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { IClaudeClient, ClaudeModel } from '../ai/claude.js';
import type { IMessageRepository } from '../storage/db.js';
import type { GroupConfig } from '../storage/db.js';
import type { IChatModule } from './chat.js';
import { ClaudeApiError, ClaudeParseError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { LORE_MODEL } from '../config.js';

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

      // Try to load existing lore from per-member directory, fall back to monolithic
      const groupLoreDir = path.join(this.loreDirPath, '..', 'groups', groupId, 'lore');
      const lorePath = path.join(this.loreDirPath, `${groupId}.md`);
      const existingLore = this._loadExistingLore(groupLoreDir, lorePath);
      const oldSize = Buffer.byteLength(existingLore, 'utf8');

      const msgLines = msgsToUse.map(m => `[${m.nickname}]: ${m.content}`).join('\n');

      const loreSection = existingLore.trim()
        ? `以下是群的现有群志：\n---\n${existingLore}\n---\n\n`
        : '（该群暂无群志，请从以下聊天记录中初步整理。）\n\n';

      const prompt = `${loreSection}以下是该群最近 ${msgCount} 条聊天记录：\n${msgLines}\n\n---\n请基于新消息更新群志：\n1. 如果有新出现的群友（之前没在档案里的），添加到"常驻群友"，每个群友用 ### 标题\n2. 如果有新的梗/黑话/群内事件，添加到对应词典\n3. 如果已有条目需要补充新信息，扩展该条目\n4. 保留所有原有内容，不要删除已有记录\n5. 输出完整的新版群志 markdown，不要添加任何前缀或说明文字\n6. 每个群友的 ### 标题后面用（）列出所有已知别名`;

      const resp = await this.claude.complete({
        model: LORE_MODEL as ClaudeModel,
        maxTokens: 8000,
        system: [{ text: '你是群组记录员，负责维护群志文档。直接输出 markdown 内容，不要任何前缀。', cache: true }],
        messages: [{ role: 'user', content: prompt }],
      });

      const newLore = resp.text.trim();
      if (!newLore) {
        logger.warn({ groupId }, 'lore update: Claude returned empty response — skipping write');
        return;
      }

      // Write monolithic file (kept as fallback)
      mkdirSync(this.loreDirPath, { recursive: true });
      const tmpPath = `${lorePath}.tmp`;
      writeFileSync(tmpPath, newLore, 'utf8');
      renameSync(tmpPath, lorePath);

      // Also split into per-member files (only if directory already exists from initial split)
      if (existsSync(groupLoreDir)) {
        this._splitAndWritePerMember(groupId, newLore, groupLoreDir);
      }

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

  /** Load existing lore: prefer per-member directory, fall back to monolithic file. */
  private _loadExistingLore(groupLoreDir: string, monolithicPath: string): string {
    // If per-member directory exists with files, concatenate them
    if (existsSync(groupLoreDir)) {
      try {
        const files = readdirSync(groupLoreDir).filter(f => f.endsWith('.md'));
        if (files.length > 0) {
          const parts: string[] = [];
          // Overview first
          if (files.includes('_overview.md')) {
            const content = readFileSync(path.join(groupLoreDir, '_overview.md'), 'utf8').trim();
            if (content) parts.push(content);
          }
          // Member files
          for (const f of files.filter(f => f !== '_overview.md')) {
            let content = readFileSync(path.join(groupLoreDir, f), 'utf8');
            // Strip frontmatter
            content = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').trim();
            if (content) parts.push(content);
          }
          if (parts.length > 0) return parts.join('\n\n');
        }
      } catch {
        // Fall through to monolithic
      }
    }
    return existsSync(monolithicPath) ? readFileSync(monolithicPath, 'utf8') : '';
  }

  /** Split LLM output by ### headers and write per-member files with frontmatter. */
  private _splitAndWritePerMember(groupId: string, lore: string, outputDir: string): void {
    try {
      mkdirSync(outputDir, { recursive: true });

      const lines = lore.split('\n');
      const overviewLines: string[] = [];
      const memberSections: { header: string; body: string[] }[] = [];
      let inMembers = false;
      let currentHeader = '';
      let currentBody: string[] = [];
      let pastMembers = false;
      const afterContent: string[] = [];

      for (const line of lines) {
        if (line.startsWith('## 常驻群友')) { inMembers = true; continue; }
        if (!inMembers && !pastMembers) { overviewLines.push(line); continue; }
        if (inMembers && (/^## /.test(line) && !line.startsWith('## 常驻群友') || line.trim() === '---')) {
          if (currentHeader) {
            memberSections.push({ header: currentHeader, body: [...currentBody] });
            currentHeader = '';
            currentBody = [];
          }
          inMembers = false;
          pastMembers = true;
          afterContent.push(line);
          continue;
        }
        if (pastMembers) { afterContent.push(line); continue; }
        if (line.startsWith('### ')) {
          if (currentHeader) {
            memberSections.push({ header: currentHeader, body: [...currentBody] });
          }
          currentHeader = line;
          currentBody = [];
          continue;
        }
        currentBody.push(line);
      }
      if (currentHeader) {
        memberSections.push({ header: currentHeader, body: [...currentBody] });
      }

      // Write _overview.md
      const overview = [overviewLines.join('\n').trim(), '', '---', '', afterContent.join('\n').trim()].join('\n');
      writeFileSync(path.join(outputDir, '_overview.md'), overview, 'utf8');

      // Write member files
      const usedNames = new Set<string>();
      for (const section of memberSections) {
        const aliases = this._extractAliasesFromHeader(section.header);
        let fileName = this._deriveFileName(section.header, aliases);
        if (usedNames.has(fileName)) {
          let i = 2;
          while (usedNames.has(`${fileName}_${i}`)) i++;
          fileName = `${fileName}_${i}`;
        }
        usedNames.add(fileName);

        const frontmatter = `---\naliases: [${aliases.map(a => `"${a.replace(/"/g, '\\"')}"`).join(', ')}]\n---\n\n`;
        const content = `${frontmatter}${section.header}\n${section.body.join('\n').trim()}\n`;
        writeFileSync(path.join(outputDir, `${fileName}.md`), content, 'utf8');
      }

      logger.debug({ groupId, members: memberSections.length }, 'per-member lore files written');
    } catch (err) {
      logger.warn({ err, groupId }, 'failed to split lore into per-member files — monolithic file still valid');
    }
  }

  private _extractAliasesFromHeader(header: string): string[] {
    const aliases = new Set<string>();
    let cleaned = header.replace(/^###\s*/, '').replace(/[\p{Emoji_Presentation}\p{Emoji}\uFE0F\u200D]/gu, '').trim();
    const allParens = [...cleaned.matchAll(/[（(]([^）)]+)[）)]/g)];
    if (allParens.length > 0) {
      for (const pm of allParens) {
        for (const a of pm[1]!.split(/[/、]/)) {
          const t = a.trim();
          if (t) aliases.add(t);
        }
      }
      const nameBefore = cleaned.slice(0, cleaned.indexOf(allParens[0]![0]!)).trim();
      if (nameBefore) {
        const withoutBracket = nameBefore.replace(/^\[[^\]]+\]\s*/, '').trim();
        if (withoutBracket) aliases.add(withoutBracket);
      }
    } else {
      const withoutBracket = cleaned.replace(/^\[[^\]]+\]\s*/, '').trim();
      if (withoutBracket) aliases.add(withoutBracket);
    }
    return [...aliases].filter(a => a.length > 0);
  }

  private _deriveFileName(header: string, aliases: string[]): string {
    let cleaned = header.replace(/^###\s*/, '').replace(/[\p{Emoji_Presentation}\p{Emoji}\uFE0F\u200D]/gu, '').trim();
    cleaned = cleaned.replace(/^\[[^\]]+\]\s*/, '').trim();
    const beforeParen = cleaned.replace(/[（(].*/s, '').trim();
    const candidates = [beforeParen, ...aliases.filter(a => a.length <= 15)]
      .filter(a => a.length > 0 && a.length <= 20 && !/^\d+$/.test(a));
    let name = candidates[0] ?? aliases[0] ?? 'unknown';
    name = name.replace(/[<>:"/\\|?*\s！？。，]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    return name || 'unknown';
  }
}
