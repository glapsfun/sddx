// Oracle red-check: prove the oracle can fail before implementation exists.
// A pre-passing oracle discriminates nothing — the spec, not the code, is broken.
import { spawnSync } from "node:child_process";
import { sha256 } from "./receipt";
import { readTask, writeTask } from "./task";

const ORACLE_TIMEOUT_MS = 10 * 60_000;

export interface RedCheckResult {
  ok: boolean;
  exitCode: number;
}

export function redCheck(cwd: string, id: string): RedCheckResult {
  const task = readTask(cwd, id);
  if (task.phase !== "RED") {
    throw new Error(
      `task ${id} is in ${task.phase}; red-check requires phase RED (a recorded failing test)`,
    );
  }
  if (task.oracle.type === "manual") {
    throw new Error("manual oracles cannot be red-checked");
  }
  const run = spawnSync("sh", ["-c", task.oracle.run], { cwd, timeout: ORACLE_TIMEOUT_MS });
  if (run.error) throw new Error(`oracle could not run: ${run.error.message}`);
  const exitCode = run.status ?? -1;
  if (exitCode === 0) return { ok: false, exitCode };
  task.evidence.oracle_red = {
    exit_code: exitCode,
    at: new Date().toISOString(),
    stdout_sha256: sha256(run.stdout ?? Buffer.alloc(0)),
    stderr_sha256: sha256(run.stderr ?? Buffer.alloc(0)),
  };
  writeTask(cwd, task);
  return { ok: true, exitCode };
}
