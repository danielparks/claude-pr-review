# Change log

All notable changes to this project will be documented in this file.

## main branch

### Breaking changes

- Added `prompt-suffix` (with default) and `additional-prompt-suffix` inputs. The `prompt-suffix` default was previously included in both prompts in the example, so configurations will need to be changed on update.
- Replaced [anthropics/claude-code-action]‘s `mcp__github_inline_comment__create_inline_comment` tool and the `gh` Bash tools for posting comments with a bundled `post-review` CLI tool that Claude runs via its Bash tool. The `allowed-tools` default changed accordingly; configurations that override it will need to be updated.

### Changes

- Added a bundled `post-review` CLI tool so Claude can post inline comments as a single grouped GitHub review instead of one review per comment, and so unsubmitted comments still post automatically after Claude's turn ends even if it never calls `submit` itself.
- Added `additional-allowed-tools` input.
- Added input to configure [gh-pr-render] version.
- Updated [gh-pr-render] to version 0.4.0 to render labels and reactions, and to use blockquotes to ensure that content is distinct from structure.
- Added defaults for `initial-review-prompt` and `re-review-prompt` based on old example prompts.
- Removed “resolve” from prompt defaults; Claude cannot actually resolve comments with the GitHub REST API.
- Clarified prompts with by combining instructions on how to submit comments with instructions on when to submit comments.
- Updated response workflow example to use snake_case instead of kebab-case for [anthropics/claude-code-action] inputs.

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
