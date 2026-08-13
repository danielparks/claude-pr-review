import { fail } from "./util.js";

const DEFAULT_API_URL = "https://api.github.com";

export class GitHubApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.body = body;
  }
}

const DEFAULT_GRAPHQL_URL = "https://api.github.com/graphql";

function apiBase() {
  return process.env.GITHUB_API_URL || DEFAULT_API_URL;
}

function graphqlUrl() {
  return process.env.GITHUB_GRAPHQL_URL || DEFAULT_GRAPHQL_URL;
}

async function request(token, method, path, body) {
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "claude-pr-review-cli",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const message = (data && data.message) || res.statusText;
    throw new GitHubApiError(
      `GitHub API ${method} ${path} failed: ${res.status} ${message}`,
      res.status,
      data,
    );
  }
  return data;
}

async function graphqlRequest(token, query, variables) {
  const res = await fetch(graphqlUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "claude-pr-review-cli",
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await res.json();
  if (!res.ok || data.errors) {
    const message =
      data.errors && data.errors.length
        ? data.errors.map((e) => e.message).join("; ")
        : res.statusText || res.status;
    throw new GitHubApiError(
      `GitHub GraphQL request failed: ${message}`,
      res.status,
      data,
    );
  }
  return data.data;
}

export async function getHeadSha({ token, owner, repo, pr }) {
  const data = await request(
    token,
    "GET",
    `/repos/${owner}/${repo}/pulls/${pr}`,
  );
  return data.head.sha;
}

/** Posts one grouped review (comments + optional top-level body). */
export async function createReview(context, comments, body, event = "COMMENT") {
  const { token, owner, repo, pr } = context;
  const commit_id = await getHeadSha(context);
  const { id, html_url } = await request(
    token,
    "POST",
    `/repos/${owner}/${repo}/pulls/${pr}/reviews`,
    { commit_id, body, event, comments },
  );
  return { id, html_url };
}

/** Resolves an inline-comment thread given its GraphQL node id. */
export async function resolveReviewThread(token, threadId) {
  await graphqlRequest(
    token,
    `mutation($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread { id }
      }
    }`,
    { threadId },
  );
}

/**
 * The login of the authenticated (Claude App) user, e.g. `claude[bot]`.
 *
 * Uses GraphQL rather than REST's `GET /user` because that REST endpoint is
 * user-to-server only -- it 403s ("Resource not accessible by integration")
 * for a GitHub App installation token, which is what this token always is
 * here. GraphQL's `viewer` field is documented to resolve to the app's bot
 * user for an installation token instead of erroring.
 */
export async function getViewerLogin(token) {
  const data = await graphqlRequest(token, `query { viewer { login } }`);
  return data.viewer.login;
}

/**
 * Get the login of the author of a review thread's first comment.
 *
 * Takes the thread's GraphQL node id. Returns `null` if there is no first
 * comment or no author (shouldn't normally happen for a real thread).
 */
export async function getThreadFirstCommentAuthor(token, threadId) {
  const data = await graphqlRequest(
    token,
    `query($threadId: ID!) {
      node(id: $threadId) {
        ... on PullRequestReviewThread {
          comments(first: 1) {
            nodes { author { login } }
          }
        }
      }
    }`,
    { threadId },
  );
  return data.node?.comments?.nodes?.[0]?.author?.login ?? null;
}

/** Fetches a single review, given its REST id. */
export async function getReview({ token, owner, repo, pr }, reviewId) {
  return await request(
    token,
    "GET",
    `/repos/${owner}/${repo}/pulls/${pr}/reviews/${reviewId}`,
  );
}

/** Minimizes a top-level review as outdated, given its GraphQL node id. */
export async function minimizeReview(token, nodeId) {
  await graphqlRequest(
    token,
    `mutation($subjectId: ID!) {
      minimizeComment(input: { subjectId: $subjectId, classifier: OUTDATED }) {
        minimizedComment { isMinimized }
      }
    }`,
    { subjectId: nodeId },
  );
}

/**
 * True if `error` is GitHub rejecting an APPROVE review specifically because
 * the token isn't permitted to approve pull requests (confirmed empirically:
 * a 422 whose `errors` is an array of strings, one of which contains this
 * phrase -- distinct from the usual array-of-objects validation-error shape).
 */
export function isApprovalRejected(error) {
  return (
    error instanceof GitHubApiError &&
    error.status === 422 &&
    Array.isArray(error.body?.errors) &&
    error.body.errors.some(
      (e) => typeof e === "string" && /not permitted to approve/i.test(e),
    )
  );
}

export async function createReply({ token, owner, repo, pr }, commentId, body) {
  const { id, html_url } = await request(
    token,
    "POST",
    `/repos/${owner}/${repo}/pulls/${pr}/comments/${commentId}/replies`,
    { body },
  );
  return { id, html_url };
}

/**
 * Fetches every top-level (issue) comment on a PR, oldest first.
 *
 * PRs share GitHub's issue comments API, so this is the same endpoint used
 * for plain issues. Pages through the full history rather than stopping
 * early, since the caller needs to find one comment by marker text and
 * that comment could be old.
 */
export async function listIssueComments({ token, owner, repo, pr }) {
  const perPage = 100;
  const all = [];
  for (let page = 1; ; page++) {
    const data = await request(
      token,
      "GET",
      `/repos/${owner}/${repo}/issues/${pr}/comments?per_page=${perPage}&page=${page}`,
    );
    all.push(...data);
    if (data.length < perPage) break;
  }
  return all;
}

/** Posts a new top-level (issue) comment on a PR. */
export async function createIssueComment({ token, owner, repo, pr }, body) {
  const { id, html_url } = await request(
    token,
    "POST",
    `/repos/${owner}/${repo}/issues/${pr}/comments`,
    { body },
  );
  return { id, html_url };
}

/** Lists every label defined on the repo (not just those applied to a PR). */
export async function listRepoLabels({ token, owner, repo }) {
  const perPage = 100;
  const all = [];
  for (let page = 1; ; page++) {
    const data = await request(
      token,
      "GET",
      `/repos/${owner}/${repo}/labels?per_page=${perPage}&page=${page}`,
    );
    all.push(...data);
    if (data.length < perPage) break;
  }
  return all;
}

/** Adds a label to a PR/issue. */
export async function addLabel({ token, owner, repo, pr }, label) {
  await request(token, "POST", `/repos/${owner}/${repo}/issues/${pr}/labels`, {
    labels: [label],
  });
}

/**
 * Removes a label from a PR/issue.
 *
 * Returns false if the label was not applied (GitHub returns 404 for both
 * "label not applied" and "label doesn't exist in repo").
 */
export async function removeLabel({ token, owner, repo, pr }, label) {
  try {
    await request(
      token,
      "DELETE",
      `/repos/${owner}/${repo}/issues/${pr}/labels/${encodeURIComponent(label)}`,
    );
    return true;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return false;
    }
    throw error;
  }
}

/** Overwrites the body of an existing top-level (issue) comment. */
export async function updateIssueComment(
  { token, owner, repo },
  commentId,
  body,
) {
  const { id, html_url } = await request(
    token,
    "PATCH",
    `/repos/${owner}/${repo}/issues/comments/${commentId}`,
    { body },
  );
  return { id, html_url };
}

/** A human-readable hint appended to error messages surfaced to Claude. */
export function apiErrorHint(error) {
  const status = error instanceof GitHubApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : String(error);

  if (isApprovalRejected(error)) {
    return (
      "\n\nGitHub did not allow this token to approve the pull request. " +
      "This should have been caught and downgraded to a comment " +
      "automatically -- if you're seeing this, something went wrong with " +
      "that fallback."
    );
  }
  if (status === 422 || /Validation Failed/i.test(message)) {
    return (
      "\n\nThis usually means a line number doesn't exist in the diff, or " +
      "the file path is wrong. Only comment on lines that are part of the " +
      "PR's changes."
    );
  }
  if (status === 404 || /Not Found/i.test(message)) {
    return (
      "\n\nThis usually means the PR number, repository, comment id, or " +
      "file path is incorrect."
    );
  }
  if (/Could not resolve to a node/i.test(message)) {
    return "\n\nThis usually means the thread or review id is wrong or stale.";
  }
  return "";
}

/**
 * Wrapper to fail correctly when a (likely) API error is raised.
 *
 * It’s fine if this catches some other error — apiErrorHint() will return "".
 */
export async function withApiError(func) {
  try {
    return await func();
  } catch (error) {
    fail(`${error.message}${apiErrorHint(error)}`);
  }
}
