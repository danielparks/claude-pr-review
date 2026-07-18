# Change log

All notable changes to this project will be documented in this file.

## main branch

### Breaking changes

- Added `prompt-suffix` (with default) and `additional-prompt-suffix` inputs. The `prompt-suffix` default was previously included in both prompts in the example, so configurations will need to be changed on update.
- Replaced [anthropics/claude-code-action]'s `mcp__github_inline_comment__create_inline_comment` tool, and the `gh pr comment`/`gh pr review --comment`/`gh api` Bash tools, with a bundled `pr_review` MCP server (`mcp__pr_review__add_comment`, `mcp__pr_review__submit_review`, `mcp__pr_review__reply_to_comment`). The `allowed-tools` and `prompt-suffix` defaults changed accordingly; configurations that override either will need to be updated.

### Changes

- Added `additional-allowed-tools` input.
- Added input to configure [gh-pr-render] version.
- Updated [gh-pr-render] to version 0.4.0 to render labels and reactions, and to use blockquotes to ensure that content is distinct from structure.
- Added a bundled `pr_review` MCP server ([`mcp-server/`], TypeScript + [`@modelcontextprotocol/sdk`] + [`@octokit/rest`], built with esbuild to a committed `dist/index.js`) so Claude's review comments post as a single grouped GitHub review instead of one review per comment. [anthropics/claude-code-action]'s inline-comment tool always posts through GitHub's single-comment REST endpoint, which creates its own standalone review per call — no prompt wording can group those after the fact.
- Added defaults for `initial-review-prompt` and `re-review-prompt` based on old example prompts.
- Removed “resolve” from prompt defaults; Claude cannot actually resolve comments with the GitHub REST API.
- Clarified re-review prompt to emphasize only adding comments if there were new changes or discussion.
- Updated response workflow example to use snake_case instead of kebab-case for [anthropics/claude-code-action] inputs.

[gh-pr-render]: https://github.com/danielparks/gh-pr-render
[anthropics/claude-code-action]: https://github.com/anthropics/claude-code-action
[`mcp-server/`]: mcp-server
[`@modelcontextprotocol/sdk`]: https://github.com/modelcontextprotocol/typescript-sdk
[`@octokit/rest`]: https://github.com/octokit/rest.js

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
