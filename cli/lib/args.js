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
  return (value, long) => {
    if (!values.includes(value ?? "")) {
      // If value was undefined or "", then values must not have included "".
      required(value, long);
      fail(`${long} must be one of ${values.join(", ")}, got: ${value}`);
    }
    return value;
  };
}

export async function getOptions(args, definitions) {
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
