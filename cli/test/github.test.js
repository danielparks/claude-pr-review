import { afterEach, describe, expect, it, beforeEach } from "vitest";
import {
  apiErrorHint,
  createReply,
  createReview,
  getHeadSha,
  hideReview,
  isApprovalRejected,
  resolveReviewThread,
} from "../lib/github.js";
import { startMockGitHub } from "./support/mock-github.js";

describe("github", () => {
  let mock;
  let originalApiUrl;
  let originalGraphqlUrl;

  beforeEach(() => {
    originalApiUrl = process.env.GITHUB_API_URL;
    originalGraphqlUrl = process.env.GITHUB_GRAPHQL_URL;
  });

  afterEach(async () => {
    await mock?.close();
    if (originalApiUrl === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = originalApiUrl;
    if (originalGraphqlUrl === undefined) {
      delete process.env.GITHUB_GRAPHQL_URL;
    } else {
      process.env.GITHUB_GRAPHQL_URL = originalGraphqlUrl;
    }
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

  it("createReview() defaults to a COMMENT event but accepts an override", async () => {
    mock = await startMockGitHub([
      {
        method: "GET",
        pattern: /\/pulls\/5$/,
        body: { head: { sha: "deadbeef" } },
      },
      {
        method: "POST",
        pattern: /\/pulls\/5\/reviews$/,
        body: { id: 115, html_url: "https://example/review/115" },
      },
    ]);
    process.env.GITHUB_API_URL = mock.baseUrl;

    await createReview("test", "acme", "widgets", 5, [], "ship it", "APPROVE");

    const [reviewRequest] = mock.requests.filter((r) =>
      r.url.endsWith("/reviews"),
    );
    expect(reviewRequest.body).toMatchObject({
      body: "ship it",
      event: "APPROVE",
      comments: [],
    });
  });

  it("resolveReviewThread() posts the mutation with the given thread id", async () => {
    mock = await startMockGitHub([
      {
        method: "POST",
        pattern: /\/graphql$/,
        body: { data: { resolveReviewThread: { thread: { id: "thread1" } } } },
      },
    ]);
    process.env.GITHUB_GRAPHQL_URL = `${mock.baseUrl}/graphql`;

    await resolveReviewThread("test", "thread1");

    const [request] = mock.requests;
    expect(request.body.variables).toEqual({ threadId: "thread1" });
    expect(request.body.query).toMatch(/resolveReviewThread/);
  });

  it("resolveReviewThread() throws on a GraphQL errors response", async () => {
    mock = await startMockGitHub([
      {
        method: "POST",
        pattern: /\/graphql$/,
        body: { errors: [{ message: "Could not resolve to a node." }] },
      },
    ]);
    process.env.GITHUB_GRAPHQL_URL = `${mock.baseUrl}/graphql`;

    await expect(resolveReviewThread("test", "bad-id")).rejects.toSatisfy(
      (error) => {
        expect(apiErrorHint(error)).toMatch(/thread or review id/);
        return true;
      },
    );
  });

  it("hideReview() looks up the review's node id, then minimizes it", async () => {
    mock = await startMockGitHub([
      {
        method: "GET",
        pattern: /\/pulls\/5\/reviews\/111$/,
        body: { node_id: "review-node-1" },
      },
      {
        method: "POST",
        pattern: /\/graphql$/,
        body: {
          data: {
            minimizeComment: { minimizedComment: { isMinimized: true } },
          },
        },
      },
    ]);
    process.env.GITHUB_API_URL = mock.baseUrl;
    process.env.GITHUB_GRAPHQL_URL = `${mock.baseUrl}/graphql`;

    await hideReview("test", "acme", "widgets", 5, 111);

    const [graphqlRequest] = mock.requests.filter((r) =>
      r.url.endsWith("/graphql"),
    );
    expect(graphqlRequest.body.variables).toEqual({
      subjectId: "review-node-1",
    });
    expect(graphqlRequest.body.query).toMatch(/minimizeComment/);
    expect(graphqlRequest.body.query).toMatch(/OUTDATED/);
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

  // Real response body captured from a live Actions run attempting to
  // approve with `github.token`: a 422 whose `errors` is an array of
  // strings, unlike the usual array-of-objects validation-error shape.
  const APPROVAL_REJECTED_BODY = {
    message: "Unprocessable Entity",
    errors: ["GitHub Actions is not permitted to approve pull requests."],
    documentation_url:
      "https://docs.github.com/rest/pulls/reviews#create-a-review-for-a-pull-request",
    status: "422",
  };

  it("isApprovalRejected() recognizes GitHub's actual not-permitted-to-approve response", async () => {
    mock = await startMockGitHub([
      {
        method: "GET",
        pattern: /\/pulls\/5$/,
        body: { head: { sha: "deadbeef" } },
      },
      {
        method: "POST",
        pattern: /\/pulls\/5\/reviews$/,
        status: 422,
        body: APPROVAL_REJECTED_BODY,
      },
    ]);
    process.env.GITHUB_API_URL = mock.baseUrl;

    await expect(
      createReview("test", "acme", "widgets", 5, [], "", "APPROVE"),
    ).rejects.toSatisfy((error) => {
      expect(isApprovalRejected(error)).toBe(true);
      expect(apiErrorHint(error)).toMatch(/did not allow this token/);
      return true;
    });
  });

  it("isApprovalRejected() is false for an unrelated 422", async () => {
    mock = await startMockGitHub([
      {
        method: "GET",
        pattern: /\/pulls\/5$/,
        body: { head: { sha: "deadbeef" } },
      },
      {
        method: "POST",
        pattern: /\/pulls\/5\/reviews$/,
        status: 422,
        body: {
          message: "Validation Failed",
          errors: [{ field: "line", code: "invalid" }],
        },
      },
    ]);
    process.env.GITHUB_API_URL = mock.baseUrl;

    await expect(
      createReview("test", "acme", "widgets", 5, [], "x"),
    ).rejects.toSatisfy((error) => {
      expect(isApprovalRejected(error)).toBe(false);
      expect(apiErrorHint(error)).toMatch(/line number doesn't exist/);
      return true;
    });
  });

  it("isApprovalRejected() is false for a plain Error", () => {
    expect(isApprovalRejected(new Error("nope"))).toBe(false);
  });
});
