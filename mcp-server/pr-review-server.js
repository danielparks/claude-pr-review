#!/usr/bin/env node
"use strict";

// Zero-dependency MCP server exposing three PR-review tools to Claude:
// add_comment, submit_review, reply_to_comment.
//
// GitHub's single-comment REST endpoint always creates its own standalone
// review, so posting comments one at a time (as the upstream
// anthropics/claude-code-action inline-comment tool does) scatters them across
// many separate reviews instead of grouping them the way "Start a review" does
// in the GitHub UI.
//
// This server queues comments in memory and posts them all at once via the
// array-based review endpoint.

const readline = require("readline");

const { GITHUB_TOKEN, REPO_OWNER, REPO_NAME, PR_NUMBER } = process.env;
const GITHUB_API_URL = process.env.GITHUB_API_URL || "https://api.github.com";

if (!GITHUB_TOKEN || !REPO_OWNER || !REPO_NAME || !PR_NUMBER) {
  console.error(
    "Error: GITHUB_TOKEN, REPO_OWNER, REPO_NAME, and PR_NUMBER environment " +
      "variables are required",
  );
  process.exit(1);
}

const SERVER_NAME = "pr_review";
const SERVER_VERSION = "0.1.0";

// Ported from anthropics/claude-code-action's src/github/utils/sanitizer.ts
// (MIT licensed) so a token Claude read from logs/output can't accidentally end
// up posted back into a public PR comment.
function redactGitHubTokens(content) {
  const patterns = [
    /\bghp_[A-Za-z0-9]{36}\b/g,
    /\bgho_[A-Za-z0-9]{36}\b/g,
    /\bghu_[A-Za-z0-9]{36}\b/g,
    /\bghs_[A-Za-z0-9]{36}\b/g,
    /\bghr_[A-Za-z0-9]{36}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{11,221}\b/g,
  ];
  return patterns.reduce(
    (text, re) => text.replace(re, "[REDACTED_GITHUB_TOKEN]"),
    content,
  );
}

async function githubRequest(method, path, body) {
  const res = await fetch(`${GITHUB_API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }

  if (!res.ok) {
    const err = new Error(data.message || `GitHub API returned ${res.status}`);
    err.status = res.status;
    throw err;
  }

  return data;
}

function helpMessageFor(error) {
  const message = error.message || String(error);
  if (error.status === 422 || /Validation Failed/i.test(message)) {
    return (
      "\n\nThis usually means a line number doesn't exist in the diff, or " +
      "the file path is wrong. Only comment on lines that are part of the " +
      "PR's changes."
    );
  }
  if (error.status === 404 || /Not Found/i.test(message)) {
    return (
      "\n\nThis usually means the PR number, repository, comment id, or " +
      "file path is incorrect."
    );
  }
  return "";
}

let cachedHeadSha = null;
async function getHeadSha() {
  if (!cachedHeadSha) {
    const pr = await githubRequest(
      "GET",
      `/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}`,
    );
    cachedHeadSha = pr.head.sha;
  }
  return cachedHeadSha;
}

// Comments queued by add_comment, flushed as one review by submit_review.
let pendingComments = [];

const TOOLS = {
  add_comment: {
    description:
      "Queue an inline review comment on a specific line or lines of a file " +
      "in this PR. Queued comments are NOT posted to GitHub until " +
      "submit_review is called — call add_comment for every issue you find " +
      "first, then call submit_review once at the end so all comments land " +
      "together as a single grouped review.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Required. File path to comment on, e.g. 'src/index.js'",
        },
        body: {
          type: "string",
          description:
            "Required. Comment text (Markdown). For a code suggestion use a " +
            "```suggestion fenced block; it replaces the entire commented " +
            "line range, so it must be a syntactically complete drop-in " +
            "replacement.",
        },
        line: {
          type: "number",
          description:
            "Required. The line number for a single-line comment, or the end " +
            "line for a multi-line comment (used with startLine).",
        },
        startLine: {
          type: "number",
          description:
            "Start line for a multi-line comment. Optional — omit for a " +
            "single-line comment on `line`.",
        },
        side: {
          type: "string",
          enum: ["LEFT", "RIGHT"],
          description:
            "Side of the diff to comment on. Defaults to RIGHT (new code).",
        },
      },
      required: ["path", "body", "line"],
    },
    handler: async ({ path, body, line, startLine, side }) => {
      if (!path) {
        throw new Error("'path' is required: file path to comment on.");
      }
      if (!body) {
        throw new Error("'body' is required: Comment text (Markdown).");
      }
      if (!line) {
        throw new Error(
          "'line' is required: the line number for a single-line comment, or " +
            "the end line for a multi-line comment.",
        );
      }
      const comment = {
        path,
        body: redactGitHubTokens(body),
        side: side || "RIGHT",
        line,
      };
      if (startLine) {
        comment.start_line = startLine;
        comment.start_side = side || "RIGHT";
      }
      pendingComments.push(comment);
      return {
        queued: true,
        count: pendingComments.length,
        message: `Comment queued for ${path}${
          startLine ? ` lines ${startLine}-${line}` : ` line ${line}`
        }. Call submit_review when you're done adding comments.`,
      };
    },
  },

  submit_review: {
    description:
      "Submit all comments queued by add_comment as a single grouped GitHub " +
      "review, optionally with top-level review text. Always call this " +
      "exactly once after you've finished calling add_comment for every " +
      "issue in this review pass — never submit one comment at a time. Can " +
      "also be called with only a body and no queued comments for pure " +
      "top-level feedback. Always posts as a plain comment review (never " +
      "approves or requests changes).",
    inputSchema: {
      type: "object",
      properties: {
        body: {
          type: "string",
          description:
            "Optional top-level review text, shown above the inline comments.",
        },
      },
    },
    handler: async (args) => {
      const body = args.body ? redactGitHubTokens(args.body) : "";
      if (pendingComments.length === 0 && !body) {
        throw new Error(
          "Nothing to submit: call add_comment first, or pass a body for " +
            "top-level-only feedback.",
        );
      }

      const commit_id = await getHeadSha();
      const result = await githubRequest(
        "POST",
        `/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}/reviews`,
        { commit_id, body, event: "COMMENT", comments: pendingComments },
      );

      const postedCount = pendingComments.length;
      pendingComments = [];

      return {
        success: true,
        review_id: result.id,
        html_url: result.html_url,
        comment_count: postedCount,
        message: `Submitted one review with ${postedCount} inline comment(s).`,
      };
    },
  },

  reply_to_comment: {
    description:
      "Reply to an existing PR review comment thread (the numeric comment id " +
      "is shown in the PR discussion you were given). Posts immediately — " +
      "replies attach to an existing thread, not a new review, so there's " +
      "nothing to group.",
    inputSchema: {
      type: "object",
      properties: {
        comment_id: {
          type: "number",
          description: "Required. The id of the review comment to reply to.",
        },
        body: {
          type: "string",
          description: "Required. Reply text (Markdown).",
        },
      },
      required: ["comment_id", "body"],
    },
    handler: async ({ body, comment_id }) => {
      if (!body) {
        throw new Error("'body' is required: Reply text (Markdown).");
      }
      if (!comment_id) {
        throw new Error(
          "'comment_id' is required: The id of the review comment to reply to.",
        );
      }
      const result = await githubRequest(
        "POST",
        `/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}` +
          `/comments/${comment_id}/replies`,
        { body: redactGitHubTokens(body) },
      );
      return {
        success: true,
        comment_id: result.id,
        html_url: result.html_url,
      };
    },
  },
};

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

// Tool calls are serialized through this chain so two calls (e.g. two
// submit_review calls issued without waiting for the first to finish) can't
// race on pendingComments — each call's handler fully completes, including its
// own awaited GitHub requests, before the next one starts.
let toolCallQueue = Promise.resolve();
function enqueueToolsCall(id, params) {
  const run = toolCallQueue.then(() => handleToolsCall(id, params));
  toolCallQueue = run.catch(() => {});
  return run;
}

async function handleToolsCall(id, params) {
  const tool = TOOLS[params?.name];
  if (!tool) {
    sendResult(id, {
      content: [{ type: "text", text: `Unknown tool: ${params?.name}` }],
      isError: true,
    });
    return;
  }
  try {
    const result = await tool.handler(params?.arguments || {});
    sendResult(id, {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendResult(id, {
      content: [
        { type: "text", text: `Error: ${message}${helpMessageFor(error)}` },
      ],
      isError: true,
    });
  }
}

function handleMessage(message) {
  const { id, method, params } = message;

  switch (method) {
    case "initialize":
      sendResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;

    case "notifications/initialized":
    case "notifications/cancelled":
      return; // Notifications: no response expected.

    case "tools/list":
      sendResult(id, {
        tools: Object.entries(TOOLS).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
      return;

    case "tools/call":
      trackInFlight(enqueueToolsCall(id, params));
      return;

    case "ping":
      sendResult(id, {});
      return;

    default:
      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
      return;
  }
}

// stdin closing means the client disconnected, but a tools/call triggered by
// the last line read may still be awaiting a GitHub API response — without
// this, that response is silently dropped instead of sent.
let inFlight = 0;
let stdinClosed = false;

function trackInFlight(promise) {
  inFlight++;
  promise.finally(() => {
    inFlight--;
    maybeExit();
  });
}

function maybeExit() {
  if (stdinClosed && inFlight === 0) {
    process.exit(0);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (error) {
    console.error(
      `pr_review MCP server: failed to parse line as JSON: ${error.message}\n` +
        `  line: ${trimmed.slice(0, 200)}`,
    );
    sendError(null, -32700, "Parse error");
    return;
  }
  handleMessage(message);
});

rl.on("close", () => {
  stdinClosed = true;
  maybeExit();
});
