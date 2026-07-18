// True end-to-end smoke tests: spawns the *built* dist/index.js (not the TS
// source) through the MCP SDK's own Client + StdioClientTransport, exactly
// how `claude` spawns this server in production. Validation edge cases,
// redaction, and the submit_review race are covered more cheaply as unit
// tests (review-batch.test.ts, github.test.ts) — this suite only needs to
// prove the real wiring works end to end against a real build artifact.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { startMockGitHub, type MockGitHub } from "./support/mock-github.js";

const DIST_PATH = fileURLToPath(new URL("../dist/index.js", import.meta.url));

async function withServer(
  mock: MockGitHub,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const client = new Client({ name: "integration-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [DIST_PATH],
    env: {
      GITHUB_TOKEN: "test-token",
      REPO_OWNER: "acme",
      REPO_NAME: "widgets",
      PR_NUMBER: "5",
      GITHUB_API_URL: mock.baseUrl,
    },
  });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error("expected tool result to have content");
  }
  const first = content[0] as { type: string; text?: string };
  if (first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected first content block to be text");
  }
  return first.text;
}

describe("pr_review MCP server (built dist/index.js)", () => {
  let mock: MockGitHub;

  afterEach(async () => {
    await mock?.close();
  });

  it("exposes exactly the three pr_review tools", async () => {
    mock = await startMockGitHub([]);
    await withServer(mock, async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "add_comment",
        "reply_to_comment",
        "submit_review",
      ]);
    });
  }, 10_000);

  it("add_comment + submit_review post one grouped review", async () => {
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
    await withServer(mock, async (client) => {
      const first = await client.callTool({
        name: "add_comment",
        arguments: { path: "foo.js", body: "issue one", line: 10 },
      });
      expect(JSON.parse(textOf(first))).toMatchObject({ count: 1 });

      const second = await client.callTool({
        name: "add_comment",
        arguments: { path: "bar.js", body: "issue two", line: 20 },
      });
      expect(JSON.parse(textOf(second))).toMatchObject({ count: 2 });

      const submitted = await client.callTool({
        name: "submit_review",
        arguments: { body: "Looks good overall." },
      });
      expect(JSON.parse(textOf(submitted))).toMatchObject({
        success: true,
        comment_count: 2,
      });

      const reviewRequests = mock.requests.filter((r) =>
        r.url.endsWith("/reviews"),
      );
      expect(reviewRequests).toHaveLength(1);
      expect(
        (reviewRequests[0]?.body as { comments: unknown[] }).comments,
      ).toHaveLength(2);
    });
  }, 10_000);

  it("surfaces a validation error without crashing the server", async () => {
    mock = await startMockGitHub([]);
    await withServer(mock, async (client) => {
      const result = await client.callTool({
        name: "add_comment",
        arguments: { path: "a.js", body: "x" }, // missing required `line`
      });
      expect(result.isError).toBe(true);

      // The server is still usable after a rejected call.
      const { tools } = await client.listTools();
      expect(tools.length).toBe(3);
    });
  }, 10_000);
});
