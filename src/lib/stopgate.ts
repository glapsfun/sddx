// Stop/SubagentStop completion gate: a session may not conclude while its
// governing task lacks verified completion. Zero trust in "done".
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveTask } from "./resolve";
import { isTerminal, type Phase } from "./task";

export interface StopDecision {
  block: boolean;
  reason?: string;
}

const NEXT_STEP: Record<Phase, string> = {
  PLAN: "write a failing test and run it to enter RED",
  RED: "make the failing test pass (run the test runner to enter GREEN)",
  GREEN: "refactor if needed, then: sddx task phase <id> VERIFY && sddx verify <id>",
  REFACTOR: "re-run tests to return to GREEN, then verify",
  VERIFY: "run: sddx verify <id>",
  DONE: "",
  ABANDONED: "",
};

export function stopGate(event: { cwd?: string; stop_hook_active?: boolean }): StopDecision {
  if (event.stop_hook_active) return { block: false }; // Claude Code loop-prevention contract
  const res = resolveTask(event.cwd ?? process.cwd());
  if (res.kind === "none") return { block: false };
  if (res.kind === "ambiguous") {
    return {
      block: true,
      reason: `sddx: tasks ${res.ids.join(" and ")} are both unfinished in this workspace — finish or abandon them before stopping.`,
    };
  }
  if (res.kind === "corrupt") {
    return {
      block: true,
      reason: `sddx: task state at ${res.path} is unreadable — completion cannot be proven. Fix the state file before stopping.`,
    };
  }
  const { task } = res;
  if (isTerminal(task.phase)) {
    // verify writes phase DONE before the receipt — a crash between the two must
    // not let the session conclude with completion unproven
    const receipt = join(res.root, ".sddx", "receipts", `${task.id}.json`);
    if (task.phase === "DONE" && !existsSync(receipt)) {
      return {
        block: true,
        reason: `sddx: task ${task.id} is DONE but .sddx/receipts/${task.id}.json is missing — completion is unproven. Restore the receipt or abandon the task.`,
      };
    }
    return { block: false };
  }
  const step = NEXT_STEP[task.phase].replaceAll("<id>", task.id);
  return {
    block: true,
    reason: `sddx: task ${task.id} is in ${task.phase} without a verified receipt — ${step}.`,
  };
}
