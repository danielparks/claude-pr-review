# Change log

All notable changes to this project will be documented in this file.

## main branch

### Breaking changes

- Replaced `initial-review-prompt` and `re-review-prompt` inputs with a single `prompt` input with a default loosely based on the old example workflow. Claude now determines the current state of the PR from the discussion context, eliminating the fragile bot comment detection.
- Replaced [anthropics/claude-code-action]‘s `mcp__github_inline_comment__create_inline_comment` tool and the `gh` Bash tools for posting comments with a bundled `pr-review` CLI tool that Claude runs via its Bash tool. The `allowed-tools` default changed accordingly; configurations that override it will need to be updated.

### Bugfixes

- Updated response workflow example to use snake_case instead of kebab-case for [anthropics/claude-code-action] inputs.
- Removed “resolve” from prompt default; Claude cannot actually resolve comments with the GitHub REST API.

### Changes

- Added a bundled `pr-review` CLI tool so Claude can post inline comments as a single grouped GitHub review instead of one review per comment.
- Updated [gh-pr-render] to version 0.5.0 to render labels, reactions, milestones, etc. and to use blockquotes to ensure that content is distinct from structure. This version also limits the number of comments it renders, and can be used to view an inline thread on its own.
- Clarified prompt (previously example prompts) by combining instructions on how to submit comments with instructions on when to submit comments.
- Added `additional-allowed-tools` input that appends to default allowed tools list.
- Added `additional-prompt` input that appends to the default prompt.
- Added `execution-log-artifact-retention` input to trigger saving Claude’s execution log as a CI artifact. See the warning in README.md.
- Added input to configure [gh-pr-render] version.
- Added opt-in `pr-review` subcommands, none of which are in the default `allowed-tools` list:
  - `resolve-any-thread`: mark an inline comment thread resolved.
  - `resolve-my-thread`: mark an inline comment thread resolved. Fails if the thread was started by another user.
  - `hide-any-review`: minimize a stale top-level review as outdated.
  - `hide-my-review`: minimize a stale top-level review as outdated. Fails if the review was authored by another user.
  - `request-changes-review`: submit a review requesting changes.
  - `approve-review`: submit a review approving the changes. If there is a problem with the Claude run, or if we don’t get the `claude[bot]` token, then the review will be downgraded to a comment with a note.
- Removed `bot-username` input (no longer needed).

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
