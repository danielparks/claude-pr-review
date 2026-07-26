import { describe, expect, it } from "vitest";
import redact, {
  redactAnthropicSecrets,
  redactGitHubSecrets,
} from "../lib/redact.js";

describe("redactGitHubSecrets", () => {
  it.each([
    ["ghp_" + "a".repeat(36)],
    ["gho_" + "a".repeat(36)],
    ["ghu_" + "a".repeat(36)],
    ["ghs_" + "a".repeat(36)],
    ["ghr_" + "a".repeat(36)],
  ])("redacts %s-style GitHub tokens", (token) => {
    expect(redactGitHubSecrets(`before ${token} after`)).toBe(
      "before [REDACTED_GITHUB_TOKEN] after",
    );
  });

  it("redacts GitHub PATs", () => {
    const pat = "github_pat_" + "a".repeat(22) + "_" + "b".repeat(59);
    expect(redactGitHubSecrets(`before ${pat} after`)).toBe(
      "before [REDACTED_GITHUB_PAT] after",
    );
  });

  it("redacts multiple tokens in the same string", () => {
    const a = "ghp_" + "a".repeat(36);
    const b = "ghs_" + "b".repeat(36);
    expect(redactGitHubSecrets(`${a} and ${b}`)).toBe(
      "[REDACTED_GITHUB_TOKEN] and [REDACTED_GITHUB_TOKEN]",
    );
  });

  it("leaves ordinary text untouched", () => {
    expect(redactGitHubSecrets("nothing secret here")).toBe(
      "nothing secret here",
    );
  });

  it("does not touch Anthropic secrets", () => {
    const secret = "sk-ant-api03-" + "a".repeat(20);
    expect(redactGitHubSecrets(secret)).toBe(secret);
  });
});

describe("redactAnthropicSecrets", () => {
  it.each([["api"], ["oat"], ["ort"], ["admin"]])(
    "redacts sk-ant-%s secrets",
    (kind) => {
      const secret = `sk-ant-${kind}03-${"a".repeat(20)}`;
      expect(redactAnthropicSecrets(`before ${secret} after`)).toBe(
        "before [REDACTED_ANTHROPIC_SECRET] after",
      );
    },
  );

  it("redacts secrets containing hyphens and underscores", () => {
    const secret = `sk-ant-api03-${"a".repeat(10)}_-${"b".repeat(10)}`;
    expect(redactAnthropicSecrets(secret)).toBe("[REDACTED_ANTHROPIC_SECRET]");
  });

  it("leaves ordinary text untouched", () => {
    expect(redactAnthropicSecrets("nothing secret here")).toBe(
      "nothing secret here",
    );
  });

  it("does not touch GitHub tokens", () => {
    const token = "ghp_" + "a".repeat(36);
    expect(redactAnthropicSecrets(token)).toBe(token);
  });
});

describe("redact", () => {
  it("redacts both GitHub and Anthropic secrets in one pass", () => {
    const ghToken = "ghp_" + "a".repeat(36);
    const anthropicSecret = "sk-ant-api03-" + "a".repeat(20);
    expect(redact(`${ghToken} ${anthropicSecret}`)).toBe(
      "[REDACTED_GITHUB_TOKEN] [REDACTED_ANTHROPIC_SECRET]",
    );
  });

  it("leaves ordinary text untouched", () => {
    expect(redact("nothing secret here")).toBe("nothing secret here");
  });
});
