# claude-pr-review action — give Claude context for PR reviews

This gives Claude a full view of the discussion in a PR using [gh-pr-render]. Diff comments are included with their nearest partial diff, but the overall diff is not provided.

This also makes Claude smarter about re-reviewing updated PRs.

## Quick start

```yaml
- uses: danielparks/claude-pr-review@620cb52116299bace8e287b6483ab8599a5d363a # HEAD
  with:
    # You can set either of these secrets. If both are set, the API key
    # seems to win.
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    initial-review-prompt: |
      Please review this pull request. The PR branch is already checked
      out in the current working directory, and the PR discussion is
      included below.

      - Use `mcp__github_inline_comment__create_inline_comment` (with
        `confirmed: true`) to highlight specific code issues.
      - Use `gh api repos/${{ github.repository }}/pulls/${{ github.event.pull_request.number }}/comments/$ID/replies -X POST -f "body=$BODY"`
        to reply to diff comments, replacing `$ID` with the comment id
        and `$BODY` with your reply.
      - Use `gh pr comment` for top-level feedback. Don't repeat feedback
        there that you've already given elsewhere.
      - Only post GitHub comments — don't submit review text as messages.
    re-review-prompt: |
      This pull request has been updated. The PR discussion (including
      your prior review) and a diff of what changed since your last
      review are included below.

      Update your feedback to reflect the current state of the PR:
      - Resolve or update any comments that have been addressed.
      - Flag any new issues introduced by the changes.
      - Use `mcp__github_inline_comment__create_inline_comment` (with
        `confirmed: true`) to highlight new specific code issues.
      - Use `gh api repos/${{ github.repository }}/pulls/${{ github.event.pull_request.number }}/comments/$ID/replies -X POST -f "body=$BODY"`
        to reply to diff comments, replacing `$ID` with the comment id
        and `$BODY` with your reply.
      - Use `gh pr comment` for top-level feedback. Don't repeat feedback
        there that you've already given elsewhere.
      - Only post GitHub comments — don't submit review text as messages.
```

See example [workflow-review.yaml] for a working PR-triggered workflow, and example [workflow-response.yaml] for a working comment (@claude) triggered workflow. This repo uses both.

## Details

### PR updates

When a PR is updated this compares the version of the PR to the new version. If they are identical, e.g. the PR was rebased on changes to another part of the codebase, it does not trigger Claude to re-review.

If the changes are not identical then this provides Claude with a diff-of-diffs so that it can see what was changed.

[gh-pr-render]: https://github.com/danielparks/gh-pr-render
[workflow-review.yaml]: workflow-review.yaml
[workflow-response.yaml]: workflow-response.yaml
