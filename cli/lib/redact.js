export function redactGitHubSecrets(raw) {
  return raw
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/github_pat_[A-Za-z0-9_]{11,}/g, "[REDACTED_GITHUB_PAT]");
}

export function redactAnthropicSecrets(raw) {
  return raw.replace(
    /sk-ant-(api|o[ar]t|admin)\d\d-[A-Za-z0-9_-]{20,}/g,
    "[REDACTED_ANTHROPIC_SECRET]",
  );
}

export default function redact(content) {
  return redactAnthropicSecrets(redactGitHubSecrets(content));
}
