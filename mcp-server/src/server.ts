import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  GitHubClient,
  helpMessageFor,
  type SubmittedReview,
} from "./github.js";
import { redactGitHubTokens } from "./redact.js";
import { ReviewBatch } from "./review-batch.js";
import type { ReviewComment } from "./types.js";

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      { type: "text", text: `Error: ${message}${helpMessageFor(error)}` },
    ],
    isError: true,
  };
}

export function createServer(github: GitHubClient): McpServer {
  const server = new McpServer({ name: "pr_review", version: "0.1.0" });
  const batch = new ReviewBatch<SubmittedReview>();

  server.registerTool(
    "add_comment",
    {
      description:
        "Queue an inline comment on a specific line or lines of a file in " +
        "this PR. Queued comments are NOT posted to GitHub until " +
        "submit_review is called — call add_comment for every issue you find " +
        "first, then call submit_review once at the end so all comments land " +
        "together as a single grouped review.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe("File path to comment on, e.g. 'src/index.js'"),
        body: z
          .string()
          .min(1)
          .describe(
            "Comment text (Markdown). For a code suggestion use a " +
              "```suggestion fenced block; it replaces the entire commented " +
              "line range, so it must be a syntactically complete drop-in " +
              "replacement.",
          ),
        line: z
          .number()
          .min(1)
          .describe(
            "The line number for a single-line comment, or the end line for " +
              "a multi-line comment (used with startLine).",
          ),
        startLine: z
          .number()
          .min(1)
          .optional()
          .describe(
            "Start line for a multi-line comment. Optional — omit for a " +
              "single-line comment on `line`.",
          ),
        side: z
          .enum(["LEFT", "RIGHT"])
          .optional()
          .describe(
            "Side of the diff to comment on. Defaults to RIGHT (new code).",
          ),
      },
    },
    ({ path, body, line, startLine, side }) => {
      try {
        const comment: ReviewComment = {
          path,
          body: redactGitHubTokens(body),
          side: side ?? "RIGHT",
          line,
        };
        if (startLine !== undefined) {
          if (startLine >= line) {
            throw new Error(
              `startLine (${startLine}) must be less than line (${line}) for ` +
                "a multi-line comment.",
            );
          }
          comment.start_line = startLine;
          comment.start_side = side ?? "RIGHT";
        }

        const count = batch.add(comment);
        return ok({
          queued: true,
          count,
          message:
            `Comment queued for ${path}` +
            (startLine !== undefined
              ? ` lines ${startLine}-${line}`
              : ` line ${line}`) +
            ". Call submit_review when you're done adding comments.",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "submit_review",
    {
      description:
        "Submit all comments queued by add_comment as a single grouped GitHub " +
        "review, optionally with top-level review text. Always call this " +
        "exactly once after you've finished calling add_comment for every " +
        "issue in this review pass — never submit one comment at a time. Can " +
        "also be called with only a body and no queued comments for pure " +
        "top-level feedback. Always posts as a plain comment review (never " +
        "approves or requests changes).",
      inputSchema: {
        body: z
          .string()
          .optional()
          .describe(
            "Optional top-level review text, shown above the inline comments.",
          ),
      },
    },
    async ({ body }) => {
      const reviewBody = body ? redactGitHubTokens(body) : "";
      try {
        return ok(
          await batch.submit(reviewBody, async (comments, submittedBody) => ({
            ...(await github.createReview(comments, submittedBody)),
            success: true,
            comment_count: comments.length,
            message: `Submitted one review with ${comments.length} inline comment(s).`,
          })),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "reply_to_comment",
    {
      description:
        "Reply to an existing PR inline comment thread (the numeric comment " +
        "id is shown in the PR discussion you were given). Posts immediately " +
        "— replies attach to an existing thread, not a new review, so " +
        "there's nothing to group.",
      inputSchema: {
        comment_id: z
          .number()
          .min(1)
          .describe("The id of the inline comment to reply to."),
        body: z.string().min(1).describe("Reply text (Markdown)."),
      },
    },
    async ({ comment_id, body }) => {
      try {
        return ok({
          ...(await github.createReply(comment_id, redactGitHubTokens(body))),
          success: true,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}
