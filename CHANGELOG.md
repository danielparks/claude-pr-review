# Change log

All notable changes to this project will be documented in this file.

## main branch

### Breaking changes

- Added `prompt-suffix` (with default) and `additional-prompt-suffix` inputs. The `prompt-suffix` default was previously included in both prompts in the example, so configurations will need to be changed on update.

### Changes

- Added `additional-allowed-tools` input.
- Added input to configure [gh-pr-render] version.
- Updated [gh-pr-render] to version 0.4.0 to render labels and reactions, and to use blockquotes to ensure that content is distinct from structure.
- Enabled `gh pr review --comment` tool and tweaked instructions to encourage Claude to group all review comments together.
- Added defaults for `initial-review-prompt` and `re-review-prompt` based on old example prompts.
- Removed “resolve” from prompt defaults; Claude cannot actually resolve comments with the GitHub REST API.
- Clarified re-review prompt to emphasize only adding comments if there were new changes or discussion.
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
