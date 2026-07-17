import { oracleRuns } from "./config";
import { captureEnv } from "./envinfo";
import { commit, stageAll, writeTree } from "./git";
import { runOracle } from "./oracle";
import { chainHead, type OracleRun, type Receipt, sha256, writeReceipt } from "./receipt";
import { signPayload } from "./sign";
import { readTask, transition, writeTask } from "./task";

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
  const redEvidence = task.evidence.oracle_red;
  if (!redEvidence || redEvidence.exit_code === undefined || redEvidence.exit_code === 0) {
    throw new Error(
      `task ${id} has no failing-oracle evidence — an oracle that never failed proves nothing. ` +
        `In RED, run \`sddx red-check ${id}\`. A task already past RED (e.g. created before sddx 0.2) ` +
        `cannot be red-checked retroactively: abandon it (sddx task phase ${id} ABANDONED) and recreate`,
    );
  }
  const firstGreen = task.history.find((h) => h.phase === "GREEN");
  if (firstGreen && Date.parse(redEvidence.at) > Date.parse(firstGreen.at)) {
    throw new Error(
      `oracle_red (${redEvidence.at}) was recorded after the first GREEN (${firstGreen.at}) — the red-check must precede implementation; abandon and restart the task`,
    );
  }
  const want = expectedExit(task.oracle.expect);

  const wanted = oracleRuns(cwd, task.oracle.runs);
  const runs: OracleRun[] = [];
  const started = Date.now();
  let exitCode = 0;
  for (let i = 0; i < wanted; i += 1) {
    const run = runOracle(cwd, task.oracle.run);
    exitCode = run.exitCode;
    runs.push({
      exit_code: run.exitCode,
      duration_ms: run.durationMs,
      stdout_sha256: sha256(run.stdout),
      stderr_sha256: sha256(run.stderr),
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
  // sign the unsigned bytes, then append the two fields LAST — audit
  // reconstructs the payload by deleting exactly these keys
  const sig = signPayload(cwd, sha256(`${JSON.stringify(receipt, null, 2)}\n`));
  if (sig) {
    receipt.signature = sig.signature;
    receipt.signer = sig.signer;
  }
  const receiptPath = writeReceipt(cwd, receipt);

  stageAll(cwd);
  const commitSha = commit(cwd, `sddx(${id}): ${task.task}`);
  return { verdict: "pass", exitCode, durationMs, receiptPath, commitSha };
}
