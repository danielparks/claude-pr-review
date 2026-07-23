## What this is

`claude-pr-review` is a GitHub Action (`action.yaml`) that wraps `anthropics/claude-code-action` to give Claude context for reviewing pull requests: full PR discussion, inline comments with their nearest diff fragment, and a diff-of-diffs on re-review. It bundles its own CLI (`cli/pr-review`) that Claude invokes via its Bash tool to post review comments as `claude[bot]`.

## Commands

All CLI development happens in `cli/`:

```sh
cd cli
npm ci
npm run lint    # eslint
npm test        # vitest run
npm run format  # prettier --write
```

Run a single test file: `npx vitest run test/queue.test.js` (from `cli/`). Use `npx vitest run -t "name"` to filter by test name.

Repo-wide checks (also run by pre-commit, see `.pre-commit-config.yaml`):

```sh
scripts/cli-check          # npm ci (if needed) + lint + test in cli/
scripts/format --check     # prettier over js/ts/json/markdown/yaml
scripts/sync-readme        # sync <!-- default:NAME --> blocks in README.md from action.yaml
scripts/generate-workflows # regenerate .github/workflows/ from workflow-*.yaml examples
scripts/zizmor-online --persona=pedantic  # zizmor lint for the workflow/action YAML
```

`sync-readme` and `generate-workflows` are also pre-commit hooks — if you edit `action.yaml`, `README.md`, or `workflow-*.yaml`, run the relevant script (or `pre-commit run --all-files`) so generated content stays in sync before committing.

## Architecture

### Why a Bash-invoked CLI instead of an MCP server

The Claude App token — what makes review comments post as `claude[bot]` instead of `github-actions[bot]` — only exists inside `anthropics/claude-code-action`'s own process and only reaches subprocesses that inherit its real environment. A Bash-tool call does; an MCP server does not, because the MCP SDK's `StdioClientTransport` spawns servers with a fixed safe env allowlist that has to be built *before* `claude-code-action` (and thus the token) exists. So `cli/pr-review` is a plain, dependency-free JS script that `action.yaml` puts on `PATH` for Claude to run directly with Bash — see `cli/README.md` for the full reasoning and citations.

### `action.yaml` flow

1. `pr-review init` creates an exclusive queue directory (`$RUNNER_TEMP/pr-review-queue`) before Claude's turn starts.
2. Compute the PR diff against the merge base, cache it (`.pr-cache`), and compare to the previous cached diff. If identical (e.g. a rebase with no real changes), skip the rest — no re-review needed. If different, build a diff-of-diffs to show Claude what changed since last review.
3. Render the full PR discussion via `gh-pr-render` (a separate npm package, fetched at whatever version — this action doesn't vendor it).
4. Run `anthropics/claude-code-action` with that context, restricted to `allowed-tools` (see `README.md`), including the `pr-review` subcommands.
5. Always run `pr-review sweep` afterward to post anything Claude queued but didn't finalize itself, retry any abandoned in-flight submission, and downgrade any queued `APPROVE` to `COMMENT` if the Claude step failed or the real `claude[bot]` token wasn't available.

### `cli/pr-review` queue/claim/sweep design

Comments are queued as one file per comment under `comments/` (nothing in memory, since `pr-review` is a fresh process every invocation). State is encoded entirely in the queue directory's name so any process can tell what happened without reading file contents:

- `comments/` — still open, Claude may still be queuing.
- `comments.claimed-<ts>-<pid>-<uuid>/` — a finalizing call (`comment-review`/`approve-review`/`request-changes-review`/`sweep`) claimed the batch via one atomic rename; if the process died before confirming success, this is retried.
- `comments.posted-<ts>-<pid>-<uuid>/` — confirmed posted, sweep ignores it.

Queuing a comment only ever creates a new uniquely-named file, and claiming/marking-posted are single atomic renames, so there is no locking anywhere. See the module doc comment at the top of `cli/lib/queue.js` and the "Why a queue directory" section of `cli/README.md` for the full state machine, including the one known gap (a crash mid-network-request can produce a duplicate review — inherent to the reviews API having no idempotency key).

`APPROVE` has extra downgrade-to-`COMMENT` handling (both proactive, via `--downgrade-approval`, and reactive, if GitHub itself rejects the approval) because an unearned approval is unsafe. `REQUEST_CHANGES` is deliberately never downgraded — see `cli/README.md`'s "Opt-in tools" section for why, and for the `resolve-thread`/`hide-review`/`approve-review`/`request-changes-review` subcommands that are intentionally left out of `action.yaml`'s default `allowed-tools` because they change what kind of thing Claude *is* in a PR (affecting merge state, not just leaving comments).

### Key files

- `cli/pr-review` — the CLI entry point / command dispatch.
- `cli/lib/queue.js` — the claim/retry state machine described above.
- `cli/lib/github.js` — GitHub REST/GraphQL calls (reviews, replies, thread resolution, review hiding).
- `cli/lib/redact.js` — strips GitHub token patterns from comment bodies before they're posted, ported from `anthropics/claude-code-action`'s sanitizer, so a token Claude reads from logs can't end up in a public comment.
- `cli/test/pr-review.test.js` spawns the real `pr-review` script as a subprocess (how Claude's Bash tool actually invokes it); `queue.test.js` and `github.test.js` are unit tests against the lib modules directly.
- `workflow-review.yaml` / `workflow-response.yaml` — example workflows (PR-triggered review, and `@claude` comment-triggered response) that this repo itself uses; `.github/workflows/` is generated from these by `scripts/generate-workflows`.
