import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// End-to-end runs against a live Anvil: `npx vitest run -c vitest.e2e.config.ts`.
// See packages/keeper/test/e2e/deploy.e2e.test.ts for the Anvil they expect.
export default defineConfig({
  resolve: {
    alias: {
      // Tests run against the SDK's sources, so they need no build first.
      "@liberta-labs/bazaar-sdk": fileURLToPath(new URL("./packages/sdk/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/test/e2e/**/*.e2e.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Anvil mines a block a second and each scenario step waits for its receipt.
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // One chain, one deployer: files and tests must not interleave their transactions.
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
