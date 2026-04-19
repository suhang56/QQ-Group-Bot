import { createHash } from 'node:crypto';

/** Returns a float in [0, 1) deterministically from seed + row id. */
export function seededRand(seed: number, rowId: number): number {
  const hex = createHash('sha256')
    .update(`${seed}:${rowId}`)
    .digest('hex');
  return Number(BigInt('0x' + hex.slice(0, 13))) / Number(2n ** 52n);
}

/** Seeded Fisher-Yates shuffle, then take first target rows. */
export function seededSample<T extends { messageId: number }>(
  rows: T[],
  seed: number,
  target: number,
): T[] {
  const arr = [...rows];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(seededRand(seed, arr[i]!.messageId) * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr.slice(0, target);
}
