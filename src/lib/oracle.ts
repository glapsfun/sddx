// The one place an oracle command is executed: red-check and verify must run
// the oracle under identical conditions or their evidence stops being comparable.
import { spawnSync } from "node:child_process";

export const ORACLE_TIMEOUT_MS = 10 * 60_000;

export interface OracleRunResult {
  exitCode: number;
  durationMs: number;
  stdout: Buffer;
  stderr: Buffer;
}

export function runOracle(cwd: string, run: string): OracleRunResult {
  const started = Date.now();
  const r = spawnSync("sh", ["-c", run], { cwd, timeout: ORACLE_TIMEOUT_MS });
  if (r.error) throw new Error(`oracle could not run: ${r.error.message}`);
  return {
    exitCode: r.status ?? -1,
    durationMs: Date.now() - started,
    stdout: r.stdout ?? Buffer.alloc(0),
    stderr: r.stderr ?? Buffer.alloc(0),
  };
}
