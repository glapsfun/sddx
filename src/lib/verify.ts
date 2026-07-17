import { spawnSync } from "node:child_process";
import { oracleRuns } from "./config";
import { captureEnv } from "./envinfo";
import { commit, stageAll, writeTree } from "./git";
import { chainHead, type OracleRun, type Receipt, sha256, writeReceipt } from "./receipt";
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

  const wanted = oracleRuns(cwd, task.oracle.runs);
  const runs: OracleRun[] = [];
  const started = Date.now();
  let exitCode = 0;
  for (let i = 0; i < wanted; i += 1) {
    const runStarted = Date.now();
    const run = spawnSync("sh", ["-c", task.oracle.run], { cwd, timeout: ORACLE_TIMEOUT_MS });
    if (run.error) throw new Error(`oracle could not run: ${run.error.message}`);
    exitCode = run.status ?? -1;
    runs.push({
      exit_code: exitCode,
      duration_ms: Date.now() - runStarted,
      stdout_sha256: sha256(run.stdout ?? Buffer.alloc(0)),
      stderr_sha256: sha256(run.stderr ?? Buffer.alloc(0)),
    });
    if (exitCode !== want) break; // fail fast — one bad run fails the whole verification
  }
  const durationMs = Date.now() - started;

  task.iterations += 1;
  if (exitCode !== want) {
    task.evidence.last_verify = { exit_code: exitCode, at: new Date().toISOString() };
    writeTask(cwd, task);
    return { verdict: "fail", exitCode, durationMs };
  }

  const env = captureEnv(cwd); // before staging — reflects the tree the oracle saw

  transition(task, "DONE", { internal: true });
  task.evidence.verify = { exit_code: exitCode, at: new Date().toISOString() };
  writeTask(cwd, task);

  stageAll(cwd);
  const treeSha = writeTree(cwd);

  const head = chainHead(cwd);
  const receipt: Receipt = {
    version: 3,
    task_id: id,
    seq: head.seq + 1,
    prev: head.prevHash,
    harness: opts.harness ?? "claude-code",
    model: opts.model ?? null,
    plugin_version: opts.pluginVersion,
    oracle: { run: task.oracle.run, expect: task.oracle.expect },
    runs,
    env,
    base_sha: task.workspace.base_sha,
    tree_sha: treeSha,
    verdict: "pass",
    verified_at: new Date().toISOString(),
    allow: [...task.allow],
  };
  const receiptPath = writeReceipt(cwd, receipt);

  stageAll(cwd);
  const commitSha = commit(cwd, `sddx(${id}): ${task.task}`);
  return { verdict: "pass", exitCode, durationMs, receiptPath, commitSha };
}
