import { readFile, writeFile } from "node:fs/promises";

/**
 * Claude has no write access to /tmp itself (its default Edit/Write
 * permissions are scoped to /tmp/pr-review-scratch), so a fixed path
 * outside that directory prevents Claude from changing the data.
 *
 * On a self-hosted runner running multiple concurrent jobs on one machine,
 * this path is shared across those jobs.
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
