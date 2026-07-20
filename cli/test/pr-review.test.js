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

  it("queue-comment + queue-comment + submit posts one grouped review", async () => {
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
      "queue-comment",
      "--path",
      "foo.js",
      "--line",
      "10",
      "--body-file",
      bodyOne,
    ]);
    await run([
      "queue-comment",
      "--path",
      "bar.js",
      "--line",
      "20",
      "--body-file",
      bodyTwo,
    ]);

    const topLevel = await bodyFile("Looks good overall.");
    const { stdout } = await run(["submit", "--body-file", topLevel]);
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

  it("reusing file for second queue-comment works", async () => {
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
      "queue-comment",
      "--path",
      "foo.js",
      "--line",
      "10",
      "--body-file",
      commentBody,
    ]);

    await writeFile(commentBody, "TWO");
    await run([
      "queue-comment",
      "--path",
      "bar.js",
      "--line",
      "20",
      "--body-file",
      commentBody,
    ]);

    const { stdout } = await run(["submit"]);
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

  it("submit with nothing queued and no body fails without calling the API", async () => {
    mock = await startMockGitHub([]);
    await expect(run(["submit"])).rejects.toThrow(/Nothing to submit/);
    expect(mock.requests).toHaveLength(0);
  });

  it("submit with only a body posts a comments-only review", async () => {
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
    await run(["submit", "--body-file", topLevel]);

    const [reviewRequest] = mock.requests.filter((r) =>
      r.url.endsWith("/reviews"),
    );
    expect(reviewRequest.body.comments).toEqual([]);
    expect(reviewRequest.body.body).toBe("Nothing to flag inline.");
  });

  it("queue-comment rejects startLine >= line", async () => {
    mock = await startMockGitHub([]);
    const body = await bodyFile("issue");
    await expect(
      run([
        "queue-comment",
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

  it("reply posts immediately", async () => {
    mock = await startMockGitHub([
      {
        method: "POST",
        pattern: /\/pulls\/5\/comments\/123\/replies$/,
        body: { id: 234, html_url: "https://example/pulls/5/comments/234" },
      },
    ]);
    const body = await bodyFile("interesting reply");
    const { stdout } = await run([
      "reply",
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
    "reply rejects a malformed GITHUB_REPOSITORY (%s) without calling the API",
    async (repo) => {
      mock = await startMockGitHub([]);
      const body = await bodyFile("x");
      await expect(
        run(["reply", "--comment-id", "123", "--body-file", body], {
          GITHUB_REPOSITORY: repo,
        }),
      ).rejects.toThrow(/owner\/repo form/);
      expect(mock.requests).toHaveLength(0);
    },
  );

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
      "queue-comment",
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

  it("sweep retries an abandoned claimed batch left by a crashed submit", async () => {
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
    const claimedDir = path.join(queueDir, "comments.claimed-1-999");
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
});
