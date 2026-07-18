"use strict";

// Exercises pr-review-server.js as a real subprocess talking real (local) HTTP,
// rather than importing it and stubbing internals — the bugs found in this file
// so far (a premature-exit-on-stdin-close data loss, and a same-tick race
// between two submit_review calls) only show up at that level, not in a unit
// test of an individual function.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const path = require("node:path");

const SERVER_PATH = path.join(__dirname, "pr-review-server.js");

// --- Mock GitHub API ------------------------------------------------------

function createMockGitHub(routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, url: req.url, body });

      const route = routes.find(
        (r) => r.method === req.method && r.pattern.test(req.url),
      );
      res.setHeader("Content-Type", "application/json");
      if (!route) {
        res.statusCode = 404;
        res.end(JSON.stringify({ message: `no mock route for ${req.url}` }));
        return;
      }

      const respond = () => {
        res.statusCode = route.status || 200;
        res.end(JSON.stringify(route.body || {}));
      };
      if (route.delayMs) {
        setTimeout(respond, route.delayMs);
      } else {
        respond();
      }
    });
  });
  return { server, requests };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function defaultRoutes() {
  return [
    {
      method: "GET",
      pattern: /\/pulls\/\d+$/,
      status: 200,
      body: { head: { sha: "deadbeef" } },
    },
  ];
}

function reviewsRoute(body, opts = {}) {
  return {
    method: "POST",
    pattern: /\/reviews$/,
    status: opts.status || 200,
    body,
    delayMs: opts.delayMs,
  };
}

function repliesRoute(
  body = { id: 222, html_url: "https://example/comment/222" },
  opts = {},
) {
  return {
    method: "POST",
    pattern: /\/replies$/,
    status: opts.status || 200,
    body,
  };
}

// --- pr-review-server.js subprocess client --------------------------------

function startClient(port) {
  const child = spawn("node", [SERVER_PATH], {
    env: {
      ...process.env,
      GITHUB_API_URL: `http://127.0.0.1:${port}`,
      GITHUB_TOKEN: "test-token",
      REPO_OWNER: "acme",
      REPO_NAME: "widgets",
      PR_NUMBER: "5",
    },
  });

  const pending = new Map();
  const stderr = [];
  child.stderr.on("data", (c) => stderr.push(c.toString()));

  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const key = message.id === null ? "null" : message.id;
      const resolve = pending.get(key);
      if (resolve) {
        pending.delete(key);
        resolve(message);
      }
    }
  });

  let nextId = 1;
  function send(method, params) {
    const id = nextId++;
    const promise = new Promise((resolve) => pending.set(id, resolve));
    sendRaw(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return promise;
  }

  function sendRaw(line) {
    child.stdin.write(line + "\n");
  }

  function waitForParseError() {
    return new Promise((resolve) => pending.set("null", resolve));
  }

  function callTool(name, args) {
    return send("tools/call", { name, arguments: args });
  }

  async function close() {
    if (!child.stdin.writableEnded) {
      child.stdin.end();
    }
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }

  return { child, send, sendRaw, callTool, waitForParseError, close, stderr };
}

function toolResult(message) {
  const text = message.result.content[0].text;
  return message.result.isError ? { isError: true, text } : JSON.parse(text);
}

async function withHarness(routes, fn) {
  const { server, requests } = createMockGitHub(routes);
  const port = await listen(server);
  const client = startClient(port);
  try {
    await client.send("initialize", {});
    await fn({ client, requests });
  } finally {
    await client.close();
    await closeServer(server);
  }
}

// --- Tests ------------------------------------------------------------

test("tools/list exposes exactly the three pr_review tools", async () => {
  await withHarness(defaultRoutes(), async ({ client }) => {
    const res = await client.send("tools/list", {});
    assert.deepEqual(res.result.tools.map((t) => t.name).sort(), [
      "add_comment",
      "reply_to_comment",
      "submit_review",
    ]);
  });
});

test("add_comment queues; submit_review posts everything as one grouped review", async () => {
  await withHarness(
    [
      ...defaultRoutes(),
      reviewsRoute({ id: 111, html_url: "https://example/review/111" }),
    ],
    async ({ client, requests }) => {
      const first = toolResult(
        await client.callTool("add_comment", {
          path: "foo.js",
          body: "issue one",
          line: 10,
        }),
      );
      assert.equal(first.count, 1);

      const second = toolResult(
        await client.callTool("add_comment", {
          path: "bar.js",
          body: "issue two",
          startLine: 5,
          line: 7,
        }),
      );
      assert.equal(second.count, 2);

      const submitted = toolResult(
        await client.callTool("submit_review", { body: "Looks good overall." }),
      );
      assert.equal(submitted.success, true);
      assert.equal(submitted.comment_count, 2);

      const reviewRequests = requests.filter((r) => r.url.endsWith("/reviews"));
      assert.equal(reviewRequests.length, 1);
      assert.equal(reviewRequests[0].body.event, "COMMENT");
      assert.equal(reviewRequests[0].body.comments.length, 2);
      assert.equal(reviewRequests[0].body.comments[1].start_line, 5);
      assert.equal(reviewRequests[0].body.comments[1].line, 7);
    },
  );
});

test("add_comment redacts GitHub tokens before they're ever sent to GitHub", async () => {
  await withHarness(
    [
      ...defaultRoutes(),
      reviewsRoute({ id: 1, html_url: "https://example/review/1" }),
    ],
    async ({ client, requests }) => {
      const token = `ghp_${"x".repeat(36)}`;
      await client.callTool("add_comment", {
        path: "a.js",
        body: `leaked ${token}`,
        line: 1,
      });
      await client.callTool("submit_review", {});

      const [review] = requests.filter((r) => r.url.endsWith("/reviews"));
      assert.doesNotMatch(review.body.comments[0].body, new RegExp(token));
      assert.match(review.body.comments[0].body, /\[REDACTED_GITHUB_TOKEN\]/);
    },
  );
});

test("submit_review with nothing queued and no body errors without calling GitHub", async () => {
  await withHarness(defaultRoutes(), async ({ client, requests }) => {
    const result = toolResult(await client.callTool("submit_review", {}));
    assert.equal(result.isError, true);
    assert.match(result.text, /Nothing to submit/);
    assert.equal(requests.filter((r) => r.url.endsWith("/reviews")).length, 0);
  });
});

test("two submit_review calls fired without waiting don't race on the queue (regression)", async () => {
  // Before this was fixed, the second call read pendingComments before the
  // first had cleared it: both requests went out with the same comment
  // attached, instead of the second seeing an empty (already-flushed) queue.
  await withHarness(
    [
      ...defaultRoutes(),
      reviewsRoute(
        { id: 1, html_url: "https://example/review/1" },
        { delayMs: 30 },
      ),
    ],
    async ({ client, requests }) => {
      await client.callTool("add_comment", {
        path: "a.js",
        body: "x",
        line: 1,
      });

      const [first, second] = await Promise.all([
        client.callTool("submit_review", { body: "first" }),
        client.callTool("submit_review", {}), // no body, no new comments queued
      ]);

      assert.equal(first.result.isError, undefined);
      assert.equal(second.result.isError, true);
      assert.match(second.result.content[0].text, /Nothing to submit/);

      const reviewRequests = requests.filter((r) => r.url.endsWith("/reviews"));
      assert.equal(reviewRequests.length, 1);
      assert.equal(reviewRequests[0].body.comments.length, 1);
    },
  );
});

test("add_comment requires 'line' even when only startLine is given", async () => {
  await withHarness(defaultRoutes(), async ({ client }) => {
    const result = toolResult(
      await client.callTool("add_comment", {
        path: "a.js",
        body: "x",
        startLine: 3,
      }),
    );
    assert.equal(result.isError, true);
    assert.match(result.text, /'line' is required/);
  });
});

test("a malformed JSON-RPC line gets a parse-error reply and doesn't kill the server", async () => {
  await withHarness(defaultRoutes(), async ({ client }) => {
    const parseError = client.waitForParseError();
    client.sendRaw("this is not json");
    const err = await parseError;
    assert.equal(err.error.code, -32700);
    assert.match(client.stderr.join(""), /failed to parse line as JSON/);

    // The server keeps working after a bad line.
    const res = await client.send("tools/list", {});
    assert.equal(res.result.tools.length, 3);
  });
});

test("a slow in-flight call still gets its response after stdin closes (regression)", async () => {
  await withHarness(
    [
      ...defaultRoutes(),
      reviewsRoute(
        { id: 1, html_url: "https://example/review/1" },
        { delayMs: 150 },
      ),
    ],
    async ({ client }) => {
      await client.callTool("add_comment", {
        path: "a.js",
        body: "x",
        line: 1,
      });
      const pending = client.callTool("submit_review", { body: "slow" });
      client.child.stdin.end(); // simulate the client disconnecting immediately
      const result = toolResult(await pending);
      assert.equal(result.success, true);
    },
  );
});

test("reply_to_comment posts immediately, without going through the review queue", async () => {
  await withHarness(
    [...defaultRoutes(), repliesRoute()],
    async ({ client, requests }) => {
      const result = toolResult(
        await client.callTool("reply_to_comment", {
          comment_id: 999,
          body: "Thanks, fixed.",
        }),
      );
      assert.equal(result.success, true);
      assert.equal(result.comment_id, 222);
      assert.equal(
        requests.filter((r) => r.url.endsWith("/replies")).length,
        1,
      );
      assert.equal(
        requests.filter((r) => r.url.endsWith("/reviews")).length,
        0,
      );
    },
  );
});

test("a GitHub API error surfaces a helpful message instead of a raw stack trace", async () => {
  await withHarness(
    [
      ...defaultRoutes(),
      repliesRoute({ message: "Not Found" }, { status: 404 }),
    ],
    async ({ client }) => {
      const result = toolResult(
        await client.callTool("reply_to_comment", {
          comment_id: 12345,
          body: "x",
        }),
      );
      assert.equal(result.isError, true);
      assert.match(result.text, /Not Found/);
      assert.match(result.text, /comment id/);
    },
  );
});
