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

// Executable so it matches the old pr-review-server.js convention for local
// testing (`./dist/index.js`); action.yaml itself invokes it via `node`, so
// this isn't load-bearing there.
chmodSync("dist/index.js", 0o755);
