// Directory-of-files queue for comments awaiting submission as one grouped
// review, plus the claim/retry scheme that lets `comment-review` run either
// from Claude (mid-session) or from the deferred sweep step (after the
// session ends) without any locking.
//
// States, encoded entirely in directory names so a fresh process can always
// tell what state a batch is in without reading any file content:
//
//   comments/                           open — Claude is still queuing
//   comments.claimed-<ts>-<pid>-<uuid>/ an attempt is in flight (or crashed)
//   comments.posted-<ts>-<pid>-<uuid>/  confirmed posted — terminal, ignorable
//
// Queuing a comment only ever creates a brand-new, uniquely-named file, so
// there's nothing to lock: two concurrent queue-inline-comment calls can
// never collide. Claiming is a single atomic rename, so at most one process can
// ever own a given batch. Marking a batch posted is also a single atomic
// rename, done only after a confirmed-successful API response, so a crash
// between "posted" and "cleaned up" is distinguishable from a crash before
// the post ever succeeded — the sweep step retries the latter and just
// ignores (or tidies up) the former.
//
// `_event.txt` (written by `setEvent`) records which review event a
// finalizing command decided on -- COMMENT, APPROVE, or REQUEST_CHANGES --
// so that if a crash happens after the decision but before the API call
// succeeds, a retry (whether live or from `sweep`) knows what it's actually
// completing instead of guessing.
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function queueRoot() {
  return (
    process.env.PR_REVIEW_QUEUE_DIR ||
    path.join(process.env.RUNNER_TEMP || os.tmpdir(), "pr-review-queue")
  );
}

/**
 * Exclusively create the queue root -- fails (EEXIST) if it already
 * exists. Meant to be called once, by `pr-review init`, before Claude's
 * turn starts, so nothing that ran earlier in the same job -- or left over
 * on a reused self-hosted runner -- can have pre-seeded a review decision
 * before Claude ever gets a chance to.
 */
export async function initQueue(root) {
  await mkdir(root);
}

function commentsDir(root) {
  return path.join(root, "comments");
}

async function writeAtomic(filePath, content) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  await writeFile(tmp, content);
  await rename(tmp, filePath);
}

/** Queue one inline comment. Returns the path it was written to. */
export async function queueComment(root, comment) {
  const dir = commentsDir(root);
  await mkdir(dir, { recursive: true });
  const final = path.join(dir, `${Date.now()}-${randomUUID()}.json`);
  await writeAtomic(final, JSON.stringify(comment));
  return final;
}

/** Set (or replace) the top-level review body for the live batch. */
export async function setBody(root, body) {
  const dir = commentsDir(root);
  await mkdir(dir, { recursive: true });
  await writeAtomic(path.join(dir, "_body.txt"), body);
}

/**
 * Set (or replace) the review event ("COMMENT", "APPROVE", or
 * "REQUEST_CHANGES") for the live batch. Called unconditionally by every
 * finalizing command (even with nothing else queued), so the batch directory
 * always exists once a decision has been made -- including a bare approval
 * with no comments or body.
 */
export async function setEvent(root, event) {
  const dir = commentsDir(root);
  await mkdir(dir, { recursive: true });
  await writeAtomic(path.join(dir, "_event.txt"), event);
}

/**
 * Atomically claim the live `comments/` directory for submission.
 * Returns the claimed directory's path, or null if there's nothing queued
 * (no comments and no body were ever added).
 */
export async function claim(root) {
  const dir = commentsDir(root);
  const claimed = path.join(
    root,
    `comments.claimed-${Date.now()}-${process.pid}-${randomUUID()}`,
  );
  try {
    await rename(dir, claimed);
    return claimed;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Read every queued comment (in filename order), plus the body and event,
 * if set. Defaults to "COMMENT" if `setEvent` was never called, e.g. when
 * Claude only creates inline comments and no actual review.
 */
export async function readBatch(claimedDir) {
  const entries = await readdir(claimedDir);
  const comments = [];
  let body = "";
  let event = "COMMENT";
  for (const entry of entries.sort()) {
    if (entry === "_body.txt") {
      body = await readFile(path.join(claimedDir, entry), "utf8");
    } else if (entry === "_event.txt") {
      event = await readFile(path.join(claimedDir, entry), "utf8");
    } else if (entry.endsWith(".json")) {
      comments.push(
        JSON.parse(await readFile(path.join(claimedDir, entry), "utf8")),
      );
    }
  }
  return { comments, body, event };
}

/** Mark a claimed batch as successfully posted. Returns the new path. */
export async function markPosted(claimedDir) {
  const { dir, base } = path.parse(claimedDir);
  const posted = path.join(
    dir,
    base.replace(/^comments\.claimed-/, "comments.posted-"),
  );
  await rename(claimedDir, posted);
  return posted;
}

/** List any claimed batches still awaiting (or abandoned mid-) submission. */
export async function listClaimed(root) {
  try {
    const entries = await readdir(root);
    return entries
      .filter((entry) => entry.startsWith("comments.claimed-"))
      .map((entry) => path.join(root, entry));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

/** Best-effort cleanup of a posted batch. Failure here is not fatal. */
export async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true });
}
