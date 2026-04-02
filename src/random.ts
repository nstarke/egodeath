import * as crypto from 'crypto';

const isVarName: (name: string) => boolean = require('is-valid-var-name').es5;

/**
 * Generate a random Unicode string of 1-10 characters.
 */
export function mkStr(): string {
  let val = '';
  const len = (crypto.randomBytes(1)[0] % 10) + 1;
  for (let i = 0; i < len; i++) {
    val += String.fromCodePoint(
      parseInt(crypto.randomBytes(3).toString('hex'), 16) % 0x10FFFF
    );
  }
  return val;
}

/**
 * Generate a valid random variable name using Unicode characters.
 */
export function gen(): string {
  let start = '1';
  while (!isVarName(start)) {
    start = mkStr();
  }
  return start;
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
