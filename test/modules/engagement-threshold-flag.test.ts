import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

/**
 * R2.5.1 Item 4 — chatMinScore is env-gated at module-load time.
 * Default true → 0.65; explicit 'false' → 0.45. Any other value is treated
 * as "not false" → default 0.65 (generous interpretation).
 */

const ENV_KEY = 'R2_5_1_HIGHER_ENGAGE_THRESHOLD';

async function loadLurker(): Promise<{ chatMinScore: number }> {
  vi.resetModules();
  const mod = await import('../../src/config.js');
  return mod.lurkerDefaults;
}

describe('R2_5_1_HIGHER_ENGAGE_THRESHOLD → lurkerDefaults.chatMinScore', () => {
  const originalValue = process.env[ENV_KEY];

  beforeEach(() => {
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    if (originalValue === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalValue;
  });

  it('unset (default) → chatMinScore === 0.65', async () => {
    delete process.env[ENV_KEY];
    const d = await loadLurker();
    expect(d.chatMinScore).toBe(0.65);
  });

  it("env = 'false' → chatMinScore === 0.45 (rollback path)", async () => {
    process.env[ENV_KEY] = 'false';
    const d = await loadLurker();
    expect(d.chatMinScore).toBe(0.45);
  });

  it("env = 'true' → chatMinScore === 0.65", async () => {
    process.env[ENV_KEY] = 'true';
    const d = await loadLurker();
    expect(d.chatMinScore).toBe(0.65);
  });

  it("env = '1' (non-'false' truthy) → chatMinScore === 0.65", async () => {
    process.env[ENV_KEY] = '1';
    const d = await loadLurker();
    expect(d.chatMinScore).toBe(0.65);
  });

  it("env = '' (empty string, not 'false') → chatMinScore === 0.65", async () => {
    process.env[ENV_KEY] = '';
    const d = await loadLurker();
    expect(d.chatMinScore).toBe(0.65);
  });
});
