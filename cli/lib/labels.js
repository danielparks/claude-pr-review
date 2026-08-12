import { listRepoLabels } from "./github.js";
import { writeAvailableLabels } from "./available-labels.js";

// Only `*` (any run of characters) and `?` (any single character) are
// supported. `path.matchesGlob()` treats `/` specially, so we use a custom
// converter instead.
export function globToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export async function fetchAndWriteLabels(token, owner, repo, patternsString) {
  const patterns = (patternsString || "")
    .split("\n")
    .filter(Boolean)
    .map(globToRegExp);

  if (patterns.length === 0) {
    await writeAvailableLabels([]);
    return;
  }

  const all = await listRepoLabels(token, owner, repo);
  const matched = all
    .filter((label) => patterns.some((re) => re.test(label.name)))
    .map(({ name, description }) => ({ name, description }));

  await writeAvailableLabels(matched);

  if (matched.length === 0) {
    process.stderr.write(
      "::warning::available-labels patterns matched no repo labels. " +
        "Check your configuration.\n",
    );
  }
}
