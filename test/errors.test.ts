import { describe, it, expect } from 'vitest';
import {
  BotError,
  BotErrorCode,
  ClaudeApiError,
  ClaudeParseError,
  NapCatActionError,
  DbError,
} from '../src/utils/errors.js';

describe('error classes', () => {
  it('BotError stores code and message', () => {
    const err = new BotError(BotErrorCode.DB_ERROR, 'db failed');
    expect(err.code).toBe('E011');
    expect(err.message).toBe('db failed');
    expect(err.name).toBe('BotError');
    expect(err).toBeInstanceOf(Error);
  });

  it('BotError stores cause', () => {
    const cause = new Error('root cause');
    const err = new BotError(BotErrorCode.CLAUDE_API_ERROR, 'api failed', cause);
    expect(err.cause).toBe(cause);
  });

  it('ClaudeApiError has correct code and name', () => {
    const err = new ClaudeApiError(new Error('timeout'));
    expect(err.code).toBe(BotErrorCode.CLAUDE_API_ERROR);
    expect(err.name).toBe('ClaudeApiError');
    expect(err).toBeInstanceOf(BotError);
  });

  it('ClaudeParseError truncates long raw responses', () => {
    const longRaw = 'x'.repeat(200);
    const err = new ClaudeParseError(longRaw);
    expect(err.code).toBe(BotErrorCode.CLAUDE_PARSE_ERROR);
    expect(err.name).toBe('ClaudeParseError');
    expect(err.message).toContain('x'.repeat(100));
    expect(err.message.length).toBeLessThan(200);
  });

  it('ClaudeParseError handles short raw response', () => {
    const err = new ClaudeParseError('bad json');
    expect(err.message).toContain('bad json');
  });

  it('NapCatActionError has correct code and action name', () => {
    const err = new NapCatActionError('set_group_ban', new Error('timeout'));
    expect(err.code).toBe(BotErrorCode.NAPCAT_ACTION_FAIL);
    expect(err.name).toBe('NapCatActionError');
    expect(err.message).toContain('set_group_ban');
    expect(err).toBeInstanceOf(BotError);
  });

  it('DbError has correct code', () => {
    const err = new DbError(new Error('disk full'));
    expect(err.code).toBe(BotErrorCode.DB_ERROR);
    expect(err.name).toBe('DbError');
    expect(err).toBeInstanceOf(BotError);
  });

  it('all BotErrorCode values are unique strings', () => {
    const codes = Object.values(BotErrorCode);
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });
});
