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
  // Jest ignores all of node_modules by default, which would skip the
  // transform above. Un-ignore exactly the ESM packages reachable from
  // jsdom so everything else keeps its fast path -- transforming the whole
  // of node_modules costs about 175s per cold-cache run of the full suite
  // (measured on Node 22: 451s with an empty list, 277s with this one).
  //
  // To regenerate after a jsdom upgrade, list the packages whose
  // package.json has "type": "module" in jsdom's require graph. A stale
  // list surfaces as "Must use import to load ES Module: <path>" -- add
  // the package from that path here.
  transformIgnorePatterns: [
    `/node_modules/(?!(?:${[
      '@asamuzakjp/css-color',
      '@asamuzakjp/dom-selector',
      '@bramus/specificity',
      '@csstools/color-helpers',
      '@csstools/css-calc',
      '@csstools/css-color-parser',
      '@csstools/css-parser-algorithms',
      '@csstools/css-tokenizer',
      '@exodus/bytes',
      'css-tree',
      'entities',
      'parse5',
      'tough-cookie',
    ].join('|')})/)`,
  ],
};
