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
 * Find the main entry point of a package.
 */
function findMainEntry(repoDir: string): string | null {
  const pkgJsonPath = path.join(repoDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return null;

  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));

  // Try main, then index.js
  for (const field of ['main']) {
    const entry = pkgJson[field];
    if (entry && typeof entry === 'string') {
      const resolved = path.resolve(repoDir, entry);
      if (fs.existsSync(resolved)) return resolved;
      // Try with .js extension
      if (fs.existsSync(resolved + '.js')) return resolved + '.js';
    }
  }

  // Fallback: index.js
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

  const webpackConfig: any = {
    mode: 'none',
    target: 'node',
    entry: entryPath,
    output: {
      path: path.dirname(outputPath),
      filename: path.basename(outputPath),
      libraryTarget: 'commonjs2',
    },
    resolve: {
      extensions: ['.js', '.mjs', '.cjs', '.json', '.node'],
      mainFields: ['main', 'module'],
      alias: aliases,
    },
    module: {
      rules: [{
        test: /\.mjs$/,
        type: 'javascript/auto',
      }],
    },
    experiments: {
      // Enable support for ESM
      outputModule: false,
    },
    externals: [
      /\.node$/,
      'bufferutil',
      'utf-8-validate',
    ],
  };

  const configPath = path.join(repoDir, '_webpack.config.js');
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
      l.includes('ERROR') || l.includes('Module not found') || l.includes('Can\'t resolve'));
    report.bundleError = errorLines[0]?.trim() || e.message.split('\n')[0];
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

  // Replace the main entry with the obfuscated bundle
  fs.copyFileSync(mainEntry, mainEntry + '.orig');
  fs.writeFileSync(mainEntry, stripped, 'utf-8');

  // Run the package's test suite against the obfuscated bundle
  const pkgJson = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf-8'));
  const testCmd = resolveTestCommand(pkgJson);
  if (testCmd) {
    console.log(`  Running tests for ${safeName}...`);
    console.log(`  Test command: ${testCmd}`);
    try {
      const testOutput = execSync(testCmd, {
        cwd: repoDir,
        stdio: 'pipe',
        timeout: 120000,
        env: { ...process.env, NODE_ENV: 'test' },
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
