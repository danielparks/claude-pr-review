# pr_review MCP server

The MCP server `action.yaml` gives Claude for grouped PR reviews — see the "MCP tools" section of the [root README](../README.md#mcp-tools) for what the three tools do and why this exists.

## Why `dist/` is committed

This isn't published to npm and isn't built at action-run time. It's a subdirectory of `danielparks/claude-pr-review` itself, already on disk by the time `action.yaml` runs, so there's no cross-repo boundary that publishing would bridge, and building fresh on every action run would just be slower with more ways to fail.

Instead, `dist/index.js` is a single-file [esbuild](https://esbuild.github.io/) bundle with all dependencies inlined — committed, so `action.yaml` can run `node mcp-server/dist/index.js` directly with no install step. `scripts/mcp-server-check` (wired into the repo's pre-commit hooks) rebuilds it and fails if that produces a diff, so a forgotten rebuild before committing is caught immediately.

## Development

```sh
npm ci
npm run check   # tsc --noEmit
npm run lint    # eslint
npm test        # vitest — rebuilds dist/ first (pretest), then runs unit + integration tests
npm run build   # bundles src/ to dist/index.js
npm run format  # prettier --write
```

`src/review-batch.ts` (the comment queue that makes grouping possible) and `src/github.ts` (the GitHub API calls) each have their own unit tests, colocated as `src/*.test.ts`, that don't need a subprocess or the built bundle. `test/integration.test.ts` is the one place that spawns the actual built `dist/index.js` through the MCP SDK's own `Client`/`StdioClientTransport`, since that's what's different from testing the source directly.
