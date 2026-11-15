import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
    // The default worker pools fail to register the "vitest" module on some
    // Windows/Node 24 setups ("failed to find the current suite"); vmThreads runs everywhere we tried.
    pool: "vmThreads",
  },
});
