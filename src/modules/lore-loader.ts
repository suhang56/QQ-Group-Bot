/**
 * Lore loading and caching module, extracted from ChatModule.
 *
 * Handles per-group lore file loading with three strategies:
 * 1. Per-member lore directory (data/groups/{groupId}/lore/*.md)
 * 2. Entity-filtered chunks (via lore-retrieval.ts buildLorePayload)
 * 3. Monolithic single-file fallback (data/lore/{groupId}.md)
 *
 * Also handles tuning file loading (global, not per-group).
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';
import { tokenizeLore } from '../utils/text-tokenize.js';
import { buildAliasMap, extractEntities, buildLorePayload } from './lore-retrieval.js';
import type { LearnedFact } from '../storage/db.js';

const logger = createLogger('lore-loader');

export interface ILoreLoader {
  /** Load relevant lore for the given group and trigger. Returns null if no lore. */
  loadRelevantLore(
    groupId: string,
    triggerContent: string,
    immediateContext: ReadonlyArray<{ nickname: string; content: string }>,
  ): string | null;

  /** Check if message content contains any lore keyword for this group. */
  hasLoreKeyword(groupId: string, content: string): boolean;

  /** Clear cached lore for a group (e.g. after admin updates). */
  invalidateLore(groupId: string): void;

  /** Load tuning file content (global, not per-group). */
  loadTuning(): string | null;

  /** Check if per-member lore directory exists for a group. */
  hasPerMemberLore(groupId: string): boolean;
}

export class LoreLoader implements ILoreLoader {
  private readonly loreCache = new Map<string, string | null>();
  private readonly loreKeywordsCache = new Map<string, Set<string>>();
  private readonly loreAliasIndex = new Map<string, Map<string, string>>();
  private readonly loreChunkAliasMap = new Map<string, Map<string, number[]>>();
  private readonly loreOverviewCache = new Map<string, string | null>();
  private readonly learnedFactsProvider: ((groupId: string) => LearnedFact[]) | null;

  constructor(
    private readonly loreDirPath: string,
    private readonly loreSizeCapBytes: number,
    private readonly tuningPath: string | null,
    learnedFactsProvider?: (groupId: string) => LearnedFact[],
  ) {
    this.learnedFactsProvider = learnedFactsProvider ?? null;
  }

  hasPerMemberLore(groupId: string): boolean {
    return this.loreAliasIndex.has(groupId) && (this.loreAliasIndex.get(groupId)?.size ?? 0) > 0;
  }

  invalidateLore(groupId: string): void {
    this.loreCache.delete(groupId);
    this.loreKeywordsCache.delete(groupId);
    this.loreAliasIndex.delete(groupId);
    this.loreChunkAliasMap.delete(groupId);
    this.loreOverviewCache.delete(groupId);
  }

  hasLoreKeyword(groupId: string, content: string): boolean {
    // Ensure lore is loaded (triggers cache if needed)
    this.loadRelevantLore(groupId, content, []);
    const loreTokens = this.loreKeywordsCache.get(groupId);
    if (!loreTokens || loreTokens.size === 0) return false;

    const msgTokens = tokenizeLore(content);
    for (const token of msgTokens) {
      if (loreTokens.has(token)) return true;
    }
    return false;
  }

  loadRelevantLore(
    groupId: string,
    triggerContent: string,
    immediateContext: ReadonlyArray<{ nickname: string; content: string }>,
  ): string | null {
    // Try per-member directory first
    const aliasIndex = this._buildLoreAliasIndex(groupId);
    if (aliasIndex && aliasIndex.size > 0) {
      return this._loadRelevantLoreFromDir(
        groupId, triggerContent,
        immediateContext as Array<{ nickname: string; content: string }>,
        aliasIndex,
      );
    }

    // Try entity-filtered path (monolithic + chunks.jsonl)
    const filtered = this._loadLoreEntityFiltered(
      groupId, triggerContent,
      immediateContext as Array<{ nickname: string; content: string }>,
    );
    if (filtered !== undefined) return filtered;

    // Fallback: monolithic single-file loading
    return this._loadLoreFallback(groupId);
  }

  loadTuning(): string | null {
    if (!this.tuningPath) return null;
    const parts: string[] = [];
    try {
      if (existsSync(this.tuningPath)) {
        const content = readFileSync(this.tuningPath, 'utf8').trim();
        if (content) parts.push(content);
      }
    } catch { /* ignore */ }
    try {
      const permanentPath = path.join(path.dirname(this.tuningPath), 'tuning-permanent.md');
      if (existsSync(permanentPath)) {
        const content = readFileSync(permanentPath, 'utf8').trim();
        if (content) parts.push(content);
      }
    } catch { /* ignore */ }
    if (parts.length === 0) return null;
    const joined = parts.join('\n\n');
    if (joined.length <= 3000) return joined;
    let end = 3000;
    const code = joined.charCodeAt(end - 1);
    if (code >= 0xD800 && code <= 0xDBFF) end--;
    return joined.slice(0, end);
  }

  private _buildLoreAliasIndex(groupId: string): Map<string, string> | null {
    if (this.loreAliasIndex.has(groupId)) {
      return this.loreAliasIndex.get(groupId) ?? null;
    }

    const loreDir = path.join(this.loreDirPath, '..', 'groups', groupId, 'lore');
    if (!existsSync(loreDir)) {
      return null;
    }

    const index = new Map<string, string>();
    let files: string[];
    try {
      files = readdirSync(loreDir).filter(f => f.endsWith('.md') && f !== '_overview.md');
    } catch {
      return null;
    }

    for (const file of files) {
      const filePath = path.join(loreDir, file);
      try {
        const content = readFileSync(filePath, 'utf8');
        const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const aliasMatch = fmMatch[1]!.match(/aliases:\s*\[([^\]]*)\]/);
          if (aliasMatch) {
            const aliasStr = aliasMatch[1]!;
            const aliases = [...aliasStr.matchAll(/"([^"]+)"/g)].map(m => m[1]!);
            for (const alias of aliases) {
              index.set(alias.toLowerCase(), filePath);
            }
          }
        }
        const baseName = file.replace(/\.md$/, '');
        index.set(baseName.toLowerCase(), filePath);
      } catch {
        logger.warn({ groupId, file }, 'Failed to read lore member file');
      }
    }

    this.loreAliasIndex.set(groupId, index);
    logger.debug({ groupId, aliasCount: index.size }, 'Lore alias index built');
    return index;
  }

  private _loadLoreEntityFiltered(
    groupId: string,
    triggerContent: string,
    immediateContext: Array<{ nickname: string; content: string }>,
  ): string | null | undefined {
    const chunksPath = path.join(this.loreDirPath, `${groupId}.md.chunks.jsonl`);
    if (!existsSync(chunksPath)) return undefined;

    if (!this.loreChunkAliasMap.has(groupId)) {
      const aliasFacts = this.learnedFactsProvider ? this.learnedFactsProvider(groupId) : undefined;
      this.loreChunkAliasMap.set(groupId, buildAliasMap(chunksPath, aliasFacts));
    }
    const chunkAliasMap = this.loreChunkAliasMap.get(groupId)!;

    if (!this.loreKeywordsCache.has(groupId)) {
      const lorePath = path.join(this.loreDirPath, `${groupId}.md`);
      try {
        const fullContent = readFileSync(lorePath, 'utf8');
        this.loreKeywordsCache.set(groupId, tokenizeLore(fullContent));
      } catch {
        this.loreKeywordsCache.set(groupId, new Set());
      }
    }

    const contextSlice = immediateContext.slice(-5);
    const matchedChunks = extractEntities(triggerContent, contextSlice, chunkAliasMap);
    return buildLorePayload(groupId, matchedChunks, this.loreDirPath);
  }

  private _loadRelevantLoreFromDir(
    groupId: string,
    triggerContent: string,
    immediateContext: Array<{ nickname: string; content: string }>,
    aliasIndex: Map<string, string>,
  ): string | null {
    const TOTAL_CAP = 8000;

    const loreDir = path.join(this.loreDirPath, '..', 'groups', groupId, 'lore');
    const overviewPath = path.join(loreDir, '_overview.md');
    let overview = '';
    if (!this.loreOverviewCache.has(groupId)) {
      try {
        if (existsSync(overviewPath)) {
          overview = readFileSync(overviewPath, 'utf8').trim();
        }
      } catch { /* ignore */ }
      this.loreOverviewCache.set(groupId, overview || null);
    } else {
      overview = this.loreOverviewCache.get(groupId) ?? '';
    }

    const matchText = [
      triggerContent,
      ...immediateContext.map(m => `${m.nickname} ${m.content}`),
    ].join(' ').toLowerCase();

    const fileScores = new Map<string, number>();
    for (const [alias, filePath] of aliasIndex) {
      if (alias.length < 2) continue;
      let idx = 0;
      let count = 0;
      const lowerAlias = alias.toLowerCase();
      while ((idx = matchText.indexOf(lowerAlias, idx)) !== -1) {
        count++;
        idx += lowerAlias.length;
      }
      if (count > 0) {
        fileScores.set(filePath, (fileScores.get(filePath) ?? 0) + count);
      }
    }

    for (const msg of immediateContext) {
      const nick = msg.nickname.toLowerCase();
      for (const [alias, filePath] of aliasIndex) {
        if (nick.includes(alias) || alias.includes(nick)) {
          fileScores.set(filePath, (fileScores.get(filePath) ?? 0) + 1);
        }
      }
    }

    const ranked = [...fileScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    const parts: string[] = [];
    let totalLen = 0;

    if (overview) {
      const overviewCapped = overview.length > 3000 ? overview.slice(0, 3000) : overview;
      parts.push(overviewCapped);
      totalLen += overviewCapped.length;
    }

    const loadedFiles: string[] = [];
    for (const [filePath] of ranked) {
      if (totalLen >= TOTAL_CAP) break;
      try {
        let memberContent = readFileSync(filePath, 'utf8');
        memberContent = memberContent.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').trim();
        if (!memberContent) continue;

        const remaining = TOTAL_CAP - totalLen;
        if (memberContent.length > remaining) {
          memberContent = memberContent.slice(0, remaining);
        }
        parts.push(memberContent);
        totalLen += memberContent.length;
        loadedFiles.push(path.basename(filePath));
      } catch { /* skip unreadable files */ }
    }

    if (parts.length === 0) {
      this.loreCache.set(groupId, null);
      this.loreKeywordsCache.set(groupId, new Set());
      return null;
    }

    const combined = parts.join('\n\n');
    this.loreCache.set(groupId, combined);
    this.loreKeywordsCache.set(groupId, tokenizeLore(combined));
    logger.debug({
      groupId,
      overviewLen: overview.length,
      memberFiles: loadedFiles,
      totalLen: combined.length,
    }, 'Relevant lore loaded (per-member)');
    return combined;
  }

  private _loadLoreFallback(groupId: string): string | null {
    if (this.loreCache.has(groupId)) {
      return this.loreCache.get(groupId) ?? null;
    }

    const lorePath = path.join(this.loreDirPath, `${groupId}.md`);
    if (!existsSync(lorePath)) {
      this.loreCache.set(groupId, null);
      this.loreKeywordsCache.set(groupId, new Set());
      return null;
    }

    let content: string;
    try {
      content = readFileSync(lorePath, 'utf8');
    } catch {
      logger.warn({ groupId, lorePath }, 'Failed to read lore file');
      this.loreCache.set(groupId, null);
      this.loreKeywordsCache.set(groupId, new Set());
      return null;
    }

    if (!content.trim()) {
      logger.warn({ groupId, lorePath }, 'Lore file is empty');
      this.loreCache.set(groupId, null);
      this.loreKeywordsCache.set(groupId, new Set());
      return null;
    }

    if (Buffer.byteLength(content, 'utf8') > this.loreSizeCapBytes) {
      const capKb = (this.loreSizeCapBytes / 1024).toFixed(0);
      logger.warn({ groupId, lorePath, capKb }, `Lore file exceeds ${capKb}KB cap`);
      content = content.slice(0, this.loreSizeCapBytes);
    }

    this.loreCache.set(groupId, content);
    this.loreKeywordsCache.set(groupId, tokenizeLore(content));
    logger.debug({ groupId, lorePath, sizeKb: (content.length / 1024).toFixed(1) }, 'Lore file loaded (fallback)');
    return content;
  }
}
