import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests each start a headed Chrome; running files one at a time keeps the machine usable.
    fileParallelism: false,
    // A headed Chrome takes focus from the developer's apps at every launch and popup. CI runs headed, where
    // nobody is typing, so headed-only behaviour such as focus return and windows is still tested before merge.
    env: process.env.CI === undefined ? { PATCHROME_TEST_HEADLESS: "1" } : {},
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
