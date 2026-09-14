import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Workspace packages resolve to their **source**, not to `dist`.
 *
 * So a test run needs no prior build and always exercises the code as written. `pnpm build`
 * still type-checks and emits for the published graph; the two are kept consistent by
 * `pnpm verify`, which runs both.
 */
const workspaceAliases = {
  "@edtp/shared": resolve(here, "packages/shared/src/index.ts"),
  "@edtp/domain": resolve(here, "packages/domain/src/index.ts"),
  "@edtp/eudi-verifier-port": resolve(here, "packages/eudi-verifier-port/src/index.ts"),
  "@edtp/eudi-issuer-port": resolve(here, "packages/eudi-issuer-port/src/index.ts"),
  "@edtp/persistence": resolve(here, "packages/persistence/src/index.ts"),
  "@edtp/eudiplo-adapter": resolve(here, "packages/eudiplo-adapter/src/index.ts"),
  "@edtp/start-token": resolve(here, "packages/start-token/src/index.ts"),
  "@edtp/registration-client": resolve(here, "packages/registration-client/src/index.ts"),
  // The console is an application, not a library, so it has no barrel. Its individual modules are
  // aliased by path so the escaping, the rendering and the one piece of state it holds can be tested
  // without starting a server — which is also why those modules are pure functions.
  "@edtp/operator-console": resolve(here, "apps/operator-console/src"),
  "@edtp/platform-api": resolve(here, "apps/platform-api/src"),
  "@edtp/test-gateway": resolve(here, "apps/test-gateway/src"),
};

/**
 * Three suites, separated so each can run on its own:
 *
 * - `unit` — pure logic. No database, no network. Always runnable.
 * - `integration` — the business layer against a real PostgreSQL and a fake verifier port.
 *   Boots an embedded PostgreSQL, so it needs no Docker and no external service.
 * - `adapter-contract` — the adapter against a real engine container. **Skipped when the
 *   container is unavailable**, as the V0 plan requires, so a missing engine never fails
 *   the build.
 */
export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    projects: [
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          // One embedded PostgreSQL for the whole suite; initdb dominates the runtime.
          globalSetup: ["tests/support/postgres.global.ts"],
          hookTimeout: 120_000,
          testTimeout: 60_000,
          // The suites share one database, so they run in sequence rather than racing.
          fileParallelism: false,
        },
      },
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: "adapter-contract",
          include: ["tests/adapter/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
        },
      },
    ],
  },
});
