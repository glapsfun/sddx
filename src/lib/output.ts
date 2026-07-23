import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AnsiColor, colorEnabled, paint } from "./ansi";

/** Schema version for the JSON envelope — versioned independently of the
 * package version. Bump the minor component for additive fields, the major
 * component for removed/renamed fields or type changes. */
export const SCHEMA_VERSION = "1.0";

export const OUTPUT_FORMATS = ["terminal", "json", "markdown", "all"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export type MessageKind = "start" | "progress" | "success" | "warning" | "error";
export type Status = "success" | "warning" | "error";
export type Stream = "stdout" | "stderr";

export interface LifecycleMessage {
  kind: MessageKind;
  text: string;
  data?: unknown;
  stream: Stream;
}

/** start/progress always stream live to stderr; success/warning default to
 * stdout and error to stderr — but the stream is tracked per-message (not
 * inferred solely from `kind` at render time) so a caller can override it
 * (e.g. `next-actions` has always reported its failures on stdout, exit code
 * carrying the failure signal) without that message losing its `error` kind
 * in the JSON/Markdown envelope. */
function defaultStreamFor(kind: MessageKind): Stream {
  return kind === "success" || kind === "warning" ? "stdout" : "stderr";
}

export interface Result<T = unknown> {
  command: string;
  status: Status;
  data: T;
  warnings: string[];
  errors: string[];
  messages: LifecycleMessage[];
}

interface Envelope<T> {
  schema_version: string;
  command: string;
  status: Status;
  data: T;
  warnings: string[];
  errors: string[];
  metadata: {
    plugin_version: string;
    harness: string;
    messages: LifecycleMessage[];
  };
}

const MARKERS: Record<MessageKind, string> = {
  start: "▶",
  progress: "→",
  success: "✓",
  warning: "⚠",
  error: "✗",
};

const COLORS: Record<MessageKind, AnsiColor> = {
  start: "dim",
  progress: "cyan",
  success: "green",
  warning: "yellow",
  error: "red",
};

function formatLine(msg: LifecycleMessage, colorOn: boolean): string {
  if (!colorOn) return msg.text;
  return paint(`${MARKERS[msg.kind]} ${msg.text}`, COLORS[msg.kind], true);
}

/** `console.log`/`console.error` live here and only here — every command routes
 * text through the framework (or these two thin wrappers for pre-command usage
 * errors and meta flags like --version/--help) rather than calling them directly. */
export function printLine(text: string): void {
  console.log(text);
}

export function printError(text: string): void {
  console.error(text);
}

export function parseOutputFlag(args: string[]): {
  format: OutputFormat;
  noColor: boolean;
  rest: string[];
} {
  const rest: string[] = [];
  let format: OutputFormat = "terminal";
  let noColor = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--output") {
      const v = args[i + 1];
      if (v === undefined || !(OUTPUT_FORMATS as readonly string[]).includes(v)) {
        printError(
          `invalid --output value: ${v ?? "(missing)"} — expected one of ${OUTPUT_FORMATS.join("|")}`,
        );
        process.exit(2);
      }
      format = v as OutputFormat;
      i++;
      continue;
    }
    if (a === "--no-color") {
      noColor = true;
      continue;
    }
    rest.push(a);
  }
  return { format, noColor, rest };
}

function renderJson<T>(result: Result<T>, pluginVersion: string, harness: string): string {
  const envelope: Envelope<T> = {
    schema_version: SCHEMA_VERSION,
    command: result.command,
    status: result.status,
    data: result.data,
    warnings: result.warnings,
    errors: result.errors,
    metadata: { plugin_version: pluginVersion, harness, messages: result.messages },
  };
  return JSON.stringify(envelope, null, 2);
}

function renderMarkdown<T>(result: Result<T>): string {
  const lines: string[] = [];
  lines.push(`# sddx ${result.command}`);
  lines.push("");
  lines.push(`**Status:** ${result.status}`);
  lines.push("");

  lines.push("## Execution Summary");
  lines.push("");
  const summary = result.messages
    .filter((m) => m.kind === "start" || m.kind === "success")
    .map((m) => `- ${m.text}`);
  lines.push(summary.length > 0 ? summary.join("\n") : "_no summary available_");
  lines.push("");

  const data = result.data as Record<string, unknown> | null | undefined;
  const tasks = data && Array.isArray(data.tasks) ? (data.tasks as unknown[]) : null;
  if (tasks) {
    lines.push("## Task Results");
    lines.push("");
    lines.push("| Task | Branch | Phase | Receipt |");
    lines.push("| --- | --- | --- | --- |");
    for (const raw of tasks) {
      const t = raw as Record<string, unknown>;
      lines.push(`| ${t.id ?? ""} | ${t.branch ?? ""} | ${t.phase ?? ""} | ${t.receipt ?? "—"} |`);
    }
    lines.push("");
  }

  if (result.warnings.length > 0 || result.errors.length > 0) {
    lines.push("## Validation Results");
    lines.push("");
    for (const w of result.warnings) lines.push(`- ⚠ ${w}`);
    for (const e of result.errors) lines.push(`- ✗ ${e}`);
    lines.push("");
  }

  const nextActions =
    data && Array.isArray(data.nextActions) ? (data.nextActions as unknown[]) : null;
  if (nextActions) {
    lines.push("## Next Actions");
    lines.push("");
    for (const a of nextActions) lines.push(`- ${a}`);
    lines.push("");
  }

  lines.push("<details><summary>Raw data (JSON)</summary>");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(data ?? null, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("</details>");
  return lines.join("\n");
}

function writeTerminalFinal(result: Result, colorFor: (stream: Stream) => boolean): void {
  for (const m of result.messages) {
    if (m.kind === "start" || m.kind === "progress") continue; // already streamed to stderr
    const line = formatLine(m, colorFor(m.stream));
    if (m.stream === "stderr") process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }
}

/** Appends a numeric suffix (`name-2.ext`) until the path is free — `all` mode
 * never silently overwrites a file that happens to already exist. */
function uniquePath(dir: string, baseName: string, ext: string): string {
  let candidate = join(dir, `${baseName}.${ext}`);
  let n = 2;
  while (existsSync(candidate)) {
    candidate = join(dir, `${baseName}-${n}.${ext}`);
    n++;
  }
  return candidate;
}

export class Reporter {
  readonly command: string;
  readonly format: OutputFormat;
  private readonly stdoutColorOn: boolean;
  private readonly stderrColorOn: boolean;
  private readonly pluginVersion: string;
  private readonly harness: string;
  private readonly messages: LifecycleMessage[] = [];
  private readonly warnings: string[] = [];
  private readonly errors: string[] = [];

  constructor(
    command: string,
    format: OutputFormat,
    opts: { noColor?: boolean; pluginVersion?: string; harness?: string } = {},
  ) {
    this.command = command;
    this.format = format;
    // decided per-stream — a command may have stdout attached to a TTY while
    // stderr is redirected to a file (or vice versa), and each stream's own
    // color state must govern only what's written to it
    this.stdoutColorOn = colorEnabled({ noColor: opts.noColor, stream: process.stdout });
    this.stderrColorOn = colorEnabled({ noColor: opts.noColor, stream: process.stderr });
    this.pluginVersion = opts.pluginVersion ?? "unknown";
    this.harness = opts.harness ?? "claude-code";
  }

  private colorFor(stream: Stream): boolean {
    return stream === "stdout" ? this.stdoutColorOn : this.stderrColorOn;
  }

  private record(kind: MessageKind, text: string, data?: unknown, stream?: Stream): void {
    const msg: LifecycleMessage = { kind, text, data, stream: stream ?? defaultStreamFor(kind) };
    this.messages.push(msg);
    if (this.format === "terminal" && (kind === "start" || kind === "progress")) {
      process.stderr.write(`${formatLine(msg, this.colorFor(msg.stream))}\n`);
    }
  }

  start(text: string): void {
    this.record("start", text);
  }

  progress(text: string, data?: unknown): void {
    this.record("progress", text, data);
  }

  success(text: string, data?: unknown): void {
    this.record("success", text, data);
  }

  warn(text: string): void {
    this.warnings.push(text);
    this.record("warning", text);
  }

  /** `opts.stream` lets a caller keep a failure's historical stdout placement
   * (e.g. `next-actions`, which has always reported failures on stdout and
   * signaled them via exit code) while still recording it as a real `error`
   * in the envelope's `errors` array and `kind: "error"` message. */
  error(text: string, opts: { stream?: Stream } = {}): void {
    this.errors.push(text);
    this.record("error", text, undefined, opts.stream);
  }

  /** Builds the Result from accumulated messages and renders it per `this.format`.
   * Formatting never feeds back into `data` — it is a pure read of what already
   * happened. Returns the Result so callers can inspect `status` for exit codes. */
  finish<T>(data: T, opts: { status?: Status } = {}): Result<T> {
    const status: Status =
      opts.status ??
      (this.errors.length > 0 ? "error" : this.warnings.length > 0 ? "warning" : "success");
    const result: Result<T> = {
      command: this.command,
      status,
      data,
      warnings: this.warnings,
      errors: this.errors,
      messages: this.messages,
    };
    this.write(result);
    return result;
  }

  private write<T>(result: Result<T>): void {
    if (this.format === "terminal") {
      writeTerminalFinal(result, (stream) => this.colorFor(stream));
      return;
    }
    if (this.format === "json") {
      process.stdout.write(`${renderJson(result, this.pluginVersion, this.harness)}\n`);
      return;
    }
    if (this.format === "markdown") {
      process.stdout.write(`${renderMarkdown(result)}\n`);
      return;
    }
    // all: terminal to stdout, plus JSON and Markdown files written to cwd
    writeTerminalFinal(result, (stream) => this.colorFor(stream));
    const baseName = `sddx-${result.command.replace(/\s+/g, "-")}`;
    const jsonPath = uniquePath(process.cwd(), baseName, "json");
    const mdPath = uniquePath(process.cwd(), baseName, "md");
    writeFileSync(jsonPath, `${renderJson(result, this.pluginVersion, this.harness)}\n`);
    writeFileSync(mdPath, `${renderMarkdown(result)}\n`);
    process.stdout.write(`wrote ${jsonPath}\n`);
    process.stdout.write(`wrote ${mdPath}\n`);
  }
}
