// PostToolUse test-result recorder: phases are earned from observed test-runner
// exit codes, never claimed. Unknown commands are ignored — the recorder never
// guesses whether a Bash command was a test run.
import { resolveTask } from "./resolve";
import { type Phase, transition, writeTask } from "./task";

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
  transitioned: Phase | null;
  taskId?: string;
}

export function recordTestRun(
  cwd: string,
  command: string,
  exitCode: number | undefined,
): RecordResult {
  if (matchTestRunner(command) === null || exitCode === undefined) {
    return { matched: false, transitioned: null };
  }
  const res = resolveTask(cwd);
  if (res.kind !== "task") return { matched: true, transitioned: null };
  const task = res.task;

  let to: Phase | null = null;
  if (task.phase === "PLAN" && exitCode !== 0) to = "RED";
  if ((task.phase === "RED" || task.phase === "REFACTOR") && exitCode === 0) to = "GREEN";

  const at = new Date().toISOString();
  if (to) {
    transition(task, to, { testExit: exitCode, source: "hook" });
  } else {
    // observation without a legal transition (e.g. exit 0 in PLAN) is still evidence
    task.evidence.last_test = { test_exit: exitCode, at, source: "hook" };
  }
  writeTask(res.root, task);
  return { matched: true, transitioned: to, taskId: task.id };
}
