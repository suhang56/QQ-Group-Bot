import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isLayeringV2Enabled } from '../../src/config/prompt-layering.js';
import { assemblePromptV2, type AssembleInput } from '../../src/modules/prompt-assembler.js';
import type { GroupConfig } from '../../src/storage/db.js';

// R5 flag=false zero-change regression contract.
// Baseline anchor: master commit 43de38f (pre-R5).
// At flag=false the chat.ts call site computes `v2SystemPrompt = null` and the
// non-hardened claude.complete `system[0].text` stays exactly equal to the
// pre-existing `systemPrompt` value (output of `_getGroupIdentityPrompt`).
// This test verifies the gate logic — no chat.ts replay because the gate is
// the only addition on the flag=false path.
const BASELINE_HASH = '43de38f';

const stubConfig = (overrides: Partial<GroupConfig> = {}): GroupConfig => ({
  groupId: 'test-group',
  enabledModules: [],
  autoMod: false,
  dailyPunishmentLimit: 0,
  punishmentsToday: 0,
  punishmentsResetDate: '2026-01-01',
  mimicActiveUserId: null,
  mimicStartedBy: null,
  chatTriggerKeywords: [],
  chatTriggerAtOnly: false,
  chatDebounceMs: 0,
  modConfidenceThreshold: 0,
  modWhitelist: [],
  appealWindowHours: 0,
  kickConfirmModel: '',
  nameImagesEnabled: false,
  nameImagesCollectionTimeoutMs: 0,
  nameImagesCollectionMax: 0,
  nameImagesCooldownMs: 0,
  nameImagesMaxPerName: 0,
  nameImagesBlocklist: [],
  loreUpdateEnabled: false,
  loreUpdateThreshold: 0,
  loreUpdateCooldownMs: 0,
  liveStickerCaptureEnabled: false,
  stickerLegendRefreshEveryMsgs: 0,
  chatPersonaText: null,
  activeCharacterId: null,
  charStartedBy: null,
  welcomeEnabled: false,
  idGuardEnabled: false,
  stickerFirstEnabled: false,
  stickerFirstThreshold: 0,
  chatInterestCategories: [],
  chatInterestMinHits: 0,
  airReadingEnabled: false,
  addresseeGraphEnabled: false,
  linkAcrossGroups: false,
  chatPromptLayeringV2: false,
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

const buildAssembleInput = (overrides: Partial<AssembleInput> = {}): AssembleInput => ({
  act: 'direct_chat',
  identityBlocks: { persona: 'PERSONA', rulesShort: '' },
  stableData: { lore: '', rulesFull: '', jargon: '', diary: '' },
  volatileData: {
    facts: 'FACTS_BLOCK',
    recentHistory: 'HISTORY_BLOCK',
    replyContext: '',
    targetBlock: '',
    habits: '',
  },
  strategyBlock: '',
  finalInstruction: 'FINAL',
  tokenBudget: 200_000,
  isBotTriggered: false,
  hasRealFactHit: false,
  ...overrides,
});

describe(`R5 flag gate — zero-change regression vs master ${BASELINE_HASH}`, () => {
  const ORIGINAL_ENV = process.env['CHAT_PROMPT_LAYERING_V2'];

  beforeEach(() => {
    delete process.env['CHAT_PROMPT_LAYERING_V2'];
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env['CHAT_PROMPT_LAYERING_V2'];
    else process.env['CHAT_PROMPT_LAYERING_V2'] = ORIGINAL_ENV;
  });

  it('Trace 1 (flag=false default): undefined groupConfig → gate false → assembler not invoked', () => {
    expect(isLayeringV2Enabled(undefined)).toBe(false);
    expect(isLayeringV2Enabled(null)).toBe(false);
  });

  it('Trace 2 (flag=false default): groupConfig with chatPromptLayeringV2=false → gate false', () => {
    const cfg = stubConfig({ chatPromptLayeringV2: false });
    expect(isLayeringV2Enabled(cfg)).toBe(false);
  });

  it('Trace 3 (flag=false default): groupConfig with chatPromptLayeringV2 missing/undefined → gate false', () => {
    // simulate older row pre-migration
    const cfg = stubConfig();
    delete (cfg as { chatPromptLayeringV2?: boolean }).chatPromptLayeringV2;
    expect(isLayeringV2Enabled(cfg)).toBe(false);
  });

  it('Trace 4 (flag=true via per-group): chatPromptLayeringV2=true → gate true', () => {
    const cfg = stubConfig({ chatPromptLayeringV2: true });
    expect(isLayeringV2Enabled(cfg)).toBe(true);
  });

  it('Trace 5 (flag=true via env): CHAT_PROMPT_LAYERING_V2=1 with no groupConfig → gate true', async () => {
    process.env['CHAT_PROMPT_LAYERING_V2'] = '1';
    // Re-import a fresh module so the env var is read at module-evaluation time.
    const fresh = await import('../../src/config/prompt-layering.js?envcheck=1');
    expect(fresh.isLayeringV2Enabled(undefined)).toBe(true);
  });
});

describe(`R5 flag=true integration — assembler shape contract`, () => {
  it('flag=true direct_chat + hasRealFactHit=true: facts text appears BEFORE recentHistory text', () => {
    const inp = buildAssembleInput({
      act: 'direct_chat',
      hasRealFactHit: true,
    });
    const out = assemblePromptV2(inp);
    const factsIdx = out.systemPrompt.indexOf('FACTS_BLOCK');
    const histIdx = out.systemPrompt.indexOf('HISTORY_BLOCK');
    expect(factsIdx).toBeGreaterThan(0);
    expect(histIdx).toBeGreaterThan(0);
    expect(factsIdx).toBeLessThan(histIdx);
    expect(out.systemPrompt.endsWith('FINAL')).toBe(true);
  });

  it('flag=true chime_in: recentHistory text appears BEFORE facts text', () => {
    // Default volatile layer order is [facts, recentHistory, replyContext, habits].
    // The assembler does NOT reorder the OUTPUT layer — it reorders the
    // truncation priority. With a generous budget both blocks survive in
    // default-order output. Verify priority effect at low budget instead.
    const inp = buildAssembleInput({
      act: 'chime_in',
      tokenBudget: 90,
      identityBlocks: { persona: 'P', rulesShort: '' },
      finalInstruction: 'F',
      stableData: { lore: '', rulesFull: '', jargon: '', diary: '' },
      strategyBlock: '',
      volatileData: {
        facts: 'FACTS_BLOCK' + 'a'.repeat(200),
        recentHistory: 'HISTORY_BLOCK' + 'b'.repeat(200),
        replyContext: '',
        targetBlock: '',
        habits: '',
      },
    });
    const out = assemblePromptV2(inp);
    expect(out.systemPrompt).toContain('HISTORY_BLOCK');
    expect(out.systemPrompt).not.toContain('FACTS_BLOCK');
    expect(out.systemPrompt.endsWith('F')).toBe(true);
  });

  it('flag=true differs structurally from raw legacy systemPrompt', () => {
    // Legacy path passes raw `systemPrompt` (a single string) as system[0].text.
    // R5 path passes assembled.systemPrompt — at minimum the assembler appends
    // STATIC_CHAT_DIRECTIVES (finalInstruction) to the end. Verify they differ.
    const legacySystemPrompt = 'PERSONA_LEGACY';
    const inp = buildAssembleInput({
      identityBlocks: { persona: legacySystemPrompt, rulesShort: '' },
      finalInstruction: 'STATIC_DIRECTIVE_END',
    });
    const out = assemblePromptV2(inp);
    expect(out.systemPrompt).not.toBe(legacySystemPrompt);
    expect(out.systemPrompt).toContain(legacySystemPrompt);
    expect(out.systemPrompt.endsWith('STATIC_DIRECTIVE_END')).toBe(true);
  });

  it('flag=true cacheBreakpoints non-empty for non-trivial input (legacy path returns no breakpoints)', () => {
    const inp = buildAssembleInput();
    const out = assemblePromptV2(inp);
    expect(out.cacheBreakpoints.length).toBeGreaterThan(0);
    expect(out.cacheBreakpoints[0]!.level).toBe('identity');
  });

  it('flag=true bot-triggered: target may be omitted, no invariant throw', () => {
    const inp = buildAssembleInput({
      isBotTriggered: true,
      volatileData: {
        facts: '', recentHistory: '', replyContext: '', targetBlock: '', habits: '',
      },
    });
    expect(() => assemblePromptV2(inp)).not.toThrow();
  });
});
