// PostToolUse test-result recorder: phases are earned from observed test-runner
// exit codes, never claimed. Unknown commands are ignored — the recorder never
// guesses whether a Bash command was a test run.
import { stuckThreshold } from "./config";
import { sha256 } from "./receipt";
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

/** Failure identity: exit code + last 20 output lines, numbers and whitespace
 * normalized away (durations vary between identical failures). */
export function failureFingerprint(exitCode: number, output: string): string {
  const tail = output
    .split("\n")
    .slice(-20)
    .join("\n")
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  return sha256(`${exitCode}\n${tail}`);
}

export interface RecordResult {
  matched: boolean;
  transitioned: Phase | null;
  taskId?: string;
  stuck?: { count: number; threshold: number };
}

export function recordTestRun(
  cwd: string,
  command: string,
  exitCode: number | undefined,
  output = "",
): RecordResult {
  if (matchTestRunner(command) === null || exitCode === undefined) {
    return { matched: false, transitioned: null };
  }
  const res = resolveTask(cwd);
  if (res.kind !== "task") return { matched: true, transitioned: null };
  const task = res.task;

  const at = new Date().toISOString();
  if (exitCode !== 0) {
    const fp = failureFingerprint(exitCode, output);
    task.stuck =
      task.stuck?.fingerprint === fp
        ? { fingerprint: fp, count: task.stuck.count + 1, since: task.stuck.since }
        : { fingerprint: fp, count: 1, since: at };
  } else if (task.stuck) {
    task.stuck = undefined; // JSON.stringify drops it — a clean pass leaves no residue
  }

  let to: Phase | null = null;
  if (task.phase === "PLAN" && exitCode !== 0) to = "RED";
  if ((task.phase === "RED" || task.phase === "REFACTOR") && exitCode === 0) to = "GREEN";

  if (to) {
    transition(task, to, { testExit: exitCode, source: "hook" });
  } else {
    // observation without a legal transition (e.g. exit 0 in PLAN) is still evidence
    task.evidence.last_test = { test_exit: exitCode, at, source: "hook" };
  }
  const threshold = stuckThreshold(res.root);
  const stuck =
    task.stuck && task.stuck.count >= threshold
      ? { count: task.stuck.count, threshold }
      : undefined;
  writeTask(res.root, task);
  return { matched: true, transitioned: to, taskId: task.id, ...(stuck ? { stuck } : {}) };
}
