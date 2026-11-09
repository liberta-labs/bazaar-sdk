import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Tests run against the SDK's sources, so they need no build first.
      "@liberta-labs/bazaar-sdk": fileURLToPath(new URL("./packages/sdk/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "packages/*/test/e2e/**"],
    testTimeout: 20_000,
  },
});
