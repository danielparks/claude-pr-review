import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Size limits, so that an earlier push that contained something huge (e.g.
 * generated files) can't make the section larger than the PR itself.
 */
export const LIMITS = {
  /** Most lines shown on each side (`<` or `>`) of one group of changes. */
  groupLines: 30,
  /** Largest rendered size of one file's changes before it's summarized. */
  fileBytes: 6000,
  /** Largest total size of the section's file details. */
  totalBytes: 20000,
  /** Most files named in each list (added, removed, or summarized). */
  listedFiles: 25,
};

const PREAMBLE =
  "Lines starting with `<` were in the PR diff at the last review, and lines " +
  "starting with `>` are in it now. Each is followed by the diff’s own " +
  "marker (`+` added, `-` removed, space for context).";

/**
 * Split a normalized patch into per-file lists of lines, keyed by path.
 */
export function parseFiles(patch) {
  const files = new Map();
  let lines = null;
  for (const line of patch.split("\n")) {
    const match = /^diff --git a\/.* b\/(.*)$/.exec(line);
    if (match) {
      lines = [line];
      files.set(match[1], lines);
    } else if (lines) {
      lines.push(line);
    }
  }
  return files;
}

function countChanges(lines) {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed++;
    }
  }
  return { added, removed };
}

function listed(entries) {
  const out = entries.slice(0, LIMITS.listedFiles);
  if (entries.length > out.length) {
    out.push(`- … and ${entries.length - out.length} more files`);
  }
  return out;
}

function describeCounts(lines) {
  const { added, removed } = countChanges(lines);
  return `+${added} −${removed}`;
}

/**
 * Run `diff` (normal format) on two arrays of lines. Returns its output.
 *
 * `diff` exits 1 when the inputs differ, which isn't an error here.
 */
async function normalDiff(oldLines, newLines) {
  const dir = await mkdtemp(join(tmpdir(), "pr-diff-section-"));
  try {
    const oldPath = join(dir, "old");
    const newPath = join(dir, "new");
    await writeFile(oldPath, oldLines.join("\n") + "\n");
    await writeFile(newPath, newLines.join("\n") + "\n");
    try {
      return (
        await execFileAsync("diff", [oldPath, newPath], {
          maxBuffer: 1024 * 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      if (error.code === 1) {
        return error.stdout;
      }
      throw error;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The function context of the nearest hunk header at or before `lineNumber`
 * (1-based), or "" if there isn't one.
 */
function contextAt(lines, lineNumber) {
  for (let i = Math.min(lineNumber, lines.length) - 1; i >= 0; i--) {
    if (lines[i].startsWith("@@")) {
      return lines[i];
    }
  }
  return "";
}

/**
 * Parse `diff` normal-format output into groups of changes:
 * `{ oldStart, newStart, kind, removed: [...], added: [...] }`.
 */
function parseNormalDiff(output) {
  const groups = [];
  let group = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("<")) {
      group?.removed.push(line.slice(2));
    } else if (line.startsWith(">")) {
      group?.added.push(line.slice(2));
    } else {
      const match = /^(\d+)(?:,\d+)?([acd])(\d+)(?:,\d+)?$/.exec(line);
      if (match) {
        group = {
          oldStart: Number(match[1]),
          newStart: Number(match[3]),
          kind: match[2],
          removed: [],
          added: [],
        };
        groups.push(group);
      }
    }
  }
  return groups;
}

function capped(marker, lines) {
  const shown = lines.slice(0, LIMITS.groupLines);
  const out = shown.map((line) => `${marker} ${line}`);
  if (lines.length > shown.length) {
    out.push(`${marker} … (${lines.length - shown.length} more lines)`);
  }
  return out;
}

function fenced(body) {
  const longest = Math.max(
    0,
    ...[...body.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}diff\n${body}\n${fence}`;
}

/**
 * Describe how one file's per-file patch changed, or "" if it didn't.
 *
 * Returns `{ text, differing }` where `differing` is the number of lines that
 * differ, used if the file has to be summarized.
 */
async function renderFile(path, oldLines, newLines) {
  const groups = parseNormalDiff(await normalDiff(oldLines, newLines));
  if (groups.length === 0) {
    return null;
  }

  const body = [];
  let differing = 0;
  for (const group of groups) {
    differing += group.removed.length + group.added.length;
    const context =
      group.kind === "d"
        ? contextAt(oldLines, group.oldStart)
        : contextAt(newLines, group.newStart);
    body.push(context || "@@");
    body.push(...capped("<", group.removed), ...capped(">", group.added));
  }
  return {
    text: `### \`${path}\`\n\n${fenced(body.join("\n"))}`,
    differing,
  };
}

/**
 * Build a Markdown description of how the PR diff changed between two
 * normalized patches, for a reviewer who saw `prev` last time.
 *
 * Files that appear or disappear are listed with their sizes, and files whose
 * changes are too large to show (see `LIMITS`) are summarized, so the result
 * stays much smaller than the PR itself.
 */
export async function buildSection(prev, current) {
  const prevFiles = parseFiles(prev);
  const currentFiles = parseFiles(current);

  const gone = [...prevFiles].filter(([path]) => !currentFiles.has(path));
  const added = [...currentFiles].filter(([path]) => !prevFiles.has(path));

  const details = [];
  const summarized = [];
  let total = 0;
  for (const [path, newLines] of currentFiles) {
    const oldLines = prevFiles.get(path);
    if (!oldLines) {
      continue;
    }
    const rendered = await renderFile(path, oldLines, newLines);
    if (!rendered) {
      continue;
    }
    if (
      rendered.text.length > LIMITS.fileBytes ||
      total + rendered.text.length > LIMITS.totalBytes
    ) {
      summarized.push(`- \`${path}\` (${rendered.differing} lines differ)`);
    } else {
      total += rendered.text.length;
      details.push(rendered.text);
    }
  }

  const out = ["## Changes since last review", "", PREAMBLE, ""];
  if (gone.length > 0) {
    out.push(
      "Files no longer in the PR diff:",
      "",
      ...listed(
        gone.map(([path, lines]) => `- \`${path}\` (${describeCounts(lines)})`),
      ),
      "",
    );
  }
  if (added.length > 0) {
    out.push(
      "Files newly in the PR diff (see the full diff for their contents):",
      "",
      ...listed(
        added.map(
          ([path, lines]) => `- \`${path}\` (${describeCounts(lines)})`,
        ),
      ),
      "",
    );
  }
  for (const text of details) {
    out.push(text, "");
  }
  if (summarized.length > 0) {
    out.push(
      "Changes too large to show here; see the full diff:",
      "",
      ...listed(summarized),
      "",
    );
  }
  return out.join("\n").trimEnd();
}
