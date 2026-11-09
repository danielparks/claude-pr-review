# Permissions and trust

What can Claude actually do when it reviews a PR with this action, and what stops it from doing more? There are several independent layers. Each one is imperfect on its own; the point is that they overlap.

The threat to keep in mind is **prompt injection**: a PR, comment, or file that Claude reads contains instructions that try to make it do something you didn’t intend. Claude is generally reliable, but the layers below are what constrain the damage when it isn’t.

## The layers

### 1. The workflow token (`GITHUB_TOKEN`)

Constrained by the `permissions:` block in your workflow. The example workflows grant only `contents: read`, `pull-requests: write`, `issues: write`, `actions: read`, and `id-token: write`, and check out with `persist-credentials: false`, so git has no stored credentials and cannot push.

This action uses the workflow token for setup (rendering the PR discussion, fetching labels) and for the fallback `sweep` step after Claude finishes (see below).

**This layer does not constrain Claude** — see the next one.

### 2. The Claude App token

[anthropics/claude-code-action] exchanges the workflow’s OIDC token for an installation token from the Claude GitHub App. That is what makes comments post as `claude[bot]`.

Things we have observed or know from the app’s configuration:

- **It is not limited by your workflow’s `permissions:`.** In a test workflow that granted only `contents: read`, the app token passed authorization on `POST /git/refs` (it got a 422 validation error rather than a 403), and it could create an issue. Treat it as having everything the app installation was granted: read access to administration, commit statuses, merge queues, and metadata, and read/write access to actions, checks, code, discussions, issues, pull requests, repository creation, repository hooks, and workflows.
- **It reaches anything Claude runs through its Bash tool**, and any hooks. It does not reach MCP servers.
- **It is revoked as soon as the Claude step finishes.** Later steps in the job cannot use it.
- You cannot currently supply your own token or change the app’s permissions through this action.

In practice this means: **anything Claude can run that talks to GitHub can use that token to write to your repository**, including pushing code and editing workflows, unless something in layers 3–5 stops it. If you are not comfortable with that, do not widen layer 3.

### 3. Claude Code’s tool permissions (`allowed-tools`)

Claude can only run Bash commands that match an entry in `allowed-tools` / `additional-allowed-tools`; anything else is denied with a message naming the command (`cli/pr-review-permission-prompt`). The default list is read-only with respect to your repository:

- `git log`, `git diff`, `git blame`, `find`, `grep` — local reads. Claude Code’s harness refuses `find -exec` and `find -delete` even when `find` is allowed.
- `gh pr diff`, `gh pr view`, `gh run list`, `gh run view` — read-only GitHub queries.
- `pr-review ...` — the bundled CLI, which can only post comments and replies, manage allowed labels, and handle its own queue. It cannot push, merge, or edit files.
- `Edit` is limited to `/tmp/pr-review-scratch/**`.

Allow-list entries are **prefix matches on the command line**, so they are a statement about commands, not about effects. The risky additions are the ones that hand Claude a general way to reach the network or run code, because with the app token in its environment those become ways to write to GitHub:

- `Bash(gh api:*)`, `Bash(gh pr merge:*)`, `Bash(gh workflow run:*)` and other mutating `gh` commands.
- `Bash(git:*)`, `Bash(git push:*)`, `Bash(git remote:*)`, `Bash(git config:*)` and anything else that can push or change what git does.
- `Bash(curl:*)`, `Bash(wget:*)`, and interpreters (`node`, `python`, `bash`, `sh`, `npx`, `npm`, …), which can do anything the token can, and can also send data elsewhere.

Narrow read-only git commands are fine to add — for example `Bash(git tag -l:*)`, `Bash(git show:*)`, or `Bash(git rev-parse:*)` — but be wary of entries that end in a bare command name followed by `:*` when that command has write modes.

### 4. The `pr-review` CLI’s own checks

Within the CLI there are further limits that don’t depend on the command line matching:

- Subcommands that change merge state (`approve-review`, `request-changes-review`) or act on threads and reviews (`resolve-my-thread`, `hide-my-review`, and their unchecked `-any-` counterparts) are **opt-in**; see [Opt-in tools][opt-in-tools].
- `add-label` / `remove-label` only work on labels matched by `available-labels`, read from a file Claude cannot write to.
- Comment bodies have GitHub token patterns redacted before they are posted.
- Queued `APPROVE` reviews are downgraded to `COMMENT` whenever `sweep` posts them.

### 5. Things you control in the repository

These are independent of this action and are the strongest defenses available today:

- **Branch protection or rulesets** on your default branch: require pull requests and reviews, block force pushes, and keep the Claude app off any bypass list. Where your plan supports it, restrict changes to `.github/workflows/**` with a push rule or `CODEOWNERS`.
- **Who can trigger Claude.** The example workflows only run for PR authors whose `author_association` is `OWNER`, `COLLABORATOR`, or `MEMBER`. Don’t run this on untrusted PRs, and don’t use `pull_request_target` with it.
- **“Allow GitHub Actions to create and approve pull requests”** does _not_ constrain the Claude app, because its token is a different credential than the workflow’s. See [Opt-in tools][opt-in-tools].
- **The thinking log artifact** (`thinking-log-artifact-retention`) is redacted on a best-effort basis and may expose secrets; think twice before enabling it on a public repository.

## Tightening things up

1. Keep `allowed-tools` as it is, and be conservative with `additional-allowed-tools`. Prefer exact, narrow entries over `:*` on commands with write modes, and avoid the risky categories listed under layer 3.
2. Turn on branch protection or rulesets, and keep the Claude app out of bypass lists.
3. Gate the workflow on `author_association` as the examples do.
4. Leave the opt-in `pr-review` subcommands off unless you need them, and document in your `additional-prompt` when Claude should use them.

[anthropics/claude-code-action]: https://github.com/anthropics/claude-code-action
[opt-in-tools]: cli/README.md#opt-in-tools
