import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests each start a headed Chrome; running files one at a time keeps the machine usable.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
