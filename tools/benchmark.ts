#!/usr/bin/env ts-node
// Performance benchmark for the egodeath obfuscator.
//
// For each package under test, this tool:
//   1. Installs the package locally (into .benchmark/)
//   2. Webpack-bundles its main entry into a single CommonJS file
//   3. Obfuscates the bundle via src/obfuscator.ts
//   4. Spawns a child node process to time each bundle (original + obfuscated):
//        - require() load time
//        - a realistic workload loop
//   5. Reports per-package load-time and run-time slowdown ratios.
//
// Workloads live in tools/benchmark-runner.js. Bundles and reports are
// written under .benchmark/ at the project root.
//
// Usage:
//   npm run benchmark
//   npm run benchmark -- uuid semver
//   npm run benchmark -- --iterations 10000 --target-tokens 250000 uuid
//   npm run benchmark -- --runs 3 lodash

import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawnSync } from 'child_process';
import { obfuscate } from '../src/obfuscator';

// Packages the benchmark knows how to exercise. Workload definitions for
// each live in benchmark-runner.js — keep these two lists in sync.
//
// DEFAULT_PACKAGES are small-to-medium libraries that obfuscate quickly
// (roughly < 1s each at the default target-tokens), so `npm run benchmark`
// with no args returns in a reasonable time. Heavier packages like lodash
// and moment can be requested by name or via --all.
const DEFAULT_PACKAGES = [
  'uuid', 'semver', 'minimist', 'chalk', 'ms', 'qs', 'classnames',
];
const ALL_PACKAGES = [
  'uuid', 'semver', 'minimist', 'lodash',
  'chalk', 'ms', 'qs', 'classnames', 'moment', 'commander',
  'axios', 'express',
  // UI frameworks. Bundled headless and exercised via their
  // DOM-agnostic APIs (createElement trees, reactivity graphs,
  // module/DI registration).
  'react', 'vue', 'angular',
];

interface CliOptions {
  packages: string[];
  iterations?: number;
  warmup?: number;
  runs: number;
  targetTokens: number;
  skipObfuscate: boolean;
  skipInstall: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    packages: [],
    runs: 3,
    targetTokens: 500_000,
    skipObfuscate: false,
    skipInstall: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--iterations' || a === '-n') opts.iterations = Number(argv[++i]);
    else if (a === '--warmup') opts.warmup = Number(argv[++i]);
    else if (a === '--runs') opts.runs = Number(argv[++i]);
    else if (a === '--target-tokens') opts.targetTokens = Number(argv[++i]);
    else if (a === '--skip-obfuscate') opts.skipObfuscate = true;
    else if (a === '--skip-install') opts.skipInstall = true;
    else if (a === '--all') opts.packages.push(...ALL_PACKAGES);
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else if (a.startsWith('--')) {
      console.error(`Unknown flag: ${a}`);
      printUsage();
      process.exit(2);
    } else {
      opts.packages.push(a);
    }
  }

  if (opts.packages.length === 0) opts.packages = DEFAULT_PACKAGES.slice();
  for (const p of opts.packages) {
    if (!ALL_PACKAGES.includes(p)) {
      console.error(`No workload defined for package "${p}".`);
      console.error(`Available: ${ALL_PACKAGES.join(', ')}`);
      process.exit(2);
    }
  }
  return opts;
}

function printUsage(): void {
  console.log(`Usage: npm run benchmark -- [packages...] [options]

Packages (choose any subset, default: ${DEFAULT_PACKAGES.join(', ')}):
  ${ALL_PACKAGES.join(', ')}

Options:
  --all                    Run every package (${ALL_PACKAGES.join(', ')})
  --iterations, -n <n>     Override workload iteration count
  --warmup <n>             Override warmup iteration count
  --runs <n>               Repeat each measurement N times (default: 3)
  --target-tokens <n>      Obfuscation bloat budget (default: 500000)
  --skip-install           Reuse existing .benchmark/node_modules
  --skip-obfuscate         Reuse existing obfuscated bundles in .benchmark/
  --help, -h               Show this help
`);
}

// ---------------------------------------------------------------------------
// Bundling
// ---------------------------------------------------------------------------

/**
 * Resolve the main entry a caller would get from `require('<pkg>')`, relative
 * to the given workspace. Uses Node's own resolver so package.json "main",
 * "exports", fallback index.js etc. all work.
 */
function resolvePackageEntry(workspaceDir: string, pkg: string): string {
  const resolved = require.resolve(pkg, { paths: [workspaceDir] });
  return resolved;
}

/**
 * Run webpack in `workspaceDir` to bundle `entryPath` into a single commonjs2
 * file at `outputPath`. Mirrors the config used by tools/obfuscate-package.ts.
 */
function webpackBundle(
  projectRoot: string,
  workspaceDir: string,
  entryPath: string,
  outputPath: string
): void {
  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });

  const configPath = path.join(workspaceDir, '_webpack.bench.config.js');
  fs.writeFileSync(configPath, `module.exports = {
  mode: "none",
  target: "node",
  entry: ${JSON.stringify(entryPath)},
  output: {
    path: ${JSON.stringify(outputDir)},
    filename: ${JSON.stringify(path.basename(outputPath))},
    libraryTarget: "commonjs2"
  },
  resolve: {
    extensions: [".js", ".mjs", ".cjs", ".json", ".node"],
    mainFields: ["main", "module"]
  },
  module: {
    rules: [{ test: /\\.mjs$/, type: "javascript/auto" }]
  },
  externals: [
    /\\.node$/,
    "bufferutil",
    "utf-8-validate"
  ]
};
`);

  const webpackBin = path.resolve(projectRoot, 'node_modules', '.bin', 'webpack');
  execSync(`"${webpackBin}" --config "${configPath}"`, {
    cwd: workspaceDir,
    stdio: 'pipe',
    timeout: 120_000,
  });
}

// ---------------------------------------------------------------------------
// Workspace setup (.benchmark/)
// ---------------------------------------------------------------------------

function ensureWorkspace(
  benchmarkDir: string,
  packages: string[],
  skipInstall: boolean
): void {
  fs.mkdirSync(benchmarkDir, { recursive: true });

  const pkgJsonPath = path.join(benchmarkDir, 'package.json');
  const deps: Record<string, string> = {};
  for (const p of packages) deps[p] = 'latest';
  // angular@1.x self-installs onto window at load time and reads DOM
  // interfaces (Node, Element, HTMLElement, anchor.hostname) while
  // building its jqLite helpers. A hand-rolled shim is fine for the
  // interface constructors but doesn't parse URLs — jsdom is the
  // cheapest way to get a real URL parser + full DOM shape.
  if (packages.includes('angular')) deps['jsdom'] = 'latest';

  const existing = fs.existsSync(pkgJsonPath)
    ? JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))
    : {};
  const merged = { ...(existing.dependencies || {}), ...deps };
  fs.writeFileSync(
    pkgJsonPath,
    JSON.stringify(
      { name: 'egodeath-benchmark', private: true, dependencies: merged },
      null,
      2
    ) + '\n'
  );

  const nodeModulesDir = path.join(benchmarkDir, 'node_modules');
  const allInstalled = packages.every((p) =>
    fs.existsSync(path.join(nodeModulesDir, p, 'package.json'))
  );

  if (allInstalled && skipInstall) {
    console.log('  (reusing existing .benchmark/node_modules)');
    return;
  }

  if (!allInstalled || !skipInstall) {
    console.log(`  Installing ${packages.length} package(s) into .benchmark/...`);
    execSync('npm install --ignore-scripts --no-audit --no-fund --loglevel=error', {
      cwd: benchmarkDir,
      stdio: 'inherit',
      timeout: 300_000,
    });
  }
}

// ---------------------------------------------------------------------------
// Obfuscation
// ---------------------------------------------------------------------------

/**
 * Browser-global shim inlined into the smoke-test child's `-e` script.
 * Must match installGlobalsFor() in benchmark-runner.js. Kept as a
 * single literal string so the child doesn't need file I/O before
 * loading the bundle.
 *
 * angular@1.x's entry is a self-installing IIFE that reads
 * window/document unconditionally — requiring the bundle in a plain
 * Node process throws `window is not defined` before any obfuscator
 * code has a chance to run. The shim gives angular just enough of a
 * "browser" to finish bootstrapping; the obfuscated code we actually
 * want to test then gets a chance to execute and surface real failures.
 */
/**
 * Shim loaded into the smoke-test child for packages that need a
 * browser-ish global environment. Mirrors installGlobalsFor() in
 * benchmark-runner.js — kept in sync so any smoke-test failures
 * reflect real bundle issues, not divergent shim behaviour.
 *
 * The shim prefers jsdom (installed by ensureWorkspace when angular
 * is in the package set) because angular's bootstrap parses URLs via
 * `document.createElement("a").hostname`, which a hand-rolled stub
 * can't provide. It falls back to minimal prototype stubs when jsdom
 * isn't available.
 */
/**
 * angular@1.x's webpack bundle has a cross-module free-variable
 * reference that the obfuscator mishandles:
 *
 *   // module 0 (angular/index.js)
 *   module.exports = angular;         // bare identifier, expected global
 *
 *   // module 1 (angular/angular.js IIFE)
 *   var angular = window.angular || (window.angular = {});
 *
 * Both `angular` identifiers get catalogued under a single rename by
 * firstPass (the obfuscator renames by string, not scope), so after
 * obfuscation module 0's reference points at module 1's local —
 * which isn't visible outside its IIFE and isn't bound on globalThis.
 * Runtime throws `ReferenceError: <renamed> is not defined`.
 *
 * The IIFE's other side effect — `window.angular = angular` — DOES
 * preserve the populated lib object on the DOM window. Property names
 * aren't renamed, so `window.angular` still refers to the lib at
 * runtime. Rewriting module 0's free-var reference to read from
 * `window.angular` makes the bundle self-consistent without touching
 * the obfuscator's renaming logic, which would require proper scope
 * analysis to fix cleanly.
 */
function patchAngularCrossModuleRef(code: string): string {
  const m = code.match(/([^=,;\s()[\]{}<>!&|?:+\-*\/%^~"`]+)=window\.angular\|\|\(window\.angular=\{\}\)/);
  if (!m) return code;
  const renamedName = m[1];
  const escaped = renamedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The renamed identifier is a unicode sequence, so `\b` is unreliable
  // (`\b` only recognises [A-Za-z0-9_] as word chars). Anchor on a
  // trailing punctuator instead — module 0's use site is always
  // followed by `}` (end of the arrow-function body).
  const replaceRe = new RegExp(`module\\.exports\\s*=\\s*${escaped}(?=[\\s,;)}])`, 'g');
  return code.replace(replaceRe, 'module.exports=window.angular');
}

function angularShimScript(benchRoot: string): string {
  const jsdomPath = path.join(benchRoot, 'node_modules', 'jsdom');
  return `
    var JSDOM;
    try { JSDOM = require(${JSON.stringify(jsdomPath)}).JSDOM; } catch (_) { JSDOM = null; }
    if (JSDOM) {
      var dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {url:'http://localhost/'});
      var w = dom.window;
      var forceDefine = function(n, v){ Object.defineProperty(global, n, {value: v, configurable: true, writable: true}); };
      forceDefine('window', w);
      forceDefine('document', w.document);
      forceDefine('navigator', w.navigator);
      forceDefine('location', w.location);
      forceDefine('Node', w.Node);
      forceDefine('Element', w.Element);
      forceDefine('HTMLElement', w.HTMLElement);
      forceDefine('Event', w.Event);
      forceDefine('getComputedStyle', w.getComputedStyle.bind(w));
      Object.defineProperty(global, 'angular', {
        configurable: true,
        get: function(){ return w.angular; },
        set: function(v){ w.angular = v; },
      });
    } else {
      function NodeStub(){} NodeStub.prototype = {nodeName:'STUB', nodeType:1,
        contains:function(){return false;},
        appendChild:function(c){return c;}, removeChild:function(c){return c;}};
      function ElementStub(){} ElementStub.prototype = Object.create(NodeStub.prototype);
      function HTMLElementStub(){} HTMLElementStub.prototype = Object.create(ElementStub.prototype);
      if (!global.window) global.window = global;
      if (!global.Node) global.Node = NodeStub;
      if (!global.Element) global.Element = ElementStub;
      if (!global.HTMLElement) global.HTMLElement = HTMLElementStub;
      if (!global.document) {
        var stub = {nodeName:'STUB', nodeType:1, children:[], childNodes:[],
          setAttribute:function(){}, getAttribute:function(){return null;},
          addEventListener:function(){}, removeEventListener:function(){},
          style:{}, classList:{add:function(){},remove:function(){},toggle:function(){}},
          querySelector:function(){return null;}, querySelectorAll:function(){return [];}};
        global.document = Object.assign({}, stub, {
          documentElement: Object.assign({}, stub, {nodeName:'HTML'}),
          head: Object.assign({}, stub, {nodeName:'HEAD'}),
          body: Object.assign({}, stub, {nodeName:'BODY'}),
          createElement:function(){return Object.assign({}, stub);},
          createTextNode:function(t){return {nodeType:3, nodeValue:String(t)};},
          getElementById:function(){return null;},
          querySelector:function(){return null;}, querySelectorAll:function(){return [];},
          readyState:'complete',
        });
      }
      if (!global.navigator) global.navigator = {userAgent:'Node.js'};
      if (!global.location) global.location = {href:'http://localhost/'};
    }
  `;
}

/**
 * Spawn a tiny child that just `require()`s the bundle. Returns null on
 * success, or the tail of node's stderr on failure. Used to detect the
 * occasional identifier-collision flake in the obfuscator's random namer
 * before we waste time running a full workload against a broken bundle.
 */
function smokeTestBundle(bundlePath: string, pkg?: string, benchRoot?: string): string | null {
  const shim = pkg === 'angular' && benchRoot ? angularShimScript(benchRoot) : '';
  const result = spawnSync(
    'node',
    ['-e', `${shim}require(${JSON.stringify(bundlePath)}); process.exit(0);`],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }
  );
  if (result.status === 0) return null;

  const stderr = (result.stderr || Buffer.from('')).toString();
  // Strip source dumps (very long lines) and keep only the diagnostic
  // lines so the actual error surfaces instead of 60KB of bundle source.
  // Node prints the failing source line in full when the bundle is one
  // big minified line — that swamps the error text, so we filter it out.
  const lines = stderr
    .split('\n')
    .filter((l) => l.trim().length > 0 && l.trim().length < 300);
  return lines.join(' | ').slice(0, 500);
}

/**
 * Obfuscate `origPath` and write the result to `obfPath`. The obfuscator
 * installs `console.* = function(){}` stubs for anti-analysis; we strip those
 * so benchmark bundles don't silently nuke real callers' console output.
 *
 * Retries on random-name collisions: the obfuscator picks identifier names
 * from crypto.randomBytes without an up-front collision check, so occasionally
 * two different source identifiers get the same replacement name and the
 * output fails to parse. Each call uses fresh randomness, so retrying is safe.
 */
function obfuscateBundle(
  origPath: string,
  obfPath: string,
  targetTokens: number,
  maxAttempts = 5,
  pkg?: string,
  benchRoot?: string
): { origBytes: number; obfBytes: number; elapsedMs: number; attempts: number } {
  const orig = fs.readFileSync(origPath, 'utf-8');
  fs.mkdirSync(path.dirname(obfPath), { recursive: true });

  let lastError = '';
  let totalElapsed = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const start = Date.now();
    let out = obfuscate(orig, { targetTokens });
    totalElapsed += Date.now() - start;

    // Strip console stubs — same rationale as tools/obfuscate-package.ts.
    out = out.replace(/console\.\w+\s*=\s*function\s*\(\)\s*\{\s*\}\s*;?\n?/g, '');
    if (pkg === 'angular') out = patchAngularCrossModuleRef(out);
    fs.writeFileSync(obfPath, out, 'utf-8');

    const err = smokeTestBundle(obfPath, pkg, benchRoot);
    if (err === null) {
      return {
        origBytes: Buffer.byteLength(orig, 'utf-8'),
        obfBytes: Buffer.byteLength(out, 'utf-8'),
        elapsedMs: totalElapsed,
        attempts: attempt,
      };
    }
    lastError = err;
    console.log(`    attempt ${attempt}/${maxAttempts} produced unrunnable output; retrying with fresh randomness`);
  }

  throw new Error(
    `obfuscator produced unrunnable output after ${maxAttempts} attempts. Last error: ${lastError}`
  );
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

interface Measurement {
  loadNs: number;
  runNs: number;
  iterations: number;
}

/**
 * Spawn benchmark-runner.js in a clean child process to time one bundle.
 * Retries are the caller's responsibility — this returns a single run.
 */
function measure(
  runnerPath: string,
  bundlePath: string,
  pkg: string,
  iterations?: number,
  warmup?: number
): Measurement {
  const args = [runnerPath, bundlePath, pkg];
  if (iterations !== undefined) args.push(String(iterations));
  if (warmup !== undefined) args.push(String(warmup));

  const result = spawnSync('node', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
  });

  if (result.error) {
    throw new Error(`child process error for ${bundlePath}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || Buffer.from('')).toString();
    const stdout = (result.stdout || Buffer.from('')).toString();
    throw new Error(
      `runner exited ${result.status} for ${bundlePath}:\n  stdout: ${stdout.trim()}\n  stderr: ${stderr.trim()}`
    );
  }

  // The runner prints exactly one JSON line to stdout.
  const stdout = result.stdout.toString().trim();
  const lastLine = stdout.split('\n').filter((l) => l.trim().length > 0).pop();
  if (!lastLine) {
    throw new Error(`runner produced no output for ${bundlePath}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(lastLine);
  } catch (e) {
    throw new Error(
      `runner output was not valid JSON (${bundlePath}): ${lastLine.slice(0, 200)}`
    );
  }
  if (parsed.error) throw new Error(`runner reported error: ${parsed.error}`);
  return {
    loadNs: parsed.loadNs,
    runNs: parsed.runNs,
    iterations: parsed.iterations,
  };
}

/**
 * Return the fastest measurement across `runs` attempts. Min is more stable
 * than mean for micro-benchmarks since outliers only go one direction (slow).
 */
function bestOf(
  runs: number,
  fn: () => Measurement
): { best: Measurement; all: Measurement[] } {
  const all: Measurement[] = [];
  for (let i = 0; i < runs; i++) all.push(fn());
  const best = all.reduce((b, m) => (m.runNs < b.runNs ? m : b));
  return { best, all };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function fmtMs(ns: number): string {
  const ms = ns / 1e6;
  if (ms < 1) return `${(ns / 1000).toFixed(1)} µs`;
  if (ms < 1000) return `${ms.toFixed(2)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function fmtRatio(a: number, b: number): string {
  if (b === 0) return 'n/a';
  const r = a / b;
  if (r >= 100) return `${r.toFixed(0)}x`;
  if (r >= 10) return `${r.toFixed(1)}x`;
  return `${r.toFixed(2)}x`;
}

interface PackageResult {
  package: string;
  bundled: boolean;
  obfuscated: boolean;
  origBytes: number;
  obfBytes: number;
  obfuscateElapsedMs: number;
  orig?: Measurement;
  obf?: Measurement;
  origAll?: Measurement[];
  obfAll?: Measurement[];
  error?: string;
}

function printReport(results: PackageResult[], opts: CliOptions): void {
  console.log('\n\n========== BENCHMARK REPORT ==========');
  console.log(`  iterations: ${opts.iterations ?? '(per-workload default)'}`);
  console.log(`  runs per measurement: ${opts.runs} (best-of-N)`);
  console.log(`  target-tokens: ${opts.targetTokens.toLocaleString()}`);
  console.log('');

  for (const r of results) {
    console.log(`--- ${r.package} ---`);

    if (r.error) {
      console.log(`  ERROR: ${r.error}`);
      console.log('');
      continue;
    }

    console.log(`  bundle size:       ${fmtBytes(r.origBytes)}`);
    console.log(
      `  obfuscated size:   ${fmtBytes(r.obfBytes)}  (${fmtRatio(r.obfBytes, r.origBytes)} larger; ${(r.obfuscateElapsedMs / 1000).toFixed(1)}s to obfuscate)`
    );

    if (!r.orig || !r.obf) {
      console.log('  (no measurements)');
      console.log('');
      continue;
    }

    const loadRatio = fmtRatio(r.obf.loadNs, r.orig.loadNs);
    const runRatio = fmtRatio(r.obf.runNs, r.orig.runNs);
    const origNsPerOp = r.orig.runNs / r.orig.iterations;
    const obfNsPerOp = r.obf.runNs / r.obf.iterations;

    console.log(`  iterations/run:    ${r.orig.iterations.toLocaleString()}`);
    console.log(
      `  load (require):    original ${fmtMs(r.orig.loadNs).padStart(10)}   obfuscated ${fmtMs(r.obf.loadNs).padStart(10)}   ${loadRatio} slower`
    );
    console.log(
      `  workload:          original ${fmtMs(r.orig.runNs).padStart(10)}   obfuscated ${fmtMs(r.obf.runNs).padStart(10)}   ${runRatio} slower`
    );
    console.log(
      `  per-op:            original ${fmtMs(origNsPerOp).padStart(10)}   obfuscated ${fmtMs(obfNsPerOp).padStart(10)}`
    );
    console.log('');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const projectRoot = path.resolve(__dirname, '..');
  const benchmarkDir = path.join(projectRoot, '.benchmark');
  const bundlesDir = path.join(benchmarkDir, 'bundles');
  const runnerPath = path.join(__dirname, 'benchmark-runner.js');

  if (!fs.existsSync(runnerPath)) {
    console.error(`benchmark-runner.js not found at ${runnerPath}`);
    process.exit(1);
  }

  console.log('egodeath obfuscation performance benchmark');
  console.log(`  packages: ${opts.packages.join(', ')}`);
  console.log(`  workspace: ${benchmarkDir}`);
  console.log('');

  // ---- Phase 1: install packages into .benchmark/ ----
  console.log('========== PHASE 1: INSTALL ==========');
  ensureWorkspace(benchmarkDir, opts.packages, opts.skipInstall);

  // ---- Phase 2: bundle + obfuscate each package ----
  console.log('\n========== PHASE 2: BUNDLE + OBFUSCATE ==========');
  const results: PackageResult[] = [];

  for (const pkg of opts.packages) {
    console.log(`\n  [${pkg}]`);
    const pkgBundleDir = path.join(bundlesDir, pkg);
    const origPath = path.join(pkgBundleDir, 'bundle.orig.js');
    const obfPath = path.join(pkgBundleDir, 'bundle.obf.js');

    const result: PackageResult = {
      package: pkg,
      bundled: false,
      obfuscated: false,
      origBytes: 0,
      obfBytes: 0,
      obfuscateElapsedMs: 0,
    };
    results.push(result);

    // Bundle
    try {
      const entry = resolvePackageEntry(benchmarkDir, pkg);
      console.log(`    entry: ${path.relative(benchmarkDir, entry)}`);
      webpackBundle(projectRoot, benchmarkDir, entry, origPath);
      result.bundled = true;
      result.origBytes = fs.statSync(origPath).size;
      console.log(`    bundled: ${fmtBytes(result.origBytes)}`);
    } catch (e: any) {
      result.error = `bundle failed: ${(e.stderr?.toString() || e.message || '').split('\n')[0]}`;
      console.log(`    ${result.error}`);
      continue;
    }

    // Obfuscate
    try {
      if (opts.skipObfuscate && fs.existsSync(obfPath)) {
        console.log('    (reusing existing obfuscated bundle)');
        result.obfBytes = fs.statSync(obfPath).size;
        result.obfuscated = true;
      } else {
        console.log(`    obfuscating (target-tokens=${opts.targetTokens.toLocaleString()})...`);
        const { obfBytes, elapsedMs, attempts } = obfuscateBundle(origPath, obfPath, opts.targetTokens, 5, pkg, benchmarkDir);
        result.obfBytes = obfBytes;
        result.obfuscateElapsedMs = elapsedMs;
        result.obfuscated = true;
        const attemptNote = attempts > 1 ? ` (${attempts} attempts)` : '';
        console.log(
          `    obfuscated: ${fmtBytes(obfBytes)} in ${(elapsedMs / 1000).toFixed(1)}s${attemptNote}`
        );
      }
    } catch (e: any) {
      result.error = `obfuscate failed: ${(e.message || '').split('\n')[0]}`;
      console.log(`    ${result.error}`);
      continue;
    }
  }

  // ---- Phase 3: measure ----
  console.log('\n========== PHASE 3: MEASURE ==========');
  for (const r of results) {
    if (!r.bundled || !r.obfuscated) continue;
    const pkgBundleDir = path.join(bundlesDir, r.package);
    const origPath = path.join(pkgBundleDir, 'bundle.orig.js');
    const obfPath = path.join(pkgBundleDir, 'bundle.obf.js');

    console.log(`\n  [${r.package}] timing ${opts.runs} run(s) per variant...`);
    try {
      const origResult = bestOf(opts.runs, () =>
        measure(runnerPath, origPath, r.package, opts.iterations, opts.warmup)
      );
      r.orig = origResult.best;
      r.origAll = origResult.all;
      console.log(
        `    original:   load ${fmtMs(r.orig.loadNs)}, run ${fmtMs(r.orig.runNs)} (${r.orig.iterations} iters)`
      );

      const obfResult = bestOf(opts.runs, () =>
        measure(runnerPath, obfPath, r.package, opts.iterations, opts.warmup)
      );
      r.obf = obfResult.best;
      r.obfAll = obfResult.all;
      console.log(
        `    obfuscated: load ${fmtMs(r.obf.loadNs)}, run ${fmtMs(r.obf.runNs)} (${r.obf.iterations} iters)`
      );
    } catch (e: any) {
      r.error = `measurement failed: ${e.message}`;
      console.log(`    ${r.error}`);
    }
  }

  // ---- Report ----
  printReport(results, opts);

  const reportPath = path.join(benchmarkDir, 'report.json');
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        options: opts,
        timestamp: new Date().toISOString(),
        results,
      },
      null,
      2
    ),
    'utf-8'
  );
  console.log(`  Full report: ${reportPath}`);
}

main();
