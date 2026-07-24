# pr-review CLI

`pr-review` is what `action.yaml` gives Claude, via its Bash tool, to post PR review comments as `claude[bot]` — see the ["Posting review comments" section of the root README][posting-review-comments] for what the subcommands do.

## Why Bash instead of MCP

The Claude App token (what makes comments post as `claude[bot]` instead of `github-actions[bot]`) only exists inside `anthropics/claude-code-action`'s own process, and only reaches a subprocess that inherits its real environment. A Bash-tool subprocess does; an MCP server does not — the MCP SDK's `StdioClientTransport` spawns servers with a fixed safe env allowlist (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`) plus whatever's explicitly in `--mcp-config`, which `action.yaml` has to build _before_ `claude-code-action` even starts — before that token exists. So an MCP server bundled here could never get it, no matter how it's configured. `pr-review` sidesteps that by being an ordinary command Claude runs via Bash, which inherits the real environment normally.

This isn't reaching around anything Anthropic didn't already intend: it's the same default trust model their own action already applies to Bash-tool subprocesses for any actor with write access (no env scrubbing unless `allowed_non_write_users` is set) — confirmed empirically on an older version of this action, where `gh pr comment`/`gh api` from Bash already posted as `claude[bot]` (see danielparks/gh-pr-render#32).

## Why no build step

This has zero runtime dependencies — it's plain JavaScript using the built-in `fetch`, so `action.yaml` runs `cli/pr-review` directly with no bundling and no install step at consumption time. `npm ci`/`eslint`/`vitest` are dev-only, for local development and `scripts/cli-check` (wired into pre-commit).

## Why a queue directory instead of an in-memory batch

Comments are queued as one file per comment (`$RUNNER_TEMP/pr-review-queue/comments/<timestamp>-<uuid>.json`) rather than held in memory, because `pr-review` is a fresh process on every invocation — there's no long-lived server to hold state. Each `queue-inline-comment` call only ever creates a new, uniquely-named file, so concurrent invocations can never collide; there's nothing to lock.

`comment-review`, `approve-review`, and `request-changes-review` all finalize the batch the same way:

1. They atomically claim the batch with a single atomic rename (`comments/` → `comments.claimed-<timestamp>-<pid>-<uuid>/`).
2. Record the review (`_event.txt` and `_body.txt`).
3. Post it as one grouped review.
4. Rename the batch directory again to `comments.posted-<timestamp>-<pid>-<uuid>/` if it got a successful response.

Three states are encoded in the directory name, so a completely separate process — the deferred `sweep` step `action.yaml` runs after Claude's turn ends — can always tell what happened without reading any file content:

- `comments/` still exists → Claude queued things but never finalized; sweep claims and posts it as a `COMMENT`. This is what lets Claude skip calling `comment-review` at all when it has nothing to add beyond the inline comments.
- `comments.claimed-*/` exists → a finalizing call claimed a batch and then crashed before confirming success; sweep retries it with the same event it was originally going to submit.
- `comments.posted-*/` → already posted; sweep ignores it.

The one gap this doesn't close: if the crash happens during the network request itself (no response either way), a retry can't distinguish "GitHub never got it" from "GitHub got it but we never heard back," so a duplicate review is possible in that narrow window. That's inherent to the reviews API not offering an idempotency key, not something the queue design can fix.

`action.yaml` runs `pr-review init` before Claude's own turn starts, which exclusively creates the queue root (failing if it already exists) so nothing that ran earlier in the same job could have pre-seeded a review decision in it. That's not a complete defense — something already running in the job (e.g. a long-lived process watching for the directory to appear) could still modify it after this point — but it closes off the cheapest version of that: dropping a file in ahead of time.

An `APPROVE` review gets special handling because it might allow a merge. If the Claude step failed, or we didn’t get the Claude app token, then `--downgrade-approval` is passed to `sweep`, which converts any queued `APPROVE` into a `COMMENT` with a note appended to the body explaining why before submitting.

Separately, any `APPROVE` review GitHub itself rejects because the token isn't permitted to approve is automatically retried as a `COMMENT`, again with a note. `REQUEST_CHANGES` never gets downgraded by either mechanism — see the danger note below for why.

## Opt-in tools

A few `pr-review` subcommands are deliberately left out of the default `allowed-tools` list in `action.yaml`. They're real capabilities some workflows want, but they change what kind of thing Claude _is_ in a PR — from "leaves comments" to "affects merge state" — so they're opt-in only, enabled by adding the relevant line(s) below to the `additional-allowed-tools` input, and should be paired with your own `additional-prompt` text describing when Claude should use them.

### `resolve-thread --thread-id ID` / `resolve-any-thread --thread-id ID`

Resolves an inline-comment thread via GitHub's `resolveReviewThread` GraphQL mutation, given the thread's GraphQL node id (not a REST comment id — [gh-pr-render] surfaces this alongside its rendered comments).

**Danger:** resolving is a judgment call. If Claude resolves a thread because someone replied to it, rather than because the underlying issue was actually fixed, it removes the visual signal a human reviewer relies on to know what's still open.

`resolve-thread` refuses to run unless the thread's first comment was authored by the authenticated user (i.e. Claude started the thread itself), which rules out the most obviously wrong case: resolving a thread someone else opened. It's still a judgment call whether the underlying issue in Claude's own thread was actually fixed — this check doesn't establish that. `resolve-any-thread` is the same mutation with that check removed, for workflows that accept the trade-off.

### `hide-review --review-id ID` / `hide-any-review --review-id ID`

Minimizes a top-level review (classified as `OUTDATED`) via GitHub's `minimizeComment` GraphQL mutation, given the review's REST id. Intended for superseding Claude's own stale reviews on re-review, not anyone else's.

**Danger:** minimizing isn't easily reversible outside the GraphQL API, and it removes the review from the normal PR timeline for anyone reading it later.

`hide-review` refuses to run unless the review was authored by the authenticated user, matching that stated intent. `hide-any-review` is the same mutation with that check removed, for workflows that accept the trade-off.

### `approve-review [--body-file PATH]` / `request-changes-review --body-file PATH`

Submit a review with an `APPROVE` or `REQUEST_CHANGES` event instead of `COMMENT`, i.e. actually approve or block the PR rather than just comment on it. Like `comment-review`, these post whatever was queued with `queue-inline-comment` alongside the top-level body.

**Danger:** this is the most consequential tool here. An approval or block from an LLM is a fundamentally different signal than the same from a human reviewer, and treating it as equivalent — e.g. for satisfying a required-approval branch protection rule — is a governance decision your organization should make deliberately, not one this action should make for you by default.

It's also **not** covered by GitHub's "Allow GitHub Actions to create and approve pull requests" repository/organization setting, even when that setting is off. That setting only inspects whether a review was submitted with the workflow run's own ephemeral `GITHUB_TOKEN` — it exists to stop a workflow from trivially rubber-stamping itself with its own ambient credential. Claude authenticates with its own GitHub App installation token, a completely different credential that setting was never scoped to check, so it approves or requests changes regardless of that setting's value. If you're relying on that setting to prevent bots from approving PRs, enabling `approve-review` here bypasses it entirely.

`APPROVE` specifically has multiple layers of automatic downgrade-to-`COMMENT` built in — see "Why a queue directory" above — because an unearned approval is unsafe (it can vouch for a review that never finished), whereas an unearned block is just recoverable friction. `REQUEST_CHANGES` is deliberately never downgraded for that reason: by default, GitHub blocks the merge button for any pending "Request changes" review from a write-access account, and softening that into a mere comment on a failed or lower-trust run would be trading a fail-safe default for a fail-open one.

## Development

```sh
npm ci
npm run lint    # eslint
npm test        # vitest
npm run format  # prettier --write
```

`lib/queue.js` (the claim/retry mechanics) and `lib/github.js` (the GitHub API calls) each have their own unit tests, colocated as `test/*.test.js`, that don't spawn a subprocess. `test/pr-review.test.js` spawns the real `pr-review` script as a subprocess, exactly how Claude's Bash tool invokes it in production.

[posting-review-comments]: ../README.md#posting-review-comments
[gh-pr-render]: https://github.com/danielparks/gh-pr-render
