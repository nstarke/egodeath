module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Force exit after tests complete — anti-debug setInterval traps in
  // obfuscated output keep worker processes alive otherwise.
  forceExit: true,
  // Longer timeout for tests that run the full obfuscation pipeline
  testTimeout: 60000,
  // Limit workers to avoid memory pressure from heavy obfuscation tests
  maxWorkers: 2,
  // Recycle workers between suites so generated code, timers, and compiler
  // state cannot accumulate until Node's heap is exhausted on CI runners.
  workerIdleMemoryLimit: '512MB',
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        types: ['node', 'jest'],
        noUnusedLocals: false,
        noUnusedParameters: false,
      },
    }],
    // jsdom >=30 and its dependency chain (html-encoding-sniffer,
    // @exodus/bytes, tough-cookie, parse5, css-tree, ...) ship ESM only.
    // keywords.ts require()s jsdom synchronously, so Jest's CommonJS
    // sandbox has to down-compile those packages before it can load them.
    '^.+\\.(js|mjs|cjs)$': ['ts-jest', {
      tsconfig: {
        allowJs: true,
        module: 'commonjs',
        target: 'es2022',
        types: ['node', 'jest'],
        noUnusedLocals: false,
        noUnusedParameters: false,
      },
      diagnostics: false,
    }],
  },
  // Empty so the ESM packages above are not skipped; Jest ignores all of
  // node_modules by default.
  transformIgnorePatterns: [],
};
