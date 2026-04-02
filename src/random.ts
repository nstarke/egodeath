import * as crypto from 'crypto';

const isVarName: (name: string) => boolean = require('is-valid-var-name').es5;

const MIN_NAME_LEN = 6;
const MAX_NAME_LEN = 16;

/**
 * Unicode ranges that produce valid JavaScript identifier characters.
 * These are dense ranges where most code points are valid, making
 * random selection efficient.
 */
const ID_START_RANGES: [number, number][] = [
  [0x0041, 0x005A],   // A-Z
  [0x0061, 0x007A],   // a-z
  [0x00C0, 0x00FF],   // Latin Extended
  [0x0100, 0x024F],   // Latin Extended-A/B
  [0x0370, 0x03FF],   // Greek
  [0x0400, 0x04FF],   // Cyrillic
  [0x0530, 0x058F],   // Armenian
  [0x0600, 0x06FF],   // Arabic
  [0x0900, 0x097F],   // Devanagari
  [0x0E00, 0x0E7F],   // Thai
  [0x1100, 0x11FF],   // Hangul Jamo
  [0x3040, 0x309F],   // Hiragana
  [0x30A0, 0x30FF],   // Katakana
  [0x3400, 0x4DBF],   // CJK Unified Ext A
  [0x4E00, 0x9FFF],   // CJK Unified
  [0xAC00, 0xD7AF],   // Hangul Syllables
];

function randomFromRanges(ranges: [number, number][]): string {
  const rangeIdx = crypto.randomBytes(1)[0] % ranges.length;
  const [lo, hi] = ranges[rangeIdx];
  const cp = lo + (crypto.randomBytes(2).readUInt16BE(0) % (hi - lo + 1));
  return String.fromCodePoint(cp);
}

/**
 * Generate a random Unicode string of 6-16 characters using code points
 * from known-valid identifier ranges.
 */
export function mkStr(): string {
  const len = (crypto.randomBytes(1)[0] % (MAX_NAME_LEN - MIN_NAME_LEN + 1)) + MIN_NAME_LEN;
  let val = randomFromRanges(ID_START_RANGES);
  for (let i = 1; i < len; i++) {
    val += randomFromRanges(ID_START_RANGES);
  }
  return val;
}

/**
 * Generate a valid random variable name using Unicode characters.
 * Names are 6-16 code points long, drawn from dense Unicode ranges
 * that are valid JavaScript identifiers.
 */
export function gen(): string {
  let name = mkStr();
  // In the rare case the name isn't valid, retry
  while (!isVarName(name)) {
    name = mkStr();
  }
  return name;
}

/**
 * Pick a random element from an array.
 */
export function choose<T>(arr: T[]): T {
  return arr[crypto.randomBytes(1)[0] % arr.length];
}

/**
 * Fisher-Yates shuffle an array in place.
 */
export function shuffle<T>(arr: T[]): T[] {
  let i = arr.length;
  if (i === 0) return arr;
  while (--i) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = arr[i];
    arr[i] = arr[j];
    arr[j] = temp;
  }
  return arr;
}
