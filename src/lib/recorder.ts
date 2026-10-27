// Strict profile only: the PostToolUse recorder that turns observed test-runner
// exit codes into the task's per-edit evidence. A failing run records RED (which
// lifts the strict gates); a passing run after it records GREEN. Unknown commands
// are ignored: the recorder never guesses whether a command was a test run.
import { profile } from "./config";
import { resolveTask } from "./resolve";
import { mainRootOf, type TaskState, writeTask } from "./task";

export const TEST_RUNNER_PREFIXES: readonly string[] = [
  "bun test",
  "npm test",
  "pnpm test",
  "yarn test",
  "npx vitest",
  "npx jest",
  "pytest",
  "go test",
  "cargo test",
];

export function matchTestRunner(command: string): string | null {
  const trimmed = command.trim();
  for (const prefix of TEST_RUNNER_PREFIXES) {
    if (trimmed === prefix || trimmed.startsWith(`${prefix} `)) return prefix;
  }
  return null;
}

export interface RecordResult {
  matched: boolean;
  recorded: "RED" | "GREEN" | null;
  taskId?: string;
}

export function recordTestRun(
  cwd: string,
  command: string,
  exitCode: number | undefined,
): RecordResult {
  if (matchTestRunner(command) === null || exitCode === undefined) {
    return { matched: false, recorded: null };
  }
  if (profile(mainRootOf(cwd)) !== "strict") return { matched: true, recorded: null };
  const res = resolveTask(cwd);
  if (res.kind !== "task") return { matched: true, recorded: null };
  const task = res.task;
  if (task.phase !== "IN_PROGRESS" || task.profile !== "strict") {
    return { matched: true, recorded: null, taskId: task.id };
  }
  const strict = task.strict ?? { runs: [] };
  strict.runs.push({ test_exit: exitCode, source: "hook", at: new Date().toISOString() });
  let recorded: RecordResult["recorded"] = null;
  if (exitCode !== 0 && strict.phase === undefined) recorded = "RED";
  if (exitCode === 0 && strict.phase === "RED") recorded = "GREEN";
  if (recorded) strict.phase = recorded;
  task.strict = strict;
  writeTask(res.root, task);
  return { matched: true, recorded, taskId: task.id };
}

/**
 * `sddx task phase <id> RED|GREEN --test-exit <n>`: the manual path for a test
 * runner the recorder does not recognize. The exit code is checked, not trusted:
 * RED needs a failing run and GREEN a passing one.
 */
export function recordManualRun(task: TaskState, phase: "RED" | "GREEN", exitCode: number): void {
  if (phase === "RED" && exitCode === 0) {
    throw new Error("RED requires evidence of a failing test: --test-exit <nonzero exit code>");
  }
  if (phase === "GREEN" && exitCode !== 0) {
    throw new Error("GREEN requires evidence of a passing test: --test-exit 0");
  }
  if (task.phase !== "IN_PROGRESS" || task.profile !== "strict") {
    throw new Error(`task ${task.id} is not an IN_PROGRESS strict-profile task`);
  }
  const strict = task.strict ?? { runs: [] };
  // Same transition rule as the automatic recorder: GREEN lifts the gates only
  // after a failing run showed the tests can fail.
  if (phase === "GREEN" && strict.phase === undefined) {
    throw new Error(
      `GREEN requires a recorded failing run first: sddx task phase ${task.id} RED --test-exit <nonzero exit code>`,
    );
  }
  strict.runs.push({ test_exit: exitCode, source: "manual", at: new Date().toISOString() });
  strict.phase = phase;
  task.strict = strict;
}
