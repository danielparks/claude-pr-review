import type { ReviewComment } from "./types.js";

/**
 * Queues review comments and flushes them as a single atomic post.
 *
 * `add()` is synchronous and immediate — pushing to an array can't race with
 * itself no matter how it's called. `submit()` validates, snapshots, and
 * clears the queue *synchronously*, before its first `await` — an `async`
 * function's body runs synchronously up to that point, so two `submit()`
 * calls made back to back (with no `await` between them) can never both
 * observe the same un-cleared queue, and each gets its own disjoint
 * snapshot. This is what replaces the bug this class was extracted to fix:
 * two `submit_review` calls fired without waiting used to both read the
 * queue before either had cleared it, and both post the same comments.
 *
 * Because each `submit()` call synchronously claims its own snapshot before
 * `post` ever runs, an `add()` that happens while a previous submit's
 * `post()` is still in flight always lands in a fresh batch for the *next*
 * submit — it can't be silently dropped or racily folded into the one
 * already underway — and their two `post()` calls need no coordination
 * between them (they're posting disjoint comment sets). If `post` throws,
 * whatever was cleared for that attempt is restored ahead of anything
 * added since, so a retry sends everything again, in order.
 */
export class ReviewBatch<TResult> {
  private comments: ReviewComment[] = [];

  add(comment: ReviewComment): number {
    this.comments.push(comment);
    return this.comments.length;
  }

  async submit(
    body: string,
    post: (comments: ReviewComment[], body: string) => Promise<TResult>,
  ): Promise<TResult> {
    if (this.comments.length === 0 && !body) {
      throw new Error(
        "Nothing to submit: call add_comment first, or pass a body for " +
          "top-level-only feedback.",
      );
    }

    const toPost = this.comments;
    this.comments = [];
    try {
      return await post(toPost, body);
    } catch (error) {
      this.comments = [...toPost, ...this.comments];
      throw error;
    }
  }
}
