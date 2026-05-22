import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/index.test.integration.ts'],
    passWithNoTests: true,
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-reports/integration-results.xml' },
    testTimeout: 6000000,
    hookTimeout: 6000000,
  },
});
