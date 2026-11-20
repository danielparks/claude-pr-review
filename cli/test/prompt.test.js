import { describe, expect, it } from "vitest";
import {
  assemblePrompt,
  MAX_PROMPT_BYTES,
  truncateMiddle,
} from "../lib/prompt.js";

const paths = { discussion: "/tmp/disc.md", diffOfDiffs: "/tmp/diff.md" };
const buf = (text) => Buffer.from(text, "utf8");
const bytes = (text) => Buffer.byteLength(text, "utf8");
const lines = (count, prefix = "line") =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join("\n");

function parts(overrides = {}) {
  return {
    header: "REPO: o/r\nPR NUMBER: 1",
    prompt: "Review this.\n",
    additionalPrompt: "",
    labels: "",
    diffOfDiffs: "",
    discussion: "discussion",
    ...overrides,
  };
}

describe("truncateMiddle", () => {
  it("returns text that already fits", () => {
    expect(truncateMiddle(buf("a\nb"), 100, () => "gap").toString()).toBe(
      "a\nb",
    );
  });

  it("keeps the start and the end, and marks the gap", () => {
    const text = lines(1000);
    const out = truncateMiddle(
      buf(text),
      500,
      (n) => `[${n} omitted]`,
    ).toString();
    expect(bytes(out)).toBeLessThanOrEqual(500);
    expect(out.startsWith("line 0\n")).toBe(true);
    expect(out.endsWith("line 999")).toBe(true);
    expect(out).toMatch(/\[\d+ omitted\]/);
  });

  it("reports the exact number of bytes omitted", () => {
    const text = lines(1000);
    const out = truncateMiddle(buf(text), 500, (n) => `[${n}]`).toString();
    const omitted = Number(/\[(\d+)\]/.exec(out)[1]);
    const kept = out.replace(/\[\d+\]\n/, "");
    expect(bytes(kept) + omitted).toBe(bytes(text));
  });

  it("leaves an empty buffer alone even with a negative budget", () => {
    const empty = buf("");
    expect(truncateMiddle(empty, -5, () => "[gap]")).toBe(empty);
  });

  it("copes with a budget too small for any lines", () => {
    const out = truncateMiddle(buf(lines(100)), 10, () => "[gap]").toString();
    expect(out).toBe("[gap]\n");
  });

  it("counts bytes, not characters", () => {
    const text = Array(500).fill("日本語日本語").join("\n");
    const out = truncateMiddle(buf(text), 600, () => "gap").toString();
    expect(bytes(out)).toBeLessThanOrEqual(600);
  });
});

describe("assemblePrompt", () => {
  it("joins the parts in order when everything fits", () => {
    const { text, shrunk } = assemblePrompt(
      parts({
        additionalPrompt: "Also this.",
        labels: "labels",
        diffOfDiffs: "diffs",
      }),
      paths,
    );
    expect(shrunk).toEqual([]);
    expect(text).toBe(
      "REPO: o/r\nPR NUMBER: 1\n\nReview this.\n\nAlso this.\n\nlabels\n\n" +
        "diffs\n\ndiscussion",
    );
  });

  it("shrinks the discussion first and points to the saved file", () => {
    const { text, shrunk } = assemblePrompt(
      parts({ diffOfDiffs: "diffs", discussion: lines(20000) }),
      paths,
    );
    expect(shrunk).toEqual(["discussion"]);
    expect(bytes(text)).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
    expect(text).toContain("diffs");
    expect(text).toContain("/tmp/disc.md");
  });

  it("shrinks the diff section only if the discussion can't absorb it", () => {
    const { text, shrunk } = assemblePrompt(
      parts({ diffOfDiffs: lines(500), discussion: "short" }),
      paths,
      2000,
    );
    expect(shrunk).toEqual(["diffOfDiffs"]);
    expect(bytes(text)).toBeLessThanOrEqual(2000);
    expect(text).toContain("/tmp/diff.md");
    expect(text).toContain("short");
  });

  it("fails if even the markers don't fit", () => {
    // The fixed parts fit, but leave no room for a section or its marker.
    const fixedBytes = bytes("REPO: o/r\nPR NUMBER: 1\n\nReview this.");
    expect(() =>
      assemblePrompt(
        parts({ discussion: lines(1000) }),
        paths,
        fixedBytes + 10,
      ),
    ).toThrow(/even with the discussion and diff of diffs cut down/);
  });

  it("does not modify its input", () => {
    const input = parts({ discussion: lines(20000) });
    const before = input.discussion;
    assemblePrompt(input, paths);
    expect(input.discussion).toBe(before);
  });

  it("fails if the fixed parts alone are too big", () => {
    expect(() =>
      assemblePrompt(parts({ prompt: "x".repeat(300) }), paths, 200),
    ).toThrow(/over the 200 byte limit/);
  });

  it("omits empty parts without stray separators", () => {
    const { text } = assemblePrompt(parts({ discussion: "" }), paths);
    expect(text).toBe("REPO: o/r\nPR NUMBER: 1\n\nReview this.");
  });
});
