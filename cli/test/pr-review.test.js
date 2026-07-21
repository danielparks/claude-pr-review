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
import { startMockGitHub } from "./support/mock-github.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL("../pr-review", import.meta.url));

describe("pr-review CLI", () => {
  let mock;
  let queueDir;
  let workDir;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "pr-review-test-"));
    queueDir = path.join(workDir, "queue");
  });

  afterEach(async () => {
    await mock?.close();
    await rm(workDir, { recursive: true, force: true });
  });

  function env(extra) {
    return {
      ...process.env,
      GITHUB_TOKEN: "test-token",
      GITHUB_REPOSITORY: "acme/widgets",
      PR_NUMBER: "5",
      PR_REVIEW_QUEUE_DIR: queueDir,
      GITHUB_API_URL: mock.baseUrl,
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

  it("init creates the queue directory", async () => {
    mock = await startMockGitHub([]);
    const { stdout } = await run(["init"]);
    expect(stdout).toMatch(/Created queue directory/);
    expect(await readdir(queueDir)).toEqual([]);
  });

  it("init fails if the queue directory already exists", async () => {
    mock = await startMockGitHub([]);
    await run(["init"]);
    await expect(run(["init"])).rejects.toThrow(/already exists/);
  });

  it("queue-inline-comment + queue-inline-comment + comment-review posts one grouped review", async () => {
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

    const bodyOne = await bodyFile("issue one");
    const bodyTwo = await bodyFile("issue two");
    await run([
      "queue-inline-comment",
      "--path",
      "foo.js",
      "--line",
      "10",
      "--body-file",
      bodyOne,
    ]);
    await run([
      "queue-inline-comment",
      "--path",
      "bar.js",
      "--line",
      "20",
      "--body-file",
      bodyTwo,
    ]);

    const topLevel = await bodyFile("Looks good overall.");
    const { stdout } = await run(["comment-review", "--body-file", topLevel]);
    expect(stdout).toMatch(/Submitted review with 2 inline comment/);

    const reviewRequests = mock.requests.filter((r) =>
      r.url.endsWith("/reviews"),
    );
    expect(reviewRequests).toHaveLength(1);
    expect(reviewRequests[0].body.comments).toHaveLength(2);
    expect(reviewRequests[0].body.body).toBe("Looks good overall.");

    // Batch is claimed-then-posted; nothing should be left in the live queue.
    const entries = await readdir(queueDir).catch(() => []);
    expect(entries.some((e) => e === "comments")).toBe(false);
    expect(entries.some((e) => e.startsWith("comments.posted-"))).toBe(true);
  });

  it("reusing file for second queue-inline-comment works", async () => {
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

    const commentBody = await bodyFile("ONE");
    await run([
      "queue-inline-comment",
      "--path",
      "foo.js",
      "--line",
      "10",
      "--body-file",
      commentBody,
    ]);

    await writeFile(commentBody, "TWO");
    await run([
      "queue-inline-comment",
      "--path",
      "bar.js",
      "--line",
      "20",
      "--body-file",
      commentBody,
    ]);

    const { stdout } = await run(["comment-review"]);
    expect(stdout).toMatch(/Submitted review with 2 inline comment/);

    const reviewRequests = mock.requests.filter((r) =>
      r.url.endsWith("/reviews"),
    );
    expect(reviewRequests).toHaveLength(1);
    expect(reviewRequests[0].body.comments).toMatchObject([
      { body: "ONE" },
      { body: "TWO" },
    ]);
    expect(reviewRequests[0].body.body).toBe("");
  });

  it("comment-review with nothing queued and no body fails without calling the API", async () => {
    mock = await startMockGitHub([]);
    await expect(run(["comment-review"])).rejects.toThrow(/Nothing to submit/);
    expect(mock.requests).toHaveLength(0);
  });

  it("comment-review with only a body posts a comments-only review", async () => {
    mock = await startMockGitHub([
      {
        method: "GET",
        pattern: /\/pulls\/5$/,
        body: { head: { sha: "deadbeef" } },
      },
      {
        method: "POST",
        pattern: /\/pulls\/5\/reviews$/,
        body: { id: 112, html_url: "https://example/review/112" },
      },
    ]);
    const topLevel = await bodyFile("Nothing to flag inline.");
    await run(["comment-review", "--body-file", topLevel]);

    const [reviewRequest] = mock.requests.filter((r) =>
      r.url.endsWith("/reviews"),
    );
    expect(reviewRequest.body.comments).toEqual([]);
    expect(reviewRequest.body.body).toBe("Nothing to flag inline.");
  });

  it("queue-inline-comment rejects startLine >= line", async () => {
    mock = await startMockGitHub([]);
    const body = await bodyFile("issue");
    await expect(
      run([
        "queue-inline-comment",
        "--path",
        "foo.js",
        "--line",
        "10",
        "--start-line",
        "15",
        "--body-file",
        body,
      ]),
    ).rejects.toThrow(/start-line/);
  });

  it("reply-inline-comment posts immediately", async () => {
    mock = await startMockGitHub([
      {
        method: "POST",
        pattern: /\/pulls\/5\/comments\/123\/replies$/,
        body: { id: 234, html_url: "https://example/pulls/5/comments/234" },
      },
    ]);
    const body = await bodyFile("interesting reply");
    const { stdout } = await run([
      "reply-inline-comment",
      "--comment-id",
      "123",
      "--body-file",
      body,
    ]);
    expect(stdout).toMatch(/Posted reply/);
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
      mock = await startMockGitHub([]);
      const body = await bodyFile("x");
      await expect(
        run(
          ["reply-inline-comment", "--comment-id", "123", "--body-file", body],
          { GITHUB_REPOSITORY: repo },
        ),
      ).rejects.toThrow(/owner\/repo form/);
      expect(mock.requests).toHaveLength(0);
    },
  );

  it("approve-review posts an APPROVE event with no comments queued", async () => {
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
    const { stdout } = await run(["approve-review"]);
    expect(stdout).toMatch(/Submitted APPROVE review with 0 inline comment/);

    const [reviewRequest] = mock.requests.filter((r) =>
      r.url.endsWith("/reviews"),
    );
    expect(reviewRequest.body).toMatchObject({ event: "APPROVE", body: "" });
  });

  it("approve-review accepts an optional body and includes queued inline comments", async () => {
    mock = await startMockGitHub([
      {
        method: "GET",
        pattern: /\/pulls\/5$/,
        body: { head: { sha: "deadbeef" } },
      },
      {
        method: "POST",
        pattern: /\/pulls\/5\/reviews$/,
        body: { id: 116, html_url: "https://example/review/116" },
      },
    ]);
    const commentBody = await bodyFile("nice touch");
    await run([
      "queue-inline-comment",
      "--path",
      "foo.js",
      "--line",
      "10",
      "--body-file",
      commentBody,
    ]);

    const body = await bodyFile("Looks great.");
    const { stdout } = await run(["approve-review", "--body-file", body]);
    expect(stdout).toMatch(/Submitted APPROVE review with 1 inline comment/);

    const [reviewRequest] = mock.requests.filter((r) =>
      r.url.endsWith("/reviews"),
    );
    expect(reviewRequest.body).toMatchObject({
      event: "APPROVE",
      body: "Looks great.",
    });
    expect(reviewRequest.body.comments).toHaveLength(1);
  });

  it("approve-review falls back to a comment when GitHub rejects the approval", async () => {
    mock = await startMockGitHub([
      {
        method: "GET",
        pattern: /\/pulls\/5$/,
        body: { head: { sha: "deadbeef" } },
      },
      {
        method: "POST",
        pattern: /\/pulls\/5\/reviews$/,
        responses: [
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
        ],
      },
    ]);
    const body = await bodyFile("Looks great.");
    const { stdout } = await run(["approve-review", "--body-file", body]);
    expect(stdout).toMatch(/didn't allow approving.*submitted as a comment/s);

    const reviewRequests = mock.requests.filter((r) =>
      r.url.endsWith("/reviews"),
    );
    expect(reviewRequests).toHaveLength(2);
    expect(reviewRequests[0].body.event).toBe("APPROVE");
    expect(reviewRequests[1].body.event).toBe("COMMENT");
    expect(reviewRequests[1].body.body).toContain("Looks great.");
    expect(reviewRequests[1].body.body).toContain(
      "submitted as a comment instead of an approval",
    );
  });

  it("request-changes-review requires --body-file", async () => {
    mock = await startMockGitHub([]);
    await expect(run(["request-changes-review"])).rejects.toThrow(
      /--body-file is required/,
    );
    expect(mock.requests).toHaveLength(0);
  });

  it("request-changes-review posts a REQUEST_CHANGES event with queued inline comments", async () => {
    mock = await startMockGitHub([
      {
        method: "GET",
        pattern: /\/pulls\/5$/,
        body: { head: { sha: "deadbeef" } },
      },
      {
        method: "POST",
        pattern: /\/pulls\/5\/reviews$/,
        body: { id: 117, html_url: "https://example/review/117" },
      },
    ]);
    const commentBody = await bodyFile("this is broken");
    await run([
      "queue-inline-comment",
      "--path",
      "foo.js",
      "--line",
      "10",
      "--body-file",
      commentBody,
    ]);

    const body = await bodyFile("Please address the security issue.");
    const { stdout } = await run([
      "request-changes-review",
      "--body-file",
      body,
    ]);
    expect(stdout).toMatch(
      /Submitted REQUEST_CHANGES review with 1 inline comment/,
    );

    const [reviewRequest] = mock.requests.filter((r) =>
      r.url.endsWith("/reviews"),
    );
    expect(reviewRequest.body).toMatchObject({
      event: "REQUEST_CHANGES",
      body: "Please address the security issue.",
    });
    expect(reviewRequest.body.comments).toHaveLength(1);
  });

  it("resolve-thread requires --thread-id", async () => {
    mock = await startMockGitHub([]);
    await expect(run(["resolve-thread"])).rejects.toThrow(
      /--thread-id is required/,
    );
    expect(mock.requests).toHaveLength(0);
  });

  it("resolve-thread resolves the given thread", async () => {
    mock = await startMockGitHub([
      {
        method: "POST",
        pattern: /\/graphql$/,
        body: { data: { resolveReviewThread: { thread: { id: "thread1" } } } },
      },
    ]);
    const { stdout } = await run(["resolve-thread", "--thread-id", "thread1"], {
      GITHUB_GRAPHQL_URL: `${mock.baseUrl}/graphql`,
    });
    expect(stdout).toMatch(/Resolved thread thread1/);

    expect(mock.requests[0].body.variables).toEqual({ threadId: "thread1" });
  });

  it("hide-review requires --review-id", async () => {
    mock = await startMockGitHub([]);
    await expect(run(["hide-review"])).rejects.toThrow(
      /--review-id is required/,
    );
    expect(mock.requests).toHaveLength(0);
  });

  it("hide-review minimizes the given review as outdated", async () => {
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
    const { stdout } = await run(["hide-review", "--review-id", "111"], {
      GITHUB_GRAPHQL_URL: `${mock.baseUrl}/graphql`,
    });
    expect(stdout).toMatch(/Hid review 111 as outdated/);

    const [graphqlRequest] = mock.requests.filter((r) =>
      r.url.endsWith("/graphql"),
    );
    expect(graphqlRequest.body.variables).toEqual({
      subjectId: "review-node-1",
    });
  });

  it("sweep posts a batch Claude queued but never submitted", async () => {
    mock = await startMockGitHub([
      {
        method: "GET",
        pattern: /\/pulls\/5$/,
        body: { head: { sha: "deadbeef" } },
      },
      {
        method: "POST",
        pattern: /\/pulls\/5\/reviews$/,
        body: { id: 113, html_url: "https://example/review/113" },
      },
    ]);
    const body = await bodyFile("forgotten issue");
    await run([
      "queue-inline-comment",
      "--path",
      "foo.js",
      "--line",
      "1",
      "--body-file",
      body,
    ]);

    const { stdout } = await run(["sweep"]);
    expect(stdout).toMatch(/Swept 1 pending submission/);

    const reviewRequests = mock.requests.filter((r) =>
      r.url.endsWith("/reviews"),
    );
    expect(reviewRequests).toHaveLength(1);
    expect(reviewRequests[0].body.comments).toHaveLength(1);
  });

  it("sweep retries an abandoned claimed batch left by a crashed comment-review", async () => {
    mock = await startMockGitHub([
      {
        method: "GET",
        pattern: /\/pulls\/5$/,
        body: { head: { sha: "deadbeef" } },
      },
      {
        method: "POST",
        pattern: /\/pulls\/5\/reviews$/,
        body: { id: 114, html_url: "https://example/review/114" },
      },
    ]);

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

    const reviewRequests = mock.requests.filter((r) =>
      r.url.endsWith("/reviews"),
    );
    expect(reviewRequests).toHaveLength(1);
    expect(reviewRequests[0].body.comments).toHaveLength(1);

    // Running sweep again should find nothing left to retry.
    const second = await run(["sweep"]);
    expect(second.stdout).toMatch(/Nothing to sweep/);
    expect(
      mock.requests.filter((r) => r.url.endsWith("/reviews")),
    ).toHaveLength(1);
    await expect(access(queueDir)).rejects.toThrow("ENOENT");
  });

  it("sweep is a no-op when there's nothing queued", async () => {
    mock = await startMockGitHub([]);
    const { stdout } = await run(["sweep"]);
    expect(stdout).toMatch(/Nothing to sweep/);
    expect(mock.requests).toHaveLength(0);
  });

  it("sweep retries an abandoned APPROVE batch with the recorded event", async () => {
    mock = await startMockGitHub([
      {
        method: "GET",
        pattern: /\/pulls\/5$/,
        body: { head: { sha: "deadbeef" } },
      },
      {
        method: "POST",
        pattern: /\/pulls\/5\/reviews$/,
        body: { id: 119, html_url: "https://example/review/119" },
      },
    ]);

    // Simulate a crashed approve-review: claimed, event recorded, but the
    // POST never happened.
    const claimedDir = path.join(queueDir, "comments.claimed-1-999-approve");
    await mkdir(claimedDir, { recursive: true });
    await writeFile(path.join(claimedDir, "_event.txt"), "APPROVE");
    await writeFile(path.join(claimedDir, "_body.txt"), "ship it");

    const { stdout } = await run(["sweep"]);
    expect(stdout).toMatch(/Swept 1 pending submission/);

    const [reviewRequest] = mock.requests.filter((r) =>
      r.url.endsWith("/reviews"),
    );
    expect(reviewRequest.body).toMatchObject({
      event: "APPROVE",
      body: "ship it",
    });
  });

  it("sweep --downgrade-approval forces a queued APPROVE to a COMMENT", async () => {
    mock = await startMockGitHub([
      {
        method: "GET",
        pattern: /\/pulls\/5$/,
        body: { head: { sha: "deadbeef" } },
      },
      {
        method: "POST",
        pattern: /\/pulls\/5\/reviews$/,
        body: { id: 120, html_url: "https://example/review/120" },
      },
    ]);

    const claimedDir = path.join(queueDir, "comments.claimed-1-999-approve2");
    await mkdir(claimedDir, { recursive: true });
    await writeFile(path.join(claimedDir, "_event.txt"), "APPROVE");
    await writeFile(path.join(claimedDir, "_body.txt"), "ship it");

    const { stdout } = await run(["sweep", "--downgrade-approval"]);
    expect(stdout).toMatch(/Swept 1 pending submission/);

    const [reviewRequest] = mock.requests.filter((r) =>
      r.url.endsWith("/reviews"),
    );
    expect(reviewRequest.body.event).toBe("COMMENT");
    expect(reviewRequest.body.body).toContain("ship it");
    expect(reviewRequest.body.body).toContain("didn't complete cleanly");
  });
});
