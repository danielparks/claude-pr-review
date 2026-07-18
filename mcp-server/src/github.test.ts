import { afterEach, describe, expect, it } from "vitest";
import { GitHubClient, helpMessageFor } from "./github.js";
import { startMockGitHub } from "../test/support/mock-github.js";

describe("GitHubClient", () => {
  let mock: Awaited<ReturnType<typeof startMockGitHub>>;

  afterEach(async () => {
    await mock?.close();
  });

  it("getHeadSha() fetches once and caches", async () => {
    mock = await startMockGitHub([
      {
        method: "GET",
        pattern: /\/pulls\/5$/,
        body: { head: { sha: "deadbeef" } },
      },
    ]);
    const client = new GitHubClient({
      token: "test",
      owner: "acme",
      repo: "widgets",
      pullNumber: 5,
      baseUrl: mock.baseUrl,
    });

    expect(await client.getHeadSha()).toBe("deadbeef");
    expect(await client.getHeadSha()).toBe("deadbeef");
    expect(
      mock.requests.filter((r) => r.url.endsWith("/pulls/5")),
    ).toHaveLength(1);
  });

  it("createReview() posts commit_id/body/event/comments and returns id/html_url", async () => {
    mock = await startMockGitHub([
      {
        method: "GET",
        pattern: /\/pulls\/5$/,
        body: { head: { sha: "deadbeef" } },
      },
      {
        method: "POST",
        pattern: /\/pulls\/5\/reviews$/,
        body: { id: 111, html_url: "https://example/review/111" },
      },
    ]);
    const client = new GitHubClient({
      token: "test",
      owner: "acme",
      repo: "widgets",
      pullNumber: 5,
      baseUrl: mock.baseUrl,
    });

    const comments = [
      { path: "a.js", body: "issue", side: "RIGHT" as const, line: 1 },
    ];
    const result = await client.createReview(comments, "looks good");

    expect(result).toEqual({ id: 111, html_url: "https://example/review/111" });
    const [reviewRequest] = mock.requests.filter((r) =>
      r.url.endsWith("/reviews"),
    );
    expect(reviewRequest?.body).toMatchObject({
      commit_id: "deadbeef",
      body: "looks good",
      event: "COMMENT",
      comments,
    });
  });

  it("createReply() posts to the comment's replies endpoint", async () => {
    mock = await startMockGitHub([
      {
        method: "POST",
        pattern: /\/comments\/999\/replies$/,
        body: { id: 222, html_url: "https://example/comment/222" },
      },
    ]);
    const client = new GitHubClient({
      token: "test",
      owner: "acme",
      repo: "widgets",
      pullNumber: 5,
      baseUrl: mock.baseUrl,
    });

    const result = await client.createReply(999, "thanks, fixed");
    expect(result).toEqual({
      id: 222,
      html_url: "https://example/comment/222",
    });
    const [replyRequest] = mock.requests;
    expect(replyRequest?.body).toEqual({ body: "thanks, fixed" });
  });

  it("helpMessageFor() adds a hint for a 404 from a failed request", async () => {
    mock = await startMockGitHub([
      {
        method: "POST",
        pattern: /\/comments\/999\/replies$/,
        status: 404,
        body: { message: "Not Found" },
      },
    ]);
    const client = new GitHubClient({
      token: "test",
      owner: "acme",
      repo: "widgets",
      pullNumber: 5,
      baseUrl: mock.baseUrl,
    });

    await expect(client.createReply(999, "x")).rejects.toSatisfy((error) => {
      expect(helpMessageFor(error)).toMatch(/comment id/);
      return true;
    });
  });
});
