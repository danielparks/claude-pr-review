// End-to-end smoke test: spawns the actual pr-review-permission-prompt
// script as a subprocess and speaks MCP's newline-delimited JSON-RPC stdio
// protocol to it, exactly how Claude Code's --permission-prompt-tool does.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI_PATH = fileURLToPath(
  new URL("../pr-review-permission-prompt", import.meta.url),
);

// Sends each message on its own line, closes stdin, and collects every
// response line (as parsed JSON) the server wrote before it exited.
function run(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [CLI_PATH]);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`exited ${code}, stderr: ${stderr}`));
        return;
      }
      const lines = stdout.split("\n").filter((line) => line.trim() !== "");
      resolve(lines.map((line) => JSON.parse(line)));
    });

    for (const message of messages) {
      const line =
        typeof message === "string" ? message : JSON.stringify(message);
      child.stdin.write(line + "\n");
    }
    child.stdin.end();
  });
}

describe("pr-review-permission-prompt", () => {
  it("responds to initialize and tools/list", async () => {
    const responses = await run([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);

    expect(responses).toHaveLength(2); // The notification gets no response.
    expect(responses[0]).toMatchObject({ id: 1 });
    expect(responses[0].result.serverInfo.name).toBe(
      "pr-review-permission-prompt",
    );

    expect(responses[1]).toMatchObject({ id: 2 });
    const [tool] = responses[1].result.tools;
    expect(tool.name).toBe("check");
    expect(tool.inputSchema.required).toEqual(["tool_name", "input"]);
  });

  it("denies every tools/call, naming the tool", async () => {
    const responses = await run([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "check",
          arguments: { tool_name: "Bash(rm -rf /)", input: {} },
        },
      },
    ]);

    const decision = JSON.parse(responses[0].result.content[0].text);
    expect(decision).toEqual({
      behavior: "deny",
      message: "Bash(rm -rf /) is not in the allowed-tools list.",
    });
  });

  it("errors on a tools/call for an unknown tool", async () => {
    const responses = await run([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "nonexistent", arguments: {} },
      },
    ]);

    expect(responses[0].error.code).toBe(-32602);
  });

  it("ignores unparsable lines instead of crashing", async () => {
    const responses = await run([
      "not json",
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
    ]);

    expect(responses).toHaveLength(1);
    expect(responses[0].id).toBe(1);
  });
});
