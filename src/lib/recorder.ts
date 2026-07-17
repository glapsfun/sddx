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

/** Failure identity: command + exit code + last 20 output lines, numbers and
 * whitespace normalized away (durations vary between identical failures). The
 * command term keeps distinct test invocations distinct even when the harness
 * delivers no output and only the exit code is left to compare. */
export function failureFingerprint(exitCode: number, output: string, command = ""): string {
  const tail = output
    .split("\n")
    .slice(-20)
    .join("\n")
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  return sha256(`${exitCode}\n${command.trim()}\n${tail}`);
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
    const fp = failureFingerprint(exitCode, output, command);
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
  let stuck: RecordResult["stuck"];
  if (task.stuck) {
    // config is only consulted when a failure streak exists — keeps the
    // passing-run hot path free of config I/O
    const threshold = stuckThreshold(res.root);
    if (task.stuck.count >= threshold) stuck = { count: task.stuck.count, threshold };
  }
  writeTask(res.root, task);
  return { matched: true, transitioned: to, taskId: task.id, stuck };
}
