/**
 * Simple command line parser.
 */

import { parseArgs } from "node:util";
import { fail } from "./util.js";

export function required(value, long) {
  if (!value) fail(`${long} is required`);
  return value;
}

export function positiveInt(value, label) {
  const n = Number(required(value, label));
  if (!Number.isInteger(n) || n < 1) {
    fail(`${label} must be a positive integer, got: ${value}`);
  }
  return n;
}

export function oneOf(...values) {
  const validate = (value, long) => {
    if (!values.includes(value ?? "")) {
      // If value was undefined or "", then values must not have included "".
      required(value, long);
      fail(`${long} must be one of ${values.join(", ")}, got: ${value}`);
    }
    return value;
  };
  // Lets formatCommandHelp() show the allowed values instead of a generic
  // placeholder, without having to duplicate them.
  validate.choices = values;
  return validate;
}

/**
 * Thrown by getOptions() when `--help`/`-h` is present, instead of parsing.
 * `message` is the full, ready-to-print usage text -- `pr-review`'s top-level
 * catch prints it and exits 0, since asking for help isn't a failure.
 */
export class HelpRequested extends Error {}

function isRequired(info) {
  return (
    info.required === true || info.map === required || info.map === positiveInt
  );
}

function placeholder(long, info) {
  if (info.type === "boolean") return "";
  if (info.map?.choices) return ` ${info.map.choices.join("|")}`;
  return ` ${long.toUpperCase().replace(/-/g, "_")}`;
}

/**
 * Render usage text for one command from the same `definitions` object
 * getOptions() itself uses to parse -- so it can never describe a flag that
 * doesn't exist, or omit one that does.
 */
export function formatCommandHelp(command, description, definitions) {
  const options = Array.from(Object.entries(definitions));

  // Collect positional args for the usage line, sorted by their positional index.
  const positionalArgs = options
    .filter(([, info]) => info.positional !== undefined)
    .sort(([, a], [, b]) => (a.positional ?? 0) - (b.positional ?? 0))
    .map(([key, info]) => (info.long ?? key).toUpperCase().replace(/-/g, "_"));
  const positionalStr = positionalArgs.length
    ? ` ${positionalArgs.join(" ")}`
    : "";

  const lines = [
    `Usage: pr-review ${command ?? "<command>"}${positionalStr} [options]`,
  ];
  if (description) {
    lines.push("");
    lines.push(description);
  }
  if (options.length) {
    lines.push("");
  }
  for (const [key, { long, description, positional, ...info }] of options) {
    const name = long ?? key;
    const notes = [];
    if (positional !== undefined) notes.push("or pass as positional argument");
    else if (isRequired(info)) notes.push("required");
    if (info.default !== undefined) notes.push(`default: ${info.default}`);
    lines.push(
      `  --${name}${placeholder(name, info)}` +
        (notes.length ? `  (${notes.join(", ")})` : ""),
    );
    if (description) lines.push(`      ${description}`);
  }
  return lines.join("\n");
}

/**
 * `command` is only used to label `--help` output -- pass the same name
 * `pr-review`'s COMMANDS map uses for this command, e.g. "queue-inline-comment".
 */
export async function getOptions(args, definitions, command, description) {
  if (args.includes("--help") || args.includes("-h")) {
    throw new HelpRequested(
      formatCommandHelp(command, description, definitions),
    );
  }

  const byLong = new Map();
  const { values, positionals, ...result } = parseArgs({
    args,
    allowPositionals: true,
    options: Object.fromEntries(
      Object.entries(definitions).map(
        ([key, { long, positional, ...info }]) => {
          const name = long ?? key;
          byLong.set(name, { key, positional, ...info }); // Key can be overridden.
          return [name, { type: "string", ...info }];
        },
      ),
    ),
  });
  const newValues = {};
  for (const [long, info] of byLong) {
    let value = values[long];
    if (value === undefined && info.positional !== undefined) {
      value = positionals[info.positional];
    }
    newValues[info.key] = info.map
      ? await info.map(value, `--${long}`, info)
      : value;
  }
  return [newValues, { positionals, ...result }];
}

export class Commands {
  commands = new Map();

  add(name, description, definitions, func) {
    const wrapper = async (args) =>
      await func(...(await getOptions(args, definitions, name, description)));
    wrapper.description = description;
    this.commands.set(name, wrapper);
    return this;
  }

  names() {
    return Array.from(this.commands.keys());
  }

  get(name) {
    return this.commands.get(name);
  }
}
