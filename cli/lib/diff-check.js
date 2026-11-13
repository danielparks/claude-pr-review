import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { countLines } from "./util.js";

const execFileAsync = promisify(execFile);

/**
 * Normalize a patch so that a clean rebase produces an identical result.
 *
 * Hunk line numbers (but not the trailing function context) and `index` lines
 * (base blob SHAs) change when the base moves, even if the PR's own changes
 * don't.
 */
export function normalizePatch(patch) {
  return patch
    .split("\n")
    .filter((line) => !line.startsWith("index "))
    .map((line) => line.replace(/^@@.*@@/, "@@ - - @@"))
    .join("\n");
}

function summarize(patch) {
  return {
    lines: patch === "" ? 0 : countLines(patch),
    sha256: createHash("sha256").update(patch).digest("hex").slice(0, 12),
  };
}

async function readIfExists(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * `diff` exits 1 when the files differ, which isn't an error here.
 */
async function textDiff(prevPath, newPath) {
  try {
    return (await execFileAsync("diff", [prevPath, newPath])).stdout;
  } catch (error) {
    if (error.code === 1) {
      return error.stdout;
    }
    throw error;
  }
}

/**
 * Compare a PR's patch to the one cached from the previous run, then make it
 * the new baseline.
 *
 * Returns `{ status, skip, section, previous, current }` where `status` is:
 *
 * - `"first"`: nothing cached; review the whole PR.
 * - `"unchanged"`: identical to the cached patch; skip the review.
 * - `"changed"`: differs; `section` is a Markdown diff-of-diffs for Claude.
 * - `"empty"`: the PR has no changes at all; skip the review. An empty patch is
 *   never treated as "unchanged" because a bad checkout or merge base can also
 *   produce one, and that would silently suppress every later review.
 *
 * `previous` and `current` summarize the normalized patches for the log.
 */
export async function compareAndCache(rawPatch, cachePath) {
  await mkdir(cachePath, { recursive: true });
  const prevPath = join(cachePath, "prev.patch");
  const newPath = join(cachePath, "new.patch");

  const current = normalizePatch(rawPatch);
  await writeFile(newPath, current);
  const prev = await readIfExists(prevPath);

  const result = {
    previous: prev === null ? null : summarize(prev),
    current: summarize(current),
    skip: false,
    section: "",
  };

  if (current.trim() === "") {
    result.status = "empty";
    result.skip = true;
  } else if (prev === null) {
    result.status = "first";
  } else if (prev === current) {
    result.status = "unchanged";
    result.skip = true;
  } else {
    result.status = "changed";
    result.section = [
      "## Changes since last review",
      "```",
      (await textDiff(prevPath, newPath)).replace(/\n$/, ""),
      "```",
    ].join("\n");
  }

  await writeFile(prevPath, current);
  return result;
}
