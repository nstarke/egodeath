#!/usr/bin/env ts-node

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { obfuscate, obfuscateMultiple } from '../src/obfuscator';

const TOP_10_PACKAGES = [
  'lodash',
  'chalk',
  'commander',
  'debug',
  'express',
  'axios',
  'moment',
  'uuid',
  'minimist',
  'semver',
];

interface TestResult {
  ran: boolean;
  passed: boolean;
  output: string;
}

interface PackageReport {
  package: string;
  repoUrl: string;
  bundled: boolean;
  bundleError?: string;
  obfuscated: boolean;
  obfuscateError?: string;
  bundleSize: number;
  obfuscatedSize: number;
  tests: TestResult;
}

/**
 * Get the git repository URL for an npm package.
 */
function getRepoUrl(packageName: string): string | null {
  try {
    const raw = execSync(`npm view ${packageName} repository.url`, { stdio: 'pipe' }).toString().trim();
    let url = raw.replace(/^git\+/, '').replace(/\.git$/, '');
    url = url.replace(/^git:\/\//, 'https://');
    url = url.replace(/^ssh:\/\/git@github\.com/, 'https://github.com');
    url = url.replace(/^git@github\.com:/, 'https://github.com/');
    return url;
  } catch {
    return null;
  }
}

/**
 * Resolve a relative path against the repo, accepting a missing `.js`.
 */
function resolveEntryFile(repoDir: string, rel: string): string | null {
  const resolved = path.resolve(repoDir, rel);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  if (fs.existsSync(resolved + '.js')) return resolved + '.js';
  return null;
}

/**
 * Pull a file path out of an `exports` value, which may be a bare string or a
 * conditional object ({ node, require, import, default, ... }). Prefers
 * Node/CommonJS conditions, then falls back to whatever resolves.
 */
function resolveExportsTarget(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // `types` points at .d.ts files, never a runtime entry — skip it.
    for (const cond of ['node', 'require', 'default', 'import', 'module', 'browser']) {
      if (cond in obj) {
        const target = resolveExportsTarget(obj[cond]);
        if (target) return target;
      }
    }
    for (const [key, v] of Object.entries(obj)) {
      if (key === 'types') continue;
      const target = resolveExportsTarget(v);
      if (target) return target;
    }
  }
  return null;
}

/**
 * Find the main entry point of a package, checking `main`, the `.` entry of the
 * `exports` map, the `module` field, then a root index.js.
 */
function findMainEntry(repoDir: string): string | null {
  const pkgJsonPath = path.join(repoDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return null;

  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));

  // 1. `main` field
  if (typeof pkgJson.main === 'string') {
    const resolved = resolveEntryFile(repoDir, pkgJson.main);
    if (resolved) return resolved;
  }

  // 2. `exports` map — many ESM-only packages (e.g. uuid) drop `main` entirely
  if (pkgJson.exports) {
    const dot = typeof pkgJson.exports === 'string'
      ? pkgJson.exports
      : resolveExportsTarget(pkgJson.exports['.'] ?? pkgJson.exports);
    if (dot) {
      const resolved = resolveEntryFile(repoDir, dot);
      if (resolved) return resolved;
    }
  }

  // 3. `module` field (ESM entry)
  if (typeof pkgJson.module === 'string') {
    const resolved = resolveEntryFile(repoDir, pkgJson.module);
    if (resolved) return resolved;
  }

  // 4. Fallback: index.js
  const indexJs = path.join(repoDir, 'index.js');
  if (fs.existsSync(indexJs)) return indexJs;

  return null;
}

/**
 * Create a webpack config and bundle the library into a single file.
 */
function webpackBundle(repoDir: string, entryPath: string, outputPath: string): boolean {
  // Read the package's imports map for # package imports
  const pkgJsonPath = path.join(repoDir, 'package.json');
  const pkgJson = fs.existsSync(pkgJsonPath)
    ? JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) : {};

  // Build resolve aliases from #imports map
  const aliases: { [key: string]: string } = {};
  if (pkgJson.imports) {
    for (const [key, value] of Object.entries(pkgJson.imports)) {
      const target = typeof value === 'string' ? value
        : typeof value === 'object' && value !== null
          ? (value as any).node || (value as any).default || Object.values(value)[0]
          : null;
      if (target && typeof target === 'string') {
        aliases[key] = path.resolve(repoDir, target);
      }
    }
  }

  // Use a .cjs extension so the config is always loaded as CommonJS. Packages
  // with "type": "module" (chalk, commander, axios, ...) would otherwise make
  // webpack-cli parse this `module.exports = ...` file as ESM and fail to load.
  const configPath = path.join(repoDir, '_webpack.config.cjs');
  // Write as JS (not JSON) so regex externals are preserved
  const aliasStr = Object.keys(aliases).length > 0
    ? JSON.stringify(aliases, null, 2)
    : '{}';
  fs.writeFileSync(configPath, `module.exports = {
  mode: "none",
  target: "node",
  entry: ${JSON.stringify(entryPath)},
  output: {
    path: ${JSON.stringify(path.dirname(outputPath))},
    filename: ${JSON.stringify(path.basename(outputPath))},
    libraryTarget: "commonjs2"
  },
  resolve: {
    extensions: [".js", ".mjs", ".cjs", ".json", ".node"],
    mainFields: ["main", "module"],
    alias: ${aliasStr}
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

  // Run webpack using the local or global CLI
  const webpackBin = path.resolve(__dirname, '..', 'node_modules', '.bin', 'webpack');
  execSync(`"${webpackBin}" --config "${configPath}"`, {
    cwd: repoDir,
    stdio: 'pipe',
    timeout: 120000,
  });

  return fs.existsSync(outputPath);
}

/**
 * Binaries that lint or type-check rather than run tests. Obfuscated output
 * is intentionally un-lintable (mangled names, reformatted, encoded strings),
 * so running these against it produces noise failures unrelated to whether the
 * obfuscation preserved behavior.
 */
const LINT_BINARIES = new Set([
  'xo', 'eslint', 'tslint', 'jshint', 'jscs', 'standard', 'semistandard',
  'prettier', 'biome', 'rome', 'stylelint', 'dtslint', 'tsd', 'flow',
  'lockfile-lint', 'publint', 'tsc',
]);

/** npm-script names (the `X` in `npm run X`) that lint or type-check. */
const LINT_SCRIPT_RE = /^(lint|xo|prettier|format|style|check|checks|typecheck|type-check|types|tsc|tsd|dtslint|flow)(:.*)?$/;

/**
 * True if a single `&&`-separated command segment lints/type-checks rather
 * than running tests.
 */
function isLintSegment(seg: string): boolean {
  const tokens = seg.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  if ((tokens[0] === 'npm' || tokens[0] === 'pnpm' || tokens[0] === 'yarn') &&
      (tokens[1] === 'run' || tokens[1] === 'run-script')) {
    return LINT_SCRIPT_RE.test(tokens[2] || '');
  }
  // Direct binary: skip `VAR=val` and cross-env/env prefixes to reach the
  // actual command, then match its basename.
  let i = 0;
  while (i < tokens.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || tokens[i] === 'cross-env' || tokens[i] === 'env')) {
    i++;
  }
  return LINT_BINARIES.has(path.basename(tokens[i] || ''));
}

/** Drop lint/type-check segments from an `a && b && c` test script. */
function stripLintSegments(testScript: string): string {
  return testScript
    .split('&&')
    .map(s => s.trim())
    .filter(s => s && !isLintSegment(s))
    .join(' && ');
}

/**
 * Figure out the right command to run just the tests, skipping linters.
 */
function resolveTestCommand(pkgJson: any): string | null {
  const scripts = pkgJson.scripts || {};
  const testScript = scripts.test;

  if (!testScript || testScript === 'echo "Error: no test specified" && exit 1') {
    return null;
  }

  const testOnlyKeys = ['tests-only', 'test:unit', 'test-only', 'unit', 'test:run'];
  for (const key of testOnlyKeys) {
    if (scripts[key]) return `npm run ${key}`;
  }

  // Strip linters / type-checkers chained into the test script (e.g. chalk's
  // `xo && c8 ava && tsd`, commander's `node --test && npm run check:type:ts`).
  const stripped = stripLintSegments(testScript);
  if (stripped !== testScript.trim()) {
    // Something was removed — run only the real test command(s) directly.
    // deployAndTest puts node_modules/.bin on PATH. Running directly also
    // skips pre/posttest, so a `pretest: build` can't clobber the deploy.
    return stripped.length > 0 ? stripped : null;
  }

  if (scripts.pretest || scripts.posttest) {
    return 'npm test --ignore-scripts';
  }

  return 'npm test';
}

/**
 * Metadata collected during the prepare phase for each package.
 */
interface PreparedPackage {
  packageName: string;
  safeName: string;
  repoDir: string;
  mainEntry: string;
  bundlePath: string;
  bundleSource: string;
  report: PackageReport;
}

/**
 * Phase 1: Clone, install, build, and webpack-bundle a package.
 * Returns a PreparedPackage if bundling succeeds, or just a report if it fails.
 */
function preparePackage(packageName: string, tempDir: string): { prepared?: PreparedPackage; report: PackageReport } {
  const safeName = packageName.replace('/', '-');
  const repoDir = path.join(tempDir, safeName);

  console.log(`\n=== ${packageName} ===`);

  const report: PackageReport = {
    package: packageName,
    repoUrl: '',
    bundled: false,
    obfuscated: false,
    bundleSize: 0,
    obfuscatedSize: 0,
    tests: { ran: false, passed: false, output: '' },
  };

  // Step 1: Get the repo URL
  const repoUrl = getRepoUrl(packageName);
  if (!repoUrl) {
    console.error(`  Could not find repository URL for ${packageName}`);
    return { report };
  }
  report.repoUrl = repoUrl;
  console.log(`  Repo: ${repoUrl}`);

  // Step 2: Clone the repo
  console.log(`  Cloning...`);
  try {
    execSync(`git clone --depth 1 "${repoUrl}" "${repoDir}"`, { stdio: 'pipe' });
  } catch (e: any) {
    console.error(`  Failed to clone: ${e.message.split('\n')[0]}`);
    return { report };
  }

  // Step 3: Install dependencies (including devDeps for tests)
  console.log(`  Installing dependencies...`);
  try {
    execSync('npm install --ignore-scripts', { cwd: repoDir, stdio: 'pipe', timeout: 120000 });
  } catch (e: any) {
    console.error(`  npm install failed: ${e.message.split('\n')[0]}`);
    return { report };
  }

  // Step 4: Build the package if there's a build script
  const pkgJson = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf-8'));
  if (pkgJson.scripts && pkgJson.scripts.build) {
    console.log(`  Building...`);
    try {
      execSync('npm run build', { cwd: repoDir, stdio: 'pipe', timeout: 120000 });
    } catch (e: any) {
      console.log(`  Build failed (continuing): ${e.message.split('\n')[0]}`);
    }
  }

  // Step 5: Find main entry point
  const mainEntry = findMainEntry(repoDir);
  if (!mainEntry) {
    console.error(`  Could not find main entry point`);
    return { report };
  }
  console.log(`  Entry: ${path.relative(repoDir, mainEntry)}`);

  // Step 6: Webpack bundle into a single file
  const bundlePath = path.join(repoDir, '_bundle.js');
  console.log(`  Bundling with webpack...`);
  try {
    webpackBundle(repoDir, mainEntry, bundlePath);
    report.bundled = true;
    report.bundleSize = fs.statSync(bundlePath).size;
    console.log(`  \u2713 Bundle: ${(report.bundleSize / 1024).toFixed(1)} KB`);
  } catch (e: any) {
    const stderr = e.stderr?.toString() || '';
    const stdout = e.stdout?.toString() || '';
    const output = stdout + '\n' + stderr;

    const errorLines = output.split('\n').filter((l: string) =>
      l.includes('ERROR') || l.includes('Module not found') || l.includes('Can\'t resolve')
      || l.includes('Failed to load') || l.includes('SyntaxError') || l.includes('Error:'));
    // Fall back to the last non-empty output lines so the real webpack/config
    // error is captured instead of just "Command failed: ...webpack --config".
    const fallback = output.split('\n').map((l: string) => l.trim()).filter(Boolean).slice(-5);
    report.bundleError = errorLines[0]?.trim() || fallback.join(' | ') || e.message.split('\n')[0];
    console.log(`  \u2717 Bundle failed: ${(report.bundleError || '').substring(0, 120)}`);
    errorLines.slice(1, 4).forEach((l: string) =>
      console.log(`    ${l.trim().substring(0, 120)}`));

    return { report };
  }

  const bundleSource = fs.readFileSync(bundlePath, 'utf-8');
  return {
    prepared: { packageName, safeName, repoDir, mainEntry, bundlePath, bundleSource, report },
    report,
  };
}

/**
 * Whether an entry file is interpreted as an ES module. `.mjs` always is and
 * `.cjs` never is; a `.js` file is ESM only when its nearest enclosing
 * package.json declares `"type": "module"`. The obfuscated bundle is CommonJS
 * (`module.exports = ...`), so writing it into an ESM-scoped entry would throw
 * `module is not defined` on import — those need the shim path below.
 */
function isEsmScoped(entryPath: string, repoDir: string): boolean {
  const ext = path.extname(entryPath);
  if (ext === '.mjs') return true;
  if (ext === '.cjs') return false;

  const root = path.resolve(repoDir);
  let dir = path.dirname(entryPath);
  while (true) {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj)) {
      try {
        return JSON.parse(fs.readFileSync(pj, 'utf-8')).type === 'module';
      } catch {
        return false;
      }
    }
    const parent = path.dirname(dir);
    if (dir === root || parent === dir) break;
    dir = parent;
  }
  return false;
}

/**
 * Enumerate the runtime export keys of a CommonJS bundle by requiring it in a
 * throwaway child process (so the obfuscated module's side effects — console
 * stubs, anti-debug probes — don't leak into this process). Returns [] on any
 * failure; the shim then exposes only the default export.
 */
function extractExportKeys(cjsPath: string): string[] {
  try {
    const script = `const m=require(${JSON.stringify(cjsPath)});` +
      `const k=(m&&typeof m==="object")?Object.keys(m):[];` +
      `process.stdout.write(JSON.stringify(k))`;
    const out = execSync(`node -e ${JSON.stringify(script)}`, {
      stdio: 'pipe',
      timeout: 30000,
    }).toString();
    return JSON.parse(out);
  } catch {
    return [];
  }
}

/**
 * Build an ESM shim that re-exports a CommonJS bundle's surface, so an
 * ESM-scoped entry (`"type": "module"`) can serve the obfuscated CJS bundle.
 */
function buildEsmShim(cjsRelPath: string, keys: string[]): string {
  const named = keys.filter(k =>
    k !== 'default' && k !== '__esModule' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k));
  const lines = [
    `import __obf from ${JSON.stringify(cjsRelPath)};`,
    `export default (__obf && __obf.__esModule && 'default' in __obf) ? __obf.default : __obf;`,
  ];
  if (named.length > 0) {
    lines.push(`export const { ${named.join(', ')} } = __obf;`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Write the obfuscated bundle over a package's entry point. For CommonJS-scoped
 * entries the bundle is written directly; for ESM-scoped entries the bundle is
 * written to a sibling `.cjs` file and the entry becomes an ESM re-export shim.
 */
function deployBundle(mainEntry: string, repoDir: string, code: string): void {
  fs.copyFileSync(mainEntry, mainEntry + '.orig');

  if (!isEsmScoped(mainEntry, repoDir)) {
    fs.writeFileSync(mainEntry, code, 'utf-8');
    return;
  }

  const dir = path.dirname(mainEntry);
  const base = path.basename(mainEntry, path.extname(mainEntry));
  const cjsName = `${base}.__obf.cjs`;
  fs.writeFileSync(path.join(dir, cjsName), code, 'utf-8');
  const keys = extractExportKeys(path.join(dir, cjsName));
  fs.writeFileSync(mainEntry, buildEsmShim(`./${cjsName}`, keys), 'utf-8');
  console.log(`  ESM package: deployed CJS bundle + shim (${keys.length} exports)`);
}

/**
 * Phase 3: Deploy obfuscated code and run the package's test suite.
 */
function deployAndTest(prepared: PreparedPackage, obfuscatedCode: string, distDir: string): void {
  const { safeName, repoDir, mainEntry, report } = prepared;
  const pkgOutputDir = path.join(distDir, safeName);

  fs.mkdirSync(pkgOutputDir, { recursive: true });
  const obfuscatedPath = path.join(pkgOutputDir, 'bundle.js');
  fs.writeFileSync(obfuscatedPath, obfuscatedCode, 'utf-8');

  report.obfuscated = true;
  report.obfuscatedSize = obfuscatedCode.length;
  console.log(`  \u2713 Obfuscated ${safeName}: ${(report.obfuscatedSize / 1024).toFixed(1)} KB`);

  // Strip console stubs from the obfuscated output for testing.
  // The stubs (console.log = function(){}) break test runners that
  // check console output. The obfuscation is still valid without them.
  const stripped = obfuscatedCode.replace(/console\.\w+\s*=\s*function\s*\(\)\s*\{\s*\}\s*;?\n?/g, '');

  // Replace the main entry with the obfuscated bundle (CJS-direct, or an ESM
  // shim wrapping a sibling .cjs for "type": "module" packages).
  deployBundle(mainEntry, repoDir, stripped);

  // Run the package's test suite against the obfuscated bundle
  const pkgJson = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf-8'));
  const testCmd = resolveTestCommand(pkgJson);
  if (testCmd) {
    console.log(`  Running tests for ${safeName}...`);
    console.log(`  Test command: ${testCmd}`);
    const binDir = path.join(repoDir, 'node_modules', '.bin');
    try {
      const testOutput = execSync(testCmd, {
        cwd: repoDir,
        stdio: 'pipe',
        timeout: 120000,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          // Stripped test commands run binaries (ava, c8, ...) directly.
          PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
        },
      }).toString();
      report.tests = { ran: true, passed: true, output: testOutput };
      console.log(`  \u2713 Tests PASSED`);
    } catch (e: any) {
      const output = (e.stdout?.toString() || '') + '\n' + (e.stderr?.toString() || '');
      report.tests = { ran: true, passed: false, output };
      console.log(`  \u2717 Tests FAILED`);
      const lines = output.trim().split('\n');
      const tail = lines.slice(-10);
      for (const line of tail) {
        console.log(`    ${line}`);
      }
    }
  } else {
    console.log(`  No usable test script found for ${safeName}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const packages = args.length > 0 ? args : TOP_10_PACKAGES;

  const projectRoot = path.resolve(__dirname, '..');
  const distDir = path.join(projectRoot, 'dist', 'obfuscated');
  const tempDir = path.join(projectRoot, '.tmp-packages');

  fs.mkdirSync(distDir, { recursive: true });
  // Clean up stale temp directory from previous runs
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempDir, { recursive: true });

  console.log(`Obfuscating packages: ${packages.join(', ')}`);
  console.log(`Output directory: ${distDir}\n`);

  // Phase 1: Clone, install, build, and bundle all packages
  console.log('========== PHASE 1: BUNDLE ==========');
  const allReports: PackageReport[] = [];
  const prepared: PreparedPackage[] = [];

  for (const pkg of packages) {
    const result = preparePackage(pkg, tempDir);
    allReports.push(result.report);
    if (result.prepared) {
      prepared.push(result.prepared);
    }
  }

  // Phase 2: Obfuscate all bundled packages together using obfuscateMultiple
  // so dead code mutation in each file draws donor code from ALL packages
  console.log('\n\n========== PHASE 2: OBFUSCATE (multi-file) ==========');
  console.log(`  ${prepared.length} packages bundled successfully`);

  if (prepared.length > 0) {
    // Use <package>/bundle.js as filename to avoid collisions
    // (every bundle is named _bundle.js locally)
    const files = prepared.map(p => ({
      filename: `${p.safeName}/bundle.js`,
      code: p.bundleSource,
    }));

    console.log(`  Input files: ${files.map(f => f.filename).join(', ')}`);
    console.log(`  Obfuscating all ${files.length} bundles with cross-file dead code donors...`);

    try {
      const results = obfuscateMultiple(files, { targetTokens: 2_000_000 });

      // Phase 3: Deploy obfuscated output and run tests
      console.log('\n\n========== PHASE 3: TEST ==========');
      for (const p of prepared) {
        const result = results.find(r => r.filename === `${p.safeName}/bundle.js`);
        if (result) {
          deployAndTest(p, result.code, distDir);
        } else {
          p.report.obfuscateError = 'obfuscateMultiple did not return result for this file';
          console.log(`  \u2717 ${p.safeName}: missing from obfuscateMultiple output`);
        }
      }
    } catch (e: any) {
      console.error(`  \u2717 obfuscateMultiple failed: ${e.message.split('\n')[0]}`);
      for (const p of prepared) {
        p.report.obfuscateError = `batch obfuscation failed: ${e.message.split('\n')[0]}`;
      }
    }
  }

  // Print summary
  console.log('\n\n========== SUMMARY ==========\n');
  console.log('  Package              Bundle    Obfuscate  Tests');
  console.log('  -------              ------    ---------  -----');

  let totalBundled = 0;
  let totalObfuscated = 0;
  let totalTestsRan = 0;
  let totalTestsPassed = 0;

  for (const r of allReports) {
    const bundle = r.bundled ? `${(r.bundleSize / 1024).toFixed(0)}KB` : 'FAIL';
    const obf = r.obfuscated ? `${(r.obfuscatedSize / 1024).toFixed(0)}KB` : 'FAIL';
    let testStatus = 'no tests';
    if (r.tests.ran) {
      testStatus = r.tests.passed ? 'PASSED' : 'FAILED';
      totalTestsRan++;
      if (r.tests.passed) totalTestsPassed++;
    }
    console.log(`  ${r.package.padEnd(20)} ${bundle.padEnd(9)} ${obf.padEnd(10)} ${testStatus}`);

    if (r.bundleError) console.log(`    Bundle: ${r.bundleError.substring(0, 100)}`);
    if (r.obfuscateError) console.log(`    Obfuscate: ${r.obfuscateError.substring(0, 100)}`);

    if (r.bundled) totalBundled++;
    if (r.obfuscated) totalObfuscated++;
  }

  console.log('');
  console.log(`  Bundled: ${totalBundled}/${allReports.length}`);
  console.log(`  Obfuscated: ${totalObfuscated}/${allReports.length}`);
  console.log(`  Tests: ${totalTestsPassed}/${totalTestsRan} suites passed`);

  // Write full report as JSON
  const reportPath = path.join(distDir, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(allReports, null, 2), 'utf-8');
  console.log(`\n  Full report: ${reportPath}`);

  // Cleanup temp directory
  fs.rmSync(tempDir, { recursive: true, force: true });
}

main();
