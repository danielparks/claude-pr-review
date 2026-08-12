// True end-to-end smoke tests: spawns the actual pr-review.js as a
// subprocess, exactly how Claude's Bash tool invokes it in production.
// Validation edge cases and the queue/claim mechanics are covered more
// cheaply as unit tests (queue.test.js, github.test.js) -- this suite only
// needs to prove the real CLI wiring works end to end.
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AVAILABLE_LABELS_FILE } from "../lib/available-labels.js";
import {
  withMockGitHub,
  filterByUrlEnd,
  route,
  responses,
} from "./support/mock-github.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL("../pr-review", import.meta.url));

describe("pr-review CLI", () => {
  let queueDir, workDir;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "pr-review-test-"));
    queueDir = path.join(workDir, "queue");
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    await rm(AVAILABLE_LABELS_FILE, { force: true });
  });

  function env(extra) {
    return {
      ...process.env,
      GITHUB_TOKEN: "test-token",
      GITHUB_REPOSITORY: "acme/widgets",
      PR_NUMBER: "5",
      PR_REVIEW_QUEUE_DIR: queueDir,
      ...extra,
    };
  }

  async function bodyFile(content) {
    const file = path.join(
      workDir,
      `body-${Math.random().toString(36).slice(2)}.txt`,
    );
    await writeFile(file, content);
    return file;
  }

  function run(args, extraEnv) {
    return execFileAsync("node", [CLI_PATH, ...args], { env: env(extraEnv) });
  }

  function runQueueInlineComment(path, line, bodyPath, ...more) {
    return run([
      "queue-inline-comment",
      "--path",
      path,
      "--line",
      line,
      "--body-file",
      bodyPath,
      ...more,
    ]);
  }

  it("init creates the queue directory", async () => {
    const { stdout } = await run(["init"]);
    expect(stdout).toMatch(/Created queue directory/);
    expect(await readdir(queueDir)).toEqual([]);
  });

  it("init fails if the queue directory already exists", async () => {
    await run(["init"]);
    await expect(run(["init"])).rejects.toThrow(/already exists/);
  });

  it("queue-inline-comment + queue-inline-comment + comment-review posts one grouped review", async () => {
    await withMockGitHub(
      responses.GET_pull(5, "deadbeef"),
      responses.POST_review(5, 111),

      async ({ requests }) => {
        await Promise.all([
          runQueueInlineComment("foo.js", "10", await bodyFile("issue one")),
          runQueueInlineComment("bar.js", "20", await bodyFile("issue two")),
        ]);

        const { stdout } = await run([
          "comment-review",
          "--body-file",
          await bodyFile("Looks good overall."),
        ]);
        expect(stdout).toMatch(/Submitted review with 2 inline comment/);

        const reviewRequests = filterByUrlEnd(requests, "/reviews");
        expect(reviewRequests).toHaveLength(1);
        expect(reviewRequests[0].body.comments).toHaveLength(2);
        expect(reviewRequests[0].body.body).toBe("Looks good overall.");

        // Batch is claimed-then-posted; nothing should be left in the live queue.
        const entries = await readdir(queueDir).catch(() => []);
        expect(entries.some((e) => e === "comments")).toBe(false);
        expect(entries.some((e) => e.startsWith("comments.posted-"))).toBe(
          true,
        );
      },
    );
  });

  it("reusing file for second queue-inline-comment works", async () => {
    await withMockGitHub(
      responses.GET_pull(5, "deadbeef"),
      responses.POST_review(5, 111),

      async ({ requests }) => {
        const commentBody = await bodyFile("ONE");
        await runQueueInlineComment("foo.js", "10", commentBody);
        await writeFile(commentBody, "TWO");
        await runQueueInlineComment("bar.js", "20", commentBody);

        const { stdout } = await run(["comment-review"]);
        expect(stdout).toMatch(/Submitted review with 2 inline comment/);

        const reviewRequests = filterByUrlEnd(requests, "/reviews");
        expect(reviewRequests).toHaveLength(1);
        expect(reviewRequests[0].body.comments).toMatchObject([
          { body: "ONE" },
          { body: "TWO" },
        ]);
        expect(reviewRequests[0].body.body).toBe("");
      },
    );
  });

  it("comment-review with nothing queued and no body fails without calling the API", async () => {
    await withMockGitHub(async ({ requests }) => {
      await expect(run(["comment-review"])).rejects.toThrow(
        /Nothing to submit/,
      );
      expect(requests).toHaveLength(0);
    });
  });

  it("comment-review with only a body posts a comments-only review", async () => {
    await withMockGitHub(
      responses.GET_pull(5, "deadbeef"),
      responses.POST_review(5, 112),

      async ({ requests }) => {
        const topLevel = await bodyFile("Nothing to flag inline.");
        await run(["comment-review", "--body-file", topLevel]);

        const [reviewRequest] = filterByUrlEnd(requests, "/reviews");
        expect(reviewRequest.body.comments).toEqual([]);
        expect(reviewRequest.body.body).toBe("Nothing to flag inline.");
      },
    );
  });

  it("queue-inline-comment rejects startLine >= line", async () => {
    await expect(
      runQueueInlineComment(
        "foo.js",
        "10",
        await bodyFile("issue"),
        "--start-line",
        "15",
      ),
    ).rejects.toThrow(/start-line/);
  });

  it("reply-inline-comment posts immediately", async () => {
    await withMockGitHub(
      responses.POST_pull_comment_reply(5, 123, 234),

      async () => {
        const { stdout } = await run([
          "reply-inline-comment",
          "--comment-id",
          "123",
          "--body-file",
          await bodyFile("interesting reply"),
        ]);
        expect(stdout).toMatch(/Posted reply/);
      },
    );
  });

  it.each([
    "https://github.com/acme/widgets",
    "acme/widgets/extra",
    "acme/",
    "/widgets",
    "acme",
  ])(
    "reply-inline-comment rejects a malformed GITHUB_REPOSITORY (%s) without calling the API",
    async (repo) => {
      await withMockGitHub(async ({ requests }) => {
        await expect(
          run(
            [
              "reply-inline-comment",
              "--comment-id",
              "123",
              "--body-file",
              await bodyFile("x"),
            ],
            { GITHUB_REPOSITORY: repo },
          ),
        ).rejects.toThrow(/owner\/repo form/);
        expect(requests).toHaveLength(0);
      });
    },
  );

  // getViewerLogin() is a GraphQL call; reused from the resolve-my-thread
  // tests further down (function declarations hoist within this describe).
  it("update-sticky-comment creates a new comment when none exists yet", async () => {
    await withMockGitHub(
      viewerRoute("claude[bot]"),
      responses.GET_issue_comments(5, [
        { id: 1, user: { login: "someone" }, body: "unrelated comment" },
      ]),
      responses.POST_issue_comment(5, 555),

      async ({ requests }) => {
        const { stdout } = await run([
          "update-sticky-comment",
          "--body-file",
          await bodyFile("current status"),
        ]);
        expect(stdout).toMatch(/Created sticky comment/);

        const [issueRequest] = filterByUrlEnd(requests, "/issues/5/comments");
        expect(issueRequest.body.body).toMatch(/current status/);
        expect(issueRequest.body.body).toMatch(
          /<!-- pr-review: sticky comment -->/,
        );
      },
    );
  });

  it("update-sticky-comment updates the existing marked comment authored by the authenticated user", async () => {
    await withMockGitHub(
      viewerRoute("claude[bot]"),
      responses.GET_issue_comments(5, [
        { id: 1, user: { login: "someone" }, body: "unrelated comment" },
        {
          id: 2,
          user: { login: "claude[bot]" },
          body: "<!-- pr-review: sticky comment -->\n\nold status",
        },
      ]),
      responses.PATCH_issue_comment(2),

      async ({ requests }) => {
        const { stdout } = await run([
          "update-sticky-comment",
          "--body-file",
          await bodyFile("new status"),
        ]);
        expect(stdout).toMatch(/Updated sticky comment/);

        const [issueRequest] = filterByUrlEnd(requests, "/issues/comments/2");
        expect(issueRequest.body.body).toMatch(/new status/);
      },
    );
  });

  it("update-sticky-comment ignores a marked comment authored by someone else", async () => {
    await withMockGitHub(
      viewerRoute("claude[bot]"),
      responses.GET_issue_comments(5, [
        {
          id: 3,
          user: { login: "someone-else" },
          body: "<!-- pr-review: sticky comment -->\n\nspoofed",
        },
      ]),
      responses.POST_issue_comment(5, 556),

      async ({ requests }) => {
        const { stdout } = await run([
          "update-sticky-comment",
          "--body-file",
          await bodyFile("real status"),
        ]);
        expect(stdout).toMatch(/Created sticky comment/);
        expect(filterByUrlEnd(requests, "/issues/comments/3")).toHaveLength(0);
      },
    );
  });

  it("update-sticky-comment requires --body-file", async () => {
    await withMockGitHub(async ({ requests }) => {
      await expect(run(["update-sticky-comment"])).rejects.toThrow(
        /--body-file is required/,
      );
      expect(requests).toHaveLength(0);
    });
  });

  it("approve-review posts an APPROVE event with no comments queued", async () => {
    await withMockGitHub(
      responses.GET_pull(5, "deadbeef"),
      responses.POST_review(5, 115),

      async ({ requests }) => {
        const { stdout } = await run(["approve-review"]);
        expect(stdout).toMatch(
          /Submitted APPROVE review with 0 inline comment/,
        );

        const [reviewRequest] = filterByUrlEnd(requests, "/reviews");
        expect(reviewRequest.body).toMatchObject({
          event: "APPROVE",
          body: "",
        });
      },
    );
  });

  it("approve-review accepts an optional body and includes queued inline comments", async () => {
    await withMockGitHub(
      responses.GET_pull(5, "deadbeef"),
      responses.POST_review(5, 116),

      async ({ requests }) => {
        await runQueueInlineComment("a.js", "10", await bodyFile("nice touch"));

        const body = await bodyFile("Looks great.");
        const { stdout } = await run(["approve-review", "--body-file", body]);
        expect(stdout).toMatch(
          /Submitted APPROVE review with 1 inline comment/,
        );

        const [reviewRequest] = filterByUrlEnd(requests, "/reviews");
        expect(reviewRequest.body).toMatchObject({
          event: "APPROVE",
          body: "Looks great.",
        });
        expect(reviewRequest.body.comments).toHaveLength(1);
      },
    );
  });

  it("approve-review falls back to a comment when GitHub rejects the approval", async () => {
    await withMockGitHub(
      responses.GET_pull(5, "deadbeef"),
      route(
        "POST",
        "/pulls/5/reviews$",
        {
          status: 422,
          body: {
            message: "Unprocessable Entity",
            errors: [
              "GitHub Actions is not permitted to approve pull requests.",
            ],
            status: "422",
          },
        },
        { body: { id: 118, html_url: "https://example/review/118" } },
      ),

      async ({ requests }) => {
        const body = await bodyFile("Looks great.");
        const { stdout } = await run(["approve-review", "--body-file", body]);
        expect(stdout).toMatch(
          /didn't allow approving.*submitted as a comment/s,
        );

        const reviewRequests = filterByUrlEnd(requests, "/reviews");
        expect(reviewRequests).toHaveLength(2);
        expect(reviewRequests[0].body.event).toBe("APPROVE");
        expect(reviewRequests[1].body.event).toBe("COMMENT");
        expect(reviewRequests[1].body.body).toContain("Looks great.");
        expect(reviewRequests[1].body.body).toContain(
          "submitted as a comment instead of an approval",
        );
      },
    );
  });

  it("request-changes-review requires content", async () => {
    await withMockGitHub(async ({ requests }) => {
      await expect(run(["request-changes-review"])).rejects.toThrow(
        /Nothing to submit/,
      );
      expect(requests).toHaveLength(0);
    });
  });

  it("request-changes-review does not require --body-file", async () => {
    await withMockGitHub(
      responses.GET_pull(5, "deadbeef"),
      responses.POST_review(5, 115),

      async ({ requests }) => {
        await runQueueInlineComment(
          "foo.js",
          "10",
          await bodyFile("this is broken"),
        );

        const { stdout } = await run(["request-changes-review"]);
        expect(stdout).toMatch(
          /Submitted REQUEST_CHANGES review with 1 inline comment/,
        );

        const [reviewRequest] = filterByUrlEnd(requests, "/reviews");
        expect(reviewRequest.body).toMatchObject({
          event: "REQUEST_CHANGES",
          body: "",
        });
        expect(reviewRequest.body.comments).toHaveLength(1);
      },
    );
  });

  it("request-changes-review posts a REQUEST_CHANGES event with top level and inline comments", async () => {
    await withMockGitHub(
      responses.GET_pull(5, "deadbeef"),
      responses.POST_review(5, 117),

      async ({ requests }) => {
        await runQueueInlineComment(
          "foo.js",
          "10",
          await bodyFile("this is broken"),
        );

        const { stdout } = await run([
          "request-changes-review",
          "--body-file",
          await bodyFile("Please address the security issue."),
        ]);
        expect(stdout).toMatch(
          /Submitted REQUEST_CHANGES review with 1 inline comment/,
        );

        const [reviewRequest] = filterByUrlEnd(requests, "/reviews");
        expect(reviewRequest.body).toMatchObject({
          event: "REQUEST_CHANGES",
          body: "Please address the security issue.",
        });
        expect(reviewRequest.body.comments).toHaveLength(1);
      },
    );
  });

  it("request-changes-review posts a REQUEST_CHANGES event with top level and no inline comments", async () => {
    await withMockGitHub(
      responses.GET_pull(5, "deadbeef"),
      responses.POST_review(5, 117),

      async ({ requests }) => {
        const { stdout } = await run([
          "request-changes-review",
          "--body-file",
          await bodyFile("Please address the security issue."),
        ]);
        expect(stdout).toMatch(
          /Submitted REQUEST_CHANGES review with 0 inline comment/,
        );

        const [reviewRequest] = filterByUrlEnd(requests, "/reviews");
        expect(reviewRequest.body).toMatchObject({
          event: "REQUEST_CHANGES",
          body: "Please address the security issue.",
        });
        expect(reviewRequest.body.comments).toHaveLength(0);
      },
    );
  });

  it("resolve-my-thread requires --thread-id", async () => {
    await withMockGitHub(async ({ requests }) => {
      await expect(run(["resolve-my-thread"])).rejects.toThrow(
        /--thread-id is required/,
      );
      expect(requests).toHaveLength(0);
    });
  });

  // getThreadFirstCommentAuthor() and getViewerLogin() are both GraphQL
  // calls to the same /graphql URL, issued concurrently -- these routes are
  // told apart by query content (via `match`) rather than call order, since
  // which one the mock server sees first isn't guaranteed.
  function viewerRoute(login) {
    return responses.graphql((body) => /viewer/.test(body.query), {
      body: { data: { viewer: { login } } },
    });
  }

  function threadFirstCommentAuthorRoute(login) {
    return responses.graphql(
      (body) => /PullRequestReviewThread/.test(body.query),
      {
        body: {
          data: { node: { comments: { nodes: [{ author: { login } }] } } },
        },
      },
    );
  }

  it("resolve-my-thread resolves a thread it started", async () => {
    await withMockGitHub(
      viewerRoute("claude[bot]"),
      threadFirstCommentAuthorRoute("claude[bot]"),
      responses.graphql((body) => /resolveReviewThread/.test(body.query), {
        body: {
          data: { resolveReviewThread: { thread: { id: "thread1" } } },
        },
      }),

      async ({ requests }) => {
        const { stdout } = await run([
          "resolve-my-thread",
          "--thread-id",
          "thread1",
        ]);
        expect(stdout).toMatch(/Resolved thread thread1/);

        const graphqlRequests = filterByUrlEnd(requests, "/graphql");
        expect(graphqlRequests).toHaveLength(3);
        expect(
          graphqlRequests.find((r) => /resolveReviewThread/.test(r.body.query))
            .body.variables,
        ).toEqual({ threadId: "thread1" });
      },
    );
  });

  it("resolve-my-thread refuses to resolve a thread it didn't start", async () => {
    await withMockGitHub(
      viewerRoute("claude[bot]"),
      threadFirstCommentAuthorRoute("someone-else"),

      async ({ requests }) => {
        await expect(
          run(["resolve-my-thread", "--thread-id", "thread1"]),
        ).rejects.toThrow(/authored by someone-else.*resolve-any-thread/s);

        const graphqlRequests = filterByUrlEnd(requests, "/graphql");
        expect(graphqlRequests).toHaveLength(2);
        expect(
          graphqlRequests.some((r) => /resolveReviewThread/.test(r.body.query)),
        ).toBe(false);
      },
    );
  });

  it("resolve-any-thread resolves a thread it didn't start", async () => {
    await withMockGitHub(
      responses.graphql({
        body: {
          data: { resolveReviewThread: { thread: { id: "thread1" } } },
        },
      }),

      async ({ requests }) => {
        const { stdout } = await run([
          "resolve-any-thread",
          "--thread-id",
          "thread1",
        ]);
        expect(stdout).toMatch(/Resolved thread thread1/);
        expect(requests).toHaveLength(1);
        expect(requests[0].body.variables).toEqual({ threadId: "thread1" });
      },
    );
  });

  it("hide-my-review requires --review-id", async () => {
    await withMockGitHub(async ({ requests }) => {
      await expect(run(["hide-my-review"])).rejects.toThrow(
        /--review-id is required/,
      );
      expect(requests).toHaveLength(0);
    });
  });

  it("hide-my-review minimizes its own review as outdated", async () => {
    await withMockGitHub(
      responses.GET_pull_review(5, 111, "review-node-1", "claude[bot]"),
      viewerRoute("claude[bot]"),
      responses.graphql((body) => /minimizeComment/.test(body.query), {
        body: {
          data: {
            minimizeComment: { minimizedComment: { isMinimized: true } },
          },
        },
      }),

      async ({ requests }) => {
        const { stdout } = await run(["hide-my-review", "--review-id", "111"]);
        expect(stdout).toMatch(/Hid review 111 as outdated/);

        const graphqlRequest = requests.find((r) =>
          /minimizeComment/.test(r.body?.query),
        );
        expect(graphqlRequest.body.variables).toEqual({
          subjectId: "review-node-1",
        });
      },
    );
  });

  it("hide-my-review refuses to hide someone else's review", async () => {
    await withMockGitHub(
      responses.GET_pull_review(5, 111, "review-node-1", "someone-else"),
      viewerRoute("claude[bot]"),

      async ({ requests }) => {
        await expect(
          run(["hide-my-review", "--review-id", "111"]),
        ).rejects.toThrow(/authored by someone-else.*hide-any-review/s);

        const graphqlRequests = filterByUrlEnd(requests, "/graphql");
        expect(graphqlRequests).toHaveLength(1);
        expect(
          graphqlRequests.some((r) => /minimizeComment/.test(r.body.query)),
        ).toBe(false);
      },
    );
  });

  it("hide-any-review minimizes someone else's review as outdated", async () => {
    await withMockGitHub(
      responses.GET_pull_review(5, 111, "review-node-1", "someone-else"),
      responses.graphql({
        body: {
          data: {
            minimizeComment: { minimizedComment: { isMinimized: true } },
          },
        },
      }),

      async ({ requests }) => {
        const { stdout } = await run(["hide-any-review", "--review-id", "111"]);
        expect(stdout).toMatch(/Hid review 111 as outdated/);
        expect(filterByUrlEnd(requests, "/graphql")).toHaveLength(1);
      },
    );
  });

  it("sweep posts a batch Claude queued but never submitted", async () => {
    await withMockGitHub(
      responses.GET_pull(5, "deadbeef"),
      responses.POST_review(5, 113),

      async ({ requests }) => {
        await runQueueInlineComment(
          "foo.js",
          "1",
          await bodyFile("forgotten issue"),
        );

        const { stdout } = await run(["sweep"]);
        expect(stdout).toMatch(/Swept 1 pending submission/);

        const reviewRequests = filterByUrlEnd(requests, "/reviews");
        expect(reviewRequests).toHaveLength(1);
        expect(reviewRequests[0].body.comments).toHaveLength(1);
      },
    );
  });

  it("sweep retries an abandoned claimed batch left by a crashed comment-review", async () => {
    await withMockGitHub(
      responses.GET_pull(5, "deadbeef"),
      responses.POST_review(5, 114),

      async ({ requests }) => {
        // Simulate a submit that claimed the batch (the rename that normally
        // happens inside `claim()`) and then crashed before the POST -- exactly
        // the state a real crash would leave behind, without needing to
        // actually kill a process mid-request.
        const claimedDir = path.join(queueDir, "comments.claimed-1-999-123abc");
        await mkdir(claimedDir, { recursive: true });
        await writeFile(
          path.join(claimedDir, "1-abc.json"),
          JSON.stringify({
            path: "foo.js",
            body: "crashed before posting",
            side: "RIGHT",
            line: 1,
          }),
        );

        const { stdout } = await run(["sweep"]);
        expect(stdout).toMatch(/Swept 1 pending submission/);

        const reviewRequests = filterByUrlEnd(requests, "/reviews");
        expect(reviewRequests).toHaveLength(1);
        expect(reviewRequests[0].body.comments).toHaveLength(1);

        // Running sweep again should find nothing left to retry.
        const second = await run(["sweep"]);
        expect(second.stdout).toMatch(/Nothing to sweep/);
        expect(filterByUrlEnd(requests, "/reviews")).toHaveLength(1);
        await expect(access(queueDir)).rejects.toThrow("ENOENT");
      },
    );
  });

  it("sweep is a no-op when there's nothing queued", async () => {
    await withMockGitHub(async ({ requests }) => {
      const { stdout } = await run(["sweep"]);
      expect(stdout).toMatch(/Nothing to sweep/);
      expect(requests).toHaveLength(0);
    });
  });

  it("sweep retries an abandoned APPROVE batch with the recorded event", async () => {
    await withMockGitHub(
      responses.GET_pull(5, "deadbeef"),
      responses.POST_review(5, 119),

      async ({ requests }) => {
        // Simulate a crashed approve-review: claimed, event recorded, but the
        // POST never happened.
        const claimedDir = path.join(
          queueDir,
          "comments.claimed-1-999-approve",
        );
        await mkdir(claimedDir, { recursive: true });
        await writeFile(path.join(claimedDir, "_event.txt"), "APPROVE");
        await writeFile(path.join(claimedDir, "_body.txt"), "ship it");

        const { stdout } = await run(["sweep"]);
        expect(stdout).toMatch(/Swept 1 pending submission/);

        const [reviewRequest] = filterByUrlEnd(requests, "/reviews");
        expect(reviewRequest.body).toMatchObject({
          event: "APPROVE",
          body: "ship it",
        });
      },
    );
  });

  it("sweep --downgrade-approval forces a queued APPROVE to a COMMENT", async () => {
    await withMockGitHub(
      responses.GET_pull(5, "deadbeef"),
      responses.POST_review(5, 120),

      async ({ requests }) => {
        const claimedDir = path.join(
          queueDir,
          "comments.claimed-1-999-approve2",
        );
        await mkdir(claimedDir, { recursive: true });
        await writeFile(path.join(claimedDir, "_event.txt"), "APPROVE");
        await writeFile(path.join(claimedDir, "_body.txt"), "ship it");

        const { stdout } = await run(["sweep", "--downgrade-approval"]);
        expect(stdout).toMatch(/Swept 1 pending submission/);

        const [reviewRequest] = filterByUrlEnd(requests, "/reviews");
        expect(reviewRequest.body.event).toBe("COMMENT");
        expect(reviewRequest.body.body).toContain("ship it");
        expect(reviewRequest.body.body).toContain("didn't complete cleanly");
      },
    );
  });

  it("list-queue reports nothing queued when the queue is empty", async () => {
    const { stdout } = await run(["list-queue"]);
    expect(stdout).toMatch(/Nothing queued/);
  });

  // Rather than hand-writing a comment.json + directory layout to fake a
  // claimed batch (which would silently drift from reality if that format
  // ever changes), these get a *real* stuck claimed batch the same way one
  // arises in production: a comment-review call that GitHub rejects.
  function rejectedReviewRoute() {
    return route("POST", "/pulls/5/reviews$", {
      status: 422,
      body: {
        message: "Unprocessable Entity",
        errors: ["line must be part of the diff"],
      },
    });
  }

  async function failCommentReviewAndGetClaimedDir() {
    await runQueueInlineComment(
      "bad.js",
      "999",
      await bodyFile("invalid line"),
    );
    let failureMessage;
    try {
      await run(["comment-review"]);
      expect.unreachable("comment-review should have failed");
    } catch (error) {
      failureMessage = error.message;
    }
    const [, claimedDir] =
      failureMessage.match(/discard-queue --dir (\S+)/) ?? [];
    expect(claimedDir).toBeDefined();
    return { claimedDir, failureMessage };
  }

  it("list-queue reports open and claimed batches with their comments", async () => {
    await withMockGitHub(
      responses.GET_pull(5, "deadbeef"),
      rejectedReviewRoute(),

      async () => {
        const { claimedDir } = await failCommentReviewAndGetClaimedDir();
        await runQueueInlineComment(
          "open.js",
          "3",
          await bodyFile("still drafting"),
        );

        const { stdout } = await run(["list-queue"]);
        expect(stdout).toMatch(/\[open\]/);
        expect(stdout).toMatch(/open\.js:3: still drafting/);
        expect(stdout).toContain(`${claimedDir} [claimed]`);
        expect(stdout).toMatch(/bad\.js:999: invalid line/);
      },
    );
  });

  it("discard-queue removes a claimed batch so sweep no longer retries it", async () => {
    await withMockGitHub(
      responses.GET_pull(5, "deadbeef"),
      rejectedReviewRoute(),

      async ({ requests }) => {
        const { claimedDir } = await failCommentReviewAndGetClaimedDir();

        const { stdout } = await run(["discard-queue", "--dir", claimedDir]);
        expect(stdout).toContain(`Discarded ${claimedDir}`);
        await expect(access(claimedDir)).rejects.toThrow("ENOENT");

        const sweep = await run(["sweep"]);
        expect(sweep.stdout).toMatch(/Nothing to sweep/);
        // Only the one failed attempt -- sweep found nothing left to retry.
        expect(filterByUrlEnd(requests, "/reviews")).toHaveLength(1);
      },
    );
  });

  it("discard-queue refuses to remove a non-claimed directory", async () => {
    await runQueueInlineComment("a.js", "1", await bodyFile("keep me"));
    const openDir = path.join(queueDir, "comments");

    await expect(run(["discard-queue", "--dir", openDir])).rejects.toThrow(
      /Not a claimed batch directory/,
    );
    expect(await readdir(openDir)).toHaveLength(1);
  });

  it("discard-queue refuses a path outside the queue root", async () => {
    const outside = path.join(workDir, "comments.claimed-1-999-stuck");

    await expect(run(["discard-queue", "--dir", outside])).rejects.toThrow(
      /must be a batch directory directly inside the queue root/,
    );
  });

  it("recovers from comment-review failing on a permanent error, e.g. an invalid line number", async () => {
    await withMockGitHub(
      responses.GET_pull(5, "deadbeef"),
      route(
        "POST",
        "/pulls/5/reviews$",
        {
          status: 422,
          body: {
            message: "Unprocessable Entity",
            errors: ["line must be part of the diff"],
          },
        },
        { body: { id: 121, html_url: "https://example/review/121" } },
      ),

      async ({ requests }) => {
        // The failure message itself carries the exact recovery command --
        // Claude shouldn't need to separately think to run `list-queue`.
        const { claimedDir, failureMessage } =
          await failCommentReviewAndGetClaimedDir();
        expect(failureMessage).toMatch(/422/);
        expect(failureMessage).toMatch(/line number doesn't exist/);
        expect(failureMessage).toMatch(/retried automatically/);

        // Claude fixes the line number and resubmits successfully.
        await runQueueInlineComment(
          "bad.js",
          "10",
          await bodyFile("correct line number"),
        );
        const { stdout } = await run(["comment-review"]);
        expect(stdout).toMatch(/Submitted review with 1 inline comment/);

        // Clean up the stuck batch so sweep doesn't retry (and fail) on it.
        const discard = await run(["discard-queue", "--dir", claimedDir]);
        expect(discard.stdout).toContain(`Discarded ${claimedDir}`);

        const sweep = await run(["sweep"]);
        expect(sweep.stdout).toMatch(/Nothing to sweep/);

        expect(filterByUrlEnd(requests, "/reviews")).toHaveLength(2);
      },
    );
  });

  it("--help with no command lists every command with a description and exits 0", async () => {
    const { stdout } = await run(["--help"]);
    expect(stdout).toMatch(/Usage: pr-review <command> \[options\]/);
    expect(stdout).toMatch(/queue-inline-comment\s+Queue an inline comment/);
    expect(stdout).toMatch(
      /discard-queue\s+Permanently remove a stuck claimed batch/,
    );
  });

  it("running with no command at all also shows top-level help", async () => {
    const { stdout } = await run([]);
    expect(stdout).toMatch(/Usage: pr-review <command> \[options\]/);
  });

  it("<command> --help shows that command's flags, descriptions, and exits 0, without calling the API", async () => {
    await withMockGitHub(async ({ requests }) => {
      const { stdout } = await run(["queue-inline-comment", "--help"]);
      expect(stdout).toMatch(
        /Usage: pr-review queue-inline-comment \[options\]/,
      );
      expect(stdout).toMatch(/--path PATH\s+\(required\)/);
      expect(stdout).toMatch(/File path, relative to the repo root/);
      expect(stdout).toMatch(/--body-file BODY_FILE\s+\(required\)/);
      expect(requests).toHaveLength(0);
    });
  });

  it("<command> -h short flag also shows help", async () => {
    const { stdout } = await run(["discard-queue", "-h"]);
    expect(stdout).toMatch(/Usage: pr-review discard-queue \[options\]/);
  });

  it("<command> --help doesn't require otherwise-required flags or touch the filesystem", async () => {
    // No --body-file given, and none created -- --help must win before
    // readBodyFile() would otherwise fail trying to read a missing file.
    const { stdout } = await run(["request-changes-review", "--help"]);
    expect(stdout).toMatch(/--body-file BODY_FILE/);
  });

  it("unknown command still fails and lists the available commands", async () => {
    await expect(run(["not-a-real-command"])).rejects.toThrow(
      /Unknown command: not-a-real-command.*discard-queue/s,
    );
  });

  describe("post-comment", () => {
    it("posts a new top-level comment immediately", async () => {
      const bodyPath = await bodyFile("Hello from Claude");
      await withMockGitHub(
        responses.POST_issue_comment(5, 999),

        async ({ requests }) => {
          const { stdout } = await run([
            "post-comment",
            "--body-file",
            bodyPath,
          ]);
          expect(stdout).toContain("Posted comment:");
          const [req] = filterByUrlEnd(requests, "/issues/5/comments");
          expect(req.body).toEqual({ body: "Hello from Claude" });
        },
      );
    });

    it("fails when --body-file is not provided", async () => {
      await expect(run(["post-comment"])).rejects.toThrow(/--body-file/);
    });
  });

  // Helper for label tests
  async function withLabelsFile(labels) {
    await writeFile(AVAILABLE_LABELS_FILE, JSON.stringify(labels));
  }

  describe("list-available-labels", () => {
    it("shows available labels with descriptions", async () => {
      await withLabelsFile([
        { name: "bug", description: "Something isn't working" },
        { name: "enhancement", description: "" },
      ]);
      const { stdout } = await run(["list-available-labels"]);
      expect(stdout).toContain("bug: Something isn't working");
      expect(stdout).toContain("- enhancement");
      expect(stdout).toContain("pr-review add-label LABEL");
      expect(stdout).toContain("pr-review remove-label LABEL");
    });

    it("shows no-labels message when file contains empty array", async () => {
      await withLabelsFile([]);
      const { stdout } = await run(["list-available-labels"]);
      expect(stdout).toContain("No labels are available");
    });

    it("shows no-labels message when labels file does not exist", async () => {
      const { stdout } = await run(["list-available-labels"]);
      expect(stdout).toContain("No labels are available");
    });
  });

  describe("add-label", () => {
    it("adds a label by positional argument", async () => {
      await withLabelsFile([{ name: "bug", description: "" }]);
      await withMockGitHub(
        responses.POST_issue_labels(5),

        async ({ requests }) => {
          const { stdout } = await run(["add-label", "bug"]);
          expect(stdout).toContain("Added label: bug");
          const [req] = filterByUrlEnd(requests, "/issues/5/labels");
          expect(req.body).toEqual({ labels: ["bug"] });
        },
      );
    });

    it("adds a label via --label flag", async () => {
      await withLabelsFile([{ name: "bug", description: "" }]);
      await withMockGitHub(
        responses.POST_issue_labels(5),

        async () => {
          const { stdout } = await run(["add-label", "--label", "bug"]);
          expect(stdout).toContain("Added label: bug");
        },
      );
    });

    it("fails when the label is not in the available list", async () => {
      await withLabelsFile([{ name: "bug", description: "" }]);
      await expect(run(["add-label", "enhancement"])).rejects.toThrow(
        /not in the available labels list/,
      );
    });

    it("fails when no labels are configured (empty file)", async () => {
      await withLabelsFile([]);
      await expect(run(["add-label", "bug"])).rejects.toThrow(
        /No labels are configured/,
      );
    });

    it("fails when no labels are configured (no file)", async () => {
      await expect(run(["add-label", "bug"])).rejects.toThrow(
        /No labels are configured/,
      );
    });

    it("fails when no label argument is given", async () => {
      await withLabelsFile([{ name: "bug", description: "" }]);
      await expect(run(["add-label"])).rejects.toThrow(/--label is required/);
    });

    it("shows positional usage in --help", async () => {
      const { stdout } = await run(["add-label", "--help"]);
      expect(stdout).toMatch(/Usage: pr-review add-label LABEL \[options\]/);
      expect(stdout).toMatch(/or pass as positional argument/);
    });
  });

  describe("remove-label", () => {
    it("removes a label by positional argument", async () => {
      await withLabelsFile([{ name: "bug", description: "" }]);
      await withMockGitHub(
        responses.DELETE_issue_label(5, "bug"),

        async () => {
          const { stdout } = await run(["remove-label", "bug"]);
          expect(stdout).toContain("Removed label: bug");
        },
      );
    });

    it("silently succeeds when label is not currently applied (404)", async () => {
      await withLabelsFile([{ name: "bug", description: "" }]);
      await withMockGitHub(
        responses.DELETE_issue_label(5, "bug", {
          status: 404,
          body: { message: "Label does not exist" },
        }),

        async () => {
          const { stdout } = await run(["remove-label", "bug"]);
          expect(stdout).toContain("Label not applied: bug");
        },
      );
    });

    it("fails when the label is not in the available list", async () => {
      await withLabelsFile([{ name: "bug", description: "" }]);
      await expect(run(["remove-label", "enhancement"])).rejects.toThrow(
        /not in the available labels list/,
      );
    });

    it("fails when no labels are configured", async () => {
      await withLabelsFile([]);
      await expect(run(["remove-label", "bug"])).rejects.toThrow(
        /No labels are configured/,
      );
    });

    it("handles label names with special URL characters", async () => {
      await withLabelsFile([{ name: "Claude: reviewed", description: "" }]);
      await withMockGitHub(
        responses.DELETE_issue_label(5, "Claude%3A%20reviewed"),

        async ({ requests }) => {
          await run(["remove-label", "Claude: reviewed"]);
          expect(requests[0].url).toContain(
            "/issues/5/labels/Claude%3A%20reviewed",
          );
        },
      );
    });
  });
});
