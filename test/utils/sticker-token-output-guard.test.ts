import { describe, it, expect } from 'vitest';
import { stripStickerTokens } from '../../src/utils/sticker-token-output-guard.js';

describe('stripStickerTokens — should strip', () => {
  it('bare token', () => {
    const r = stripStickerTokens('sticker:18');
    expect(r.hadToken).toBe(true);
    expect(r.wasTokenOnly).toBe(true);
    expect(r.stripped).toBe('');
  });

  it('bracketed token', () => {
    const r = stripStickerTokens('<sticker:34>');
    expect(r.hadToken).toBe(true);
    expect(r.wasTokenOnly).toBe(true);
    expect(r.stripped).toBe('');
  });

  it('whitespace-padded token-only', () => {
    const r = stripStickerTokens('  sticker:5  ');
    expect(r.hadToken).toBe(true);
    expect(r.wasTokenOnly).toBe(true);
    expect(r.stripped).toBe('');
  });

  it('mid-sentence embed leaves surrounding text trimmed', () => {
    const r = stripStickerTokens('some text sticker:29 more text');
    expect(r.hadToken).toBe(true);
    expect(r.wasTokenOnly).toBe(false);
    expect(r.stripped).toBe('some text  more text');
  });

  it('token with leading newlines is token-only', () => {
    const r = stripStickerTokens('\n\nsticker:12\n');
    expect(r.hadToken).toBe(true);
    expect(r.wasTokenOnly).toBe(true);
    expect(r.stripped).toBe('');
  });

  it('multiple bracketed tokens with text between', () => {
    const r = stripStickerTokens('<sticker:1> yo <sticker:2>');
    expect(r.hadToken).toBe(true);
    expect(r.wasTokenOnly).toBe(false);
    expect(r.stripped).toBe('yo');
  });
});

describe('stripStickerTokens — must NOT strip', () => {
  it('empty string', () => {
    const r = stripStickerTokens('');
    expect(r.hadToken).toBe(false);
    expect(r.wasTokenOnly).toBe(false);
    expect(r.stripped).toBe('');
  });

  it('pure natural text', () => {
    const r = stripStickerTokens('hello world');
    expect(r.hadToken).toBe(false);
    expect(r.wasTokenOnly).toBe(false);
    expect(r.stripped).toBe('hello world');
  });

  it('word "sticker" without digit suffix', () => {
    const r = stripStickerTokens('用 sticker 回');
    expect(r.hadToken).toBe(false);
    expect(r.wasTokenOnly).toBe(false);
    expect(r.stripped).toBe('用 sticker 回');
  });

  it('resolved CQ:image form', () => {
    const r = stripStickerTokens('[CQ:image,file=abc.jpg]');
    expect(r.hadToken).toBe(false);
    expect(r.stripped).toBe('[CQ:image,file=abc.jpg]');
  });

  it('non-digit suffix', () => {
    const r = stripStickerTokens('sticker:abc');
    expect(r.hadToken).toBe(false);
    expect(r.stripped).toBe('sticker:abc');
  });
});
