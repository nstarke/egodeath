import { obfuscate, obfuscateMultiple } from '../obfuscator';
import {
  makeDispatchPlan,
  normalizeFileExports,
  pickSlotForFile,
  DEFAULT_DISPATCH_SIZE,
} from '../transforms/exportNormalization';

/**
 * API surface normalization: the pass rewrites each file in a
 * batch so its `module.exports` boundary has a shared, fixed-shape
 * dispatch object. Coverage matrix:
 *
 *   - transform in isolation (makeDispatchPlan / normalizeFileExports /
 *     pickSlotForFile): contracts over shape, key identity across
 *     plans, ESM skip, named-export drop, no-op on unparseable.
 *   - end-to-end via obfuscateMultiple with {normalizeExports: true}:
 *     dispatch survives obfuscation, the real default export is
 *     reachable via exactly one slot, dummy slots are callable and
 *     return 0, key set is shared across files.
 */

const OPTS_FAST = { targetTokens: 2000 };
const OPTS_NORMALIZED = { targetTokens: 2000, normalizeExports: true };

function retry<T>(fn: () => T, attempts = 5): T {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return fn(); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function runAsCommonJS(code: string): any {
  const mod: any = { exports: {} };
  const fn = new Function('module', 'exports', code);
  fn(mod, mod.exports);
  return mod.exports;
}

beforeAll(() => {
  (global as any).setInterval = () => 0;
});

describe('makeDispatchPlan', () => {
  it('produces the requested number of unique keys', () => {
    const plan = makeDispatchPlan(12);
    expect(plan.keys).toHaveLength(12);
    expect(new Set(plan.keys).size).toBe(12);
  });

  it('uses a reserved prefix so keys are unlikely to collide with user source', () => {
    const plan = makeDispatchPlan(8);
    for (const k of plan.keys) {
      expect(k.startsWith('_ed')).toBe(true);
    }
  });

  it('default size is stable so batches share a common contract', () => {
    const plan = makeDispatchPlan();
    expect(plan.keys).toHaveLength(DEFAULT_DISPATCH_SIZE);
  });
});

describe('normalizeFileExports (unit)', () => {
  it('captures module.exports assignment and emits dispatch at end of file', () => {
    const plan = makeDispatchPlan(4);
    const out = normalizeFileExports('module.exports = function(x) { return x + 1; };', plan, 2);
    // Dispatch assignment lives at the end.
    expect(out).toMatch(/module\.exports\s*=\s*\{[\s\S]*\}/);
    // Every dispatch key appears.
    for (const k of plan.keys) expect(out).toContain(k);
    // The real default got captured, and is referenced in the dispatch.
    expect(out).toContain('_egdDefault_');
    // Exactly one reference from dispatch props — one slot holds the real export.
    // Counting is a rough but effective check; the capture var is
    // *declared* once and *referenced* once (at slotForDefault).
    const captureName = (out.match(/_egdDefault_[a-f0-9]+/) || [])[0];
    expect(captureName).toBeDefined();
    const refCount = (out.match(new RegExp(captureName!, 'g')) || []).length;
    // Declaration + one dispatch-slot reference.
    expect(refCount).toBe(2);
  });

  it('keeps script behavior intact (bare script still runs, dispatch still appended)', () => {
    // Bare script: no exports. Normalization should still append a
    // dispatch — every file in a batch must have identical surface
    // shape whether or not it originally exported anything.
    const plan = makeDispatchPlan(3);
    const out = normalizeFileExports('var a = 1; var b = a + 2;', plan, 1);
    expect(out).toMatch(/module\.exports\s*=\s*\{/);
    for (const k of plan.keys) expect(out).toContain(k);
    // No capture var is emitted because there was no real default to
    // capture — every slot holds the shared dummy.
    expect(out).not.toContain('_egdDefault_');
    // Executing it in a CJS shim produces the dispatch object, with
    // every slot callable and every callable returning 0.
    const dispatch = runAsCommonJS(out);
    for (const k of plan.keys) {
      expect(typeof dispatch[k]).toBe('function');
      expect(dispatch[k]()).toBe(0);
    }
  });

  it('drops exports.NAME and module.exports.NAME top-level writes', () => {
    // Both forms are top-level named-export writes that don't survive
    // v1 normalization (the final dispatch overrides module.exports,
    // so those earlier writes are discarded).
    const plan = makeDispatchPlan(3);
    const out = normalizeFileExports(
      'var helper = function(){return 7;}; exports.helper = helper; module.exports.also = helper;',
      plan,
      0,
    );
    // The rewritten body must NOT contain the named-export writes.
    expect(out).not.toMatch(/exports\.helper\s*=/);
    expect(out).not.toMatch(/module\.exports\.also\s*=/);
  });

  it('preserves ES modules unchanged', () => {
    // Mixing `import`/`export` with `module.exports = ...` is a
    // SyntaxError; normalization would produce broken output. The
    // transform must detect ESM and bail.
    const esm = 'import foo from "bar";\nexport default function(){return 1;};';
    const plan = makeDispatchPlan(3);
    const out = normalizeFileExports(esm, plan, 0);
    expect(out).toBe(esm);
  });

  it('returns the source unchanged when parsing fails', () => {
    const plan = makeDispatchPlan(3);
    const junk = '%%% not valid js %%%';
    expect(normalizeFileExports(junk, plan, 0)).toBe(junk);
  });

  it('two files with different slot assignments have identical key sequences', () => {
    const plan = makeDispatchPlan(6);
    const a = normalizeFileExports('module.exports = function(){return "A";};', plan, 2);
    const b = normalizeFileExports('module.exports = function(){return "B";};', plan, 5);
    // The dispatch object's key LIST (order-preserved) is identical
    // at the source level across files — the slot used for the real
    // export is the only structural difference.
    const extractKeys = (src: string) => {
      const m = src.match(/module\.exports\s*=\s*\{([\s\S]*)\}\s*;?\s*$/);
      if (!m) return [];
      // The dispatch block is the final object literal. Property
      // keys look like `_edXXXXXX:` so we pull them directly.
      return (m[1].match(/_ed[a-f0-9]{6}/g) || []).slice(0, plan.keys.length);
    };
    const keysA = extractKeys(a);
    const keysB = extractKeys(b);
    expect(keysA).toEqual(plan.keys);
    expect(keysB).toEqual(plan.keys);
  });
});

describe('pickSlotForFile', () => {
  it('different file indices land on different slots within a batch', () => {
    const plan = makeDispatchPlan(8);
    // Running pickSlotForFile for a whole batch yields a set of slot
    // choices whose spread is the point — every file in a 2-file
    // batch must pick a DIFFERENT slot, else the "move the real
    // export around" signal disappears.
    const slot0 = pickSlotForFile(plan, 0);
    const slot1 = pickSlotForFile(plan, 1);
    expect(slot0).not.toBe(slot1);
  });

  it('slots stay within bounds', () => {
    const plan = makeDispatchPlan(5);
    for (let i = 0; i < 50; i++) {
      const s = pickSlotForFile(plan, i);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(plan.keys.length);
    }
  });
});

describe('obfuscateMultiple with normalizeExports', () => {
  it('each output exports a dispatch object with every key reachable', () => {
    const files = [
      { filename: 'a.js', code: 'module.exports = function addA(x) { return x + 7; };' },
      { filename: 'b.js', code: 'module.exports = function mulB(y) { return y * 11; };' },
    ];
    const results = retry(() => obfuscateMultiple(files, OPTS_NORMALIZED));
    expect(results).toHaveLength(2);

    const dispatchA = runAsCommonJS(results[0].code);
    const dispatchB = runAsCommonJS(results[1].code);

    // Dispatch objects have the same number of keys.
    const keysA = Object.keys(dispatchA);
    const keysB = Object.keys(dispatchB);
    expect(keysA).toHaveLength(DEFAULT_DISPATCH_SIZE);
    expect(keysB).toHaveLength(DEFAULT_DISPATCH_SIZE);
    // Dispatch keys are shared across files — byte-identical surface.
    expect(keysA.sort()).toEqual(keysB.sort());
  });

  it('the real default export is reachable from exactly one slot', () => {
    const files = [
      { filename: 'a.js', code: 'module.exports = function addA(x) { return x + 7; };' },
      { filename: 'b.js', code: 'module.exports = function mulB(y) { return y * 11; };' },
    ];
    const results = retry(() => obfuscateMultiple(files, OPTS_NORMALIZED));
    const dispatchA = runAsCommonJS(results[0].code);
    const dispatchB = runAsCommonJS(results[1].code);

    // One slot in A returns 10 (addA(3)); every other slot returns
    // the dummy value 0. Same for B with mulB(3) === 33.
    const aHits = Object.keys(dispatchA).filter((k) => {
      try { return dispatchA[k](3) === 10; } catch { return false; }
    });
    const bHits = Object.keys(dispatchB).filter((k) => {
      try { return dispatchB[k](3) === 33; } catch { return false; }
    });
    expect(aHits).toHaveLength(1);
    expect(bHits).toHaveLength(1);
  });

  it('every non-default slot is a callable dummy returning 0', () => {
    // The "byte-identical surface" guarantee requires that dummy
    // slots be shape-uniform: same type (function), same arity, same
    // return value. A dummy that throws would signal "this slot
    // isn't the real one" to a reader who probes slots at runtime.
    const files = [
      { filename: 'a.js', code: 'module.exports = function (x) { return x + 1; };' },
      { filename: 'b.js', code: 'module.exports = function (x) { return x * 2; };' },
    ];
    const results = retry(() => obfuscateMultiple(files, OPTS_NORMALIZED));
    for (const r of results) {
      const dispatch = runAsCommonJS(r.code);
      const zeros: number[] = [];
      for (const k of Object.keys(dispatch)) {
        // Only count slots that return 0 on a no-arg call — the real
        // export slot returns something else and is excluded by design.
        try {
          const v = dispatch[k]();
          if (v === 0) zeros.push(0);
        } catch {
          // no-op — a throwing slot would be caught here; the
          // assertion below ensures the right count of non-throwers.
        }
      }
      // DEFAULT_DISPATCH_SIZE - 1 dummy slots return 0. The +1 is
      // the real default, which returns a non-zero value on
      // `fn()` (addA(undefined) = NaN is not 0; mulB(undefined) = NaN
      // is not 0).
      expect(zeros).toHaveLength(DEFAULT_DISPATCH_SIZE - 1);
    }
  });

  it('bare script inputs still get a normalized dispatch', () => {
    // The detection test's inputs are mostly bare scripts with no
    // exports. After normalization they should still end with a
    // dispatch block whose shape matches any other file in the batch.
    const files = [
      { filename: 'a.js', code: 'var a = 1; var b = a + 2; var c = b * 3;' },
      { filename: 'b.js', code: 'var x = 5; var y = 10; var z = x + y;' },
    ];
    const results = retry(() => obfuscateMultiple(files, OPTS_NORMALIZED));
    for (const r of results) {
      const dispatch = runAsCommonJS(r.code);
      const keys = Object.keys(dispatch);
      expect(keys).toHaveLength(DEFAULT_DISPATCH_SIZE);
      // Every slot is a dummy (returns 0) — no real default to slot in.
      for (const k of keys) {
        expect(typeof dispatch[k]).toBe('function');
        expect(dispatch[k]()).toBe(0);
      }
    }
  });

  it('off by default — output keeps original export shape', () => {
    const files = [
      { filename: 'a.js', code: 'module.exports = function addA(x) { return x + 7; };' },
    ];
    const results = retry(() => obfuscateMultiple(files, OPTS_FAST));
    const exported = runAsCommonJS(results[0].code);
    // Default-off: the original `function` export is preserved, not
    // wrapped in a dispatch object.
    expect(typeof exported).toBe('function');
    expect(exported(3)).toBe(10);
  });
});

describe('obfuscate (single-file) ignores normalizeExports', () => {
  it('single-file obfuscate is a no-op for the flag (no cross-file coordination)', () => {
    // The option only makes sense with a shared key set, which
    // obfuscate() alone can't produce. Verify it doesn't break the
    // single-file path.
    const code = 'module.exports = function(x) { return x * 2; };';
    const out = retry(() => obfuscate(code, OPTS_NORMALIZED));
    const fn = runAsCommonJS(out);
    expect(typeof fn).toBe('function');
    expect(fn(21)).toBe(42);
  });
});
