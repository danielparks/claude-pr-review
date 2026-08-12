import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // fetch-available-labels.test.js and pr-review.test.js's label tests
    // both spawn the real CLI against AVAILABLE_LABELS_FILE, a fixed
    // filesystem path (see lib/available-labels.js) -- required so Claude
    // can't redirect it by overriding an env var. Running test files in
    // parallel workers would let them race on that shared path.
    fileParallelism: false,
  },
});
