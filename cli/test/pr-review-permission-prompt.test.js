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

  async function checkCall(toolName, input) {
    const responses = await run([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "check",
          arguments: { tool_name: toolName, input },
        },
      },
    ]);
    return JSON.parse(responses[0].result.content[0].text);
  }

  it("denies a Bash call, naming the actual command", async () => {
    const decision = await checkCall("Bash", { command: "rm -rf /" });

    expect(decision.behavior).toBe("deny");
    expect(decision.message).toMatch(/^Bash\(rm -rf \/\) is not in the/);
    expect(decision.message).toMatch(/permissions restriction/);
    expect(decision.message).not.toMatch(/pr-review --help/); // Not a pr-review command.
  });

  it("points a denied pr-review Bash call at `pr-review --help`", async () => {
    const decision = await checkCall("Bash", {
      command: "pr-review request-changes-review --help",
    });

    expect(decision.behavior).toBe("deny");
    expect(decision.message).toMatch(
      /^Bash\(pr-review request-changes-review --help\) is not in the/,
    );
    expect(decision.message).toMatch(/pr-review --help/);
  });

  it("denies a non-Bash call by its bare tool name", async () => {
    const decision = await checkCall("WebFetch", { url: "https://x.test" });

    expect(decision).toEqual({
      behavior: "deny",
      message:
        "WebFetch is not in the allowed-tools list. This is a workflow " +
        "permissions restriction (this action's allowed-tools / " +
        "additional-allowed-tools inputs) -- not a missing command, a crash, " +
        "or a bug.",
    });
  });

  it("falls back to the bare tool name if Bash input has no command", async () => {
    const decision = await checkCall("Bash", {});

    expect(decision.message).toMatch(/^Bash is not in the/);
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
