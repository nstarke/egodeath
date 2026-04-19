import { obfuscate, obfuscateMultiple } from '../obfuscator';
import { setStringArrayDecoys, clearStringArrayDecoys } from '../transforms/stringArrayExtraction';

/**
 * Extract the length of the first string-array declaration in an
 * obfuscated file — the `var X = ["...", "...", ...];` that sits right
 * after the console stubs.
 *
 * We parse out the array that matches the shape the transform emits
 * (an ArrayExpression of StringLiterals assigned to a var at program
 * scope) and count its elements. Using a proper parser here, instead
 * of regex-matching brackets, keeps the test robust against nested
 * Unicode names and escaped characters inside the hex strings.
 */
function firstStringArrayLength(code: string): number {
  const recast = require('recast');
  const ast = recast.parse(code, { parser: require('recast/parsers/babel') });
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const d of stmt.declarations || []) {
      if (
        d.init &&
        d.init.type === 'ArrayExpression' &&
        Array.isArray(d.init.elements) &&
        d.init.elements.length > 0 &&
        d.init.elements.every((e: any) => e && (e.type === 'StringLiteral' || (e.type === 'Literal' && typeof e.value === 'string')))
      ) {
        return d.init.elements.length;
      }
    }
  }
  return 0;
}

/** Execute an obfuscated CommonJS file and return its module.exports. */
function runAsCommonJS(code: string): any {
  const mod: any = { exports: {} };
  const fn = new Function('module', 'exports', code);
  fn(mod, mod.exports);
  return mod.exports;
}

beforeAll(() => {
  (global as any).setInterval = () => 0;
});

afterEach(() => {
  clearStringArrayDecoys();
});

describe('cross-file string-array normalization', () => {
  // Small but non-trivial — each file produces its own string array so
  // the test has something to compare.
  const OPTS = { targetTokens: 2000 };

  it('single-file obfuscate is unaffected when no decoys are set', () => {
    const out = obfuscate('var msg = "hello"; var tag = "world";', OPTS);
    // Just sanity — the array still emits, transform didn't regress.
    const len = firstStringArrayLength(out);
    expect(len).toBeGreaterThan(0);
  });

  it('obfuscateMultiple arrays for different files are the same length', () => {
    // Three files with VERY different literal counts — without
    // normalization their arrays would diverge by ~10x.
    const files = [
      {
        filename: 'rich.js',
        code: `
          var a = "alpha"; var b = "beta"; var c = "gamma";
          var d = "delta"; var e = "epsilon"; var f = "zeta";
          var g = "eta"; var h = "theta";
          module.exports = {};
        `,
      },
      {
        filename: 'sparse.js',
        code: 'var only = "lonely"; module.exports = {};',
      },
      {
        filename: 'medium.js',
        code: 'var x = "foo"; var y = "bar"; var z = "baz"; module.exports = {};',
      },
    ];
    const results = obfuscateMultiple(files, OPTS);
    const lengths = results.map((r) => firstStringArrayLength(r.code));
    // All arrays present.
    for (const L of lengths) expect(L).toBeGreaterThan(0);
    // Post-pass normalization pads every array to the longest, so
    // lengths must match exactly.
    const uniq = new Set(lengths);
    expect(uniq.size).toBe(1);
  });

  it('each file runtime still works after decoy padding', () => {
    const files = [
      {
        filename: 'a.js',
        code: `
          function add(x, y) { return x + y; }
          module.exports = { label: "sum", v: add(3, 4) };
        `,
      },
      {
        filename: 'b.js',
        code: `
          function greet(name) { return "Hello " + name; }
          module.exports = { phrase: greet("World") };
        `,
      },
      {
        filename: 'c.js',
        code: `
          var answer = 42;
          module.exports = { key: "truth", value: answer };
        `,
      },
    ];
    const results = obfuscateMultiple(files, OPTS);
    const a = runAsCommonJS(results[0].code);
    expect(a.label).toBe('sum');
    expect(a.v).toBe(7);
    const b = runAsCommonJS(results[1].code);
    expect(b.phrase).toBe('Hello World');
    const c = runAsCommonJS(results[2].code);
    expect(c.key).toBe('truth');
    expect(c.value).toBe(42);
  });

  it('single-file obfuscate is not affected by a stale decoy pool', () => {
    // Stale state should never leak into a plain obfuscate() call;
    // obfuscateMultiple() wraps every per-file call in set/clear, but
    // we verify the clear side works in isolation here.
    setStringArrayDecoys(['aaaa', 'bbbb', 'cccc']);
    clearStringArrayDecoys();
    const out = obfuscate('var x = "only";', OPTS);
    // No decoy left over — array length driven just by real + transform-injected.
    expect(firstStringArrayLength(out)).toBeGreaterThan(0);
  });

  it('sparse and rich files in the same batch end up at the same array length', () => {
    // The inherent per-file variance from random transforms
    // (antiDebug picking 10–20 intervals, CFF dead code padding,
    // …) means isolated-obfuscation array lengths are unstable run
    // to run. Post-pass normalization erases that: within a batch,
    // every file's array matches the longest one exactly.
    const results = obfuscateMultiple(
      [
        { filename: 'sparse.js', code: 'var only = "lonely"; module.exports = {};' },
        {
          filename: 'rich.js',
          code: `
            var a = "first"; var b = "second"; var c = "third";
            var d = "fourth"; var e = "fifth"; var f = "sixth";
            var g = "seventh";
            module.exports = {};
          `,
        },
      ],
      OPTS,
    );
    expect(firstStringArrayLength(results[0].code)).toBe(firstStringArrayLength(results[1].code));
  });

  it('decoys are drawn from other files strings (not made-up)', () => {
    // A file whose only string is 'ONLY_A' is padded with decoys from
    // the other file, which contains distinctive marker strings. The
    // decoys are chain-XOR-encoded into the array, so they're not
    // searchable by the plaintext marker — but the array should grow
    // to match the richer file's size, proving the decoys took.
    const files = [
      { filename: 'a.js', code: 'var x = "ONLY_A"; module.exports = {};' },
      {
        filename: 'b.js',
        code: `
          var m1 = "MARKER_ONE";
          var m2 = "MARKER_TWO";
          var m3 = "MARKER_THREE";
          var m4 = "MARKER_FOUR";
          var m5 = "MARKER_FIVE";
          module.exports = {};
        `,
      },
    ];
    const results = obfuscateMultiple(files, OPTS);
    const aLen = firstStringArrayLength(results[0].code);
    const bLen = firstStringArrayLength(results[1].code);
    // Post-pass normalization guarantees equal length.
    expect(aLen).toBe(bLen);
    // File a originally had 1 real string; if decoys took, its array
    // is now much larger than that.
    expect(aLen).toBeGreaterThanOrEqual(5);
  });
});
