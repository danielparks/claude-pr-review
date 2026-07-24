import { describe, expect, it } from "vitest";
import {
  apiErrorHint,
  createReply,
  createReview,
  getHeadSha,
  getReview,
  getThreadFirstCommentAuthor,
  getViewerLogin,
  isApprovalRejected,
  minimizeReview,
  resolveReviewThread,
} from "../lib/github.js";
import { withMockGitHub, filterByUrlEnd } from "./support/mock-github.js";

const TOKEN_ORG_REPO = ["test", "acme", "widgets"];

describe("github", () => {
  it("getHeadSha() fetches the PR's head commit sha", async () => {
    await withMockGitHub(
      {
        method: "GET",
        pattern: /\/pulls\/5$/,
        body: { head: { sha: "deadbeef" } },
      },

      async () => {
        expect(await getHeadSha(...TOKEN_ORG_REPO, 5)).toBe("deadbeef");
      },
    );
  });

  it("createReview() posts commit_id/body/event/comments and returns id/html_url", async () => {
    await withMockGitHub(
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

      async ({ requests }) => {
        const comments = [
          { path: "a.js", body: "issue", side: "RIGHT", line: 1 },
        ];
        expect(
          await createReview(...TOKEN_ORG_REPO, 5, comments, "looks good"),
        ).toEqual({
          id: 111,
          html_url: "https://example/review/111",
        });
        const [reviewRequest] = filterByUrlEnd(requests, "/reviews");
        expect(reviewRequest.body).toMatchObject({
          commit_id: "deadbeef",
          body: "looks good",
          event: "COMMENT",
          comments,
        });
      },
    );
  });

  it("createReview() defaults to a COMMENT event but accepts an override", async () => {
    await withMockGitHub(
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

      async ({ requests }) => {
        await createReview(...TOKEN_ORG_REPO, 5, [], "go", "APPROVE");

        const [reviewRequest] = filterByUrlEnd(requests, "/reviews");
        expect(reviewRequest.body).toMatchObject({
          body: "go",
          event: "APPROVE",
          comments: [],
        });
      },
    );
  });

  it("resolveReviewThread() posts the mutation with the given thread id", async () => {
    await withMockGitHub(
      {
        method: "POST",
        pattern: /\/graphql$/,
        body: {
          data: { resolveReviewThread: { thread: { id: "thread1" } } },
        },
      },

      async ({ requests }) => {
        await resolveReviewThread("test", "thread1");

        expect(requests[0].body.variables).toEqual({ threadId: "thread1" });
        expect(requests[0].body.query).toMatch(/resolveReviewThread/);
      },
    );
  });

  it("resolveReviewThread() throws on a GraphQL errors response", async () => {
    await withMockGitHub(
      {
        method: "POST",
        pattern: /\/graphql$/,
        body: { errors: [{ message: "Could not resolve to a node." }] },
      },

      async () => {
        await expect(resolveReviewThread("test", "bad-id")).rejects.toSatisfy(
          (error) => {
            expect(apiErrorHint(error)).toMatch(/thread or review id/);
            return true;
          },
        );
      },
    );
  });

  it("getReview() fetches a review by id", async () => {
    await withMockGitHub(
      {
        method: "GET",
        pattern: /\/pulls\/5\/reviews\/111$/,
        body: { node_id: "review-node-1", user: { login: "claude[bot]" } },
      },

      async () => {
        expect(await getReview(...TOKEN_ORG_REPO, 5, 111)).toEqual({
          node_id: "review-node-1",
          user: { login: "claude[bot]" },
        });
      },
    );
  });

  it("minimizeReview() posts the mutation with the given node id", async () => {
    await withMockGitHub(
      {
        method: "POST",
        pattern: /\/graphql$/,
        body: {
          data: {
            minimizeComment: { minimizedComment: { isMinimized: true } },
          },
        },
      },

      async ({ requests }) => {
        await minimizeReview("test", "review-node-1");

        const [graphqlRequest] = filterByUrlEnd(requests, "/graphql");
        expect(graphqlRequest.body.variables).toEqual({
          subjectId: "review-node-1",
        });
        expect(graphqlRequest.body.query).toMatch(/minimizeComment/);
        expect(graphqlRequest.body.query).toMatch(/OUTDATED/);
      },
    );
  });

  it("getViewerLogin() fetches the authenticated user's login via GraphQL viewer", async () => {
    await withMockGitHub(
      {
        method: "POST",
        pattern: /\/graphql$/,
        body: { data: { viewer: { login: "claude[bot]" } } },
      },

      async ({ requests }) => {
        expect(await getViewerLogin("test")).toBe("claude[bot]");
        expect(requests[0].body.query).toMatch(/viewer/);
      },
    );
  });

  it("getThreadFirstCommentAuthor() returns the first comment's author login, not a later one", async () => {
    await withMockGitHub(
      {
        method: "POST",
        pattern: /\/graphql$/,
        body: {
          data: {
            node: {
              comments: {
                nodes: [
                  { author: { login: "someone" } },
                  { author: { login: "someone-else" } },
                ],
              },
            },
          },
        },
      },

      async ({ requests }) => {
        expect(await getThreadFirstCommentAuthor("test", "thread1")).toBe(
          "someone",
        );
        expect(requests[0].body.variables).toEqual({ threadId: "thread1" });
        expect(requests[0].body.query).toMatch(/PullRequestReviewThread/);
      },
    );
  });

  it("getThreadFirstCommentAuthor() returns null when the thread has no comments", async () => {
    await withMockGitHub(
      {
        method: "POST",
        pattern: /\/graphql$/,
        body: { data: { node: { comments: { nodes: [] } } } },
      },

      async () => {
        expect(await getThreadFirstCommentAuthor("test", "thread1")).toBeNull();
      },
    );
  });

  it("createReply() posts to the comment's replies endpoint", async () => {
    await withMockGitHub(
      {
        method: "POST",
        pattern: /\/comments\/999\/replies$/,
        body: { id: 222, html_url: "https://example/comment/222" },
      },

      async ({ requests }) => {
        expect(
          await createReply(...TOKEN_ORG_REPO, 5, 999, "thanks, fixed"),
        ).toEqual({
          id: 222,
          html_url: "https://example/comment/222",
        });
        expect(requests[0].body).toEqual({ body: "thanks, fixed" });
      },
    );
  });

  it("apiErrorHint() adds a hint for a 404 from a failed request", async () => {
    await withMockGitHub(
      {
        method: "POST",
        pattern: /\/comments\/999\/replies$/,
        status: 404,
        body: { message: "Not Found" },
      },

      async () => {
        await expect(
          createReply(...TOKEN_ORG_REPO, 5, 999, "x"),
        ).rejects.toSatisfy((error) => {
          expect(apiErrorHint(error)).toMatch(/comment id/);
          return true;
        });
      },
    );
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
    await withMockGitHub(
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

      async () => {
        await expect(
          createReview(...TOKEN_ORG_REPO, 5, [], "", "APPROVE"),
        ).rejects.toSatisfy((error) => {
          expect(isApprovalRejected(error)).toBe(true);
          expect(apiErrorHint(error)).toMatch(/did not allow this token/);
          return true;
        });
      },
    );
  });

  it("isApprovalRejected() is false for an unrelated 422", async () => {
    await withMockGitHub(
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

      async () => {
        await expect(
          createReview(...TOKEN_ORG_REPO, 5, [], "x"),
        ).rejects.toSatisfy((error) => {
          expect(isApprovalRejected(error)).toBe(false);
          expect(apiErrorHint(error)).toMatch(/line number doesn't exist/);
          return true;
        });
      },
    );
  });

  it("isApprovalRejected() is false for a plain Error", () => {
    expect(isApprovalRejected(new Error("nope"))).toBe(false);
  });
});
