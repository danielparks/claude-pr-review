# Change log

All notable changes to this project will be documented in this file.

## main branch

### Breaking changes

- Replaced `initial-review-prompt` and `re-review-prompt` inputs with a single `prompt` input with a default loosely based on the old example workflow. Claude now determines the current state of the PR from the discussion context, eliminating the fragile bot-comment grep logic.
- Removed `bot-username` input (no longer needed).
- Replaced [anthropics/claude-code-action]‘s `mcp__github_inline_comment__create_inline_comment` tool and the `gh` Bash tools for posting comments with a bundled `pr-review` CLI tool that Claude runs via its Bash tool. The `allowed-tools` default changed accordingly; configurations that override it will need to be updated.

### Bugfixes

- Updated response workflow example to use snake_case instead of kebab-case for [anthropics/claude-code-action] inputs.
- Removed “resolve” from prompt default; Claude cannot actually resolve comments with the GitHub REST API.

### Changes

- Added a bundled `pr-review` CLI tool so Claude can post inline comments as a single grouped GitHub review instead of one review per comment, and so unsubmitted comments still post automatically after Claude's turn ends even if it never calls `comment-review` itself.
- Updated [gh-pr-render] to version 0.4.0 to render labels and reactions, and to use blockquotes to ensure that content is distinct from structure.
- Clarified prompt (previously example prompts) by combining instructions on how to submit comments with instructions on when to submit comments.
- Added `additional-allowed-tools` input that appends to default allowed tools list.
- Added `additional-prompt` input that appends to the default prompt.
- Added input to configure [gh-pr-render] version.
- Added opt-in `pr-review` subcommands, none in the default `allowed-tools` list: `resolve-thread` (resolve an inline-comment thread), `hide-review` (minimize a stale top-level review as outdated), and `approve-review`/`request-changes-review` (submit a review — including any queued inline comments — with an `APPROVE`/`REQUEST_CHANGES` event instead of `COMMENT`). An `APPROVE` is never trusted blindly: it's automatically downgraded to a `COMMENT` (with a note) if GitHub itself rejects the approval, or proactively via `sweep --downgrade-approval` when the review run didn't succeed or only a lower-privilege fallback token was available; `REQUEST_CHANGES` is never downgraded, deliberately. See the ["Opt-in tools"](cli/README.md#opt-in-tools) section of `cli/README.md` for what they do and why they aren't on by default.
- Removed leftover `Bash(gh pr review:*)`/`Bash(gh pr comment:*)` from the `allowed-tools` default — posting now goes exclusively through `pr-review`.
- Added `pr-review init`, run once by `action.yaml` before Claude's turn starts, which exclusively creates the queue directory so nothing that ran earlier in the same job can pre-seed a review decision into it.

[gh-pr-render]: https://github.com/danielparks/gh-pr-render
[anthropics/claude-code-action]: https://github.com/anthropics/claude-code-action

## Release 1.0.2 (2026-06-12)

- Fix [gh-pr-render] usage.

[gh-pr-render]: https://github.com/danielparks/gh-pr-render

## Release 1.0.1 (2026-06-12)

- Enable immutable releases.
- Fix generic heredoc delimiter that could be accidentally used within content.
- Pin [gh-pr-render] to version 0.2.0.

[gh-pr-render]: https://github.com/danielparks/gh-pr-render

## Release 1.0.0 (2026-05-28)

Initial release.
