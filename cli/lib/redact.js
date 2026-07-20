// Ported from anthropics/claude-code-action's src/github/utils/sanitizer.ts
// (MIT licensed) so a token Claude read from logs/output can't accidentally
// end up posted back into a public PR comment.
const TOKEN_PATTERNS = [
  /\bghp_[A-Za-z0-9]{36}\b/g,
  /\bgho_[A-Za-z0-9]{36}\b/g,
  /\bghu_[A-Za-z0-9]{36}\b/g,
  /\bghs_[A-Za-z0-9]{36}\b/g,
  /\bghr_[A-Za-z0-9]{36}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{11,221}\b/g,
];

export function redactGitHubTokens(content) {
  return TOKEN_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, "[REDACTED_GITHUB_TOKEN]"),
    content,
  );
}
