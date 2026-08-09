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
export function formatCommandHelp(command, definitions) {
  const lines = [`Usage: pr-review ${command ?? "<command>"} [options]`, ""];
  for (const [key, { long, description, ...info }] of Object.entries(
    definitions,
  )) {
    const name = long ?? key;
    const notes = [];
    if (isRequired(info)) notes.push("required");
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
export async function getOptions(args, definitions, command) {
  if (args.includes("--help") || args.includes("-h")) {
    throw new HelpRequested(formatCommandHelp(command, definitions));
  }

  const byLong = new Map();
  const { values, ...result } = parseArgs({
    args,
    options: Object.fromEntries(
      Object.entries(definitions).map(([key, { long, ...info }]) => {
        const name = long ?? key;
        byLong.set(name, { key, ...info }); // Key can be overridden.
        return [name, { type: "string", ...info }];
      }),
    ),
  });
  const newValues = {};
  for (const [long, info] of byLong) {
    newValues[info.key] = info.map
      ? await info.map(values[long], `--${long}`, info)
      : values[long];
  }
  return [newValues, result];
}

export class Commands {
  commands = new Map();

  add(name, description, definitions, func) {
    const wrapper = async (args) =>
      await func(...(await getOptions(args, definitions, name)));
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
