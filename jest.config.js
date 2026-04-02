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
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        types: ['node', 'jest'],
      },
    }],
  },
};
