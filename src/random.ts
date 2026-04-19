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
 * Names already handed out during the current obfuscation run. Cleared
 * between calls to obfuscate() via resetIssuedNames() so each output file
 * starts fresh. Without this, two different source identifiers could pick
 * the same random name and produce a "Identifier 'X' has already been
 * declared" SyntaxError on load — the name space is vast, but not vast
 * enough to rule out collisions on bundles with thousands of identifiers.
 */
const issuedNames = new Set<string>();

/**
 * Shared identifier pool for cross-file name sharing. When installed
 * via `setSharedNamePool()`, `gen()` draws from `sharedPool[
 * sharedPoolIndex++]` in order rather than rolling a fresh random
 * name. Two files processed through the same pool, with the index
 * reset to zero before each file, get the same identifier at every
 * matching `gen()` call position — so their surface-level token
 * streams collide at matching positions and look like one source
 * twice to a static reader.
 *
 * The pool entries are themselves drawn from `mkStr()` so they're
 * indistinguishable from regular random identifiers in shape; the
 * only difference is that the SAME entries appear in multiple files.
 *
 * When the pool is exhausted during a single file's pass (file had
 * more `gen()` calls than the pool has entries), `gen()` falls back
 * to fresh random generation for the remainder. This is a soft
 * degrade: the collision signal applies to the first N names and
 * tails off beyond. Callers should size the pool generously — the
 * default used by `obfuscateMultiple` is meant to cover pretty big
 * files without hitting the tail.
 */
let sharedPool: string[] | null = null;
let sharedPoolIndex = 0;

/**
 * Install a shared pool of names. `gen()` will return entries in
 * order for the rest of this obfuscate() call (or until cleared).
 * Resets the draw index to 0 so each file processed in a batch
 * starts from the same position — which is what makes position-N
 * names collide across files.
 *
 * Callers must `clearSharedNamePool()` when the batch finishes, or
 * subsequent (unrelated) `obfuscate()` calls will keep drawing from
 * the pool and produce non-random names across the rest of the
 * process's life. `obfuscateMultiple` wraps set/clear in a
 * `try/finally`.
 */
export function setSharedNamePool(pool: string[]): void {
  sharedPool = pool;
  sharedPoolIndex = 0;
}

/**
 * Revert to fresh-random-per-call `gen()` behavior.
 */
export function clearSharedNamePool(): void {
  sharedPool = null;
  sharedPoolIndex = 0;
}

/**
 * Build a pool of `size` unique Unicode identifier names. Used by
 * `obfuscateMultiple` once per batch; the same returned array is
 * then reinstalled before each file so every file's `gen()` sequence
 * starts from index 0 on the same pool.
 *
 * Uniqueness is enforced during construction — the returned array
 * has no duplicates, so a file drawing from it can never produce an
 * in-file collision via the shared path (the fallback path at
 * exhaustion still guards against collisions via `issuedNames`).
 */
export function generateSharedNamePool(size: number): string[] {
  const seen = new Set<string>();
  const pool: string[] = [];
  // Retry cap per slot: mkStr() occasionally produces a string
  // isValidVarName rejects (unicode quirks) or a duplicate. A cap
  // of 32 per slot is beyond any realistic failure rate and keeps a
  // pathological input from hanging.
  for (let i = 0; i < size; i++) {
    let filled = false;
    for (let retry = 0; retry < 32; retry++) {
      const name = mkStr();
      if (!isVarName(name)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      pool.push(name);
      filled = true;
      break;
    }
    if (!filled) {
      // Pool is shorter than requested — callers handle this
      // gracefully (fresh random fallback in `gen()`).
      break;
    }
  }
  return pool;
}

/**
 * Maximum gen() rerolls before we give up and append a numeric suffix.
 * The unicode name space is astronomical, so in practice we'll never hit
 * this — the cap exists only to make a bug produce a bad name instead of
 * hanging forever.
 */
const MAX_COLLISION_RETRIES = 32;

/**
 * Clear the issued-names set. Called at the start of every obfuscate()
 * invocation so names don't leak across runs.
 */
export function resetIssuedNames(): void {
  issuedNames.clear();
}

/**
 * Generate a valid, unique random variable name using Unicode characters.
 * Names are 6-16 code points long, drawn from dense Unicode ranges that are
 * valid JavaScript identifiers. Uniqueness is guaranteed within a single
 * obfuscate() call by tracking every issued name.
 *
 * When a shared pool has been installed via `setSharedNamePool()`,
 * we draw the next entry from the pool instead of rolling a fresh
 * random name — this makes matching-position calls across sibling
 * files return the same identifier. Pool entries that happen to
 * collide with an already-issued name (unlikely: pool entries are
 * unique, and `resetIssuedNames` clears between files) are skipped.
 * On pool exhaustion we fall through to fresh random generation.
 */
export function gen(): string {
  if (sharedPool !== null) {
    while (sharedPoolIndex < sharedPool.length) {
      const name = sharedPool[sharedPoolIndex++];
      if (!issuedNames.has(name)) {
        issuedNames.add(name);
        return name;
      }
    }
    // Fell through — pool exhausted. Continue to random generation
    // below so the file still gets every rename target it needs.
  }
  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
    let name = mkStr();
    while (!isVarName(name)) name = mkStr();
    if (!issuedNames.has(name)) {
      issuedNames.add(name);
      return name;
    }
  }

  // Vanishingly unlikely: after dozens of rerolls we keep colliding. Fall
  // back to a deterministic disambiguation so we still produce runnable
  // output. The suffix is itself just digits, which isValidVarName won't
  // accept as a first character, so we prepend to an existing random stem.
  let base = mkStr();
  while (!isVarName(base)) base = mkStr();
  let counter = 0;
  while (issuedNames.has(base) && counter < 1_000_000) {
    base = base + (counter % 10);
    counter++;
  }
  issuedNames.add(base);
  return base;
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
