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
import {
  withMockGitHub,
  filterByUrlEnd,
  match,
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
      match(
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

  it("request-changes-review requires --body-file", async () => {
    await withMockGitHub(async ({ requests }) => {
      await expect(run(["request-changes-review"])).rejects.toThrow(
        /--body-file is required/,
      );
      expect(requests).toHaveLength(0);
    });
  });

  it("request-changes-review posts a REQUEST_CHANGES event with queued inline comments", async () => {
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
});
