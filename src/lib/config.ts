// Shared reader for .sddx/config.json (materialized from the manifest's
// userConfig). Unreadable config never changes behavior — defaults apply.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SddxConfig {
  test_globs?: string;
  exempt_globs?: string;
  board_enabled?: boolean;
  oracle_runs_default?: number;
  red_bash_allow?: string;
  stuck_threshold?: number;
}

export function readConfig(root: string): SddxConfig {
  const path = join(root, ".sddx", "config.json");
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as SddxConfig) : {};
  } catch {
    return {};
  }
}

const positiveInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;

/** Precedence: SDDX_STUCK_THRESHOLD > config stuck_threshold > 3. */
export function stuckThreshold(root: string, env: NodeJS.ProcessEnv = process.env): number {
  return (
    positiveInt(Number(env.SDDX_STUCK_THRESHOLD)) ??
    positiveInt(readConfig(root).stuck_threshold) ??
    3
  );
}

/** Precedence: spec > SDDX_ORACLE_RUNS > config oracle_runs_default > 1. */
export function oracleRuns(
  root: string,
  specRuns: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (specRuns !== undefined) return specRuns;
  return (
    positiveInt(Number(env.SDDX_ORACLE_RUNS)) ??
    positiveInt(readConfig(root).oracle_runs_default) ??
    1
  );
}
