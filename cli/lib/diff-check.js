import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

const OUTDATED_NOTE =
  "Earlier inline comments on code that changed may now be marked outdated. " +
  "That does not mean the issue was fixed, so check each one against the " +
  "current code.";

function changedPaths(patch) {
  return [...patch.matchAll(/^diff --git a\/.* b\/(.*)$/gm)].map((m) => m[1]);
}

function emptiedSection(prev) {
  const paths = changedPaths(prev);
  return [
    "## Changes since last review",
    "",
    "The PR diff is now **empty**: it has no changes against its merge base. " +
      "This usually means the changes were reverted or already landed in the " +
      "base branch." +
      (paths.length > 0 ? " At the last review it changed:\n" : ""),
    ...paths.map((path) => `- \`${path}\``),
    "",
    OUTDATED_NOTE,
    "",
    "Tell the author what you see, and ask whether this is intentional.",
  ].join("\n");
}

function refilledSection() {
  return [
    "## Changes since last review",
    "",
    "The PR was **empty** at the last review, so all of the current diff is " +
      "new.",
    "",
    OUTDATED_NOTE,
  ].join("\n");
}

/**
 * Compare a PR's patch to the cached baseline, then make it the new baseline.
 *
 * The baseline is what the reviewer last saw, including an empty PR. Returns
 * `{ changed, section, previous, current }`. `previous` and `current` summarize
 * the normalized patches for the log, and `section` shows what has changed
 * since the last review in Markdown format.
 *
 * If nothing is cached then this always returns `changed === true` even if the
 * new patch is completely empty. Claude can explain the situation to the user.
 *
 * Callers must rule out an empty patch caused by a bad checkout or merge base
 * *before* calling this, because it saves the baseline.
 */
export async function compareAndCache(rawPatch, cachePath) {
  await mkdir(cachePath, { recursive: true });
  const prevPath = join(cachePath, "prev.patch");
  const newPath = join(cachePath, "new.patch");

  const current = normalizePatch(rawPatch);
  await writeFile(newPath, current);
  const prev = await readIfExists(prevPath);

  const result = {
    changed: prev !== current,
    previous: prev === null ? null : summarize(prev),
    current: summarize(current),
    section: "",
  };

  if (result.current.lines === 0) {
    result.section = emptiedSection(prev ?? "");
  } else if (result.previous?.lines === 0) {
    result.section = refilledSection();
  } else if (result.changed && result.previous) {
    result.section = [
      "## Changes since last review",
      "",
      "```",
      (await textDiff(prevPath, newPath)).replace(/\n$/, ""),
      "```",
    ].join("\n");
  }

  await rename(newPath, prevPath);
  return result;
}
