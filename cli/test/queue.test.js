import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claim,
  listClaimed,
  markPosted,
  queueComment,
  readBatch,
  setBody,
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
    const a = await queueComment(root, comment("a.js"));
    const b = await queueComment(root, comment("b.js"));
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

    const files = await readdir(path.join(root, "comments"));
    expect(files).toHaveLength(50);
  });

  it("claim() returns null when nothing was ever queued", async () => {
    expect(await claim(root)).toBeNull();
  });

  it("claim() atomically renames comments/ and only one caller can win it", async () => {
    await queueComment(root, comment("a.js"));

    const [first, second] = await Promise.all([claim(root), claim(root)]);
    const winners = [first, second].filter((c) => c !== null);
    expect(winners).toHaveLength(1);
  });

  it("claim() -> readBatch() round-trips comments and body", async () => {
    await queueComment(root, comment("a.js"));
    await queueComment(root, comment("b.js"));
    await setBody(root, "top-level notes");

    const claimed = await claim(root);
    const { comments, body } = await readBatch(claimed);
    expect(comments).toHaveLength(2);
    expect(body).toBe("top-level notes");
  });

  it("queueComment() after a claim() starts a fresh batch", async () => {
    await queueComment(root, comment("a.js"));
    const firstClaim = await claim(root);
    expect(await claim(root)).toBeNull(); // nothing new queued yet

    await queueComment(root, comment("b.js"));
    const secondClaim = await claim(root);
    expect(secondClaim).not.toBeNull();
    expect(secondClaim).not.toEqual(firstClaim);

    const { comments } = await readBatch(secondClaim);
    expect(comments).toEqual([comment("b.js")]);
  });

  it("markPosted() renames .claimed- to .posted-, and listClaimed() ignores it", async () => {
    await queueComment(root, comment("a.js"));
    const claimed = await claim(root);

    expect(await listClaimed(root)).toEqual([claimed]);

    const posted = await markPosted(claimed);
    expect(posted).toMatch(/comments\.posted-/);
    expect(await listClaimed(root)).toEqual([]);
  });

  it("listClaimed() surfaces an abandoned claim for retry", async () => {
    await queueComment(root, comment("a.js"));
    const claimed = await claim(root);
    // Simulate a crash: never call markPosted().

    expect(await listClaimed(root)).toEqual([claimed]);
    const { comments } = await readBatch(claimed);
    expect(comments).toEqual([comment("a.js")]);
  });

  it("listClaimed() returns an empty list when the queue dir doesn't exist yet", async () => {
    expect(await listClaimed(path.join(root, "never-created"))).toEqual([]);
  });
});
