import { readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AVAILABLE_LABELS_FILE } from "../lib/available-labels.js";
import { fetchAndWriteLabels, globToRegExp } from "../lib/labels.js";
import { withMockGitHub, route, responses } from "./support/mock-github.js";

async function readLabelsFile() {
  return JSON.parse(await readFile(AVAILABLE_LABELS_FILE, "utf8"));
}

describe("globToRegExp", () => {
  it("matches * as any run of characters", () => {
    const re = globToRegExp("foo*");
    expect(re.test("foo")).toBe(true);
    expect(re.test("foobar")).toBe(true);
    expect(re.test("bar")).toBe(false);
  });

  it("matches ? as a single character", () => {
    const re = globToRegExp("ab?cd");
    expect(re.test("ab cd")).toBe(true);
    expect(re.test("abcd")).toBe(false);
    expect(re.test("ab  cd")).toBe(false);
  });

  it("escapes regex special characters", () => {
    const re = globToRegExp("a.b");
    expect(re.test("a.b")).toBe(true);
    expect(re.test("axb")).toBe(false);
  });
});

describe("fetchAndWriteLabels", () => {
  afterEach(async () => {
    await rm(AVAILABLE_LABELS_FILE, { force: true });
  });

  it("writes [] without calling the API when no patterns are configured", async () => {
    await withMockGitHub(async ({ requests }) => {
      await fetchAndWriteLabels("test-token", "acme", "widgets", "");
      expect(await readLabelsFile()).toEqual([]);
      expect(requests).toHaveLength(0);
    });
  });

  it("writes matching labels with descriptions", async () => {
    await withMockGitHub(
      responses.GET_repo_labels([
        { name: "bug", description: "A bug" },
        { name: "enhancement", description: "" },
        { name: "other" },
        { name: "wontfix", description: "Won't fix" },
      ]),

      async () => {
        await fetchAndWriteLabels(
          "test-token",
          "acme",
          "widgets",
          "bug\nenhancement\nother",
        );
        expect(await readLabelsFile()).toEqual([
          { name: "bug", description: "A bug" },
          { name: "enhancement", description: "" },
          { name: "other" },
        ]);
      },
    );
  });

  it("matches glob patterns", async () => {
    await withMockGitHub(
      responses.GET_repo_labels([
        { name: "Claude: reviewed" },
        { name: "Claude: needs-work" },
        { name: "bug" },
        { name: "abcxyz" },
        { name: "abxyz" },
        { name: "abc xyz" },
        { name: "abc  xyz" },
      ]),

      async () => {
        await fetchAndWriteLabels(
          "test-token",
          "acme",
          "widgets",
          "Claude: *\nabc?xyz",
        );
        const labels = await readLabelsFile();
        expect(labels.map((l) => l.name)).toEqual([
          "Claude: reviewed",
          "Claude: needs-work",
          "abc xyz",
        ]);
      },
    );
  });

  it("warns on stderr when patterns match nothing", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      await withMockGitHub(
        responses.GET_repo_labels([{ name: "bug" }]),

        async () => {
          await fetchAndWriteLabels(
            "test-token",
            "acme",
            "widgets",
            "nonexistent",
          );
          const output = stderrSpy.mock.calls
            .map(([msg]) => String(msg))
            .join("");
          expect(output).toMatch(/::warning::available-labels/);
          expect(await readLabelsFile()).toEqual([]);
        },
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("paginates through repo labels", async () => {
    // A full 100-item page triggers a second fetch; route() cycles through
    // responses per call and repeats the last one, so this returns page1
    // then page2 (which is under 100 items, ending the loop).
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      name: `label-${i}`,
      description: "",
    }));
    const page2 = [{ name: "label-100" }];

    await withMockGitHub(
      route("GET", "/labels\\?", { body: page1 }, { body: page2 }),

      async () => {
        await fetchAndWriteLabels("test-token", "acme", "widgets", "label-*");
        const labels = await readLabelsFile();
        expect(labels).toHaveLength(101);
        expect(labels[100].name).toBe("label-100");
      },
    );
  });
});
