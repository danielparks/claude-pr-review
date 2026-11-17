import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { positiveInt } from "./args.js";

export function actionContext() {
  return {
    ...repoFromEnv(),
    token: requireToken(),
    pr: positiveInt(process.env.PR_NUMBER, "PR_NUMBER environment variable"),
  };
}

export class CliError extends Error {}

export function countLines(content) {
  return content.replace(/\n$/, "").split(/\n/).length;
}

export function fail(message) {
  throw new CliError(message);
}

export function repoFromEnv() {
  const ownerRepo = process.env.GITHUB_REPOSITORY ?? "";
  const match = /^([^/]+)\/([^/]+)$/.exec(ownerRepo);
  if (!match) {
    fail(
      "GITHUB_REPOSITORY environment variable must be in owner/repo form, " +
        `got: ${JSON.stringify(ownerRepo)}`,
    );
  }
  const [, owner, repo] = match;
  return { owner, repo };
}

export function requireToken() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    fail("GITHUB_TOKEN or GH_TOKEN environment variable is required");
  }
  return token;
}

/**
 * Append a multi-line step output to `$GITHUB_OUTPUT`, using a random
 * delimiter so the value can't terminate it early.
 */
export async function writeOutput(name, value) {
  const delim = `EOF-${randomBytes(8).toString("hex")}`;
  const valueStr = String(value);
  if (valueStr.split("\n").some((line) => line === delim)) {
    fail(
      `Output '${name}' has line matching random delimiter '${delim}'. Retry ` +
        "the workflow.",
    );
  }
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `${name}<<${delim}\n${valueStr}\n${delim}\n`,
  );
}
