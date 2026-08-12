import { readFile, writeFile } from "node:fs/promises";

/**
 * Fixed path -- deliberately not derived from $RUNNER_TEMP or any other env
 * var. Claude's Bash tool can set arbitrary env vars on a single invocation
 * (e.g. `RUNNER_TEMP=/tmp/evil pr-review add-label x`), so anything that let
 * an env var influence this path would let Claude point add-label/
 * remove-label/list-available-labels at a labels file it wrote itself
 * instead of the one fetch-available-labels populated from the real repo
 * labels. Claude has no write access to /tmp itself (its default Edit/Write
 * permissions are scoped to /tmp/pr-review-scratch), so a literal path
 * outside that directory is safe from both routes.
 *
 * On a self-hosted runner running multiple concurrent jobs on one machine,
 * this path is shared across those jobs -- same caveat as the queue
 * directory falling back to os.tmpdir() (see queue.js).
 */
export const AVAILABLE_LABELS_FILE = "/tmp/pr-review-available-labels.json";

/**
 * Read the available labels file written by fetch-available-labels before
 * Claude's turn. Returns [] if the file doesn't exist (no labels
 * configured).
 */
export async function readAvailableLabels() {
  try {
    return JSON.parse(await readFile(AVAILABLE_LABELS_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

/** Write the available labels file. Called once by fetch-available-labels. */
export async function writeAvailableLabels(labels) {
  await writeFile(AVAILABLE_LABELS_FILE, JSON.stringify(labels));
}
