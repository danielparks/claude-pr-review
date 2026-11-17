import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareAndCache, normalizePatch } from "../lib/diff-check.js";

const patch = (line, extra = "") =>
  [
    "diff --git a/f b/f",
    "index 1111111..2222222 100644",
    "--- a/f",
    "+++ b/f",
    `@@ -${line},3 +${line},4 @@ function foo() {`,
    " context",
    `+added${extra}`,
    "",
  ].join("\n");

describe("normalizePatch", () => {
  it("removes index lines and hunk line numbers", () => {
    expect(normalizePatch(patch(10))).toBe(
      [
        "diff --git a/f b/f",
        "--- a/f",
        "+++ b/f",
        "@@ - - @@ function foo() {",
        " context",
        "+added",
        "",
      ].join("\n"),
    );
  });

  it("makes a rebased patch identical", () => {
    const rebased = patch(250).replace("2222222", "3333333");
    expect(normalizePatch(rebased)).toBe(normalizePatch(patch(10)));
  });

  it("keeps real content changes", () => {
    expect(normalizePatch(patch(10, "!"))).not.toBe(normalizePatch(patch(10)));
  });
});

describe("compareAndCache", () => {
  let dir;
  let cache;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "diff-check-"));
    cache = join(dir, "cache");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports the first run and saves the baseline", async () => {
    const result = await compareAndCache(patch(10), cache);
    expect(result).toMatchObject({
      changed: true,
      section: "",
      previous: null,
    });
    expect(await readFile(join(cache, "prev.patch"), "utf8")).toBe(
      normalizePatch(patch(10)),
    );
  });

  it("skips when a rebase leaves the diff unchanged", async () => {
    await compareAndCache(patch(10), cache);
    const result = await compareAndCache(patch(250), cache);
    expect(result).toMatchObject({ changed: false });
    expect(result.previous).toEqual(result.current);
  });

  it("produces a diff-of-diffs when the diff changes", async () => {
    await compareAndCache(patch(10), cache);
    const result = await compareAndCache(patch(10, "!"), cache);
    expect(result.changed).toBe(true);
    expect(result.section).toMatch(/^## Changes since last review\n\n```\n/);
    expect(result.section).toContain("< +added\n---\n> +added!");
    expect(result.section).toMatch(/\n```$/);
  });

  it("uses the changed diff as the next baseline", async () => {
    await compareAndCache(patch(10), cache);
    await compareAndCache(patch(10, "!"), cache);
    const result = await compareAndCache(patch(99, "!"), cache);
    expect(result).toMatchObject({ changed: false, section: "" });
  });

  it("handles an empty first diff", async () => {
    const result = await compareAndCache("", cache);
    expect(result).toMatchObject({
      changed: true,
      previous: null,
      current: { lines: 0 },
    });
    expect(result.section).toContain("now **empty**");
    expect(result.section).not.toContain("\n- ");
    expect(result.section).toContain("outdated");
    await expect(await readFile(join(cache, "prev.patch"), "utf8")).toBe("");
  });

  it("notes the first real diff after an empty first run", async () => {
    await compareAndCache("", cache);
    const result = await compareAndCache(patch(10), cache);
    expect(result).toMatchObject({
      changed: true,
      previous: { lines: 0 },
    });
    expect(result.section).toContain("was **empty**");
    expect(result.section).not.toContain("\n- ");
    expect(result.section).toContain("outdated");
  });

  it("reports a PR that becomes empty, listing its old files", async () => {
    await compareAndCache(patch(10), cache);
    const result = await compareAndCache("", cache);
    expect(result).toMatchObject({ changed: true, current: { lines: 0 } });
    expect(result.section).toContain("now **empty**");
    expect(result.section).toContain("- `f`");
    expect(result.section).toContain("outdated");
  });

  it("saves the empty diff so a second empty push is skipped", async () => {
    await compareAndCache(patch(10), cache);
    await compareAndCache("", cache);
    expect(await readFile(join(cache, "prev.patch"), "utf8")).toBe("");
    const result = await compareAndCache("", cache);
    expect(result).toMatchObject({ changed: false });
  });

  it("says everything is new when a PR is refilled after being empty", async () => {
    await compareAndCache(patch(10), cache);
    await compareAndCache("", cache);
    const result = await compareAndCache(patch(10), cache);
    expect(result).toMatchObject({ changed: true, previous: { lines: 0 } });
    expect(result.section).toContain("**empty** at the last review");
    expect(result.section).toContain("outdated");
    expect(result.section).not.toContain("```");
  });

  it("ignores a cache directory left by something else", async () => {
    await writeFile(join(dir, "unrelated"), "x");
    const result = await compareAndCache(patch(10), cache);
    expect(result).toMatchObject({ changed: true, previous: null });
  });
});
