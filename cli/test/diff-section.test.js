import { describe, expect, it } from "vitest";
import { normalizePatch } from "../lib/diff-check.js";
import { buildSection, LIMITS, parseFiles } from "../lib/diff-section.js";

/** Build a normalized patch from `{ path, ctx, lines }` file descriptions. */
function patchOf(files) {
  return normalizePatch(
    files
      .map(({ path, hunks }) =>
        [
          `diff --git a/${path} b/${path}`,
          `--- a/${path}`,
          `+++ b/${path}`,
          ...hunks.flatMap(({ ctx = "", lines }) => [
            `@@ -1,3 +1,3 @@ ${ctx}`.trimEnd(),
            ...lines,
          ]),
          "",
        ].join("\n"),
      )
      .join(""),
  );
}

const file = (path, lines, ctx = "function foo() {") => ({
  path,
  hunks: [{ ctx, lines }],
});

describe("parseFiles", () => {
  it("keys by path and reduces hunk headers to their context", () => {
    const files = parseFiles(patchOf([file("a.js", [" x", "+y"])]));
    expect([...files.keys()]).toEqual(["a.js"]);
    expect(files.get("a.js")).toContain("@@ function foo() {");
    expect(files.get("a.js")).toContain("+y");
  });

  it("uses a bare @@ when there is no context", () => {
    const files = parseFiles(patchOf([file("a.js", ["+y"], "")]));
    expect(files.get("a.js")).toContain("@@");
    expect(files.get("a.js")).not.toContain("@@ -");
  });
});

describe("buildSection", () => {
  it("shows an edited line under its file and function", async () => {
    const prev = patchOf([file("a.js", [" keep", "+old line"])]);
    const current = patchOf([file("a.js", [" keep", "+new line"])]);
    const section = await buildSection(prev, current);
    expect(section).toMatch(/^## Changes since last review\n/);
    expect(section).toContain("### `a.js`");
    expect(section).toContain("@@ function foo() {\n< +old line\n> +new line");
    expect(section).not.toContain("keep");
  });

  it("labels groups with the nearest preceding function context", async () => {
    const prev = patchOf([
      {
        path: "a.js",
        hunks: [
          { ctx: "first()", lines: [" a", "+one"] },
          { ctx: "second()", lines: [" b", "+two"] },
        ],
      },
    ]);
    const current = patchOf([
      {
        path: "a.js",
        hunks: [
          { ctx: "first()", lines: [" a", "+one"] },
          { ctx: "second()", lines: [" b", "+TWO"] },
        ],
      },
    ]);
    const section = await buildSection(prev, current);
    expect(section).toContain("@@ second()\n< +two\n> +TWO");
    expect(section).not.toContain("first()");
  });

  it("omits files that did not change", async () => {
    const same = file("same.js", ["+x"]);
    const section = await buildSection(
      patchOf([same, file("a.js", ["+1"])]),
      patchOf([same, file("a.js", ["+2"])]),
    );
    expect(section).toContain("### `a.js`");
    expect(section).not.toContain("same.js");
  });

  it("summarizes added and removed files by name and size", async () => {
    const section = await buildSection(
      patchOf([file("gone.js", ["+a", "+b", "-c"])]),
      patchOf([file("new.js", ["+a", "+b", "+c", "+d"])]),
    );
    expect(section).toContain("Files no longer in the PR diff:");
    expect(section).toContain("- `gone.js` (+2 −1)");
    expect(section).toContain("Files newly in the PR diff");
    expect(section).toContain("- `new.js` (+4 −0)");
    expect(section).not.toContain("###");
  });

  it("caps the number of files listed", async () => {
    const names = Array.from(
      { length: LIMITS.listedFiles + 7 },
      (_, i) => `f${i}.js`,
    );
    const section = await buildSection(
      "",
      patchOf(names.map((n) => file(n, ["+x"]))),
    );
    expect(section).toContain("- `f0.js` (+1 −0)");
    expect(section).not.toContain(`- \`f${LIMITS.listedFiles}.js\``);
    expect(section).toContain("- … and 7 more files");
  });

  it("explains the markers", async () => {
    const section = await buildSection(
      patchOf([file("a.js", ["+1"])]),
      patchOf([file("a.js", ["+2"])]),
    );
    expect(section).toContain("Lines starting with `<` were in the PR diff");
  });

  it("caps the lines shown on each side of a group", async () => {
    const many = (prefix) =>
      Array.from({ length: LIMITS.groupLines + 5 }, (_, i) => `+${prefix}${i}`);
    const section = await buildSection(
      patchOf([file("a.js", many("old"))]),
      patchOf([file("a.js", many("new"))]),
    );
    expect(section).toContain("< +old0\n");
    expect(section).toContain(`< +old${LIMITS.groupLines - 1}\n`);
    expect(section).not.toContain(`< +old${LIMITS.groupLines}\n`);
    expect(section).toContain("< … (5 more lines)");
    expect(section).toContain("> … (5 more lines)");
  });

  it("summarizes a file whose changes are too large", async () => {
    // Many separate small changes, each under the group cap.
    const hunks = (prefix) =>
      Array.from({ length: 200 }, (_, i) => ({
        ctx: `f${i}()`,
        lines: [`+${prefix} ${"x".repeat(40)} ${i}`],
      }));
    const section = await buildSection(
      patchOf([{ path: "big.js", hunks: hunks("a") }, file("s.js", ["+1"])]),
      patchOf([{ path: "big.js", hunks: hunks("b") }, file("s.js", ["+2"])]),
    );
    expect(section).toContain("Changes too large to show here");
    expect(section).toContain("- `big.js` (400 lines differ)");
    expect(section).toContain("### `s.js`");
    expect(section.length).toBeLessThan(LIMITS.totalBytes);
  });

  it("stops showing details once the total limit is reached", async () => {
    const perFile = Math.floor(LIMITS.fileBytes / 4);
    const lines = (prefix) => [`+${prefix}${"x".repeat(perFile)}`];
    const names = Array.from({ length: 10 }, (_, i) => `f${i}.js`);
    const section = await buildSection(
      patchOf(names.map((n) => file(n, lines("a")))),
      patchOf(names.map((n) => file(n, lines("b")))),
    );
    const shown = names.filter((n) => section.includes(`### \`${n}\``));
    const summarized = names.filter((n) => section.includes(`- \`${n}\``));
    expect(shown.length).toBeGreaterThan(0);
    expect(summarized.length).toBeGreaterThan(0);
    expect(shown.length + summarized.length).toBe(names.length);
    expect(section.length).toBeLessThan(LIMITS.totalBytes + 2000);
  });

  it("uses a longer fence when the content contains backticks", async () => {
    const section = await buildSection(
      patchOf([file("a.md", ["+```js"])]),
      patchOf([file("a.md", ["+````js"])]),
    );
    expect(section).toContain("`````diff\n");
    expect(section).toMatch(/\n`````$/);
  });
});
