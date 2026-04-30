import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadRealLlmConfig } from '../../../scripts/eval/real-llm-config.js';

const ENV_KEYS = [
  'GEMINI_API_KEY',
  'REPLAY_MAX_COST_USD',
  'REPLAY_PER_CALL_TIMEOUT_MS',
  'REPLAY_RATE_LIMIT_RPS',
  'REPLAY_RETRY_MAX',
];

describe('loadRealLlmConfig', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env['GEMINI_API_KEY'] = 'fake-test-key';
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns apiKey from env when GEMINI_API_KEY set', () => {
    const cfg = loadRealLlmConfig();
    expect(cfg.apiKey).toBe('fake-test-key');
  });

  it('exits with code 1 when GEMINI_API_KEY missing', () => {
    delete process.env['GEMINI_API_KEY'];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${String(code)})`);
    });
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() => loadRealLlmConfig()).toThrow(/process\.exit\(1\)/);
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('GEMINI_API_KEY not set'));
    exitSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('default maxCostUsd = 5.00 when REPLAY_MAX_COST_USD unset', () => {
    const cfg = loadRealLlmConfig();
    expect(cfg.maxCostUsd).toBe(5.00);
  });

  it('reads REPLAY_MAX_COST_USD as float', () => {
    process.env['REPLAY_MAX_COST_USD'] = '2.5';
    const cfg = loadRealLlmConfig();
    expect(cfg.maxCostUsd).toBe(2.5);
  });

  it('throws on non-numeric REPLAY_MAX_COST_USD', () => {
    process.env['REPLAY_MAX_COST_USD'] = 'abc';
    expect(() => loadRealLlmConfig()).toThrow(/must be a number/);
  });

  it('CLI override beats env (overrides.maxCostUsd wins)', () => {
    process.env['REPLAY_MAX_COST_USD'] = '2.5';
    const cfg = loadRealLlmConfig({ maxCostUsd: 1.0 });
    expect(cfg.maxCostUsd).toBe(1.0);
  });

  it('reads REPLAY_RATE_LIMIT_RPS as int', () => {
    process.env['REPLAY_RATE_LIMIT_RPS'] = '10';
    const cfg = loadRealLlmConfig();
    expect(cfg.rateLimitRps).toBe(10);
  });

  it('default perCallTimeoutMs = 15000 when REPLAY_PER_CALL_TIMEOUT_MS unset', () => {
    const cfg = loadRealLlmConfig();
    expect(cfg.perCallTimeoutMs).toBe(15_000);
  });

  it('rejects rateLimitRps < 1', () => {
    expect(() => loadRealLlmConfig({ rateLimitRps: 0 })).toThrow(/rateLimitRps/);
  });

  it('rejects retryMax < 0', () => {
    expect(() => loadRealLlmConfig({ retryMax: -1 })).toThrow(/retryMax/);
  });
});
