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

    Update your feedback to reflect the current state of the PR:
    - Update any comments that have been addressed.
    - Flag any new issues introduced by the changes.

### `prompt-suffix`

Added to the end of `initial-review-prompt` and `re-review-prompt`. Defaults to:

    - Use `mcp__github_inline_comment__create_inline_comment` (without
      `confirmed`) to highlight new specific code issues.
    - Use `gh api repos/${{ github.repository }}/pulls/${{ github.event.pull_request.number }}/comments/$ID/replies -X POST -f "body=$BODY"`
      to reply to diff comments, replacing `$ID` with the comment id
      and `$BODY` with your reply.
    - After submitting inline comments, use `gh pr review --comment` for
      top-level feedback if there is anything that couldn't be addressed.
    - Only post GitHub comments — don't submit review text as messages.

### `additional-prompt-suffix`

Appended after `prompt-suffix`. Empty default.

This is useful if you just want to add text to the default prompt.

### `bot-username`

GitHub username of the bot; used to detect prior reviews. Defaults to “claude”.

### `allowed-tools`

List of tools to allow Claude to use, one per line. Passed to `--allowedTools`. Defaults to:

    mcp__github_inline_comment__create_inline_comment
    Read
    Bash(find:*)
    Bash(grep:*)
    Bash(git log:*)
    Bash(git diff:*)
    Bash(git blame:*)
    Bash(gh pr comment:*)
    Bash(gh pr diff:*)
    Bash(gh pr review --comment:*)
    Bash(gh pr view:*)
    Bash(gh run list:*)
    Bash(gh run view:*)
    Bash(gh api:*)

### `additional-allowed-tools`

List of additional tools to allow Claude to use, one per line. Added to `allowed-tools` and then passed to `--allowedTools`. Empty default.

This is useful if you just want to add a tool to the default tool list.

### `gh-pr-render-version`

Version of the [gh-pr-render] tool to use. Defaults to the latest version at the time of this action’s release.

## Details

### PR updates

When a PR is updated this compares the version of the PR to the new version. If they are identical, e.g. the PR was rebased on changes to another part of the codebase, it does not trigger Claude to re-review.

If the changes are not identical then this provides Claude with a diff-of-diffs so that it can see what was changed.

[gh-pr-render]: https://github.com/danielparks/gh-pr-render
[workflow-review.yaml]: workflow-review.yaml
[workflow-response.yaml]: workflow-response.yaml
