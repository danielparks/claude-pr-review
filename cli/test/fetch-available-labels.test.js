// End-to-end smoke test: spawns the actual fetch-available-labels script as
// a subprocess, exactly how action.yaml invokes it before Claude's turn.
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { AVAILABLE_LABELS_FILE } from "../lib/available-labels.js";
import { withMockGitHub, route, responses } from "./support/mock-github.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(
  new URL("../fetch-available-labels", import.meta.url),
);

function run(extraEnv) {
  return execFileAsync("node", [CLI_PATH], {
    env: {
      ...process.env,
      GH_TOKEN: "test-token",
      GITHUB_REPOSITORY: "acme/widgets",
      ...extraEnv,
    },
  });
}

async function readLabelsFile() {
  return JSON.parse(await readFile(AVAILABLE_LABELS_FILE, "utf8"));
}

describe("fetch-available-labels", () => {
  afterEach(async () => {
    await rm(AVAILABLE_LABELS_FILE, { force: true });
  });

  it("writes [] without calling the API when no patterns are configured", async () => {
    await withMockGitHub(async ({ requests }) => {
      await run({ AVAILABLE_LABELS_PATTERNS: "" });
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
        await run({ AVAILABLE_LABELS_PATTERNS: "bug\nenhancement\nother" });
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
        await run({ AVAILABLE_LABELS_PATTERNS: "Claude: *\nabc?xyz" });
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
    await withMockGitHub(
      responses.GET_repo_labels([{ name: "bug" }]),

      async () => {
        const { stderr } = await run({
          AVAILABLE_LABELS_PATTERNS: "nonexistent",
        });
        expect(stderr).toMatch(/::warning::available-labels/);
        expect(await readLabelsFile()).toEqual([]);
      },
    );
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
        await run({ AVAILABLE_LABELS_PATTERNS: "label-*" });
        const labels = await readLabelsFile();
        expect(labels).toHaveLength(101);
        expect(labels[100].name).toBe("label-100");
      },
    );
  });
});
