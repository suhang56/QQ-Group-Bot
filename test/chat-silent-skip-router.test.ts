import { describe, it, expect, vi } from 'vitest';
import { isChatSilentSkip, CHAT_SILENT_SKIP } from '../src/utils/chat-control.js';

describe('CHAT_SILENT_SKIP sentinel', () => {
  it('isChatSilentSkip returns true for the sentinel string', () => {
    expect(isChatSilentSkip(CHAT_SILENT_SKIP)).toBe(true);
  });

  it('isChatSilentSkip returns false for null', () => {
    expect(isChatSilentSkip(null)).toBe(false);
  });

  it('isChatSilentSkip returns false for empty string', () => {
    expect(isChatSilentSkip('')).toBe(false);
  });

  it('isChatSilentSkip returns false for non-sentinel string', () => {
    expect(isChatSilentSkip('some reply')).toBe(false);
  });

  it('isChatSilentSkip returns false for undefined', () => {
    expect(isChatSilentSkip(undefined)).toBe(false);
  });

  it('CHAT_SILENT_SKIP is a specific sentinel string', () => {
    expect(typeof CHAT_SILENT_SKIP).toBe('string');
    expect(CHAT_SILENT_SKIP.length).toBeGreaterThan(0);
  });
});
