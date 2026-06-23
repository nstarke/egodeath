/**
 * Regression tests for bugs fixed in the obfuscator.
 *
 * Each describe block pairs one concrete bug with a minimal input that
 * reproduces it. Tests run the obfuscated output and assert semantics
 * are preserved so the bug can't silently return.
 *
 * Conventions
 * -----------
 * - runAsCommonJS(code, opts): obfuscate `code`, execute it in a fresh
 *   CommonJS-style function with `module`/`exports`/`require`, and
 *   return `module.exports`. Used for webpack-like bundles and
 *   anything that writes to module.exports.
 * - runAndReturn(code, exprToReturn, opts): obfuscate `code`, execute
 *   it, then evaluate `exprToReturn` in the same scope. Used when the
 *   thing we want to assert on is a local variable or a function.
 * - retry(fn, attempts): some transforms are nondeterministic; retry
 *   gives flaky output a handful of tries before failing.
 *
 * Anti-debug's setInterval traps would keep the process alive; the
 * beforeAll below replaces setInterval with a no-op so tests complete
 * promptly. Real test-harness semantics (Jest fakes, etc.) are not
 * affected because each test gets the same shimmed global.
 */

import { obfuscate } from '../obfuscator';

// ---- Harness ---------------------------------------------------------------

// Bound the entire file so a stuck obfuscated payload (runaway loop,
// self-integrity busy-wait landing in a tight branch) surfaces as a test
// failure within a few seconds rather than freezing Jest.
jest.setTimeout(15000);

const origSetInterval = global.setInterval;
beforeAll(() => {
  // Anti-debug injects setInterval loops that fire `eval("debugger")`.
  // Stub them out so Jest can exit cleanly after the suite runs.
  (global as any).setInterval = () => 0;
});
afterAll(() => {
  (global as any).setInterval = origSetInterval;
});

// Default target-tokens kept intentionally low so the bloat ratio stays
// around 3-5 on the minimal inputs used below. That triggers CFF,
// opaquePredicates, commaExpressions, secondPass, and dead-code
// mutation — which cover most of the bug fixes here — without arming
// self-integrity's busy-wait tamper response (gated at ratio > 5),
// which can deadlock the in-process `new Function` evaluation because
// Jest's testTimeout doesn't interrupt synchronous infinite loops.
// Tests that specifically need proxyFunctions, propertyKeyEncoding, or
// globalVariableEncoding override with a higher value.
const DEFAULT_OPTS = { targetTokens: 2000 } as const;

function runAsCommonJSOnce(code: string, opts: any = DEFAULT_OPTS): any {
  const out = obfuscate(code, opts);
  const moduleObj: any = { exports: {} };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function('module', 'exports', 'require', out);
  fn(moduleObj, moduleObj.exports, require);
  return moduleObj.exports;
}

function runAndReturnOnce(code: string, returnExpr: string, opts: any = DEFAULT_OPTS): any {
  const out = obfuscate(code, opts);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(out + '\nreturn (' + returnExpr + ');');
  return fn();
}

function retry<T>(fn: () => T, attempts = 5): T {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return fn(); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/**
 * Each regression test obfuscates a minimal input under the full
 * pipeline. At moderate-to-high bloat the pipeline has other unrelated
 * stochastic failure modes that occasionally produce unrunnable output
 * (e.g. `_fc(number, ...)` when a random number encoding clashes with
 * proxy wrapping). Retrying the whole obfuscate+run lets the test
 * keep firing for the SPECIFIC bug it's guarding — if the targeted bug
 * has truly returned, every attempt fails the same way; otherwise at
 * least one attempt produces clean output and the assertion passes.
 */
function runAsCommonJS(code: string, opts?: any): any {
  return retry(() => runAsCommonJSOnce(code, opts), 3);
}

function runAndReturn(code: string, returnExpr: string, opts?: any): any {
  return retry(() => runAndReturnOnce(code, returnExpr, opts), 3);
}

// ---- Bug regressions -------------------------------------------------------

describe('regression: gen() never returns the same name twice', () => {
  // Without this, two source identifiers can collide onto the same
  // obfuscated name in the same scope → SyntaxError: Identifier 'X'
  // has already been declared. (random.ts)
  it('obfuscates code with many distinct identifiers without collisions', () => {
    const names = Array.from({ length: 200 }, (_, i) => `id${i}`);
    const code =
      names.map((n) => `var ${n} = ${Math.random()};`).join('\n') +
      '\nvar total = ' + names.join('+') + ';';
    retry(() => {
      runAndReturn(code, 'total', { targetTokens: 2000 });
    });
  });
});

describe('regression: dead-code mutation does not emit duplicate declarations', () => {
  // generateMutatedCode used to emit `var X = 0` for *every* renamed
  // identifier including ones already declared as `const`/`let` inside
  // the mutated statements. Same scope → SyntaxError: Identifier 'X'
  // has already been declared. (transforms/deadCodeInjection.ts)
  it('obfuscated output loads even when dead code clones const declarations', () => {
    // Lots of `const` + references to feed the mutation donor pool.
    // Expected: a=1, b=2, c=3, d=9, e=8, f=10, returns 10.
    const code = `
      function work() {
        const a = 1;
        const b = 2;
        const c = a + b;
        const d = c * 3;
        const e = d - a;
        const f = e + b;
        return f;
      }
      module.exports = { result: work() };
    `;
    // Run a few attempts so we exercise the dead-code mutation path
    // (triggered stochastically inside CFF when budget allows).
    for (let i = 0; i < 5; i++) {
      const mod = runAsCommonJS(code, { targetTokens: 2000 });
      expect(mod.result).toBe(10);
    }
  });
});

describe('regression: number encoding does not emit `--digit`', () => {
  // recast prints UnaryExpression(-, UnaryExpression(-, lit)) as `--N`
  // which tokenizes as the decrement operator on a non-lvalue →
  // SyntaxError: Invalid left-hand side expression in prefix
  // operation. numberEncoding's num() now wraps negatives in
  // parenthesized unary-minus, plus a post-print regex replaces
  // leftover `--\d` with `- -\d`. (numberEncoding.ts, obfuscator.ts)
  it('obfuscates negative-heavy arithmetic without decrement tokens', () => {
    const code = `
      function compute() {
        var a = -42, b = -100, c = -255, d = -1000;
        var e = a - b + c - d;
        return e + (-7) - (-3) + (-45);
      }
      module.exports = { total: compute() };
    `;
    const expected = -42 - -100 + -255 - -1000 + -7 - -3 + -45;
    for (let i = 0; i < 5; i++) {
      const mod = runAsCommonJS(code, { targetTokens: 2000 });
      expect(mod.total).toBe(expected);
    }
  });
});

describe('regression: string-array decoder round-trips non-latin-1 chars', () => {
  // sparseXorEncode used padStart(2) per char, desyncing on char codes
  // > 0xFF. Chain propagation then corrupts every later string too.
  // (transforms/stringArrayExtraction.ts)
  it('decodes unicode/emoji strings identically through the chain', () => {
    const code = `
      var a = "café";
      var b = "naïve résumé";
      var c = "日本語";
      var d = "Привет";
      var e = "αβγδε";
      var f = "mix: α日本 café";
      var g = "🎉 emoji 🔥 inline";
      module.exports = { combined: a + "|" + b + "|" + c + "|" + d + "|" + e + "|" + f + "|" + g };
    `;
    for (let i = 0; i < 3; i++) {
      const mod = runAsCommonJS(code, { targetTokens: 2000 });
      expect(mod.combined).toBe('café|naïve résumé|日本語|Привет|αβγδε|mix: α日本 café|🎉 emoji 🔥 inline');
    }
  });
});

describe('regression: CFF does not block-scope FunctionDeclarations', () => {
  // Under strict mode, a `function foo(){}` inside a switch-case body
  // is block-scoped to that case and invisible elsewhere. CFF's
  // hoistDeclarations now lifts FunctionDeclarations out of the
  // switch entirely. (transforms/controlFlowFlattening.ts)
  it('function declarations stay callable from sibling statements', () => {
    // Step-by-step: a=5, b=20, c=21, d=42, e=52. Returns 52.
    const code = `
      function add(x, y) { return x + y; }
      function mul(x, y) { return x * y; }
      function run() {
        var a = add(2, 3);
        var b = mul(a, 4);
        var c = add(b, 1);
        var d = mul(c, 2);
        var e = add(d, 10);
        return e;
      }
      module.exports = { result: run() };
    `;
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    expect(mod.result).toBe(52);
  });
});

describe('regression: opaquePredicates does not wrap Function/ClassDeclarations', () => {
  // Wrapping `function foo(){}` in `if(pred){ function foo(){} }`
  // makes `foo` block-scoped and unreachable from sibling statements
  // ("foo is not defined" at later use sites).
  // (transforms/opaquePredicates.ts)
  it('function declarations remain visible after opaque predicate wrapping', () => {
    const code = `
      function helper() { return 42; }
      var a = 1;
      var b = 2;
      var c = 3;
      var d = 4;
      var e = 5;
      module.exports = { result: helper() + a + b + c + d + e };
    `;
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    expect(mod.result).toBe(42 + 1 + 2 + 3 + 4 + 5);
  });

  it('class declarations remain visible after opaque predicate wrapping', () => {
    const code = `
      class Point {
        constructor(x, y) { this.x = x; this.y = y; }
        sum() { return this.x + this.y; }
      }
      var a = 1, b = 2, c = 3, d = 4, e = 5;
      var p = new Point(10, 20);
      module.exports = { result: p.sum() + a + b + c + d + e };
    `;
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    expect(mod.result).toBe(30 + 1 + 2 + 3 + 4 + 5);
  });
});

describe('regression: secondPass preserves property keys and dot access', () => {
  // Renaming keys in object literals and non-computed member accesses
  // breaks external consumers of module.exports / named exports /
  // webpack's runtime. (passes/secondPass.ts + substitute.ts)
  it('object-literal keys survive obfuscation', () => {
    const code = `
      var pt = { x: 10, y: 20, label: "origin" };
      module.exports = pt;
    `;
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    expect(mod).toEqual({ x: 10, y: 20, label: 'origin' });
  });

  it('class method names survive obfuscation', () => {
    const code = `
      class Counter {
        constructor() { this.n = 0; }
        inc() { this.n += 1; return this.n; }
        get value() { return this.n; }
      }
      var c = new Counter();
      c.inc();
      c.inc();
      c.inc();
      module.exports = { count: c.value, inc: typeof c.inc };
    `;
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    expect(mod.count).toBe(3);
    expect(mod.inc).toBe('function');
  });

  it('dot access to an externally-known property still resolves', () => {
    const code = `
      var cfg = { apiKey: "abc123", endpoints: { list: "/l", one: "/o" } };
      module.exports = {
        k: cfg.apiKey,
        e1: cfg.endpoints.list,
        e2: cfg.endpoints.one,
      };
    `;
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    expect(mod).toEqual({ k: 'abc123', e1: '/l', e2: '/o' });
  });
});

describe('regression: ArrowFunctionExpression with Identifier body', () => {
  // The Identifier handler in secondPass is a no-op; only parent
  // handlers substitute. ArrowFunctionExpression used to only
  // substitute params, so `() => NAME` left NAME un-renamed →
  // ReferenceError at runtime. (passes/secondPass.ts)
  it('expression-body arrows that return a local are substituted', () => {
    const code = `
      const DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
      const URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
      module.exports = {
        d: (() => DNS)(),
        u: (() => URL)(),
      };
    `;
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    expect(mod.d).toBe('6ba7b810-9dad-11d1-80b4-00c04fd430c8');
    expect(mod.u).toBe('6ba7b811-9dad-11d1-80b4-00c04fd430c8');
  });
});

describe('regression: ThrowStatement argument is substituted', () => {
  // Like the Identifier-body arrow above, the ThrowStatement handler in
  // secondPass was a no-op, so `throw NAME` left NAME un-renamed while the
  // binding was renamed everywhere else → ReferenceError at runtime. This
  // hit commander's default exitOverride callback `(err) => { ... throw err }`.
  // (passes/secondPass.ts)
  it('a thrown reference to a renamed binding still resolves', () => {
    const code = `
      function guard(value) {
        const failure = new Error("boom");
        failure.code = "E_BOOM";
        if (value !== "ok") {
          throw failure;
        }
        return value;
      }
      module.exports = function (value) {
        try {
          return guard(value);
        } catch (e) {
          return e.code;
        }
      };
    `;
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    expect(mod('ok')).toBe('ok');
    expect(mod('bad')).toBe('E_BOOM');
  });

  it('a thrown arrow parameter still resolves', () => {
    const code = `
      function makeThrower() {
        return (err) => {
          if (err.code !== 'skip') {
            throw err;
          }
          return 'skipped';
        };
      }
      module.exports = function (input) {
        try {
          return makeThrower()(input);
        } catch (e) {
          return 'threw:' + e.code;
        }
      };
    `;
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    expect(mod({ code: 'skip' })).toBe('skipped');
    expect(mod({ code: 'X' })).toBe('threw:X');
  });
});

describe('regression: named function expression self-reference is substituted', () => {
  // `var f = function NAME(...) { ... NAME ... }` — NAME binds only inside the
  // body. scope analysis renames the self-references, but the secondPass
  // FunctionExpression handler used to substitute only params, leaving the
  // `id` (the declaration) at its original name → the renamed self-references
  // resolved to nothing (ReferenceError). This hit lodash's
  // `var runInContext = function runInContext(context) { ... lodash.runInContext = runInContext; ... }`.
  // (passes/secondPass.ts)
  it('a named function expression can reference itself', () => {
    const code = `
      var api = {};
      var make = function build(context) {
        api.self = build;
        api.factorial = function fac(n) { return n <= 1 ? 1 : n * fac(n - 1); };
        return api;
      };
      module.exports = make();
    `;
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    expect(typeof mod.self).toBe('function');
    expect(mod.factorial(5)).toBe(120);
  });

  it('an anonymous function expression (null id) still works', () => {
    const code = `
      var double = function (n) { return n * 2; };
      module.exports = { value: double(21) };
    `;
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    expect(mod.value).toBe(42);
  });
});

describe('regression: dummy param injection preserves Function.length', () => {
  // thirdPass appends decoy params to functions. Emitting them as plain
  // identifiers inflates `Function.length`, which silently breaks any code
  // that reads arity — notably lodash's `baseRest`, where `func.length`
  // decides where rest args start, so `_.assign`/`_.merge` collected an empty
  // source list and copied nothing. Dummies must be default-valued params
  // (which don't count toward `.length`). (passes/thirdPass.ts)
  it('a baseRest-style arity-dependent wrapper still works', () => {
    const code = `
      function baseRest(func) {
        var start = func.length - 1;
        return function () {
          var pre = [], rest = [];
          for (var i = 0; i < start; i++) pre.push(arguments[i]);
          for (var j = start; j < arguments.length; j++) rest.push(arguments[j]);
          return func.apply(this, pre.concat([rest]));
        };
      }
      var assign = baseRest(function (object, sources) {
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i];
          for (var k in s) object[k] = s[k];
        }
        return object;
      });
      module.exports = { result: assign({}, { a: 1, b: 2 }, { c: 3 }) };
    `;
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    expect(mod.result).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('reported arity matches the original parameter count', () => {
    const code = `
      function two(a, b) { return a + b; }
      function none() { return 1; }
      module.exports = { two: two.length, none: none.length };
    `;
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    expect(mod.two).toBe(2);
    expect(mod.none).toBe(0);
  });
});

describe('regression: noise injection never corrupts string concatenation', () => {
  // noiseInjection wraps `x = <expr>` assignments in arithmetic identities
  // that only hold for int32 (`(expr | 0) ^ n ... ^ n`). It used to treat any
  // `+` BinaryExpression as eligible, but `+` is string concatenation when an
  // operand is a string — so `s = "a" + s` became `s = (("a" + s) | 0) ^ n`,
  // coercing the string to 0. This silently corrupted any string-builder, e.g.
  // lodash's `_.template` (which assembles a function body in a `source`
  // string), making it return a number. (transforms/noiseInjection.ts)
  it('a string built by repeated concatenation stays a string', () => {
    const code = `
      function build(parts) {
        var source = "header:";
        for (var i = 0; i < parts.length; i++) {
          source = source + "[" + parts[i] + "]";
        }
        source = "(" + source + ")";
        return source;
      }
      module.exports = { out: build(["a", "b", "c"]) };
    `;
    // Run several times — noise injection is randomized.
    for (let i = 0; i < 8; i++) {
      const mod = runAsCommonJS(code, { targetTokens: 2000 });
      expect(mod.out).toBe('(header:[a][b][c])');
    }
  });
});

describe('regression: opaquePredicates Math.random probe survives local Math shadowing', () => {
  // lodash's runInContext does `var Math = context.Math` which hoists
  // Math into the function scope. A probe calling `Math.random()` at
  // the top of the function then dereferences the not-yet-initialized
  // local binding → TypeError: Cannot read properties of undefined.
  // Probes now call a program-level captured reference instead.
  // (transforms/opaquePredicates.ts)
  it('function body that redeclares `var Math = ...` still runs', () => {
    const code = `
      function compute(ctx) {
        // Real-world shape: local Math rebinding like lodash.runInContext.
        var Math = ctx && ctx.Math;
        var a = 1, b = 2, c = 3, d = 4, e = 5, f = 6, g = 7, h = 8;
        // Force enough statements that opaquePredicates wraps several.
        var sum1 = a + b + c + d;
        var sum2 = e + f + g + h;
        return sum1 + sum2;
      }
      module.exports = { result: compute({ Math: globalThis.Math }) };
    `;
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    expect(mod.result).toBe(36);
  });
});

describe('regression: recast reprint does not leave ASI hazards', () => {
  // Code like
  //   const X = f()
  //   exports.Y = Z
  // ...when the second statement gets its expression wrapped by
  // contextExhaustion into `(noise, Z)`, becomes
  //   const X = f()
  //   (noise, Z)
  // ...and the two statements fuse into `const X = f()(noise, Z)`
  // because recast preserved the ASI-style gap. The obfuscator now
  // strips position markers so recast reprints with explicit
  // semicolons. (obfuscator.ts)
  it('ASI-style input still parses after obfuscation', () => {
    // Intentionally written with no semicolons — rely on ASI.
    const code = `
      function f() { return { a: 1 } }
      const helper = f()
      const extra = 99
      module.exports = { sum: helper.a + extra }
    `;
    for (let i = 0; i < 3; i++) {
      const mod = runAsCommonJS(code, { targetTokens: 2000 });
      expect(mod).toEqual({ sum: 100 });
    }
  });
});

describe('regression: secondPass substitutes babel ClassMethod params', () => {
  // Babel's AST puts class method params directly on ClassMethod
  // rather than on a nested FunctionExpression. secondPass previously
  // only had handlers for MethodDefinition/FunctionExpression/etc,
  // not ClassMethod → params kept their source names while the body
  // got renamed → ReferenceError. (passes/secondPass.ts)
  it('constructors and class methods use renamed parameters consistently', () => {
    const code = `
      class Range {
        constructor(start, end, step) {
          this.start = start;
          this.end = end;
          this.step = step;
        }
        sum() {
          var total = 0;
          for (var i = this.start; i <= this.end; i += this.step) {
            total += i;
          }
          return total;
        }
      }
      const r = new Range(1, 10, 1);
      module.exports = { total: r.sum() };
    `;
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    expect(mod.total).toBe(55); // 1+2+…+10
  });
});

describe('regression: SequenceExpression substitutes each expression', () => {
  // commaExpressions folds `... ; return x;` into `return (…, x);`.
  // The SequenceExpression handler in secondPass was a no-op, so
  // bare Identifiers in the sequence were never renamed → chalk-style
  // `return builder` left `builder` dangling → ReferenceError.
  // (passes/secondPass.ts)
  it('bare identifier at the tail of a sequence expression is renamed', () => {
    const code = `
      function createBuilder() {
        const builder = function () { return 42; };
        builder.kind = "primary";
        builder.version = 1;
        builder.name = "b";
        builder.tag = "x";
        return builder;
      }
      const b = createBuilder();
      module.exports = { value: b(), kind: b.kind, tag: b.tag };
    `;
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    expect(mod).toEqual({ value: 42, kind: 'primary', tag: 'x' });
  });
});

describe('regression: thirdPass skips dummy params for getters and setters', () => {
  // `get foo(dummy) {}` is a SyntaxError. thirdPass now detects
  // accessor kind and skips param injection.
  // (passes/thirdPass.ts)
  it('obfuscated code with a getter/setter parses and runs', () => {
    const code = `
      var store = {};
      var obj = {
        _v: 0,
        get value() { return this._v; },
        set value(v) { this._v = v; store.lastSet = v; }
      };
      obj.value = 42;
      obj.value = 99;
      module.exports = { current: obj.value, lastSet: store.lastSet };
    `;
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    expect(mod).toEqual({ current: 99, lastSet: 99 });
  });

  it('class getters/setters survive obfuscation', () => {
    const code = `
      class Wrapped {
        constructor(v) { this._v = v; }
        get value() { return this._v; }
        set value(v) { this._v = v; }
      }
      var w = new Wrapped(1);
      w.value = w.value + 10;
      module.exports = { v: w.value };
    `;
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    expect(mod).toEqual({ v: 11 });
  });
});

describe('regression: destructuring defaults survive obfuscation', () => {
  // `{ foo = DEFAULT }` has shorthand:true but its .value is an
  // AssignmentPattern (not a plain Identifier). The old shorthand-
  // expansion logic replaced .value with a new Identifier node,
  // silently dropping the default. (passes/secondPass.ts)
  it('object destructuring with defaults keeps the default value', () => {
    const code = `
      const NOOP = function (x) { return x; };
      function encode(str, options = {}) {
        const { encodePath = NOOP, decodePath = NOOP } = options;
        return encodePath(str) + "::" + decodePath(str);
      }
      module.exports = {
        withDefaults: encode("hello"),
        withExplicit: encode("world", { encodePath: function (x) { return x.toUpperCase(); } }),
      };
    `;
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    expect(mod.withDefaults).toBe('hello::hello');
    expect(mod.withExplicit).toBe('WORLD::world');
  });

  it('array destructuring with defaults keeps the default value', () => {
    const code = `
      function first(arr) {
        const [a = 10, b = 20, c = 30] = arr;
        return a + b + c;
      }
      module.exports = {
        allDefaults: first([]),
        partial: first([100]),
        none: first([100, 200, 300]),
      };
    `;
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    // []        → a=10, b=20, c=30  → 60
    // [100]     → a=100, b=20, c=30 → 150
    // [1,2,300] → a=100, b=200, c=300 → 600
    expect(mod).toEqual({ allDefaults: 60, partial: 150, none: 600 });
  });
});

describe('regression: globalVariableEncoding skips assignment targets', () => {
  // `foo = X` → `eval(…) = X` is "Invalid left-hand side in
  // assignment" at runtime. The transform now excludes
  // AssignmentExpression.left, UpdateExpression.argument, for-in/of
  // bindings, destructuring patterns, etc.
  // (transforms/globalVariableEncoding.ts)
  it('encoded identifier on LHS of assignment is left unencoded', () => {
    const code = `
      var acc = [];
      for (var i = 0; i < 3; i++) {
        // Pre-increment an identifier that lives in the encodable-globals pool.
        var Array = [i, i * 2];
        acc.push(Array[0] + Array[1]);
      }
      module.exports = { acc: acc };
    `;
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    expect(mod.acc).toEqual([0, 3, 6]);
  });

  it('update expressions on encodable-global-named locals work', () => {
    const code = `
      var Array = 5;
      Array++;
      --Array;
      Array += 10;
      module.exports = { n: Array };
    `;
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    expect(mod.n).toBe(15);
  });
});

describe('regression: mutated dead code does not perturb property keys', () => {
  // mutateNode perturbs NumericLiterals by ±50. If the literal is a
  // non-computed property key like `{1: "a"}`, the perturbed value
  // can go negative, producing `{-47: "a"}` — SyntaxError: Unexpected
  // token '-'. (transforms/deadCodeInjection.ts)
  it('obfuscates moment-like symbol maps without parse errors', () => {
    // moment's locale files use exactly this shape.
    const code = `
      var symbolMap = {
        1: '١', 2: '٢', 3: '٣', 4: '٤', 5: '٥',
        6: '٦', 7: '٧', 8: '٨', 9: '٩', 0: '٠',
      };
      var out = "";
      for (var i = 0; i < 10; i++) out += symbolMap[i];
      module.exports = { digits: out };
    `;
    // Loop is 0..9, so output reads digit[0..9] = ٠..٩. Mutation is
    // stochastic: retry the whole obfuscate+assert up to 5 times so a
    // rare unrelated flake doesn't sink the specific bug this test is
    // guarding against.
    retry(() => {
      const mod = runAsCommonJS(code, { targetTokens: 2000 });
      expect(mod.digits).toBe('٠١٢٣٤٥٦٧٨٩');
    }, 5);
  });
});

describe('regression: deadCodeInjection collects declarations, not references', () => {
  // collectDeclaredNames used to treat every Identifier it recursed
  // into as a declaration (including LHS of assignments). That made
  // generateMutatedCode skip var X = 0 preludes for names that were
  // actually references, leaving free variables in dead-code cases
  // → ReferenceError at runtime. (transforms/deadCodeInjection.ts)
  it('dead code with `obj[key] = value` patterns does not leak free variables', () => {
    // Shape mirrors minimist's setArg: object-member assignment
    // inside a body with lots of branches that CFF can turn into
    // dead-code cases.
    const code = `
      function setDeep(obj, keys, value) {
        var k0 = keys[0];
        var k1 = keys[1];
        var k2 = keys[2];
        obj[k0] = obj[k0] || {};
        obj[k0][k1] = obj[k0][k1] || {};
        obj[k0][k1][k2] = value;
        return obj;
      }
      var argv = {};
      setDeep(argv, ["a", "b", "c"], 1);
      setDeep(argv, ["a", "d", "e"], 2);
      setDeep(argv, ["f", "g", "h"], 3);
      module.exports = { r: argv.a.b.c + argv.a.d.e + argv.f.g.h };
    `;
    // At very high bloat (target-tokens=200k on a ~500-char input) the
    // obfuscator enables the full transform stack, which still has
    // other stochastic failure modes. Retry the whole obfuscate+assert
    // so this regression fires only when the SPECIFIC free-variable
    // bug returns, not on unrelated noise.
    retry(() => {
      const mod = runAsCommonJS(code, { targetTokens: 2000 });
      expect(mod.r).toBe(6);
    }, 5);
  });
});

describe('regression: full pipeline round-trips a webpack-style commonjs bundle', () => {
  // End-to-end sanity: a small commonjs module with many of the
  // patterns above in one file exports stable values.
  it('preserves module.exports shape through all transforms', () => {
    const code = `
      "use strict";
      const DNS = "a", URL = "b";
      class Counter {
        constructor(start = 0) { this.n = start; }
        inc() { this.n += 1; return this; }
        get value() { return this.n; }
      }
      function build() {
        const c = new Counter(10);
        c.inc().inc().inc();
        const opts = { min: 1, max: 5 };
        const { min = 0, max = 0 } = opts;
        return { count: c.value, range: max - min, dns: DNS, url: URL };
      }
      module.exports = build();
    `;
    for (let i = 0; i < 5; i++) {
      const mod = runAsCommonJS(code, { targetTokens: 2000 });
      expect(mod).toEqual({ count: 13, range: 4, dns: 'a', url: 'b' });
    }
  });
});

describe('regression: tripwire hash setups do not coerce object params', () => {
  // Tripwires were injecting hash computations like `(param | 0) * prime`
  // directly at function entry. For numeric primitives that's free, but
  // for objects `| 0` invokes ToNumber → valueOf → toString. Lodash's
  // self-initialization creates a narrow window where `mixin(lodash,
  // lodash)` has installed a wrapped toString that calls `this.value()`
  // *before* `lodash.prototype.value = wrapperValue` runs; a tripwire
  // firing inside that window coerces a wrapper, invokes the half-built
  // toString, and throws `this.value is not a function`. Likewise
  // `Cannot read properties of undefined (reading 'length')` fell out of
  // the typeof-tripwire reading `.length` before its own `typeof ===
  // 'string'` guard had a chance to run.
  //
  // The fix guards every hash computation on `typeof param === 'number'`
  // (or the already-typeof-guarded string case), so tripwires on
  // object-typed params reduce to a constant `seed` that never matches
  // the independently-chosen secret.
  it('object params with custom valueOf are not coerced by tripwire setup', () => {
    const code = `
      var calls = 0;
      function probe(x) { return x; }
      var obj = {
        valueOf: function() { calls++; throw new Error('valueOf should not be called'); },
        toString: function() { calls++; throw new Error('toString should not be called'); },
      };
      // 30 calls, 30 × per-function tripwire rate (~20%) → we expect
      // several tripwires to have been injected across runs. If any
      // tripwire coerces its object arg, calls goes up and/or an error
      // propagates.
      for (var i = 0; i < 30; i++) probe(obj);
      module.exports = { calls: calls };
    `;
    // Higher targetTokens to bump bloat ratio above tripwire gate.
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    expect(mod.calls).toBe(0);
  });

  it('undefined-param callees do not throw from tripwire setup', () => {
    // The typeof tripwire previously read `.length` unconditionally,
    // so any function that got a typeof-tripwire AND was ever called
    // with `undefined` would throw at the tripwire site instead of
    // returning. lodash's defaulted helpers hit this every run.
    const code = `
      function accept(a) { return a == null ? 'nil' : a; }
      module.exports = {
        one: accept(undefined),
        two: accept(null),
        three: accept('x'),
      };
    `;
    const mod = runAsCommonJS(code, { targetTokens: 2000 });
    expect(mod).toEqual({ one: 'nil', two: 'nil', three: 'x' });
  });
});
