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

export async function getHeadSha(token, owner, repo, pullNumber) {
  const data = await request(
    token,
    "GET",
    `/repos/${owner}/${repo}/pulls/${pullNumber}`,
  );
  return data.head.sha;
}

/** Posts one grouped review (comments + optional top-level body). */
export async function createReview(
  token,
  owner,
  repo,
  pullNumber,
  comments,
  body,
  event = "COMMENT",
) {
  const commit_id = await getHeadSha(token, owner, repo, pullNumber);
  const data = await request(
    token,
    "POST",
    `/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`,
    { commit_id, body, event, comments },
  );
  return { id: data.id, html_url: data.html_url };
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
export async function getReview(token, owner, repo, pullNumber, reviewId) {
  return await request(
    token,
    "GET",
    `/repos/${owner}/${repo}/pulls/${pullNumber}/reviews/${reviewId}`,
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

export async function createReply(
  token,
  owner,
  repo,
  pullNumber,
  commentId,
  body,
) {
  const data = await request(
    token,
    "POST",
    `/repos/${owner}/${repo}/pulls/${pullNumber}/comments/${commentId}/replies`,
    { body },
  );
  return { id: data.id, html_url: data.html_url };
}

/**
 * Fetches every top-level (issue) comment on a PR, oldest first.
 *
 * PRs share GitHub's issue comments API, so this is the same endpoint used
 * for plain issues. Pages through the full history rather than stopping
 * early, since the caller needs to find one comment by marker text and
 * that comment could be old.
 */
export async function listIssueComments(token, owner, repo, pullNumber) {
  const perPage = 100;
  const all = [];
  for (let page = 1; ; page++) {
    const data = await request(
      token,
      "GET",
      `/repos/${owner}/${repo}/issues/${pullNumber}/comments?per_page=${perPage}&page=${page}`,
    );
    all.push(...data);
    if (data.length < perPage) break;
  }
  return all;
}

/** Posts a new top-level (issue) comment on a PR. */
export async function createIssueComment(token, owner, repo, pullNumber, body) {
  const data = await request(
    token,
    "POST",
    `/repos/${owner}/${repo}/issues/${pullNumber}/comments`,
    { body },
  );
  return { id: data.id, html_url: data.html_url };
}

/** Overwrites the body of an existing top-level (issue) comment. */
export async function updateIssueComment(token, owner, repo, commentId, body) {
  const data = await request(
    token,
    "PATCH",
    `/repos/${owner}/${repo}/issues/comments/${commentId}`,
    { body },
  );
  return { id: data.id, html_url: data.html_url };
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

/** Adds labels to an issue/PR. All labels must already exist in the repo. */
export async function addLabels(token, owner, repo, issueNumber, labels) {
  await request(
    token,
    "POST",
    `/repos/${owner}/${repo}/issues/${issueNumber}/labels`,
    { labels },
  );
}

/**
 * Removes a label from an issue/PR.
 *
 * Silently succeeds if the label isn’t applied or doesn’t exist in the repo
 * (both return 404 from GitHub).
 */
export async function removeLabel(token, owner, repo, issueNumber, label) {
  try {
    await request(
      token,
      "DELETE",
      `/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
    );
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return;
    }
    throw error;
  }
}
