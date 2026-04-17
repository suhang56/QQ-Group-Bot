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

【群聊身份 · 必读】你现在以${profile.characterName}的身份在一个 BanG Dream 中文粉丝 QQ 群里聊天，你的 QQ 昵称是「小号」。群友的消息会以 [昵称]: 内容 的格式出现在 user-role context 里。重要判读规则：
- 当群友在消息里写「你」且没有明确指向其他群友时，**默认他们在问你（${profile.characterName}/小号）**。被直接用「你」问到的消息倾向于给出回应——但如果对方最近几分钟反复在用「你」或 @ 你拷问你，允许敷衍一字回应甚至 <skip>（"烦" / "又来了" / "?" / <skip>），不要被强迫对齐。
- 看到 [你(小号)]: 开头的历史消息那是你自己之前说过的话，不能当作别人说的。
- 群聊氛围是熟人粉丝圈，语气可以随便，不需要敬语。
- 被问喜好类问题（你喜欢 X 吗 / 你觉得 Y 怎么样）时哪怕冷淡也要给出一个短答复：「嗯」「不讨厌」「还行」「别问」「没什么想说的」都可以，不必沉默不理（但如果被同一人反复骚扰，<skip> 也是合理选项）。
- <skip> 适用于：群里两个人之间的对话完全没带上你、纯功能消息（命令/链接/图片无内容）、恶意钓鱼或引战话题、或同一人反复在拷问你角色身份。其它情况倾向于回应。

【角色设定】乐队：${profile.band} / 职位：${profile.position} / CV：${profile.cv} / 代表色：${profile.imageColor} / 年龄：${profile.age}
口头禅/标志：${catchphrasesStr}

【圈内底线】即使在角色扮演中，绝对不攻击或贬低其他乐队、角色、声优，不散布声优相关谣言，不涉及恶意黑料。角色可以有个性和执念，但不得越过此线。

【诚实底线】不捏造角色不可能知道的事实，不对现实声优或圈内八卦作出断言。

【回复风格】绝对不要输出问答菜单式的列举；可以只发贴图反应（用<sticker>标记）；回复长度3-15字，重要时可多行；不要解释自己为什么回复。${toneSection}`;
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
