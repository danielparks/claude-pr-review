import { afterEach, describe, expect, it, beforeEach } from "vitest";
import {
  apiErrorHint,
  createReply,
  createReview,
  getHeadSha,
} from "../lib/github.js";
import { startMockGitHub } from "./support/mock-github.js";

describe("github", () => {
  let mock;
  let originalApiUrl;

  beforeEach(() => {
    originalApiUrl = process.env.GITHUB_API_URL;
  });

  afterEach(async () => {
    await mock?.close();
    if (originalApiUrl === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = originalApiUrl;
  });

  it("getHeadSha() fetches the PR's head commit sha", async () => {
    mock = await startMockGitHub([
      {
        method: "GET",
        pattern: /\/pulls\/5$/,
        body: { head: { sha: "deadbeef" } },
      },
    ]);
    process.env.GITHUB_API_URL = mock.baseUrl;

    expect(await getHeadSha("test", "acme", "widgets", 5)).toBe("deadbeef");
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
    process.env.GITHUB_API_URL = mock.baseUrl;

    const comments = [{ path: "a.js", body: "issue", side: "RIGHT", line: 1 }];
    const result = await createReview(
      "test",
      "acme",
      "widgets",
      5,
      comments,
      "looks good",
    );

    expect(result).toEqual({ id: 111, html_url: "https://example/review/111" });
    const [reviewRequest] = mock.requests.filter((r) =>
      r.url.endsWith("/reviews"),
    );
    expect(reviewRequest.body).toMatchObject({
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
    process.env.GITHUB_API_URL = mock.baseUrl;

    const result = await createReply(
      "test",
      "acme",
      "widgets",
      5,
      999,
      "thanks, fixed",
    );
    expect(result).toEqual({
      id: 222,
      html_url: "https://example/comment/222",
    });
    const [replyRequest] = mock.requests;
    expect(replyRequest.body).toEqual({ body: "thanks, fixed" });
  });

  it("apiErrorHint() adds a hint for a 404 from a failed request", async () => {
    mock = await startMockGitHub([
      {
        method: "POST",
        pattern: /\/comments\/999\/replies$/,
        status: 404,
        body: { message: "Not Found" },
      },
    ]);
    process.env.GITHUB_API_URL = mock.baseUrl;

    await expect(
      createReply("test", "acme", "widgets", 5, 999, "x"),
    ).rejects.toSatisfy((error) => {
      expect(apiErrorHint(error)).toMatch(/comment id/);
      return true;
    });
  });

  it("apiErrorHint() adds nothing for an unknown error", () => {
    expect(apiErrorHint(new Error("???"))).toEqual("");
  });
});
