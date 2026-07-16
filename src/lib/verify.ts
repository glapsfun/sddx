import { spawnSync } from "node:child_process";
import { commit, stageAll, writeTree } from "./git";
import { chainHead, sha256, writeReceipt, type Receipt } from "./receipt";
import { readTask, transition, writeTask } from "./task";

const ORACLE_TIMEOUT_MS = 10 * 60_000;

function expectedExit(expect: string): number {
  const m = /^exit\s+(\d+)$/.exec(expect.trim());
  if (!m) {
    throw new Error(`unsupported oracle.expect: "${expect}" (M1 supports "exit <code>")`);
  }
  return Number(m[1]);
}

export interface VerifyResult {
  verdict: "pass" | "fail";
  exitCode: number;
  durationMs: number;
  receiptPath?: string;
  commitSha?: string;
}

export function verifyTask(
  cwd: string,
  id: string,
  opts: { model?: string | null; harness?: string; pluginVersion: string },
): VerifyResult {
  const task = readTask(cwd, id);
  if (task.phase !== "VERIFY") {
    throw new Error(`task ${id} is in ${task.phase}; verify requires phase VERIFY`);
  }
  if (task.oracle.type === "manual") {
    throw new Error("manual oracles need a human decision; M1 verify supports command oracles");
  }
  const want = expectedExit(task.oracle.expect);

  const started = Date.now();
  const run = spawnSync("sh", ["-c", task.oracle.run], {
    cwd,
    timeout: ORACLE_TIMEOUT_MS,
  });
  if (run.error) throw new Error(`oracle could not run: ${run.error.message}`);
  const durationMs = Date.now() - started;
  const exitCode = run.status ?? -1;

  task.iterations += 1;
  if (exitCode !== want) {
    task.evidence.last_verify = { exit_code: exitCode, at: new Date().toISOString() };
    writeTask(cwd, task);
    return { verdict: "fail", exitCode, durationMs };
  }

  transition(task, "DONE", { internal: true });
  task.evidence.verify = { exit_code: exitCode, at: new Date().toISOString() };
  writeTask(cwd, task);

  stageAll(cwd);
  const treeSha = writeTree(cwd);

  const head = chainHead(cwd);
  const receipt: Receipt = {
    version: 1,
    task_id: id,
    seq: head.seq + 1,
    prev: head.prevHash,
    harness: opts.harness ?? "claude-code",
    model: opts.model ?? null,
    plugin_version: opts.pluginVersion,
    oracle: { run: task.oracle.run, expect: task.oracle.expect },
    exit_code: exitCode,
    duration_ms: durationMs,
    stdout_sha256: sha256(run.stdout ?? Buffer.alloc(0)),
    stderr_sha256: sha256(run.stderr ?? Buffer.alloc(0)),
    base_sha: task.workspace.base_sha,
    tree_sha: treeSha,
    verdict: "pass",
    verified_at: new Date().toISOString(),
  };
  const receiptPath = writeReceipt(cwd, receipt);

  stageAll(cwd);
  const commitSha = commit(cwd, `sddx(${id}): ${task.task}`);
  return { verdict: "pass", exitCode, durationMs, receiptPath, commitSha };
}
