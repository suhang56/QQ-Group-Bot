export interface StickerTokenChoice {
  token: string;
  key: string;
  cqCode: string;
  label?: string;
}

export interface StickerLike {
  key?: string;
  label?: string;
  cqCode: string;
}

const STICKER_TOKEN_RE = /^\s*<?sticker:(\d{1,3})>?\s*$/i;

export function makeStickerToken(index: number): string {
  return `<sticker:${index}>`;
}

export function stickerKeyFromCqCode(cqCode: string): string {
  const key = /\bkey=([^,\]]+)/.exec(cqCode)?.[1]?.trim();
  if (key) return key;
  const emojiId = /\bemoji_id=([^,\]]+)/.exec(cqCode)?.[1]?.trim();
  if (emojiId) return `mface:${emojiId}`;
  const file = /\bfile=([^,\]]+)/.exec(cqCode)?.[1]?.trim();
  if (file) return `image:${file}`;
  return cqCode.slice(0, 80);
}

export function makeStickerTokenChoices(
  stickers: ReadonlyArray<StickerLike>,
  startIndex = 1,
): StickerTokenChoice[] {
  return stickers.map((s, i) => ({
    token: makeStickerToken(startIndex + i),
    key: s.key ?? stickerKeyFromCqCode(s.cqCode),
    cqCode: s.cqCode,
    label: s.label,
  }));
}

export function resolveStickerTokenOutput(
  text: string,
  choices: ReadonlyArray<StickerTokenChoice>,
): StickerTokenChoice | null {
  const m = STICKER_TOKEN_RE.exec(text.trim());
  if (!m) return null;
  const token = makeStickerToken(Number.parseInt(m[1]!, 10));
  return choices.find(c => c.token.toLowerCase() === token.toLowerCase()) ?? null;
}

export function isStickerTokenOutput(text: string): boolean {
  return STICKER_TOKEN_RE.test(text.trim());
}
