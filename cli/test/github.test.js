import { describe, expect, it } from "vitest";
import {
  addLabels,
  apiErrorHint,
  createIssueComment,
  createReply,
  createReview,
  getHeadSha,
  getReview,
  getThreadFirstCommentAuthor,
  getViewerLogin,
  isApprovalRejected,
  listIssueComments,
  listRepoLabels,
  minimizeReview,
  removeLabel,
  resolveReviewThread,
  updateIssueComment,
} from "../lib/github.js";
import {
  withMockGitHub,
  filterByUrlEnd,
  route,
  responses,
} from "./support/mock-github.js";

const TOKEN_ORG_REPO = ["test", "acme", "widgets"];

describe("github", () => {
  it("getHeadSha() fetches the PR's head commit sha", async () => {
    await withMockGitHub(
      responses.GET_pull(5, "deadbeef"),

      async () => {
        expect(await getHeadSha(...TOKEN_ORG_REPO, 5)).toBe("deadbeef");
      },
    );
  });

  it("createReview() posts commit_id/body/event/comments and returns id/html_url", async () => {
    await withMockGitHub(
      responses.GET_pull(5, "deadbeef"),
      responses.POST_review(5, 111),

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
      responses.GET_pull(5, "deadbeef"),
      responses.POST_review(5, 115),

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
      responses.graphql({
        body: {
          data: { resolveReviewThread: { thread: { id: "thread1" } } },
        },
      }),

      async ({ requests }) => {
        await resolveReviewThread("test", "thread1");

        expect(requests[0].body.variables).toEqual({ threadId: "thread1" });
        expect(requests[0].body.query).toMatch(/resolveReviewThread/);
      },
    );
  });

  it("resolveReviewThread() throws on a GraphQL errors response", async () => {
    await withMockGitHub(
      responses.graphql({
        body: { errors: [{ message: "Could not resolve to a node." }] },
      }),

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
      responses.GET_pull_review(5, 111, "review-node-1", "claude[bot]"),

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
      responses.graphql({
        body: {
          data: {
            minimizeComment: { minimizedComment: { isMinimized: true } },
          },
        },
      }),

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
      responses.graphql({
        body: { data: { viewer: { login: "claude[bot]" } } },
      }),

      async ({ requests }) => {
        expect(await getViewerLogin("test")).toBe("claude[bot]");
        expect(requests[0].body.query).toMatch(/viewer/);
      },
    );
  });

  it("getThreadFirstCommentAuthor() returns the first comment's author login, not a later one", async () => {
    await withMockGitHub(
      responses.graphql({
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
      }),

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
      responses.graphql({
        body: { data: { node: { comments: { nodes: [] } } } },
      }),

      async () => {
        expect(await getThreadFirstCommentAuthor("test", "thread1")).toBeNull();
      },
    );
  });

  it("createReply() posts to the comment's replies endpoint", async () => {
    await withMockGitHub(
      responses.POST_pull_comment_reply(5, 999, 222),

      async ({ requests }) => {
        expect(
          await createReply(...TOKEN_ORG_REPO, 5, 999, "thanks, fixed"),
        ).toEqual({
          id: 222,
          html_url: "https://example/pulls/5/comments/222",
        });
        expect(requests[0].body).toEqual({ body: "thanks, fixed" });
      },
    );
  });

  it("listIssueComments() returns comments from a single page", async () => {
    await withMockGitHub(
      responses.GET_issue_comments(5, [
        { id: 1, user: { login: "someone" }, body: "hi" },
        { id: 2, user: { login: "claude[bot]" }, body: "bye" },
      ]),

      async () => {
        expect(await listIssueComments(...TOKEN_ORG_REPO, 5)).toEqual([
          { id: 1, user: { login: "someone" }, body: "hi" },
          { id: 2, user: { login: "claude[bot]" }, body: "bye" },
        ]);
      },
    );
  });

  it("listIssueComments() pages through results until a short page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      body: `comment ${i}`,
    }));
    const page2 = [{ id: 100, body: "comment 100" }];

    await withMockGitHub(
      route("GET", `/issues/5/comments`, { body: page1 }, { body: page2 }),

      async ({ requests }) => {
        const comments = await listIssueComments(...TOKEN_ORG_REPO, 5);
        expect(comments).toHaveLength(101);
        expect(comments.at(-1)).toEqual({ id: 100, body: "comment 100" });

        const issueRequests = filterByUrlEnd(requests, "&page=1").concat(
          filterByUrlEnd(requests, "&page=2"),
        );
        expect(issueRequests).toHaveLength(2);
      },
    );
  });

  it("createIssueComment() posts a top-level comment and returns id/html_url", async () => {
    await withMockGitHub(
      responses.POST_issue_comment(5, 333),

      async ({ requests }) => {
        expect(
          await createIssueComment(...TOKEN_ORG_REPO, 5, "sticky content"),
        ).toEqual({
          id: 333,
          html_url: "https://example/issues/5/comments/333",
        });
        const [issueRequest] = filterByUrlEnd(requests, "/issues/5/comments");
        expect(issueRequest.body).toEqual({ body: "sticky content" });
      },
    );
  });

  it("updateIssueComment() patches an existing comment and returns id/html_url", async () => {
    await withMockGitHub(
      responses.PATCH_issue_comment(333),

      async ({ requests }) => {
        expect(
          await updateIssueComment(...TOKEN_ORG_REPO, 333, "updated content"),
        ).toEqual({
          id: 333,
          html_url: "https://example/issues/comments/333",
        });
        const [issueRequest] = filterByUrlEnd(requests, "/issues/comments/333");
        expect(issueRequest.body).toEqual({ body: "updated content" });
      },
    );
  });

  it("apiErrorHint() adds a hint for a 404 from a failed request", async () => {
    await withMockGitHub(
      route("POST", "/pulls/5/comments/999/replies$", {
        status: 404,
        body: { message: "Not Found" },
      }),

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
      responses.GET_pull(5, "deadbeef"),
      route("POST", "/pulls/5/reviews$", {
        status: 422,
        body: APPROVAL_REJECTED_BODY,
      }),

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
      responses.GET_pull(5, "deadbeef"),
      route("POST", "/pulls/5/reviews$", {
        status: 422,
        body: {
          message: "Validation Failed",
          errors: [{ field: "line", code: "invalid" }],
        },
      }),

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

  it("listRepoLabels() fetches all labels and paginates", async () => {
    await withMockGitHub(
      route("GET", `/repos/acme/widgets/labels\\?per_page=100&page=1$`, {
        body: [
          { name: "bug", description: "Something isn't working" },
          { name: "enhancement", description: "New feature" },
        ],
      }),

      async ({ requests }) => {
        const labels = await listRepoLabels(...TOKEN_ORG_REPO);
        expect(labels).toHaveLength(2);
        expect(labels[0]).toMatchObject({ name: "bug" });
        expect(labels[1]).toMatchObject({ name: "enhancement" });
        expect(
          filterByUrlEnd(requests, "/labels?per_page=100&page=1"),
        ).toHaveLength(1);
      },
    );
  });

  it("addLabels() posts the labels array", async () => {
    await withMockGitHub(
      route("POST", `/repos/acme/widgets/issues/5/labels$`, {
        body: [{ name: "bug" }],
      }),

      async ({ requests }) => {
        await addLabels(...TOKEN_ORG_REPO, 5, ["bug"]);
        const [req] = filterByUrlEnd(requests, "/issues/5/labels");
        expect(req.body).toEqual({ labels: ["bug"] });
      },
    );
  });

  it("removeLabel() sends the DELETE request", async () => {
    await withMockGitHub(
      route("DELETE", `/repos/acme/widgets/issues/5/labels/bug$`, {
        body: [],
      }),

      async ({ requests }) => {
        await removeLabel(...TOKEN_ORG_REPO, 5, "bug");
        expect(filterByUrlEnd(requests, "/issues/5/labels/bug")).toHaveLength(
          1,
        );
      },
    );
  });

  it("removeLabel() silently returns null on 404", async () => {
    await withMockGitHub(
      route("DELETE", `/repos/acme/widgets/issues/5/labels/missing$`, {
        status: 404,
        body: { message: "Not Found" },
      }),

      async () => {
        const result = await removeLabel(...TOKEN_ORG_REPO, 5, "missing");
        expect(result).toBeNull();
      },
    );
  });
});
