# claude-pr-review action — give Claude context for PR reviews

Have Claude review and re-review pull requests with the context of all the comments in the pull request, including inline comments along with the nearest diff fragment.

The full diff is saved to a file to allow Claude to read it however it likes. Claude’s first step in a review is almost always to get the diff, so this skips at least one tool use.

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

### `prompt`

Prompt sent to Claude for both initial reviews and re-reviews. Claude determines
the current state of the PR from context. Defaults to:

<!-- default:prompt -->

    Please review this pull request. /tmp/pr.patch contains the overall diff
    for the PR, the PR branch is checked out in the current working directory,
    and the PR discussion is included below.

    If there are prior review comments from you in the PR discussion, treat
    this as a re-review. Respond to discussion as appropriate, and review new
    changes. If nothing has changed there is no need to note it unless the
    user seems to think that changes were made.

    Only post GitHub comments — don't submit review text as messages.

    For the commands below: write the comment body to a file under
    /tmp/pr-review-scratch first with the Write tool, then pass that file's
    path with `--body-file`. This avoids shell special characters.

    1. Use `pr-review reply-inline-comment --comment-id ID --body-file PATH`
       to reply to existing inline comments if they have been resolved, if
       changes have been made that haven’t resolved them, or if you have new
       information. This posts immediately.
    2. Use `pr-review queue-inline-comment --path PATH --line N --body-file
       PATH` for every specific code issue you find in new code. This only
       queues the comment; nothing is posted yet.
    3. Use `pr-review comment-review --body-file PATH` once at the end if
       you want to leave top-level feedback. This will submit all queued
       comments; if you don't call it queued comments will be submitted
       after you finish. Do not repeat comments made inline, though you may
       briefly list issues that remain unresolved from a previous review.

    If it's useful you may link to specific comments, but don’t refer to them
    by ID — the user does not have easy access to that.

    - `#discussion_rID` — an inline comment.
    - `#pullrequestreview-ID` — a top-level review comment.
    - `#issuecomment-ID` — a top-level non-review comment.

<!-- /default:prompt -->

### `additional-prompt`

Appended after `prompt`. Empty default.

This is useful if you just want to add text to the default prompt.

### `allowed-tools`

List of tools to allow Claude to use, one per line. Passed to `--allowedTools`. Defaults to:

<!-- default:allowed-tools -->

    Read
    Bash(find:*)
    Bash(grep:*)
    Bash(git log:*)
    Bash(git diff:*)
    Bash(git blame:*)
    Bash(gh pr diff:*)
    Bash(gh pr view:*)
    Bash(gh run list:*)
    Bash(gh run view:*)
    Bash(pr-review queue-inline-comment:*)
    Bash(pr-review reply-inline-comment:*)
    Bash(pr-review comment-review:*)
    Bash(pr-review list-queue:*)
    Bash(pr-review discard-queue:*)

    # From https://code.claude.com/docs/en/agent-sdk/permissions.md:
    #
    # > Use `//path` for an absolute filesystem path: a deny rule of
    # > `Edit(//secrets/**)` blocks writes anywhere under `/secrets` on disk.
    # > With a single leading slash, `Edit(/secrets/**)` anchors at the rule's
    # > source instead.
    Edit(//tmp/pr-review-scratch/**)

    # Needed to view long inline comment threads:
    Bash(gh-pr-render:*)

<!-- /default:allowed-tools -->

### `additional-allowed-tools`

List of additional tools to allow Claude to use, one per line. Added to `allowed-tools` and then passed to `--allowedTools`. Empty default.

This is useful if you just want to add a tool to the default tool list. In particular, see the [“Opt-in tools”][opt-in-tools] section of [`cli/README.md`] for `pr-review` subcommands that are deliberately left out of the default list.

### `gh-pr-render-version`

Version of the [gh-pr-render] tool to use. Defaults to the latest version at the time of this action’s release.

### `thinking-log-artifact-retention`

How long to keep the Claude thinking log artifact in days. `disabled` or `0` means not to create it.

The thinking log is an HTML file that contains some of Claude’s internal thoughts and all of its tool uses.

> [!WARNING]
> The log can contain repository secrets. Artifacts are available to the public on public repositories.

This attempts to redact GitHub tokens, Anthropic API keys, and other Anthropic secrets. There is no guarantee that it will succeed — keys could be broken up into multiple strings.

Defaults to: `disabled`

## Details

### Posting review comments

This action bundles its own CLI tool, [`cli/pr-review`], that `action.yaml` puts on `PATH` for Claude to run via its Bash tool:

- `pr-review queue-inline-comment` queues an inline comment on disk. Nothing is posted to GitHub until `comment-review` is called.
- `pr-review comment-review` posts everything queued by `queue-inline-comment`, plus an optional top-level body, as a single grouped comment review. Claude doesn’t have to call this itself — `action.yaml` runs it automatically after Claude’s turn ends if anything is still queued.
- `pr-review reply-inline-comment` replies to an existing inline comment thread; this posts immediately, since replies attach to an existing thread rather than a new review.
- `pr-review list-queue` and `pr-review discard-queue --dir PATH` let Claude recover if a submission fails for a reason that won’t change on retry (e.g. GitHub rejecting an inline comment’s line number): after fixing the problem and resubmitting successfully, Claude can discard the original failed batch so the automatic post-turn sweep doesn’t keep retrying — and failing on — it.

[anthropics/claude-code-action]’s built-in inline-comment tool posts each inline comment through GitHub’s single-comment REST endpoint, which creates and submits its own standalone review every time — so a review with five comments shows up as five separate reviews instead of one.

This is a Bash-invoked CLI tool rather than an MCP server so that it can post as `claude[bot]` instead of `github-actions[bot]`: the Claude App token only reaches subprocesses that inherit [anthropics/claude-code-action]’s real environment, which a Bash-tool call does and an MCP server does not. It’s plain, dependency-free JavaScript that `action.yaml` runs directly with no build step — see [`cli/README.md`] for more information, including the [opt-in `pr-review` subcommands][opt-in-tools] that are left out of the default `allowed-tools` list.

### PR updates

When a PR is updated this compares the version of the PR to the new version. If they are identical, e.g. the PR was rebased on changes to another part of the codebase, it does not trigger Claude to re-review.

If the changes are not identical then this provides Claude with a diff-of-diffs so that it can see what was changed.

[gh-pr-render]: https://github.com/danielparks/gh-pr-render
[workflow-review.yaml]: workflow-review.yaml
[workflow-response.yaml]: workflow-response.yaml
[anthropics/claude-code-action]: https://github.com/anthropics/claude-code-action
[`cli/pr-review`]: cli/pr-review
[opt-in-tools]: cli/README.md#opt-in-tools
[`cli/README.md`]: cli/README.md
