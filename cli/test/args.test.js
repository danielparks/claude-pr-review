import { describe, expect, it } from "vitest";
import {
  formatCommandHelp,
  getOptions,
  HelpRequested,
  oneOf,
  positiveInt,
  required,
} from "../lib/args.js";
import { CliError } from "../lib/util.js";

describe("required()", () => {
  it("returns the value unchanged when truthy", () => {
    expect(required("foo", "--thing")).toBe("foo");
  });

  it("throws when the value is undefined", () => {
    expect(() => required(undefined, "--thing")).toThrow(CliError);
    expect(() => required(undefined, "--thing")).toThrow("--thing is required");
  });

  it("throws when the value is an empty string", () => {
    expect(() => required("", "--thing")).toThrow("--thing is required");
  });
});

describe("positiveInt()", () => {
  it("parses a numeric string", () => {
    expect(positiveInt("5", "--n")).toBe(5);
  });

  it("throws the required() message when the value is missing", () => {
    expect(() => positiveInt(undefined, "--n")).toThrow("--n is required");
  });

  it("throws when the value is not an integer", () => {
    expect(() => positiveInt("3.5", "--n")).toThrow(
      "--n must be a positive integer, got: 3.5",
    );
  });

  it("throws when the value is zero", () => {
    expect(() => positiveInt("0", "--n")).toThrow(
      "--n must be a positive integer, got: 0",
    );
  });

  it("throws when the value is negative", () => {
    expect(() => positiveInt("-1", "--n")).toThrow(
      "--n must be a positive integer, got: -1",
    );
  });

  it("throws when the value is not numeric", () => {
    expect(() => positiveInt("abc", "--n")).toThrow(
      "--n must be a positive integer, got: abc",
    );
  });
});

describe("oneOf()", () => {
  it("returns a validator function", () => {
    expect(typeof oneOf("a", "b")).toBe("function");
  });

  it("returns the value when it's in the allowed list", () => {
    expect(oneOf("a", "b")("b", "--side")).toBe("b");
  });

  it("throws 'must be one of' when the value isn't allowed", () => {
    expect(() => oneOf("a", "b")("c", "--side")).toThrow(
      "--side must be one of a, b, got: c",
    );
  });

  it("throws the required() message, not 'must be one of', when the value is missing and '' isn't allowed", () => {
    expect(() => oneOf("a", "b")(undefined, "--side")).toThrow(
      "--side is required",
    );
  });

  it("accepts '' when it's explicitly in the allowed list", () => {
    expect(oneOf("a", "")("", "--side")).toBe("");
  });

  it("returns undefined as-is, not coerced to '', when '' is allowed", () => {
    expect(oneOf("a", "")(undefined, "--side")).toBeUndefined();
  });

  it("exposes the allowed values as .choices, for formatCommandHelp()", () => {
    expect(oneOf("LEFT", "RIGHT").choices).toEqual(["LEFT", "RIGHT"]);
  });
});

describe("getOptions()", () => {
  it("passes raw string values through with no map", async () => {
    const [values] = await getOptions(["--path", "foo.js"], {
      path: {},
    });
    expect(values).toEqual({ path: "foo.js" });
  });

  it("maps a definition key to a differently named flag via long", async () => {
    const [values] = await getOptions(["--start-line", "5"], {
      startLine: { long: "start-line" },
    });
    expect(values).toEqual({ startLine: "5" });
  });

  it("fills in default when the flag is omitted", async () => {
    const [values] = await getOptions([], {
      side: { default: "RIGHT" },
    });
    expect(values).toEqual({ side: "RIGHT" });
  });

  it("applies map to transform the raw value", async () => {
    const [values] = await getOptions(["--n", "5"], {
      n: { map: positiveInt },
    });
    expect(values).toEqual({ n: 5 });
  });

  it("awaits an async map function", async () => {
    const [values] = await getOptions(["--path", "foo.js"], {
      path: { map: async (value) => `${value}!` },
    });
    expect(values).toEqual({ path: "foo.js!" });
  });

  it("passes (value, long, info) to map", async () => {
    let received;
    await getOptions(["--body-file", "x"], {
      body: {
        long: "body-file",
        map: (...args) => {
          received = args;
        },
        required: true,
      },
    });
    expect(received[0]).toBe("x");
    expect(received[1]).toBe("--body-file");
    expect(received[2]).toMatchObject({ key: "body", required: true });
  });

  it("parses a boolean flag as true when present", async () => {
    const [values] = await getOptions(["--downgrade-approval"], {
      downgradeApproval: { type: "boolean", long: "downgrade-approval" },
    });
    expect(values).toEqual({ downgradeApproval: true });
  });

  it("leaves a boolean flag undefined when absent", async () => {
    const [values] = await getOptions([], {
      downgradeApproval: { type: "boolean", long: "downgrade-approval" },
    });
    expect(values).toEqual({ downgradeApproval: undefined });
  });

  it("handles multiple definitions together, mirroring queue-inline-comment's shape", async () => {
    const [values] = await getOptions(
      [
        "--path",
        "foo.js",
        "--line",
        "10",
        "--start-line",
        "5",
        "--body-file",
        "body.txt",
      ],
      {
        path: { map: required },
        line: { map: positiveInt },
        startLine: { long: "start-line" },
        side: { map: oneOf("LEFT", "RIGHT"), default: "RIGHT" },
        body: { long: "body-file", map: (value) => value, required: true },
      },
    );
    expect(values).toEqual({
      path: "foo.js",
      line: 10,
      startLine: "5",
      side: "RIGHT",
      body: "body.txt",
    });
  });

  it("returns parseArgs' leftovers as the second element", async () => {
    const [, rest] = await getOptions(["--path", "foo.js"], {
      path: {},
    });
    expect(rest).toHaveProperty("positionals");
  });

  it("rejects with the error a map function throws", async () => {
    await expect(
      getOptions([], {
        path: { map: required },
      }),
    ).rejects.toThrow("--path is required");
  });

  it("rejects with HelpRequested when --help is present, without invoking any map", async () => {
    let called = false;
    await expect(
      getOptions(
        ["--help"],
        { path: { map: () => (called = true) } },
        "some-command",
      ),
    ).rejects.toThrow(HelpRequested);
    expect(called).toBe(false);
  });

  it("rejects with HelpRequested when -h is present", async () => {
    await expect(
      getOptions(["-h"], { path: {} }, "some-command"),
    ).rejects.toThrow(HelpRequested);
  });

  it("HelpRequested's message is the formatted command help", async () => {
    const definitions = { path: { map: required } };
    await expect(
      getOptions(["--help"], definitions, "some-command", undefined),
    ).rejects.toThrow(
      formatCommandHelp("some-command", undefined, definitions),
    );
  });
});

describe("formatCommandHelp()", () => {
  it("labels the command and lists each flag", () => {
    const help = formatCommandHelp("queue-inline-comment", undefined, {
      path: { map: required },
      line: { map: positiveInt },
      startLine: { long: "start-line" },
      side: { map: oneOf("LEFT", "RIGHT"), default: "RIGHT" },
      body: { long: "body-file", map: required, required: true },
    });
    expect(help).toBe(
      [
        "Usage: pr-review queue-inline-comment [options]",
        "",
        "  --path PATH  (required)",
        "  --line LINE  (required)",
        "  --start-line START_LINE",
        "  --side LEFT|RIGHT  (default: RIGHT)",
        "  --body-file BODY_FILE  (required)",
      ].join("\n"),
    );
  });

  it("marks a boolean flag with no value placeholder", () => {
    const help = formatCommandHelp("sweep", "description", {
      forceDowngradeApproval: { type: "boolean", long: "downgrade-approval" },
    });
    expect(help).toBe(
      [
        "Usage: pr-review sweep [options]",
        "",
        "description",
        "",
        "  --downgrade-approval",
      ].join("\n"),
    );
  });

  it("falls back to a generic label when command is omitted", () => {
    expect(formatCommandHelp(undefined, undefined, {})).toBe(
      "Usage: pr-review <command> [options]",
    );
  });

  it("adds an indented description line under a flag that has one", () => {
    const help = formatCommandHelp("discard-queue", "description", {
      dir: { map: required, description: "Which batch to discard." },
    });
    expect(help).toBe(
      [
        "Usage: pr-review discard-queue [options]",
        "",
        "description",
        "",
        "  --dir DIR  (required)",
        "      Which batch to discard.",
      ].join("\n"),
    );
  });

  it("omits the description line entirely when a flag has none", () => {
    const help = formatCommandHelp("sweep", "description", {
      forceDowngradeApproval: { type: "boolean", long: "downgrade-approval" },
    });
    expect(help.split("\n")).toHaveLength(5);
  });
});
