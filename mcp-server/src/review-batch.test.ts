import { describe, expect, it, vi } from "vitest";
import { ReviewBatch } from "./review-batch.js";
import type { ReviewComment } from "./types.js";

function comment(path: string): ReviewComment {
  return { path, body: path, side: "RIGHT", line: 1 };
}

/** A post() that only resolves once `resolve()` is called, so tests can
 * control exactly when a submit's "network request" completes. */
function deferredPost<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const post = vi.fn((_comments: ReviewComment[], _body: string) => promise);
  return { post, resolve, reject };
}

describe("ReviewBatch", () => {
  it("add() returns the running count", () => {
    const batch = new ReviewBatch<void>();
    expect(batch.add(comment("a.js"))).toBe(1);
    expect(batch.add(comment("b.js"))).toBe(2);
  });

  it("submit() posts everything queued and clears the batch", async () => {
    const batch = new ReviewBatch<{ ok: true }>();
    batch.add(comment("a.js"));
    batch.add(comment("b.js"));

    const post = vi.fn(async (comments: ReviewComment[], body: string) => {
      expect(comments).toHaveLength(2);
      expect(body).toBe("looks good");
      return { ok: true as const };
    });

    const result = await batch.submit("looks good", post);
    expect(result).toEqual({ ok: true });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("rejects without calling post when there's nothing queued and no body", async () => {
    const batch = new ReviewBatch<void>();
    const post = vi.fn(async () => undefined);

    await expect(batch.submit("", post)).rejects.toThrow("Nothing to submit");
    expect(post).not.toHaveBeenCalled();
  });

  it("allows a body-only submit with an empty queue", async () => {
    const batch = new ReviewBatch<{ ok: true }>();
    const post = vi.fn(async (comments: ReviewComment[]) => {
      expect(comments).toHaveLength(0);
      return { ok: true as const };
    });

    await expect(batch.submit("top-level feedback", post)).resolves.toEqual({
      ok: true,
    });
  });

  it("two submits fired without waiting don't race on the queue (regression)", async () => {
    const batch = new ReviewBatch<{ ok: true }>();
    batch.add(comment("a.js"));

    const first = deferredPost<{ ok: true }>();
    const second = vi.fn(async () => ({ ok: true as const }));

    const firstResult = batch.submit("first", first.post);
    // Fired before the first submit's post() has resolved.
    const secondResult = batch.submit("", second);

    first.resolve({ ok: true });

    await expect(firstResult).resolves.toEqual({ ok: true });
    await expect(secondResult).rejects.toThrow("Nothing to submit");

    expect(first.post).toHaveBeenCalledTimes(1);
    expect(first.post).toHaveBeenCalledWith([comment("a.js")], "first");
    expect(second).not.toHaveBeenCalled();
  });

  it("restores the queue on failure so a retry sends everything again", async () => {
    const batch = new ReviewBatch<{ ok: true }>();
    batch.add(comment("a.js"));

    await expect(
      batch.submit("first try", async () => {
        throw new Error("network blip");
      }),
    ).rejects.toThrow("network blip");

    // The failed comment is still queued, and a comment added afterward
    // joins it, in order.
    batch.add(comment("b.js"));

    const post = vi.fn(async (comments: ReviewComment[]) => {
      expect(comments).toEqual([comment("a.js"), comment("b.js")]);
      return { ok: true as const };
    });
    await expect(batch.submit("retry", post)).resolves.toEqual({ ok: true });
  });

  it("an add() during an in-flight submit lands in the next batch, not the current one", async () => {
    const batch = new ReviewBatch<{ ok: true }>();
    batch.add(comment("a.js"));

    const inFlight = deferredPost<{ ok: true }>();
    const firstResult = batch.submit("first", inFlight.post);

    // Queued while the first submit's post() is still pending.
    batch.add(comment("b.js"));

    inFlight.resolve({ ok: true });
    await expect(firstResult).resolves.toEqual({ ok: true });
    expect(inFlight.post).toHaveBeenCalledWith([comment("a.js")], "first");

    const post = vi.fn(async (comments: ReviewComment[]) => {
      expect(comments).toEqual([comment("b.js")]);
      return { ok: true as const };
    });
    await expect(batch.submit("second", post)).resolves.toEqual({ ok: true });
  });
});
