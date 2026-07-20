# pr-review CLI

`pr-review` is what `action.yaml` gives Claude, via its Bash tool, to post PR review comments as `claude[bot]` — see the "Posting review comments" section of the [root README](../README.md#posting-review-comments) for what the subcommands do.

## Why Bash instead of MCP

The Claude App token (what makes comments post as `claude[bot]` instead of `github-actions[bot]`) only exists inside `anthropics/claude-code-action`'s own process, and only reaches a subprocess that inherits its real environment. A Bash-tool subprocess does; an MCP server does not — the MCP SDK's `StdioClientTransport` spawns servers with a fixed safe env allowlist (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`) plus whatever's explicitly in `--mcp-config`, which `action.yaml` has to build _before_ `claude-code-action` even starts — before that token exists. So an MCP server bundled here could never get it, no matter how it's configured. `pr-review` sidesteps that by being an ordinary command Claude runs via Bash, which inherits the real environment normally.

This isn't reaching around anything Anthropic didn't already intend: it's the same default trust model their own action already applies to Bash-tool subprocesses for any actor with write access (no env scrubbing unless `allowed_non_write_users` is set) — confirmed empirically on an older version of this action, where `gh pr comment`/`gh api` from Bash already posted as `claude[bot]` (see danielparks/gh-pr-render#32).

## Why no build step

This has zero runtime dependencies — it's plain JavaScript using the built-in `fetch`, so `action.yaml` runs `cli/pr-review` directly with no bundling and no install step at consumption time. `npm ci`/`eslint`/`vitest` are dev-only, for local development and `scripts/cli-check` (wired into pre-commit).

## Why a queue directory instead of an in-memory batch

Comments are queued as one file per comment (`$RUNNER_TEMP/pr-review-queue/comments/<timestamp>-<uuid>.json`) rather than held in memory, because `pr-review` is a fresh process on every invocation — there's no long-lived server to hold state. Each `queue-comment` call only ever creates a new, uniquely-named file, so concurrent invocations can never collide; there's nothing to lock.

`submit` claims the batch with a single atomic rename (`comments/` → `comments.claimed-<ts>-<pid>-<uuid>/`), posts it as one grouped review, and renames it again to `comments.posted-<ts>-<pid>-<uuid>/` only after a confirmed-successful response. All three states are encoded in the directory name, so a completely separate process — the deferred `sweep` step `action.yaml` runs after Claude's turn ends — can always tell what happened without reading any file content:

- `comments/` still exists → Claude queued things but never called `submit`; sweep claims and posts it. This is what lets Claude skip calling `submit` at all when it has nothing to add beyond the inline comments.
- `comments.claimed-*/` exists → a `submit` call claimed a batch and then crashed before confirming success; sweep retries it.
- `comments.posted-*/` → already posted; sweep ignores it.

The one gap this doesn't close: if the crash happens during the network request itself (no response either way), a retry can't distinguish "GitHub never got it" from "GitHub got it but we never heard back," so a duplicate review is possible in that narrow window. That's inherent to the reviews API not offering an idempotency key, not something the queue design can fix.

## Development

```sh
npm ci
npm run lint    # eslint
npm test        # vitest
npm run format  # prettier --write
```

`lib/queue.js` (the claim/retry mechanics) and `lib/github.js` (the GitHub API calls) each have their own unit tests, colocated as `test/*.test.js`, that don't spawn a subprocess. `test/pr-review.test.js` spawns the real `pr-review` script as a subprocess, exactly how Claude's Bash tool invokes it in production.
