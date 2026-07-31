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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeBoard } from "../board";
import { tddGate } from "../tdd-gate";
import { approvalGate } from "./approvalgate";
import { bashGate } from "./bashgate";
import { boardEnabled } from "./config";
import { recordTestRun } from "./recorder";
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

const emit = (output: Record<string, unknown>): void => {
  console.log(JSON.stringify(output));
};

function cmdTddGate(event: HookEvent): void {
  const decision = tddGate({
    filePath: event.tool_input?.file_path ?? event.tool_input?.notebook_path,
    cwd: event.cwd,
  });
  if (decision.allow) {
    // pass-through: no permissionDecision — never auto-approve, just don't deny
    emit(decision.diagnostic ? { systemMessage: decision.diagnostic } : {});
    return;
  }
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    },
  });
}

/**
 * The plan-approval gate. Unlike `cmdTddGate`/`cmdBashGate` above — prohibition
 * gates that deny or stay silent, and must NEVER emit "allow" — this is a
 * permission gate: it emits `"ask"` to raise the user's own permission dialog,
 * which is the only signal in this system a model cannot produce for itself.
 * Do not "harmonize" this with the prohibition gates; a silent approval gate is
 * a disabled one. See src/lib/approvalgate.ts and its regression test.
 */
function cmdApprovalGate(event: HookEvent): void {
  const decision = approvalGate({ command: event.tool_input?.command, cwd: event.cwd });
  if (decision.decision === "pass") {
    emit({});
    return;
  }
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: decision.reason,
    },
  });
}

function cmdBashGate(event: HookEvent): void {
  const decision = bashGate({ command: event.tool_input?.command, cwd: event.cwd });
  if (decision.allow) {
    emit({});
    return;
  }
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    },
  });
}

function exitCodeOf(response: HookEvent["tool_response"]): number | undefined {
  for (const key of ["exit_code", "exitCode", "code"]) {
    const v = response?.[key];
    if (typeof v === "number") return v;
  }
  return undefined;
}

function outputOf(response: HookEvent["tool_response"]): string {
  let out = "";
  for (const key of ["stdout", "stderr", "output"]) {
    const v = response?.[key];
    if (typeof v === "string") out += v;
  }
  return out;
}

function cmdRecordTest(event: HookEvent): void {
  const command = event.tool_input?.command;
  if (typeof command !== "string") {
    emit({});
    return;
  }
  const res = recordTestRun(
    event.cwd ?? process.cwd(),
    command,
    exitCodeOf(event.tool_response),
    outputOf(event.tool_response),
  );
  const parts: string[] = [];
  if (res.transitioned)
    parts.push(`sddx: task ${res.taskId} → ${res.transitioned} (observed test run)`);
  if (res.stuck)
    parts.push(
      `sddx: task ${res.taskId} has failed identically ${res.stuck.count}× (threshold ${res.stuck.threshold}) — stuck; stop and escalate to the human instead of iterating.`,
    );
  emit(parts.length > 0 ? { systemMessage: parts.join("\n") } : {});
}

function cmdStopGate(event: HookEvent): void {
  const decision = stopGate({ cwd: event.cwd, stop_hook_active: event.stop_hook_active });
  emit(
    decision.block
      ? { decision: "block", reason: decision.reason }
      : decision.note
        ? { systemMessage: decision.note }
        : {},
  );
}

function cmdSessionStart(event: HookEvent): void {
  const cwd = event.cwd ?? process.cwd();
  const lines: string[] = [];
  if (existsSync(join(cwd, ".sddx"))) {
    try {
      const res = sweep(cwd);
      if (res.removed.length > 0)
        lines.push(`sddx: swept ${res.removed.length} orphan worktree(s)`);
    } catch {
      // sweep needs git; its absence must not delay session start
    }
    if (boardEnabled(cwd)) {
      try {
        writeBoard(cwd);
      } catch (e) {
        lines.push(`sddx: board refresh failed: ${(e as Error).message}`);
      }
    }
    const tasksDir = join(cwd, ".sddx", "tasks");
    if (existsSync(tasksDir)) {
      for (const file of readdirSync(tasksDir).filter((f) => f.endsWith(".json"))) {
        try {
          const t = JSON.parse(readFileSync(join(tasksDir, file), "utf8")) as TaskState;
          if (!isTerminal(t.phase)) lines.push(`sddx task ${t.id}: phase ${t.phase} — ${t.task}`);
        } catch {
          lines.push(`sddx: task file ${file} is unreadable`);
        }
      }
    }
  }
  if (lines.length === 0) {
    emit({});
    return;
  }
  emit({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") },
  });
}

/** Routes one hook event. Never throws: a failure is a diagnostic, not a crash. */
export function dispatchHook(sub: string | undefined, event: HookEvent): void {
  try {
    if (sub === "tdd-gate") cmdTddGate(event);
    else if (sub === "bash-gate") cmdBashGate(event);
    else if (sub === "approval-gate") cmdApprovalGate(event);
    else if (sub === "record-test") cmdRecordTest(event);
    else if (sub === "stop-gate") cmdStopGate(event);
    else if (sub === "session-start") cmdSessionStart(event);
    else emit({ systemMessage: `sddx hooks: unknown subcommand ${sub ?? "(none)"}` });
  } catch (e) {
    emit({ systemMessage: `sddx hook error (${sub}): ${(e as Error).message}` });
  }
}

/** Entrypoint behavior shared by the CLI's `hook` command. Always exits 0. */
export function runHook(sub: string | undefined): never {
  dispatchHook(sub, readEvent());
  process.exit(0);
}
