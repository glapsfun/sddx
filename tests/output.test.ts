import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { colorEnabled, paint } from "../src/lib/ansi";
import { parseOutputFlag, Reporter, SCHEMA_VERSION } from "../src/lib/output";

/** Captures everything written to stdout/stderr during `fn`, restoring the
 * real streams afterward even if `fn` throws. */
function captureStreams(fn: () => void): { stdout: string; stderr: string } {
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: string) => {
    stdout += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    stderr += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { stdout, stderr };
}

describe("ansi", () => {
  test("colorEnabled is false when NO_COLOR is set", () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      expect(colorEnabled({ stream: { isTTY: true } })).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });

  test("colorEnabled is false when --no-color (noColor option) is passed", () => {
    expect(colorEnabled({ noColor: true, stream: { isTTY: true } })).toBe(false);
  });

  test("colorEnabled is false on a non-TTY stream", () => {
    expect(colorEnabled({ stream: { isTTY: false } })).toBe(false);
  });

  test("paint wraps text in SGR codes only when enabled", () => {
    expect(paint("x", "green", false)).toBe("x");
    expect(paint("x", "green", true)).toContain("x");
    expect(paint("x", "green", true)).not.toBe("x");
  });
});

describe("parseOutputFlag", () => {
  test("defaults to terminal with no flag", () => {
    const { format, noColor, rest } = parseOutputFlag(["show"]);
    expect(format).toBe("terminal");
    expect(noColor).toBe(false);
    expect(rest).toEqual(["show"]);
  });

  test("extracts --output and --no-color, leaving other args", () => {
    const { format, noColor, rest } = parseOutputFlag(["show", "--output", "json", "--no-color"]);
    expect(format).toBe("json");
    expect(noColor).toBe(true);
    expect(rest).toEqual(["show"]);
  });
});

describe("Reporter JSON envelope", () => {
  test("emits schema_version and all required top-level keys", () => {
    const reporter = new Reporter("test-cmd", "json", { pluginVersion: "9.9.9" });
    reporter.success("did the thing");
    const { stdout } = captureStreams(() => {
      reporter.finish({ answer: 42 });
    });
    const envelope = JSON.parse(stdout);
    expect(envelope.schema_version).toBe(SCHEMA_VERSION);
    expect(envelope.command).toBe("test-cmd");
    expect(envelope.status).toBe("success");
    expect(envelope.data).toEqual({ answer: 42 });
    expect(envelope.warnings).toEqual([]);
    expect(envelope.errors).toEqual([]);
    expect(envelope.metadata.plugin_version).toBe("9.9.9");
    expect(envelope.metadata.harness).toBeDefined();
  });

  test("status reflects recorded errors/warnings", () => {
    const withError = new Reporter("cmd", "json");
    withError.error("boom");
    const errEnvelope = JSON.parse(captureStreams(() => withError.finish(null)).stdout);
    expect(errEnvelope.status).toBe("error");
    expect(errEnvelope.errors).toEqual(["boom"]);

    const withWarning = new Reporter("cmd", "json");
    withWarning.warn("careful");
    const warnEnvelope = JSON.parse(captureStreams(() => withWarning.finish(null)).stdout);
    expect(warnEnvelope.status).toBe("warning");
    expect(warnEnvelope.warnings).toEqual(["careful"]);
  });
});

describe("Reporter terminal renderer", () => {
  test("no ANSI codes when color is disabled (default in test env)", () => {
    const reporter = new Reporter("cmd", "terminal");
    reporter.success("plain text line");
    const { stdout } = captureStreams(() => reporter.finish(null));
    expect(stdout).toBe("plain text line\n");
    expect(stdout).not.toContain("\x1b[");
  });

  test("progress/start stream to stderr immediately, success prints to stdout at finish", () => {
    const reporter = new Reporter("cmd", "terminal");
    const during = captureStreams(() => {
      reporter.start("beginning");
      reporter.progress("working");
    });
    expect(during.stderr).toContain("beginning");
    expect(during.stderr).toContain("working");
    expect(during.stdout).toBe("");

    const after = captureStreams(() => reporter.finish(null));
    expect(after.stdout).toBe("");
  });

  test("error messages print to stderr, not stdout", () => {
    const reporter = new Reporter("cmd", "terminal");
    reporter.error("things broke");
    const { stdout, stderr } = captureStreams(() => reporter.finish(null));
    expect(stdout).toBe("");
    expect(stderr).toContain("things broke");
  });
});

describe("Reporter markdown renderer parity", () => {
  test("every data point in JSON also appears in the markdown raw-data block", () => {
    const data = {
      tasks: [{ id: "t1", branch: "sddx/t1", phase: "DONE", receipt: "#1" }],
      extra: "value",
    };

    const jsonReporter = new Reporter("run", "json");
    jsonReporter.success("done");
    const jsonOut = captureStreams(() => jsonReporter.finish(data)).stdout;
    const envelope = JSON.parse(jsonOut);

    const mdReporter = new Reporter("run", "markdown");
    mdReporter.success("done");
    const mdOut = captureStreams(() => mdReporter.finish(data)).stdout;

    expect(mdOut).toContain("## Task Results");
    expect(mdOut).toContain("t1");
    expect(mdOut).toContain(JSON.stringify(envelope.data, null, 2));
  });
});

describe("Reporter --output all", () => {
  test("writes two files and reports their paths, never overwriting an existing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "sddx-output-all-"));
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      const reporter = new Reporter("board", "all");
      reporter.success("wrote board");
      const { stdout } = captureStreams(() => reporter.finish({ ok: true }));
      const jsonPath = join(dir, "sddx-board.json");
      const mdPath = join(dir, "sddx-board.md");
      expect(existsSync(jsonPath)).toBe(true);
      expect(existsSync(mdPath)).toBe(true);
      expect(stdout).toContain(jsonPath);
      expect(stdout).toContain(mdPath);

      // second run must not clobber the first
      const before = readFileSync(jsonPath, "utf8");
      const reporter2 = new Reporter("board", "all");
      reporter2.success("wrote board again");
      captureStreams(() => reporter2.finish({ ok: false }));
      expect(readFileSync(jsonPath, "utf8")).toBe(before);
      expect(existsSync(join(dir, "sddx-board-2.json"))).toBe(true);
    } finally {
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
