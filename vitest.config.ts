import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // v2.2.1 audit fix: the e2e project used to carry `sequential: true`,
    // which is NOT a valid Vitest 3 option (silently ignored - the config
    // file was covered by neither typecheck nor lint, so the typo was
    // invisible to CI). With file parallelism ON (default on multi-core CI
    // runners), two e2e suites that both listened on port 3113 collided with
    // EADDRINUSE and failed. Vitest 3 only supports fileParallelism at the
    // ROOT level: the e2e suites boot in-process Fastify apps on fixed ports
    // and were designed to run serially, so file parallelism stays off for
    // the whole run (unit/integration still run their tests concurrently
    // WITHIN each file). audit-fixes.e2e.test.ts also moved to its own port
    // (3127) as defense in depth.
    fileParallelism: false,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node'
        }
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30000
        }
      },
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60000
        }
      }
    ]
  }
});
