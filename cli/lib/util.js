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
