const DEFAULT_API_URL = "https://api.github.com";

export class GitHubApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.body = body;
  }
}

function apiBase() {
  return process.env.GITHUB_API_URL || DEFAULT_API_URL;
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
) {
  const commit_id = await getHeadSha(token, owner, repo, pullNumber);
  const data = await request(
    token,
    "POST",
    `/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`,
    { commit_id, body, event: "COMMENT", comments },
  );
  return { id: data.id, html_url: data.html_url };
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

/** A human-readable hint appended to error messages surfaced to Claude. */
export function apiErrorHint(error) {
  const status = error instanceof GitHubApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : String(error);

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
  return "";
}
