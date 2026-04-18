#!/usr/bin/env node
// Child-process runner for the obfuscation performance benchmark.
//
// Invoked as:
//   node benchmark-runner.js <bundlePath> <packageName> <iterations> <warmup>
//
// Prints a single JSON line to stdout and exits. Writes are done via
// process.stdout.write (which the obfuscated bundle cannot stub out the way
// it stubs console.*), so this runner stays observable even after the
// bundle's console methods have been replaced with no-ops.

'use strict';

const path = require('path');

// Capture stdout.write up-front — the obfuscated bundle replaces console.*
// with no-ops on require, but process.stdout is untouched by the obfuscator.
const rawWrite = process.stdout.write.bind(process.stdout);

function emit(result) {
  rawWrite(JSON.stringify(result) + '\n');
}

function die(err) {
  emit({ error: err && err.stack ? err.stack : String(err) });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Workload definitions.
//
// Each workload returns { setup, step } where:
//   setup(mod) -> state    (called once, not timed)
//   step(mod, state, i)    (called in a tight loop, timed)
//
// step bodies intentionally touch the public API paths that real consumers
// use — e.g. lodash's sortBy/chunk/groupBy, semver's valid/gt/satisfies.
// ---------------------------------------------------------------------------

const workloads = {
  uuid: {
    description: 'generate v4 UUIDs',
    defaultIterations: 50000,
    setup: () => ({}),
    step: (mod) => {
      // uuid's main entry exposes v4 as a named export.
      const v4 = mod.v4 || (mod.default && mod.default.v4);
      if (!v4) throw new Error('uuid.v4 not found on module export');
      return v4();
    },
  },

  semver: {
    description: 'validate + compare version strings',
    defaultIterations: 10000,
    setup: () => ({
      versions: [
        '1.0.0', '1.0.1', '1.2.3', '2.0.0-beta.1',
        '1.2.3-alpha+build.123', '0.9.0', '3.1.4',
        '1.10.0', '1.2.0', '2.0.0',
      ],
      ranges: ['>=1.0.0', '^1.2.0', '~1.2.3', '>=1.0.0 <2.0.0'],
    }),
    step: (mod, state, i) => {
      const v = state.versions;
      const r = state.ranges;
      const a = v[i % v.length];
      const b = v[(i + 1) % v.length];
      mod.valid(a);
      mod.gt(a, b);
      mod.satisfies(a, r[i % r.length]);
      return a;
    },
  },

  minimist: {
    description: 'parse argv arrays',
    defaultIterations: 50000,
    setup: () => ({
      argvs: [
        ['--foo', 'bar', '-x', '3', 'positional'],
        ['-abc', '--count=5', '--', '--raw'],
        ['--name', 'Alice', '--age', '30', '--admin'],
        ['-v', '-v', '-v', 'input.txt', 'output.txt'],
        ['--no-color', '--paths', 'a,b,c'],
      ],
    }),
    step: (mod, state, i) => {
      const parse = typeof mod === 'function' ? mod : mod.default;
      return parse(state.argvs[i % state.argvs.length]);
    },
  },

  lodash: {
    description: 'sortBy/chunk/groupBy/cloneDeep',
    defaultIterations: 200,
    setup: () => {
      const arr = [];
      for (let i = 0; i < 500; i++) {
        arr.push({
          id: i,
          value: (i * 2654435761) >>> 0,
          category: 'cat-' + (i % 7),
          nested: { a: i, b: { c: i * 2 } },
        });
      }
      return { arr };
    },
    step: (mod, state) => {
      const _ = mod.default || mod;
      const sorted = _.sortBy(state.arr, 'value');
      const chunks = _.chunk(sorted, 16);
      const grouped = _.groupBy(state.arr, 'category');
      const cloned = _.cloneDeep(chunks[0]);
      return cloned.length + Object.keys(grouped).length;
    },
  },
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const [bundlePathArg, pkg, iterationsArg, warmupArg] = process.argv.slice(2);
  if (!bundlePathArg || !pkg) {
    die('usage: benchmark-runner.js <bundlePath> <packageName> [iterations] [warmup]');
  }

  const workload = workloads[pkg];
  if (!workload) die('no workload defined for package: ' + pkg);

  const bundlePath = path.resolve(bundlePathArg);
  const iterations = Number(iterationsArg) || workload.defaultIterations;
  const warmup = Number(warmupArg) || Math.max(10, Math.floor(iterations / 20));

  let mod;
  let loadNs;
  try {
    const loadStart = process.hrtime.bigint();
    mod = require(bundlePath);
    loadNs = Number(process.hrtime.bigint() - loadStart);
  } catch (e) {
    die('require failed: ' + (e && e.stack ? e.stack : e));
    return;
  }

  let state;
  try {
    state = workload.setup(mod);
  } catch (e) {
    die('workload setup failed: ' + (e && e.stack ? e.stack : e));
    return;
  }

  // Warmup — let V8 JIT steady-state before timing.
  try {
    for (let i = 0; i < warmup; i++) workload.step(mod, state, i);
  } catch (e) {
    die('workload warmup failed: ' + (e && e.stack ? e.stack : e));
    return;
  }

  // Timed loop.
  let checksum = 0;
  let runNs;
  try {
    const runStart = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      const result = workload.step(mod, state, i);
      // Force the JIT to keep the result live.
      if (typeof result === 'string') checksum ^= result.length;
      else if (typeof result === 'number') checksum ^= result | 0;
      else if (result && typeof result === 'object') checksum ^= 1;
    }
    runNs = Number(process.hrtime.bigint() - runStart);
  } catch (e) {
    die('workload run failed: ' + (e && e.stack ? e.stack : e));
    return;
  }

  emit({
    package: pkg,
    bundle: bundlePath,
    iterations,
    warmup,
    loadNs,
    runNs,
    checksum,
  });

  // Force exit — the obfuscated bundle installs setInterval anti-debug
  // traps that keep the event loop alive forever otherwise.
  process.exit(0);
}

main();
