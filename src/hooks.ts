// Hook dispatcher entrypoint: one bundle for every sddx hook event.
//   hooks.mjs <session-start | tdd-gate | record-test | stop-gate>
// Reads the Claude Code event JSON from stdin, emits the decision JSON on stdout,
// always exits 0 — a bug in sddx must never brick a user session. RED-phase safety
// survives a crash here because the phase machine and verifier still gate completion.
// Deliberately not exported: process entrypoint (see bootstrap.ts).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { recordTestRun } from "./lib/recorder";
import { stopGate } from "./lib/stopgate";
import { isTerminal, type TaskState } from "./lib/task";
import { sweep } from "./lib/worktree";
import { tddGate } from "./tdd-gate";

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

function exitCodeOf(response: HookEvent["tool_response"]): number | undefined {
  for (const key of ["exit_code", "exitCode", "code"]) {
    const v = response?.[key];
    if (typeof v === "number") return v;
  }
  return undefined;
}

function cmdRecordTest(event: HookEvent): void {
  const command = event.tool_input?.command;
  if (typeof command !== "string") {
    emit({});
    return;
  }
  const res = recordTestRun(event.cwd ?? process.cwd(), command, exitCodeOf(event.tool_response));
  emit(
    res.transitioned
      ? { systemMessage: `sddx: task ${res.taskId} → ${res.transitioned} (observed test run)` }
      : {},
  );
}

function cmdStopGate(event: HookEvent): void {
  const decision = stopGate({ cwd: event.cwd, stop_hook_active: event.stop_hook_active });
  emit(decision.block ? { decision: "block", reason: decision.reason } : {});
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

function main(): void {
  const sub = process.argv[2];
  const event = readEvent();
  try {
    if (sub === "tdd-gate") cmdTddGate(event);
    else if (sub === "record-test") cmdRecordTest(event);
    else if (sub === "stop-gate") cmdStopGate(event);
    else if (sub === "session-start") cmdSessionStart(event);
    else emit({ systemMessage: `sddx hooks: unknown subcommand ${sub ?? "(none)"}` });
  } catch (e) {
    emit({ systemMessage: `sddx hook error (${sub}): ${(e as Error).message}` });
  }
  process.exit(0);
}

main();
