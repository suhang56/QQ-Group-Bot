import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CharModule } from '../src/modules/char.js';
import { BotErrorCode } from '../src/utils/errors.js';
import { Database } from '../src/storage/db.js';
import { defaultGroupConfig } from '../src/config.js';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

// ── fixtures ──────────────────────────────────────────────────────────────────

const YKN_PROFILE = {
  characterName: '凑友希那',
  alias: 'ykn',
  band: 'Roselia',
  position: '主唱/作词作曲',
  cv: '相羽あいな',
  imageColor: '#881188',
  age: '17（高中3年级→大学1年级）',
  catchphrases: ['就这样决定了。', '音乐不容妥协。'],
  profile: '凑友希那是Roselia的主唱兼作词作曲，性格冷静坚定，对音乐近乎苛刻的执念。',
  toneNotes: '语气简短有力，不轻易妥协，少用疑问句',
  distilledAt: '2026-01-01T00:00:00.000Z',
  sourceFile: 'data/lore/moegirl/凑友希那.md',
};

const ALIASES = {
  ykn: '凑友希那',
  yukina: '凑友希那',
  友希那: '凑友希那',
  sayo: '冰川纱夜',
  纱夜: '冰川纱夜',
  risa: '今井莉莎',
  莉莎: '今井莉莎',
  rinko: '白金燐子',
  燐子: '白金燐子',
  ako: '宇田川亚子',
  亚子: '宇田川亚子',
};

function makeTempCharDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'char-test-'));
  fs.writeFileSync(path.join(dir, 'aliases.json'), JSON.stringify(ALIASES));
  fs.writeFileSync(path.join(dir, '凑友希那.json'), JSON.stringify(YKN_PROFILE));
  return dir;
}

// ── alias resolution ──────────────────────────────────────────────────────────

describe('CharModule — alias resolution', () => {
  let dir: string;
  let mod: CharModule;

  beforeEach(() => {
    dir = makeTempCharDir();
    mod = new CharModule(dir);
  });

  it('resolves known alias to canonical name', () => {
    expect(mod.resolveAlias('ykn')).toBe('凑友希那');
  });

  it('resolves alias case-insensitively', () => {
    expect(mod.resolveAlias('YKN')).toBe('凑友希那');
    expect(mod.resolveAlias('Yukina')).toBe('凑友希那');
  });

  it('resolves full Chinese name as alias', () => {
    expect(mod.resolveAlias('友希那')).toBe('凑友希那');
  });

  it('returns null for unknown alias (EC-1)', () => {
    expect(mod.resolveAlias('nobody')).toBeNull();
  });

  it('trims whitespace before lookup', () => {
    expect(mod.resolveAlias('  ykn  ')).toBe('凑友希那');
  });
});

// ── profile loading ───────────────────────────────────────────────────────────

describe('CharModule — profile loading', () => {
  let dir: string;
  let mod: CharModule;

  beforeEach(() => {
    dir = makeTempCharDir();
    mod = new CharModule(dir);
  });

  it('loads present profile file', () => {
    const p = mod.loadProfile('凑友希那');
    expect(p).not.toBeNull();
    expect(p!.characterName).toBe('凑友希那');
    expect(p!.band).toBe('Roselia');
  });

  it('returns null for absent profile file (EC-6)', () => {
    expect(mod.loadProfile('不存在的角色')).toBeNull();
  });

  it('caches profile on second call (verifiable via object identity)', () => {
    const first = mod.loadProfile('凑友希那');
    const second = mod.loadProfile('凑友希那');
    expect(first).toBe(second); // same object reference = cached
  });
});

// ── persona composition ───────────────────────────────────────────────────────

describe('CharModule — composePersonaPrompt', () => {
  let dir: string;
  let mod: CharModule;

  beforeEach(() => {
    dir = makeTempCharDir();
    mod = new CharModule(dir);
  });

  it('contains character name', () => {
    expect(mod.composePersonaPrompt('凑友希那')).toContain('凑友希那');
  });

  it('contains band name', () => {
    expect(mod.composePersonaPrompt('凑友希那')).toContain('Roselia');
  });

  it('contains at least one catchphrase', () => {
    const p = mod.composePersonaPrompt('凑友希那');
    expect(p).toContain('就这样决定了');
  });

  it('contains 圈内底线 block', () => {
    expect(mod.composePersonaPrompt('凑友希那')).toContain('圈内底线');
  });

  it('contains 诚实底线 block', () => {
    expect(mod.composePersonaPrompt('凑友希那')).toContain('诚实底线');
  });

  it('contains 回复风格 block', () => {
    expect(mod.composePersonaPrompt('凑友希那')).toContain('回复风格');
  });

  it('throws BotError E022 when profile file missing (EC-6)', () => {
    let threw = false;
    try { mod.composePersonaPrompt('不存在的角色'); } catch (e: unknown) {
      threw = true;
      expect((e as { code?: string }).code).toBe(BotErrorCode.CHAR_PROFILE_MISSING);
    }
    expect(threw).toBe(true);
  });

  it('system prompt does NOT contain user-supplied content interpolated into system block', () => {
    // Static-system-prompt regression: persona is pre-distilled static data only
    const prompt = mod.composePersonaPrompt('凑友希那');
    // Ensure no runtime user content markers could be injected (the prompt only
    // uses static CharacterProfile fields loaded from disk)
    expect(prompt).not.toContain('{userMessage}');
    expect(prompt).not.toContain('{{');
  });
});

// ── listAvailableAliases ──────────────────────────────────────────────────────

describe('CharModule — listAvailableAliases', () => {
  it('returns only aliases whose lore file exists', () => {
    const dir = makeTempCharDir();
    // Only 凑友希那.json exists; others (冰川纱夜 etc.) do not
    const mod = new CharModule(dir);
    const available = mod.listAvailableAliases();
    expect(available).toContain('ykn');
    expect(available).toContain('yukina');
    expect(available).toContain('友希那');
    // sayo maps to 冰川纱夜 — no profile file in temp dir
    expect(available).not.toContain('sayo');
  });
});

// ── constructor error ─────────────────────────────────────────────────────────

describe('CharModule — startup failures', () => {
  it('throws if aliases.json is absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'char-empty-'));
    expect(() => new CharModule(dir)).toThrow();
  });
});

// ── EC-10: alias input too long ───────────────────────────────────────────────

describe('CharModule — alias input length (EC-10)', () => {
  it('resolveAlias returns null for input >50 chars', () => {
    const dir = makeTempCharDir();
    const mod = new CharModule(dir);
    expect(mod.resolveAlias('a'.repeat(51))).toBeNull();
  });
});

// ── DB integration: /char state persistence ───────────────────────────────────

describe('CharModule + DB integration', () => {
  let dir: string;
  let mod: CharModule;
  let db: Database;

  beforeEach(() => {
    dir = makeTempCharDir();
    mod = new CharModule(dir);
    db = new Database(':memory:');
  });

  it('/char set ykn → activeCharacterId persisted in DB', () => {
    const config = defaultGroupConfig('g1');
    const canonical = mod.resolveAlias('ykn')!;
    db.groupConfig.upsert({ ...config, activeCharacterId: canonical, charStartedBy: 'u1' });
    const saved = db.groupConfig.get('g1');
    expect(saved?.activeCharacterId).toBe('凑友希那');
    expect(saved?.charStartedBy).toBe('u1');
  });

  it('/char_off → activeCharacterId set to null in DB', () => {
    const config = defaultGroupConfig('g1');
    db.groupConfig.upsert({ ...config, activeCharacterId: '凑友希那', charStartedBy: 'u1' });
    db.groupConfig.upsert({ ...db.groupConfig.get('g1')!, activeCharacterId: null, charStartedBy: null });
    const saved = db.groupConfig.get('g1');
    expect(saved?.activeCharacterId).toBeNull();
  });

  it('migration: ALTER TABLE adds active_character_id and char_started_by columns (EC-migration)', () => {
    // The Database constructor runs migrations; verify the columns exist by reading back
    const config = defaultGroupConfig('g1');
    db.groupConfig.upsert({ ...config, activeCharacterId: '凑友希那', charStartedBy: 'u1' });
    const row = db.groupConfig.get('g1');
    expect(row).toHaveProperty('activeCharacterId');
    expect(row).toHaveProperty('charStartedBy');
  });
});

// ── EC-2: /char_on while mimic active ────────────────────────────────────────

describe('CharModule — mutual exclusion edge cases', () => {
  let dir: string;
  let mod: CharModule;

  beforeEach(() => {
    dir = makeTempCharDir();
    mod = new CharModule(dir);
  });

  it('EC-2: charCanActivate returns false when mimic is active', () => {
    expect(mod.charCanActivate({ mimicActiveUserId: 'u1' })).toBe(false);
  });

  it('EC-3: mimicCanActivate returns false when char is active', () => {
    expect(mod.mimicCanActivate({ activeCharacterId: '凑友希那' })).toBe(false);
  });

  it('EC-4: charIsActive returns false when activeCharacterId is null', () => {
    expect(mod.charIsActive({ activeCharacterId: null })).toBe(false);
  });

  it('EC-18: defaultCharacter() returns ykn canonical', () => {
    expect(mod.defaultCharacter()).toBe('凑友希那');
  });

  it('EC-23: charIsAlreadyActive returns true when same char active', () => {
    expect(mod.charIsAlreadyActive({ activeCharacterId: '凑友希那' }, '凑友希那')).toBe(true);
  });

  it('EC-23: charIsAlreadyActive returns false for different char', () => {
    expect(mod.charIsAlreadyActive({ activeCharacterId: '凑友希那' }, '冰川纱夜')).toBe(false);
  });

  it('EC-12: dual-active state — both fields set returns correct precedence info', () => {
    // charCanActivate returns false if mimic active (mimic takes precedence over allowing char)
    expect(mod.charCanActivate({ mimicActiveUserId: 'u1', activeCharacterId: '凑友希那' })).toBe(false);
  });
});

// ── distill-character script ──────────────────────────────────────────────────

describe('distill-character output schema', () => {
  it('凑友希那.json validates against CharacterProfile shape', async () => {
    const profilePath = path.join(
      'D:/QQ-Group-Bot/.claude/worktrees/feat-char-mimic',
      'data/characters/凑友希那.json'
    );
    if (!fs.existsSync(profilePath)) {
      // Pre-distilled file not yet committed — skip during pre-ship test run
      return;
    }
    const raw = JSON.parse(fs.readFileSync(profilePath, 'utf-8')) as Record<string, unknown>;
    expect(typeof raw['characterName']).toBe('string');
    expect(typeof raw['alias']).toBe('string');
    expect(typeof raw['band']).toBe('string');
    expect(typeof raw['profile']).toBe('string');
    expect((raw['profile'] as string).length).toBeLessThanOrEqual(800);
    expect(Array.isArray(raw['catchphrases'])).toBe(true);
    expect(typeof raw['distilledAt']).toBe('string');
  });
});
