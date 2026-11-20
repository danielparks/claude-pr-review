import { fail } from "./util.js";

/**
 * Largest prompt, in UTF-8 bytes, that we'll hand to `claude-code-action`.
 *
 * The action receives the prompt as an environment variable, and on Linux a
 * single environment string larger than 128 KiB (`MAX_ARG_STRLEN`) makes
 * every child process fail to spawn with "Argument list too long". This leaves
 * headroom below that.
 */
export const MAX_PROMPT_BYTES = 100_000;

const SEPARATOR = Buffer.from("\n\n");
const NEWLINE = 0x0a;

const toBuffer = (text) => Buffer.from(text, "utf8");

// Trailing whitespace carries no meaning here, and the sections are joined
// with their own separators.
const toTrimmedBuffer = (text) => toBuffer(text.trimEnd());

/**
 * Shrink `buf` to at most `budget` bytes by dropping lines from the middle,
 * keeping the start (titles, descriptions) and favoring the end (the most
 * recent activity). `markerForElision(omitted)` makes the marker left in the gap.
 *
 * This cuts only at newlines, which never occur inside a multi-byte UTF-8
 * character, so each piece decodes cleanly.
 */
export function truncateMiddle(buf, budget, markerForElision) {
  if (buf.length <= budget) {
    return buf;
  }
  // The marker's size depends on how much is omitted, so reserve room for the
  // largest it could be.
  const reserve = Buffer.byteLength(markerForElision(buf.length)) + 2;
  const available = Math.max(0, budget - reserve);

  // Keep a quarter of the room for the start, ending after its last newline.
  const headEnd =
    buf.subarray(0, Math.floor(available / 4)).lastIndexOf(NEWLINE) + 1;

  // Give the rest to the end, starting at the first line start in range.
  let tailStart = Math.max(headEnd, buf.length - (available - headEnd));
  if (tailStart > headEnd && buf[tailStart - 1] !== NEWLINE) {
    const newline = buf.indexOf(NEWLINE, tailStart);
    tailStart = newline === -1 ? buf.length : newline + 1;
  }

  return Buffer.concat([
    buf.subarray(0, headEnd),
    toBuffer(markerForElision(tailStart - headEnd) + "\n"),
    buf.subarray(tailStart),
  ]);
}

/**
 * Assemble the prompt from its sections, keeping it within `maxBytes`.
 *
 * The header, prompt, additional prompt, and labels are never cut: if they
 * alone are too big that's a configuration problem and this throws. The
 * discussion is shrunk first, then the diff of diffs.
 *
 * `paths` says where the complete text of the discussion and diff of diffs are
 * saved; the marker left in a shrunk section points Claude there. Returns the
 * prompt and the names of the sections that were shrunk.
 */
export function assemblePrompt(
  { header, prompt, additionalPrompt, labels, diffOfDiffs, discussion },
  paths,
  maxBytes = MAX_PROMPT_BYTES,
) {
  const fixed = [header, prompt, additionalPrompt, labels]
    .map(toTrimmedBuffer)
    .filter((buf) => buf.length);
  const fixedBytes =
    fixed.reduce((sum, part) => sum + part.length, 0) +
    SEPARATOR.length * (fixed.length - 1);
  if (fixedBytes > maxBytes) {
    fail(
      `The prompt and labels are ${fixedBytes} bytes, over the ${maxBytes} ` +
        "byte limit. Shorten `prompt` or `additional-prompt`.",
    );
  }

  const sections = {
    diffOfDiffs: toTrimmedBuffer(diffOfDiffs),
    discussion: toTrimmedBuffer(discussion),
  };
  const present = Object.values(sections).filter((buf) => buf.length);
  let room = maxBytes - fixedBytes - SEPARATOR.length * present.length;
  const shrunk = [];

  // The discussion gets what the diff of diffs leaves, but never less than
  // half, so an oversized diff of diffs can't squeeze it out entirely. The diff
  // of diffs then gets whatever the discussion didn't use.
  let budget = Math.max(
    room - sections.diffOfDiffs.length,
    Math.floor(room / 2),
  );
  for (const name of ["discussion", "diffOfDiffs"]) {
    const buf = truncateMiddle(
      sections[name],
      budget,
      (omitted) =>
        `[… ${omitted} bytes omitted to fit the prompt limit; the full text ` +
        `is in ${paths[name]} …]`,
    );
    if (buf !== sections[name]) {
      shrunk.push(name);
    }
    sections[name] = buf;
    room -= buf.length;
    budget = room;
  }

  const text = Buffer.concat(
    [...fixed, sections.diffOfDiffs, sections.discussion]
      .filter((buf) => buf.length)
      .flatMap((buf) => [SEPARATOR, buf])
      .slice(1),
  ).toString("utf8");
  return { text, shrunk };
}
