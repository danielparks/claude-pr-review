// Bundles src/index.ts into a single, dependency-free dist/index.js that
// action.yaml runs directly with `node` — no npm install step needed at
// consumption time. See README.md for why this is committed rather than
// built at action-run time or published to npm.
import { chmodSync } from "node:fs";
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});

// Executable for pre-commit check.
chmodSync("dist/index.js", 0o755);
