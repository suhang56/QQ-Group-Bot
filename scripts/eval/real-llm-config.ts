/**
 * R6.4 — Real-LLM env / CLI config loader for replay-runner.
 *
 * Owns ENV parsing for `GEMINI_API_KEY`, `REPLAY_MAX_COST_USD`,
 * `REPLAY_PER_CALL_TIMEOUT_MS`, `REPLAY_RATE_LIMIT_RPS`, `REPLAY_RETRY_MAX`.
 *
 * Precedence (highest first): CLI overrides → env vars → defaults.
 *
 * Idempotent dotenv import — safe even if `replay-runner.ts` already loaded it.
 *
 * Validation policy:
 *   - missing GEMINI_API_KEY → process.exit(1) with stderr message
 *   - non-finite numeric env → throw Error (not exit, so tests can assert)
 *   - rateLimitRps < 1 / retryMax < 0 → throw Error
 */

import 'dotenv/config';
import type { RealLlmConfig } from '../../src/ai/real-claude-client-for-replay.js';

export type { RealLlmConfig };

const DEFAULT_MAX_COST_USD = 5.00;
const DEFAULT_PER_CALL_TIMEOUT_MS = 15_000;
const DEFAULT_RATE_LIMIT_RPS = 3;
const DEFAULT_RETRY_MAX = 3;

interface Overrides {
  maxCostUsd?: number;
  rateLimitRps?: number;
  retryMax?: number;
}

function readFloatEnv(name: string): number | null {
  const raw = process.env[name];
  if (raw == null || raw === '') return null;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number (got ${JSON.stringify(raw)})`);
  }
  return parsed;
}

function readIntEnv(name: string): number | null {
  const raw = process.env[name];
  if (raw == null || raw === '') return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number (got ${JSON.stringify(raw)})`);
  }
  return parsed;
}

export function loadRealLlmConfig(overrides: Overrides = {}): RealLlmConfig {
  const apiKey = process.env['GEMINI_API_KEY'];
  if (!apiKey) {
    process.stderr.write('GEMINI_API_KEY not set\n');
    process.exit(1);
  }

  const envMaxCost = readFloatEnv('REPLAY_MAX_COST_USD');
  const maxCostUsd =
    overrides.maxCostUsd != null
      ? overrides.maxCostUsd
      : envMaxCost != null
        ? envMaxCost
        : DEFAULT_MAX_COST_USD;
  if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
    throw new Error(`maxCostUsd must be finite and >= 0 (got ${maxCostUsd})`);
  }

  const envTimeout = readIntEnv('REPLAY_PER_CALL_TIMEOUT_MS');
  const perCallTimeoutMs = envTimeout != null ? envTimeout : DEFAULT_PER_CALL_TIMEOUT_MS;
  if (perCallTimeoutMs <= 0) {
    throw new Error(`REPLAY_PER_CALL_TIMEOUT_MS must be > 0 (got ${perCallTimeoutMs})`);
  }

  const envRps = readIntEnv('REPLAY_RATE_LIMIT_RPS');
  const rateLimitRps =
    overrides.rateLimitRps != null
      ? overrides.rateLimitRps
      : envRps != null
        ? envRps
        : DEFAULT_RATE_LIMIT_RPS;
  if (rateLimitRps < 1) {
    throw new Error(`rateLimitRps must be >= 1 (got ${rateLimitRps})`);
  }

  const envRetry = readIntEnv('REPLAY_RETRY_MAX');
  const retryMax =
    overrides.retryMax != null
      ? overrides.retryMax
      : envRetry != null
        ? envRetry
        : DEFAULT_RETRY_MAX;
  if (retryMax < 0) {
    throw new Error(`retryMax must be >= 0 (got ${retryMax})`);
  }

  return {
    apiKey,
    maxCostUsd,
    perCallTimeoutMs,
    rateLimitRps,
    retryMax,
  };
}
