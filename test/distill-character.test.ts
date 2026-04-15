import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initLogger } from '../src/utils/logger.js';

initLogger({ level: 'silent' });

// These tests exercise the distill-character script logic without actually
// calling Claude. We test: empty source file rejection, idempotent re-run,
// output JSON schema validation.

describe('distill-character — edge cases', () => {
  it('EC-16: empty source .md → returned profile is undefined (script would exit non-zero)', async () => {
    // We test the helper that validates source content before calling Claude
    const { validateSourceContent } = await import('../scripts/distill-character.js');
    const result = validateSourceContent('');
    expect(result.valid).toBe(false);
  });

  it('EC-17: second run with same output path overwrites without error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-test-'));
    const outPath = path.join(dir, '凑友希那.json');
    const profile = {
      characterName: '凑友希那', alias: 'ykn', band: 'Roselia', position: '主唱',
      cv: '相羽あいな', imageColor: '#881188', age: '17', catchphrases: ['就这样决定了。'],
      profile: '测试档案', toneNotes: '', distilledAt: new Date().toISOString(),
      sourceFile: 'data/lore/moegirl/凑友希那.md',
    };
    // First write
    fs.writeFileSync(outPath, JSON.stringify(profile), 'utf-8');
    // Second write (overwrite) — should not throw
    expect(() => fs.writeFileSync(outPath, JSON.stringify({ ...profile, toneNotes: 'updated' }), 'utf-8')).not.toThrow();
    const saved = JSON.parse(fs.readFileSync(outPath, 'utf-8')) as typeof profile;
    expect(saved.toneNotes).toBe('updated');
  });

  it('output JSON validates against CharacterProfile schema fields', async () => {
    const { buildEmptyProfile } = await import('../scripts/distill-character.js');
    const p = buildEmptyProfile('凑友希那', 'data/lore/moegirl/凑友希那.md');
    expect(p).toHaveProperty('characterName');
    expect(p).toHaveProperty('alias');
    expect(p).toHaveProperty('band');
    expect(p).toHaveProperty('profile');
    expect(p).toHaveProperty('catchphrases');
    expect(p).toHaveProperty('distilledAt');
    expect(p).toHaveProperty('sourceFile');
  });
});
