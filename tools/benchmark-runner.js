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

  chalk: {
    description: 'build styled terminal strings',
    defaultIterations: 10000,
    setup: (mod) => {
      const chalk = mod.default || mod;
      return { chalk };
    },
    step: (mod, state, i) => {
      const c = state.chalk;
      // Touch the main styling paths: direct colors, modifiers, chaining,
      // and the template-tag-compatible call form.
      const a = c.red('error');
      const b = c.bold.blue('info');
      const d = c.green.underline('ok ' + i);
      const e = c.bgYellow.black('warn');
      return a.length + b.length + d.length + e.length;
    },
  },

  ms: {
    description: 'parse + format time strings',
    defaultIterations: 50000,
    setup: () => ({
      strings: [
        '2 days', '1h', '30 minutes', '5s', '100ms',
        '1.5 hours', '2 weeks', '1 year', '45 min', '10d',
      ],
      numbers: [
        60_000, 3_600_000, 86_400_000, 604_800_000,
        1_500, 500, 45_000, 1_000, 2_500_000, 10_000,
      ],
    }),
    step: (mod, state, i) => {
      const ms = mod.default || mod;
      const s = state.strings[i % state.strings.length];
      const n = state.numbers[i % state.numbers.length];
      const parsed = ms(s);
      const formatted = ms(n);
      return (parsed | 0) ^ formatted.length;
    },
  },

  qs: {
    description: 'parse + stringify query strings',
    defaultIterations: 10000,
    setup: () => ({
      queries: [
        'a=1&b=2&c=3',
        'arr[]=1&arr[]=2&arr[]=3',
        'nested[a]=1&nested[b][c]=2',
        'foo=bar&baz=qux&quux=corge',
        'q=hello%20world&filter=active&page=2&sort=name',
      ],
      objects: [
        { a: 1, b: 2, c: 3 },
        { arr: [1, 2, 3, 4] },
        { nested: { a: 1, b: { c: 2, d: 3 } } },
        { tags: ['js', 'ts', 'node'], page: 5, sort: 'asc' },
        { q: 'hello world', filters: { status: 'active', role: 'admin' } },
      ],
    }),
    step: (mod, state, i) => {
      const q = mod.default || mod;
      const parsed = q.parse(state.queries[i % state.queries.length]);
      const stringified = q.stringify(state.objects[i % state.objects.length]);
      return Object.keys(parsed).length + stringified.length;
    },
  },

  classnames: {
    description: 'compose conditional className strings',
    defaultIterations: 100000,
    setup: () => ({
      variants: [
        ['foo', 'bar', 'baz'],
        ['btn', { 'btn-primary': true, 'btn-disabled': false }],
        [{ active: true }, { visible: false }, 'card'],
        ['a', 'b', null, undefined, false, 'c', 0, { d: 1 }],
        [['nested', 'array'], 'x', { y: 1, z: 0 }],
      ],
    }),
    step: (mod, state, i) => {
      const cn = mod.default || mod;
      const args = state.variants[i % state.variants.length];
      return cn(...args);
    },
  },

  moment: {
    description: 'parse + format + arithmetic on dates',
    defaultIterations: 2000,
    setup: (mod) => {
      const moment = mod.default || mod;
      return {
        moment,
        dates: [
          '2023-01-01', '2024-06-15T12:30:00Z', '2020-12-31',
          '1999-01-01', '2025-04-18T09:15:30',
        ],
        formats: [
          'YYYY-MM-DD', 'dddd, MMMM Do YYYY', 'MMM D, YYYY [at] h:mm A',
          'YYYY-MM-DDTHH:mm:ssZ', 'Q [quarter of] YYYY',
        ],
      };
    },
    step: (mod, state, i) => {
      const m = state.moment;
      const d = state.dates[i % state.dates.length];
      const f = state.formats[i % state.formats.length];
      const parsed = m(d);
      parsed.format(f);
      const later = parsed.clone().add(5, 'days').subtract(2, 'hours');
      later.isBefore(parsed.clone().add(1, 'year'));
      return later.diff(parsed, 'hours');
    },
  },

  axios: {
    description: 'create instances + register/eject interceptors',
    // axios is fundamentally an HTTP client; benchmarking real requests
    // would depend on a network, so instead we exercise the parts that
    // run client-side: factory construction, config merging, and
    // interceptor wiring. These dominate the synchronous cost before
    // the network I/O begins.
    defaultIterations: 500,
    setup: (mod) => {
      const axios = mod.default || mod;
      return { axios };
    },
    step: (mod, state, i) => {
      const ax = state.axios;
      const inst = ax.create({
        baseURL: 'https://example.invalid/api/' + (i % 10),
        timeout: 1000 + (i % 100),
        headers: {
          'X-Bench': String(i),
          'User-Agent': 'egodeath-bench/1.0',
          'Accept': 'application/json',
        },
        params: { page: i % 50, limit: 20 },
      });
      // Register and eject a few interceptors on each side to exercise
      // axios's InterceptorManager list management.
      const h1 = inst.interceptors.request.use((cfg) => cfg);
      const h2 = inst.interceptors.request.use((cfg) => cfg);
      const h3 = inst.interceptors.response.use((r) => r);
      inst.interceptors.request.eject(h1);
      inst.interceptors.request.eject(h2);
      inst.interceptors.response.eject(h3);
      // Force defaults merge to run by creating a second instance off
      // this one's defaults.
      const inner = inst.create ? inst.create({ timeout: 2000 }) : inst;
      return (inner.defaults ? Object.keys(inner.defaults).length : 0) + i;
    },
  },

  express: {
    description: 'build an app + router, exercise handler registration',
    // Similar to axios: running a real HTTP server would be
    // environment-dependent, so we exercise the synchronous setup
    // paths — app creation, middleware registration, route matching
    // via the internal router — which is where express spends most
    // of the per-request cost.
    defaultIterations: 500,
    setup: (mod) => {
      const express = mod.default || mod;
      return { express };
    },
    step: (mod, state, i) => {
      const express = state.express;
      const app = express();
      app.use((req, res, next) => next());
      app.use('/api', (req, res, next) => next());
      app.get('/users/:id', (req, res) => res.json({ id: req.params.id }));
      app.post('/users', (req, res) => res.status(201).end());
      app.put('/users/:id', (req, res) => res.json(req.body));
      app.delete('/users/:id', (req, res) => res.status(204).end());
      app.get('/items/:category/:id', (req, res) => res.json(req.params));

      // Exercise the router's internal handle() path without a real
      // request: build a minimal req/res pair and let express route it.
      const router = app._router || app.router;
      let matched = 0;
      const req = {
        method: 'GET',
        url: '/users/' + (i % 100),
        headers: {},
        originalUrl: '/users/' + (i % 100),
      };
      const res = {
        json: () => { matched++; },
        status: () => res,
        end: () => { matched++; },
        setHeader: () => {},
      };
      try {
        if (router && typeof router.handle === 'function') {
          router.handle(req, res, () => {});
        }
      } catch (_) { /* some express internals poke at req fields we don't set */ }
      return matched + i;
    },
  },

  commander: {
    description: 'parse CLI argv through a small program',
    defaultIterations: 2000,
    setup: (mod) => {
      const { Command } = mod;
      // Build a fresh program fresh each iteration is expensive; reuse
      // across iterations but parse different argvs.
      return {
        Command,
        argvs: [
          ['node', 'prog', '--name', 'Alice', '--count', '3', 'input.txt'],
          ['node', 'prog', '-v', '-v', 'file.json'],
          ['node', 'prog', '--dry-run', '--output', '/tmp/x'],
          ['node', 'prog', '--tag', 'a', '--tag', 'b', '--tag', 'c'],
          ['node', 'prog', '--no-color', 'build'],
        ],
      };
    },
    step: (mod, state, i) => {
      const program = new state.Command();
      program
        .name('bench')
        .exitOverride() // don't call process.exit on parse errors
        .option('-v, --verbose', 'verbose output', 0)
        .option('-n, --name <name>', 'the name')
        .option('-c, --count <n>', 'how many', (v) => parseInt(v, 10), 1)
        .option('-t, --tag <tag...>', 'tags (repeatable)')
        .option('-d, --dry-run', 'do not actually do it')
        .option('-o, --output <path>', 'output path')
        .option('--no-color', 'disable color')
        .argument('[file]', 'input file');
      try {
        program.parse(state.argvs[i % state.argvs.length]);
      } catch (_) { /* exitOverride throws on --help/--version; ignore */ }
      const opts = program.opts();
      return Object.keys(opts).length;
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
