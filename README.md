# claude-pr-review action — give Claude context for PR reviews

Have Claude review and re-review pull requests with the context of all the comments in the pull request, including inline comments along with the nearest diff fragment.

(The full diff is not included; Claude already has access to that.)

This detects whether a re-review is needed on `synchronize` (push) by comparing the PR diff against a cached baseline. If the PR is the same, i.e. it was rebased after changes were made elsewhere in the codebase, this skips the Claude review.

The context is generated with [gh-pr-render].

## Quick start

```yaml
- uses: danielparks/claude-pr-review@fdca20601bf0d709ee55c3b799c2cdcc9adcccf7 # v1.0.2
  with:
    # You can set either of these secrets. If both are set, the API key
    # seems to win.
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

See example [workflow-review.yaml] for a working PR-triggered workflow, and example [workflow-response.yaml] for a working comment (@claude) triggered workflow. This repo uses both.

## Inputs

### `anthropic-api-key`

Anthropic API key for token-based billing. Either this or `claude-code-oauth-token` is **required**.

### `claude-code-oauth-token`

Claude Code OAuth token for use with a subscription account. Generate with `claude setup-token`. Either this or `anthropic-api-key` is **required**.

### `initial-review-prompt`

Prompt for when no prior Claude review exists. Defaults to:

    Please review this pull request. The PR branch is already checked out in
    the current working directory, and the PR discussion is included below.

### `re-review-prompt`

Prompt for when a prior Claude review exists. Defaults to:

    This pull request has been updated. The PR discussion (including your
    prior review) and a diff of what changed since your last review are
    included below.

### `prompt-suffix`

Added to the end of `initial-review-prompt` and `re-review-prompt`. Defaults to:

    Only post GitHub comments — don't submit review text as messages.

    For the commands below: write the comment body to a file under /tmp first
    (e.g. with the Write tool), then pass that file's path with `--body-file`.
    This avoids dealing with shell special characters.

    1. Use `pr-review reply --comment-id ID --body-file PATH` to reply to
       existing inline comments if they need it. This posts immediately.
    2. Use `pr-review queue-comment --path PATH --line N --body-file PATH`
       for every specific code issue you find in new code. This only
       queues the comment; nothing is posted yet.
    3. Use `pr-review submit --body-file PATH` once at the end if you want
       to leave top-level feedback. This will submit all queued comments; if
       you don't call it queued comments will be submitted after you finish.

### `additional-prompt-suffix`

Appended after `prompt-suffix`. Empty default.

This is useful if you just want to add text to the default prompt.

### `bot-username`

GitHub username of the bot; used to detect prior reviews. Defaults to “claude”.

### `allowed-tools`

List of tools to allow Claude to use, one per line. Passed to `--allowedTools`. Defaults to:

    Read
    Write(/tmp/**)
    Bash(find:*)
    Bash(grep:*)
    Bash(git log:*)
    Bash(git diff:*)
    Bash(git blame:*)
    Bash(gh pr diff:*)
    Bash(gh pr view:*)
    Bash(gh run list:*)
    Bash(gh run view:*)
    Bash(pr-review queue-comment:*)
    Bash(pr-review reply:*)
    Bash(pr-review submit:*)

### `additional-allowed-tools`

List of additional tools to allow Claude to use, one per line. Added to `allowed-tools` and then passed to `--allowedTools`. Empty default.

This is useful if you just want to add a tool to the default tool list.

### `gh-pr-render-version`

Version of the [gh-pr-render] tool to use. Defaults to the latest version at the time of this action’s release.

## Details

### Posting review comments

This action bundles its own CLI tool, [`cli/pr-review`], that `action.yaml` puts on `PATH` for Claude to run via its Bash tool:

- `pr-review queue-comment` queues an inline comment on disk. Nothing is posted to GitHub until `submit` is called.
- `pr-review submit` posts everything queued by `queue-comment`, plus an optional top-level body, as a single grouped comment review (it cannot approve or request changes). Claude doesn't have to call this itself — `action.yaml` runs it automatically after Claude's turn ends if anything is still queued.
- `pr-review reply` replies to an existing inline comment thread; this posts immediately, since replies attach to an existing thread rather than a new review.

[anthropics/claude-code-action]'s built-in inline-comment tool posts each inline comment through GitHub's single-comment REST endpoint, which creates and submits its own standalone review every time — so a review with five comments shows up as five separate reviews instead of one.

This is a Bash-invoked CLI tool rather than an MCP server so that it can post as `claude[bot]` instead of `github-actions[bot]`: the Claude App token only reaches subprocesses that inherit [anthropics/claude-code-action]'s real environment, which a Bash-tool call does and an MCP server does not. It's plain, dependency-free JavaScript that `action.yaml` runs directly with no build step — see [`cli/README.md`] for more information.

### PR updates

When a PR is updated this compares the version of the PR to the new version. If they are identical, e.g. the PR was rebased on changes to another part of the codebase, it does not trigger Claude to re-review.

If the changes are not identical then this provides Claude with a diff-of-diffs so that it can see what was changed.

[gh-pr-render]: https://github.com/danielparks/gh-pr-render
[workflow-review.yaml]: workflow-review.yaml
[workflow-response.yaml]: workflow-response.yaml
[anthropics/claude-code-action]: https://github.com/anthropics/claude-code-action
[`cli/pr-review`]: cli/pr-review
[`cli/README.md`]: cli/README.md
