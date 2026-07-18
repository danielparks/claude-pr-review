import { describe, expect, it } from "vitest";
import { redactGitHubTokens } from "./redact.js";

describe("redactGitHubTokens", () => {
  it("redacts a classic personal access token", () => {
    const token = `ghp_${"x".repeat(36)}`;
    expect(redactGitHubTokens(`leaked: ${token}`)).toBe(
      "leaked: [REDACTED_GITHUB_TOKEN]",
    );
  });

  it("redacts a fine-grained personal access token", () => {
    const token = `github_pat_${"x".repeat(22)}`;
    expect(redactGitHubTokens(`leaked: ${token}`)).toBe(
      "leaked: [REDACTED_GITHUB_TOKEN]",
    );
  });

  it("leaves ordinary text untouched", () => {
    const text = "This function has a bug on line 42.";
    expect(redactGitHubTokens(text)).toBe(text);
  });

  it("does not touch a string that merely contains the ghp_ prefix without a valid token", () => {
    const text = "the variable is named ghp_token_holder";
    expect(redactGitHubTokens(text)).toBe(text);
  });
});
