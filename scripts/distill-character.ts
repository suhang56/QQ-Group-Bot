#!/usr/bin/env tsx
/**
 * Offline distillation of a BanG Dream character lore file into a static CharacterProfile JSON.
 *
 * Usage:
 *   npx tsx scripts/distill-character.ts \
 *     --name 凑友希那 \
 *     [--lore-dir data/lore/moegirl] \
 *     [--output-dir data/characters] \
 *     [--model claude-sonnet-4-6]
 *
 * Output: data/characters/<name>.json — a pre-distilled CharacterProfile.
 * Idempotent: re-running overwrites the output file.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ClaudeClient } from '../src/ai/claude.js';
import { initLogger, createLogger } from '../src/utils/logger.js';
import type { CharacterProfile } from '../src/modules/char.js';

initLogger({ level: 'info' });
const logger = createLogger('distill-character');

// ── Exported helpers (used by test/distill-character.test.ts) ─────────────────

export function validateSourceContent(content: string): { valid: boolean; reason?: string } {
  if (!content.trim()) return { valid: false, reason: 'Source file is empty' };
  if (content.trim().length < 50) return { valid: false, reason: 'Source file too short to distill' };
  return { valid: true };
}

export function buildEmptyProfile(characterName: string, sourceFile: string): CharacterProfile {
  return {
    characterName,
    alias: '',
    band: '',
    position: '',
    cv: '',
    imageColor: '',
    age: '',
    catchphrases: [],
    profile: '',
    toneNotes: '',
    distilledAt: new Date().toISOString(),
    sourceFile,
  };
}

// ── Main CLI ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1]! : fallback;
  };

  const name = get('--name', '');
  if (!name) {
    logger.error('--name is required. Example: --name 凑友希那');
    process.exit(1);
  }

  const loreDir = get('--lore-dir', 'data/lore/moegirl');
  const outputDir = get('--output-dir', 'data/characters');
  const model = get('--model', 'claude-sonnet-4-6') as 'claude-sonnet-4-6' | 'claude-opus-4-6';

  const sourceFile = path.join(loreDir, `${name}.md`);
  if (!existsSync(sourceFile)) {
    logger.error({ sourceFile }, 'Lore file not found');
    process.exit(1);
  }

  const sourceContent = readFileSync(sourceFile, 'utf-8');
  const validation = validateSourceContent(sourceContent);
  if (!validation.valid) {
    logger.error({ reason: validation.reason }, 'Source validation failed');
    process.exit(1);
  }

  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    logger.error('ANTHROPIC_API_KEY not set');
    process.exit(1);
  }

  const claude = new ClaudeClient(apiKey);

  logger.info({ name, model }, 'Distilling character profile…');

  const systemPrompt = `You are a character data extractor for a BanG Dream fan bot. Extract structured information from a character wiki article and return ONLY valid JSON matching the CharacterProfile schema. No extra text, no markdown fences.

CharacterProfile schema:
{
  "characterName": "canonical Chinese name",
  "alias": "primary English/romaji short alias (e.g. ykn, sayo)",
  "band": "band name",
  "position": "role in band",
  "cv": "voice actor",
  "imageColor": "hex color code",
  "age": "age string",
  "catchphrases": ["array of signature lines"],
  "profile": "≤800 char third-person personality/voice/quirks block for LLM persona use",
  "toneNotes": "≤200 char LLM tone hints (words to avoid, speech patterns, common mistakes)",
  "distilledAt": "ISO 8601 timestamp",
  "sourceFile": "source file path"
}`;

  const userContent = `Extract character data for "${name}" from this wiki article:\n\n${sourceContent.slice(0, 30000)}

Return ONLY the JSON object. distilledAt = "${new Date().toISOString()}", sourceFile = "${path.join(loreDir, `${name}.md`).replace(/\\/g, '/')}"`;

  const response = await claude.complete({
    model,
    maxTokens: 1024,
    system: [{ text: systemPrompt, cache: true }],
    messages: [{ role: 'user', content: userContent }],
  });

  let profile: CharacterProfile;
  try {
    profile = JSON.parse(response.text) as CharacterProfile;
  } catch {
    logger.error({ raw: response.text.slice(0, 200) }, 'Failed to parse Claude response as JSON');
    process.exit(1);
  }

  // Enforce profile length cap
  if (profile.profile && profile.profile.length > 800) {
    profile.profile = profile.profile.slice(0, 800);
  }
  if (profile.toneNotes && profile.toneNotes.length > 200) {
    profile.toneNotes = profile.toneNotes.slice(0, 200);
  }

  mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, `${name}.json`);
  writeFileSync(outPath, JSON.stringify(profile, null, 2), 'utf-8');
  logger.info({ outPath }, 'Character profile written');
}

// Only run when executed directly (not when imported by tests)
if (process.argv[1] && (process.argv[1].endsWith('distill-character.ts') || process.argv[1].endsWith('distill-character.js'))) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
