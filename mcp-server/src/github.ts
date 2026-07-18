import { Octokit } from "@octokit/rest";
import { RequestError } from "@octokit/request-error";
import type { ReviewComment } from "./types.js";

export interface GitHubClientOptions {
  token: string;
  owner: string;
  repo: string;
  pullNumber: number;
  baseUrl?: string;
}

export interface SubmittedReview {
  id: number;
  html_url: string;
}

export interface PostedReply {
  id: number;
  html_url: string;
}

export class GitHubClient {
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;
  private readonly pullNumber: number;
  private cachedHeadSha: string | undefined;

  constructor(options: GitHubClientOptions) {
    this.octokit = new Octokit({
      auth: options.token,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    });
    this.owner = options.owner;
    this.repo = options.repo;
    this.pullNumber = options.pullNumber;
  }

  async getHeadSha(): Promise<string> {
    if (!this.cachedHeadSha) {
      const { data } = await this.octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: this.pullNumber,
      });
      this.cachedHeadSha = data.head.sha;
    }
    return this.cachedHeadSha;
  }

  async createReview(
    comments: ReviewComment[],
    body: string,
  ): Promise<SubmittedReview> {
    const commit_id = await this.getHeadSha();
    const {
      data: { id, html_url },
    } = await this.octokit.rest.pulls.createReview({
      owner: this.owner,
      repo: this.repo,
      pull_number: this.pullNumber,
      commit_id,
      body,
      event: "COMMENT",
      comments,
    });
    return { id, html_url };
  }

  async createReply(commentId: number, body: string): Promise<PostedReply> {
    const {
      data: { id, html_url },
    } = await this.octokit.rest.pulls.createReplyForReviewComment({
      owner: this.owner,
      repo: this.repo,
      pull_number: this.pullNumber,
      comment_id: commentId,
      body,
    });
    return { id, html_url };
  }
}

/** A human-readable hint appended to error messages surfaced to Claude. */
export function helpMessageFor(error: unknown): string {
  const status = error instanceof RequestError ? error.status : undefined;
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
