import * as fs from 'node:fs';
import * as path from 'node:path';
import { BotError, BotErrorCode } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

export interface CharacterProfile {
  characterName: string;
  alias: string;
  band: string;
  position: string;
  cv: string;
  imageColor: string;
  age: string;
  catchphrases: string[];
  profile: string;
  toneNotes: string;
  distilledAt: string;
  sourceFile: string;
}

export interface ICharModule {
  resolveAlias(input: string): string | null;
  loadProfile(canonicalName: string): CharacterProfile | null;
  composePersonaPrompt(canonicalName: string): string;
  listAvailableAliases(): string[];
  charCanActivate(state: { mimicActiveUserId?: string | null }): boolean;
  mimicCanActivate(state: { activeCharacterId?: string | null }): boolean;
  charIsActive(state: { activeCharacterId: string | null }): boolean;
  charIsAlreadyActive(state: { activeCharacterId: string | null }, canonicalName: string): boolean;
  defaultCharacter(): string;
}

const MAX_ALIAS_LENGTH = 50;
const DEFAULT_CHARACTER = '凑友希那';
const logger = createLogger('char');

export class CharModule implements ICharModule {
  private readonly aliasMap: ReadonlyMap<string, string>;
  private readonly profileCache = new Map<string, CharacterProfile>();
  private readonly charDataDir: string;

  constructor(charDataDir: string) {
    this.charDataDir = charDataDir;
    const aliasPath = path.join(charDataDir, 'aliases.json');
    if (!fs.existsSync(aliasPath)) {
      throw new Error(`CharModule: aliases.json not found at ${aliasPath}. Cannot start.`);
    }
    const raw = JSON.parse(fs.readFileSync(aliasPath, 'utf-8')) as Record<string, string>;
    this.aliasMap = new Map(Object.entries(raw));
    logger.info({ aliases: this.aliasMap.size }, 'CharModule loaded aliases');
  }

  resolveAlias(input: string): string | null {
    const trimmed = input.trim();
    if (trimmed.length > MAX_ALIAS_LENGTH) return null;
    return this.aliasMap.get(trimmed.toLowerCase()) ?? this.aliasMap.get(trimmed) ?? null;
  }

  loadProfile(canonicalName: string): CharacterProfile | null {
    if (this.profileCache.has(canonicalName)) {
      return this.profileCache.get(canonicalName)!;
    }
    const profilePath = path.join(this.charDataDir, `${canonicalName}.json`);
    if (!fs.existsSync(profilePath)) return null;
    try {
      const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8')) as CharacterProfile;
      this.profileCache.set(canonicalName, profile);
      return profile;
    } catch (e) {
      logger.error({ err: e, canonicalName }, 'Failed to parse character profile JSON');
      return null;
    }
  }

  composePersonaPrompt(canonicalName: string): string {
    const profile = this.loadProfile(canonicalName);
    if (!profile) {
      throw new BotError(BotErrorCode.CHAR_PROFILE_MISSING, `Character profile not found: ${canonicalName}`);
    }
    const catchphrasesStr = profile.catchphrases.join('、');
    const toneSection = profile.toneNotes
      ? `\n\n【语气提示】${profile.toneNotes}`
      : '';

    return `你是${profile.characterName}（${profile.band}）。${profile.profile}

【角色设定】乐队：${profile.band} / 职位：${profile.position} / CV：${profile.cv} / 代表色：${profile.imageColor} / 年龄：${profile.age}
口头禅/标志：${catchphrasesStr}

【圈内底线】即使在角色扮演中，绝对不攻击或贬低其他乐队、角色、声优，不散布声优相关谣言，不涉及恶意黑料。角色可以有个性和执念，但不得越过此线。

【诚实底线】不捏造角色不可能知道的事实，不对现实声优或圈内八卦作出断言。

【回复风格】绝对不要输出问答菜单式的列举；可以只发贴图反应（用<sticker>标记）；回复长度3-15字，重要时可多行；不要解释自己为什么回复。如果不想回复，输出 <skip>。${toneSection}`;
  }

  listAvailableAliases(): string[] {
    const available: string[] = [];
    for (const [alias, canonical] of this.aliasMap.entries()) {
      const profilePath = path.join(this.charDataDir, `${canonical}.json`);
      if (fs.existsSync(profilePath)) {
        available.push(alias);
      }
    }
    return available;
  }

  charCanActivate(state: { mimicActiveUserId?: string | null; activeCharacterId?: string | null }): boolean {
    return !state.mimicActiveUserId;
  }

  mimicCanActivate(state: { activeCharacterId?: string | null }): boolean {
    return !state.activeCharacterId;
  }

  charIsActive(state: { activeCharacterId: string | null }): boolean {
    return !!state.activeCharacterId;
  }

  charIsAlreadyActive(state: { activeCharacterId: string | null }, canonicalName: string): boolean {
    return state.activeCharacterId === canonicalName;
  }

  defaultCharacter(): string {
    return DEFAULT_CHARACTER;
  }
}
