// Hook dispatch: one implementation, two entrypoints.
//
// Split out of the standalone `hooks.mjs` bundle when the Claude adapter
// stopped referencing bundle paths. Generated hook registrations now invoke
// `<sddx> hook <event>`, which routes here through the CLI — so the dispatcher
// must not run anything at import time. Keeping it in a module with no
// top-level side effects is what makes that safe.
//
// Contract, unchanged: read the harness event JSON from stdin, emit the
// decision JSON on stdout, always exit 0. A bug in sddx must never brick a
// user session; RED-phase safety survives a crash here because the phase
// machine and verifier still gate completion.
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeBoard } from "../board";
import { tddGate } from "../tdd-gate";
import { type ApprovalGateDecision, approvalGate } from "./approvalgate";
import { bashGate } from "./bashgate";
import { boardEnabled, profile } from "./config";
import { withoutFrontmatter } from "./frontmatter";
import { detectV5Signals, type V5Signals, v5Blockers } from "./migrate";
import { optedInRoot } from "./optin";
import { recordTestRun } from "./recorder";
import { shellWord } from "./shellcwd";
import { stopGate } from "./stopgate";
import { isTerminal, type TaskState } from "./task";
import { sweep } from "./worktree";

interface HookEvent {
  cwd?: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    notebook_path?: string;
    command?: string;
    [k: string]: unknown;
  };
  tool_response?: { [k: string]: unknown };
  stop_hook_active?: boolean;
  [k: string]: unknown;
}

function readEvent(): HookEvent {
  try {
    const raw = readFileSync(0, "utf8");
    const parsed: unknown = raw.trim() === "" ? {} : JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as HookEvent) : {};
  } catch {
    return {}; // malformed stdin → no-op decision with a diagnostic, never a crash
  }
}

type Output = Record<string, unknown>;

/** The harness running the hook: Codex cannot raise a dialog from a hook. */
export type Harness = "claude-code" | "codex";

export const harnessOf = (name: string | undefined): Harness =>
  name === "codex" ? "codex" : "claude-code";

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function cmdTddGate(event: HookEvent): Output {
  const decision = tddGate({
    filePath: event.tool_input?.file_path ?? event.tool_input?.notebook_path,
    cwd: event.cwd,
  });
  if (decision.allow) {
    // pass-through: no permissionDecision — never auto-approve, just don't deny
    return decision.diagnostic ? { systemMessage: decision.diagnostic } : {};
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    },
  };
}

/** The plugin's `bin/sddx` by absolute path, as a shell word, for a command someone types. */
function pluginCommand(harness: Harness): string {
  const plugin = pluginRoot(harness);
  return plugin ? shellWord(join(plugin, "bin", "sddx")) : "sddx";
}

/** Codex has no dialog: an ask becomes a deny. One about a plan hands the approve command to the user. */
function handOff(decision: ApprovalGateDecision): string {
  const reason = decision.reason ?? "sddx: approval required";
  if (decision.spec === undefined) {
    return [
      reason,
      "",
      "In Codex a hook cannot ask the user, so this was refused. If the user wants it run, they can type it themselves with the ! prefix.",
    ].join("\n");
  }
  return [
    reason,
    "",
    "In Codex only a person can approve a plan, so this was refused. Ask the user to review the plan and type:",
    `  !${pluginCommand("codex")} plan approve ${shellWord(decision.spec)}`,
  ].join("\n");
}

/**
 * The plan-approval gate. Unlike `cmdTddGate`/`cmdBashGate` above — prohibition
 * gates that deny or stay silent, and must NEVER emit "allow" — this is a
 * permission gate: it emits `"ask"` to raise the user's own permission dialog,
 * which is the only signal in this system a model cannot produce for itself.
 * Do not "harmonize" this with the prohibition gates; a silent approval gate is
 * a disabled one. See src/lib/approvalgate.ts and its regression test.
 */
function cmdApprovalGate(event: HookEvent, harness: Harness): Output {
  const fileTool =
    (typeof event.tool_name === "string" && FILE_TOOLS.has(event.tool_name)) ||
    (event.tool_input?.file_path ?? event.tool_input?.notebook_path) !== undefined;
  const decision = approvalGate(
    event.tool_name === "apply_patch"
      ? { patch: String(event.tool_input?.command ?? ""), cwd: event.cwd }
      : fileTool
        ? {
            filePath: String(event.tool_input?.file_path ?? event.tool_input?.notebook_path ?? ""),
            cwd: event.cwd,
          }
        : { command: event.tool_input?.command, cwd: event.cwd },
  );
  if (decision.decision === "pass") return {};
  const handedOff = harness === "codex" && decision.decision === "ask";
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: handedOff ? "deny" : decision.decision,
      permissionDecisionReason: handedOff ? handOff(decision) : decision.reason,
    },
  };
}

function cmdBashGate(event: HookEvent): Output {
  const decision = bashGate({ command: event.tool_input?.command, cwd: event.cwd });
  if (decision.allow) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    },
  };
}

function exitCodeOf(response: HookEvent["tool_response"]): number | undefined {
  for (const key of ["exit_code", "exitCode", "code"]) {
    const v = response?.[key];
    if (typeof v === "number") return v;
  }
  return undefined;
}

function cmdRecordTest(event: HookEvent): Output {
  const command = event.tool_input?.command;
  if (typeof command !== "string") return {};
  const res = recordTestRun(event.cwd ?? process.cwd(), command, exitCodeOf(event.tool_response));
  return res.recorded
    ? { systemMessage: `sddx: task ${res.taskId} recorded ${res.recorded} (observed test run)` }
    : {};
}

function cmdStopGate(event: HookEvent): Output {
  const decision = stopGate({ cwd: event.cwd, stop_hook_active: event.stop_hook_active });
  return decision.block
    ? { decision: "block", reason: decision.reason }
    : decision.note
      ? { systemMessage: decision.note }
      : {};
}

/** Task files in the main checkout plus each task worktree's own file. */
function activeTaskFiles(root: string): string[] {
  const files: string[] = [];
  const main = join(root, ".sddx", "tasks");
  if (existsSync(main)) {
    for (const f of readdirSync(main).filter((n) => n.endsWith(".json"))) files.push(join(main, f));
  }
  const wts = join(root, ".sddx-worktrees");
  if (existsSync(wts)) {
    for (const id of readdirSync(wts)) {
      const f = join(wts, id, ".sddx", "tasks", `${id}.json`);
      if (existsSync(f)) files.push(f);
    }
  }
  return files;
}

export const NOT_OPTED_IN_LINE =
  "sddx is installed. To plan a change with it in this repository, run /sddx:brainstorm.";
export const CODEX_NOT_OPTED_IN_LINE =
  "sddx is installed. To plan a change with it in this repository, mention $sddx:brainstorm.";

/** Codex puts no plugin directory on PATH, so the line also gives the command and the tool mapping. */
const codexNotOptedInLine = (plugin: string | null): string =>
  plugin
    ? `${CODEX_NOT_OPTED_IN_LINE} Run sddx as ${shellWord(join(plugin, "bin", "sddx"))}, and read ${join(plugin, ROUTER_MAPPING.codex)} before running it.`
    : CODEX_NOT_OPTED_IN_LINE;

const CODEX_STRICT_NOTE =
  "This repository uses the strict profile, whose per-edit gates do not run in Codex. Each task still needs its boundary proof from sddx verify. Record each test run with sddx task phase <id> RED --test-exit <n>, then GREEN once it passes.";

const ROUTER = join("skills", "using-sddx", "SKILL.md");
const ROUTER_MAPPING: Record<Harness, string> = {
  "claude-code": join("skills", "using-sddx", "references", "claude-code.md"),
  codex: join("skills", "using-sddx", "references", "codex.md"),
};

/** The harness's own plugin root variable, PLUGIN_ROOT in Codex and
 * CLAUDE_PLUGIN_ROOT in Claude Code, else the nearest ancestor of this bundle
 * that ships the router. */
function pluginRoot(harness: Harness): string | null {
  const fromEnv = harness === "codex" ? process.env.PLUGIN_ROOT : process.env.CLAUDE_PLUGIN_ROOT;
  if (fromEnv) return fromEnv;
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++, d = dirname(d)) {
    if (existsSync(join(d, ROUTER))) return d;
  }
  return null;
}

/** An executable `sddx` on PATH outside the plugin's own `bin/`. The plugin's
 * `bin/` comes after the user's PATH in the agent's shell, so this one wins there. */
export function shadowingSddx(pluginBin: string | null): string | null {
  const own = pluginBin ? realOrNull(join(pluginBin, "sddx")) : null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, "sddx");
    try {
      accessSync(candidate, constants.X_OK);
      if (!statSync(candidate).isFile()) continue;
      // a link to the plugin's own launcher, under any spelling, is the plugin's CLI
      if (own !== null && realpathSync(candidate) === own) continue;
      if (pluginBin && resolve(dir) === resolve(pluginBin)) continue;
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

const realOrNull = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

function runCommandLines(plugin: string | null, harness: Harness): string[] {
  const pluginBin = plugin ? join(plugin, "bin") : null;
  const absolute = pluginBin ? shellWord(join(pluginBin, "sddx")) : "sddx";
  // Codex puts no plugin directory on the agent's PATH: only the absolute path reaches it
  if (harness === "codex") return [`Run sddx as: ${absolute}`];
  const shadow = shadowingSddx(pluginBin);
  if (!shadow || !pluginBin) return ["Run sddx as: sddx"];
  return [
    `Run sddx as: ${absolute}`,
    `Warning: another sddx at ${shadow} comes first on PATH and would shadow the plugin's, so use the command above wherever a skill says sddx. Removing the other one lets plain sddx work; the sddx troubleshooting guide shows how.`,
  ];
}

function routerText(plugin: string | null, harness: Harness): string {
  if (!plugin) return "sddx: the router skill could not be located (the plugin root is unset)";
  const parts: string[] = [];
  for (const rel of [ROUTER, ROUTER_MAPPING[harness]]) {
    try {
      parts.push(withoutFrontmatter(readFileSync(join(plugin, rel), "utf8")));
    } catch {
      parts.push(`sddx: ${join(plugin, rel)} could not be read`);
    }
  }
  return parts.join("\n\n");
}

/**
 * sddx 5 leftovers in an opted-in repository. While `sddx migrate` still has
 * something to do, session start points to it instead of loading the router.
 * Files sddx 5 generated that were edited, which migrate keeps on purpose, only
 * get a note, so a migrated repository is never stuck behind the pointer. A
 * failure here costs one diagnostic line, never the rest of session start.
 */
function v5Check(root: string): { pending: boolean; lines: string[] } {
  let s: V5Signals;
  try {
    s = detectV5Signals(root);
  } catch (e) {
    return {
      pending: false,
      lines: [`sddx: could not check for sddx 5 leftovers: ${(e as Error).message}`],
    };
  }
  const registered = s.claudeOwned.length > 0 || s.settingsHooks > 0;
  if (v5Blockers(s).length > 0 || registered || s.declaration) {
    const lines = [
      "This repository was set up by sddx 5, which sddx 6 does not run. Run `sddx migrate` to preview the move and show the user what it would change. Apply it with `sddx migrate --yes` only once the user agrees.",
    ];
    if (registered) {
      lines.push(
        "Until then its sddx 5 files and hooks under .claude/ stay registered, so both sets of hooks would fire: sddx 5's and the plugin's.",
      );
    }
    return { pending: true, lines };
  }
  if (s.claudeModified.length === 0) return { pending: false, lines: [] };
  return {
    pending: false,
    lines: [
      `Note: sddx 5 generated ${s.claudeModified.join(", ")}, and they were edited since, so sddx migrate kept them. Remove them once they are no longer needed.`,
    ],
  };
}

function optedInLines(
  root: string,
  plugin: string | null,
  notes: string[],
  harness: Harness,
): string[] {
  const lines = [
    `sddx is active in this repository (${root}).`,
    ...runCommandLines(plugin, harness),
    ...notes,
  ];
  if (harness === "codex") {
    try {
      if (profile(root) === "strict") lines.push(CODEX_STRICT_NOTE);
    } catch (e) {
      lines.push(`sddx: could not read the profile: ${(e as Error).message}`);
    }
  }
  try {
    const res = sweep(root);
    if (res.removed.length > 0) lines.push(`sddx: swept ${res.removed.length} orphan worktree(s)`);
  } catch {
    // sweep needs git; its absence must not delay session start
  }
  if (boardEnabled(root)) {
    try {
      writeBoard(root);
    } catch (e) {
      lines.push(`sddx: board refresh failed: ${(e as Error).message}`);
    }
  }
  for (const file of activeTaskFiles(root)) {
    try {
      const t = JSON.parse(readFileSync(file, "utf8")) as TaskState;
      if (!isTerminal(t.phase)) lines.push(`sddx task ${t.id}: ${t.phase}, ${t.task}`);
    } catch {
      lines.push(`sddx: task file ${file} is unreadable`);
    }
  }
  return [...lines, "", routerText(plugin, harness)];
}

/** What session start tells the agent, by repository state and harness (see the session-router spec). */
export function sessionStartContext(cwd: string, harness: Harness = "claude-code"): string {
  const root = optedInRoot(cwd);
  const plugin = pluginRoot(harness);
  if (root === null) return harness === "codex" ? codexNotOptedInLine(plugin) : NOT_OPTED_IN_LINE;
  const v5 = v5Check(root);
  if (v5.pending) return [...v5.lines, ...runCommandLines(plugin, harness)].join("\n");
  return optedInLines(root, plugin, v5.lines, harness).join("\n");
}

function cmdSessionStart(event: HookEvent, harness: Harness): Output {
  let context: string;
  try {
    context = sessionStartContext(event.cwd ?? process.cwd(), harness);
  } catch (e) {
    context = `sddx: session start failed: ${(e as Error).message}`;
  }
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } };
}

/** The output for one hook event. Never throws: a failure is a diagnostic, not a crash. */
export function hookOutput(
  sub: string | undefined,
  event: HookEvent,
  harness: Harness = "claude-code",
): Output {
  try {
    if (sub === "tdd-gate") return cmdTddGate(event);
    if (sub === "bash-gate") return cmdBashGate(event);
    if (sub === "approval-gate") return cmdApprovalGate(event, harness);
    if (sub === "record-test") return cmdRecordTest(event);
    if (sub === "stop-gate") return cmdStopGate(event);
    if (sub === "session-start") return cmdSessionStart(event, harness);
    return { systemMessage: `sddx hooks: unknown subcommand ${sub ?? "(none)"}` };
  } catch (e) {
    return { systemMessage: `sddx hook error (${sub}): ${(e as Error).message}` };
  }
}

/** Routes one hook event and prints its output. */
export function dispatchHook(
  sub: string | undefined,
  event: HookEvent,
  harness: Harness = "claude-code",
): void {
  console.log(JSON.stringify(hookOutput(sub, event, harness)));
}

/** Entrypoint behavior shared by the CLI's `hook` command. Always exits 0. */
export function runHook(sub: string | undefined, harness?: string): never {
  dispatchHook(sub, readEvent(), harnessOf(harness));
  process.exit(0);
}
