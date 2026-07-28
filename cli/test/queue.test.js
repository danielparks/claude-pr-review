import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claim,
  discardClaimed,
  initQueue,
  listClaimed,
  listQueue,
  markPosted,
  queueComment,
  readBatch,
  setReview,
} from "../lib/queue.js";

function comment(path_) {
  return { path: path_, body: path_, side: "RIGHT", line: 1 };
}

describe("queue", () => {
  let root;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "pr-review-queue-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("queueComment() writes each comment to its own uniquely named file", async () => {
    const a = await queueComment(root, comment("a.txt"));
    const b = await queueComment(root, comment("b.txt"));
    expect(a).not.toEqual(b);

    const files = await readdir(path.join(root, "comments"));
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith(".json"))).toBe(true);
  });

  it("many concurrent queueComment() calls never collide", async () => {
    const paths = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        queueComment(root, comment(`f${i}.js`)),
      ),
    );
    expect(new Set(paths).size).toBe(50);

    expect(await readdir(path.join(root, "comments"))).toHaveLength(50);
  });

  it("initQueue() creates the root directory", async () => {
    const fresh = path.join(root, "fresh");
    await initQueue(fresh);
    expect(await readdir(fresh)).toEqual([]);
  });

  it("initQueue() fails with EEXIST when the directory already exists", async () => {
    // `root` itself already exists (mkdtemp created it in beforeEach).
    await expect(initQueue(root)).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("claim() returns null when nothing was ever queued", async () => {
    expect(await claim(root)).toBeNull();
  });

  it("claim() atomically renames comments/ and only one caller can win it", async () => {
    await queueComment(root, comment("a.txt"));

    const [first, second] = await Promise.all([claim(root), claim(root)]);
    const winners = [first, second].filter((c) => c !== null);
    expect(winners).toHaveLength(1);
  });

  it("claim() -> readBatch() round-trips comments and body", async () => {
    await queueComment(root, comment("a.txt"));
    await queueComment(root, comment("b.txt"));

    const claimed = await claim(root);
    await setReview(claimed, "COMMENT", "top-level notes");
    const { comments, body } = await readBatch(claimed);
    expect(comments).toHaveLength(2);
    expect(body).toBe("top-level notes");
  });

  it("readBatch() defaults event to COMMENT when setReview() was never called", async () => {
    await queueComment(root, comment("a.txt"));
    const claimed = await claim(root);
    expect((await readBatch(claimed)).event).toBe("COMMENT");
  });

  it("claim() -> readBatch() round-trips the event set by setReview()", async () => {
    await queueComment(root, comment("a.txt"));

    const claimed = await claim(root);
    await setReview(claimed, "APPROVE", "");
    expect((await readBatch(claimed)).event).toBe("APPROVE");
  });

  it("claim() can create an empty claimed directory", async () => {
    const claimed = await claim(root, { create: true });
    expect(claimed).not.toBeNull();

    const { comments, body, event } = await readBatch(claimed);
    expect(comments).toEqual([]);
    expect(body).toBe("");
    expect(event).toBe("COMMENT");
  });

  it("queueComment() after a claim() starts a fresh batch", async () => {
    await queueComment(root, comment("a.txt"));
    const firstClaim = await claim(root);
    expect(await claim(root)).toBeNull(); // nothing new queued yet

    await queueComment(root, comment("b.txt"));
    const secondClaim = await claim(root);
    expect(secondClaim).not.toBeNull();
    expect(secondClaim).not.toEqual(firstClaim);

    const { comments } = await readBatch(secondClaim);
    expect(comments).toEqual([comment("b.txt")]);
  });

  it("markPosted() renames .claimed- to .posted-, and listClaimed() ignores it", async () => {
    await queueComment(root, comment("a.txt"));
    const claimed = await claim(root);

    expect(await listClaimed(root)).toEqual([claimed]);

    const posted = await markPosted(claimed);
    expect(posted).toMatch(/comments\.posted-/);
    expect(await listClaimed(root)).toEqual([]);
  });

  it("listClaimed() surfaces an abandoned claim for retry", async () => {
    await queueComment(root, comment("a.txt"));
    const claimed = await claim(root);
    // Simulate a crash: never call markPosted().

    expect(await listClaimed(root)).toEqual([claimed]);
    const { comments } = await readBatch(claimed);
    expect(comments).toEqual([comment("a.txt")]);
  });

  it("listClaimed() returns an empty list when the queue dir doesn't exist yet", async () => {
    expect(await listClaimed(path.join(root, "never-created"))).toEqual([]);
  });

  it("listQueue() returns an empty list when the queue dir doesn't exist yet", async () => {
    expect(await listQueue(path.join(root, "never-created"))).toEqual([]);
  });

  it("listQueue() reports open, claimed, and posted batches with their contents", async () => {
    await queueComment(root, comment("posted.txt"));
    const toPost = await claim(root);
    await setReview(toPost, "COMMENT", "posted body");
    const posted = await markPosted(toPost);

    await queueComment(root, comment("stuck.txt"));
    const stuck = await claim(root);
    await setReview(stuck, "APPROVE", "stuck body");

    await queueComment(root, comment("open.txt"));

    const batches = await listQueue(root);
    expect(batches).toEqual([
      {
        dir: path.join(root, "comments"),
        state: "open",
        comments: [comment("open.txt")],
        body: "",
        event: "COMMENT",
      },
      {
        dir: stuck,
        state: "claimed",
        comments: [comment("stuck.txt")],
        body: "stuck body",
        event: "APPROVE",
      },
      {
        dir: posted,
        state: "posted",
        comments: [comment("posted.txt")],
        body: "posted body",
        event: "COMMENT",
      },
    ]);
  });

  it("discardClaimed() removes a claimed batch", async () => {
    await queueComment(root, comment("a.txt"));
    const claimed = await claim(root);

    await discardClaimed(claimed);
    expect(await listClaimed(root)).toEqual([]);
  });

  it("discardClaimed() refuses to remove a non-claimed directory", async () => {
    await queueComment(root, comment("a.txt"));
    const openDir = path.join(root, "comments");

    await expect(discardClaimed(openDir)).rejects.toThrow(
      /Not a claimed batch directory/,
    );
    expect(await readdir(openDir)).toHaveLength(1);
  });

  it("discardClaimed() fails on a directory that doesn't exist", async () => {
    await expect(
      discardClaimed(path.join(root, "comments.claimed-nope")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
