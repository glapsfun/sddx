// Shared reader for .sddx/config.json (materialized from the manifest's
// userConfig). Unreadable config never changes behavior — defaults apply.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SddxConfig {
  workspace_mode?: "auto" | "worktree" | "branch" | "none";
  test_globs?: string;
  exempt_globs?: string;
  max_iterations_default?: number;
  board_enabled?: boolean;
  oracle_runs_default?: number;
  red_bash_allow?: string;
  stuck_threshold?: number;
  pr_host?: "gh" | "glab";
  agent_model?: string;
  prefer_solo?: boolean;
  verbose?: boolean;
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

/**
 * General precedence resolver: `cliValue` (a per-call override, e.g. a spec
 * field or CLI flag) beats an environment variable, which beats
 * `.sddx/config.json`, which beats `fallback`. `envParse`/`configParse`
 * default to an identity cast — pass one when the raw value needs parsing or
 * validating (numbers, enums); a value that fails to parse falls through to
 * the next source rather than throwing.
 */
export function resolveValue<T>(opts: {
  cliValue?: T;
  env?: NodeJS.ProcessEnv;
  envVar?: string;
  envParse?: (raw: string) => T | null | undefined;
  configValue?: unknown;
  configParse?: (raw: unknown) => T | null | undefined;
  fallback: T;
}): T {
  if (opts.cliValue !== undefined) return opts.cliValue;
  const rawEnv = opts.envVar && opts.env ? opts.env[opts.envVar] : undefined;
  if (rawEnv !== undefined) {
    const parsed = opts.envParse ? opts.envParse(rawEnv) : (rawEnv as unknown as T);
    if (parsed !== null && parsed !== undefined) return parsed;
  }
  if (opts.configValue !== undefined) {
    const parsed = opts.configParse ? opts.configParse(opts.configValue) : (opts.configValue as T);
    if (parsed !== null && parsed !== undefined) return parsed;
  }
  return opts.fallback;
}

/** Precedence: SDDX_STUCK_THRESHOLD > config stuck_threshold > 3. */
export function stuckThreshold(root: string, env: NodeJS.ProcessEnv = process.env): number {
  return resolveValue({
    env,
    envVar: "SDDX_STUCK_THRESHOLD",
    envParse: (raw) => positiveInt(Number(raw)),
    configValue: readConfig(root).stuck_threshold,
    configParse: positiveInt,
    fallback: 3,
  });
}

/** Precedence: spec > SDDX_ORACLE_RUNS > config oracle_runs_default > 1. */
export function oracleRuns(
  root: string,
  specRuns: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  // re-validate the task-file value: a tampered "runs": 0 must never mean
  // "verify without executing the oracle"
  return resolveValue({
    cliValue: positiveInt(specRuns) ?? undefined,
    env,
    envVar: "SDDX_ORACLE_RUNS",
    envParse: (raw) => positiveInt(Number(raw)),
    configValue: readConfig(root).oracle_runs_default,
    configParse: positiveInt,
    fallback: 1,
  });
}

/** Precedence: SDDX_BOARD_ENABLED > config board_enabled > true. */
export function boardEnabled(root: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveValue({
    env,
    envVar: "SDDX_BOARD_ENABLED",
    envParse: (raw) => !["false", "0"].includes(raw),
    configValue: readConfig(root).board_enabled,
    configParse: (v) => (typeof v === "boolean" ? v : null),
    fallback: true,
  });
}

const KNOWN_AGENT_ROLES = ["orchestrator", "planner", "tddExecutor", "verifier"] as const;

/**
 * Parses `agent_model` ("role=model" pairs, comma-separated) into a role→model
 * map. Malformed or unrecognized-role segments are dropped individually (with
 * a warning) rather than failing the whole value — consistent with "unreadable
 * config never changes behavior" for the rest of this file.
 */
export function parseAgentModel(raw: string | undefined): {
  models: Record<string, string>;
  warnings: string[];
} {
  const models: Record<string, string> = {};
  const warnings: string[] = [];
  if (!raw) return { models, warnings };
  for (const segment of raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")) {
    const eq = segment.indexOf("=");
    const role = eq === -1 ? "" : segment.slice(0, eq).trim();
    const model = eq === -1 ? "" : segment.slice(eq + 1).trim();
    if (eq === -1 || model === "" || !(KNOWN_AGENT_ROLES as readonly string[]).includes(role)) {
      warnings.push(
        `agent_model: ignoring "${segment}" — expected one of ${KNOWN_AGENT_ROLES.join("|")} followed by =<model>`,
      );
      continue;
    }
    models[role] = model;
  }
  return { models, warnings };
}

export interface ResolvedConfig {
  workspace_mode: "auto" | "worktree" | "branch" | "none";
  test_globs: string;
  exempt_globs: string;
  max_iterations_default: number;
  board_enabled: boolean;
  oracle_runs_default: number;
  red_bash_allow: string;
  stuck_threshold: number;
  pr_host: "gh" | "glab" | null;
  agent_model: Record<string, string>;
  prefer_solo: boolean;
  verbose: boolean;
}

const WORKSPACE_MODES = ["auto", "worktree", "branch", "none"] as const;
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** Every config key, fully resolved (env/config/default precedence applied),
 * for `sddx config show` and any caller that wants the whole picture at once. */
export function resolveConfig(root: string, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const cfg = readConfig(root);
  return {
    workspace_mode: (WORKSPACE_MODES as readonly string[]).includes(cfg.workspace_mode ?? "")
      ? (cfg.workspace_mode as ResolvedConfig["workspace_mode"])
      : "auto",
    test_globs: resolveValue({
      env,
      envVar: "SDDX_TEST_GLOBS",
      configValue: cfg.test_globs,
      fallback: "",
    }),
    exempt_globs: resolveValue({
      env,
      envVar: "SDDX_EXEMPT_GLOBS",
      configValue: cfg.exempt_globs,
      fallback: "",
    }),
    max_iterations_default: resolveValue({
      configValue: cfg.max_iterations_default,
      configParse: positiveInt,
      fallback: 5,
    }),
    board_enabled: resolveValue({
      env,
      envVar: "SDDX_BOARD_ENABLED",
      envParse: (raw) => !["false", "0"].includes(raw),
      configValue: cfg.board_enabled,
      configParse: bool,
      fallback: true,
    }),
    oracle_runs_default: resolveValue({
      env,
      envVar: "SDDX_ORACLE_RUNS",
      envParse: (raw) => positiveInt(Number(raw)),
      configValue: cfg.oracle_runs_default,
      configParse: positiveInt,
      fallback: 1,
    }),
    red_bash_allow: resolveValue({
      env,
      envVar: "SDDX_RED_BASH_ALLOW",
      configValue: cfg.red_bash_allow,
      fallback: "",
    }),
    stuck_threshold: resolveValue({
      env,
      envVar: "SDDX_STUCK_THRESHOLD",
      envParse: (raw) => positiveInt(Number(raw)),
      configValue: cfg.stuck_threshold,
      configParse: positiveInt,
      fallback: 3,
    }),
    pr_host: cfg.pr_host ?? null,
    agent_model: parseAgentModel(cfg.agent_model).models,
    prefer_solo: resolveValue({ configValue: cfg.prefer_solo, configParse: bool, fallback: false }),
    verbose: resolveValue({ configValue: cfg.verbose, configParse: bool, fallback: false }),
  };
}

const isString = (v: unknown): boolean => typeof v === "string";
const isBoolean = (v: unknown): boolean => typeof v === "boolean";
const isPositiveInt = (v: unknown): boolean => positiveInt(v) !== null;
const isOneOf =
  (values: readonly string[]) =>
  (v: unknown): boolean =>
    typeof v === "string" && (values as readonly string[]).includes(v);

/**
 * The full known-key schema: each entry is `[key, isValid, expectation]`.
 * `isValid` enforces the same domain rule the corresponding resolver applies
 * (positive integers, enum membership) — not just JS `typeof` — so a
 * structurally-valid-but-out-of-range value (`stuck_threshold: -2`, a typo'd
 * `workspace_mode`) is caught here instead of silently falling back to its
 * default at resolution time with nothing telling the user why.
 * `KNOWN_CONFIG_KEYS` is derived from this list so the two can never drift.
 */
const CONFIG_SCHEMA: ReadonlyArray<[string, (v: unknown) => boolean, string]> = [
  ["workspace_mode", isOneOf(WORKSPACE_MODES), `one of ${WORKSPACE_MODES.join("|")}`],
  ["test_globs", isString, "a string"],
  ["exempt_globs", isString, "a string"],
  ["max_iterations_default", isPositiveInt, "a positive integer"],
  ["board_enabled", isBoolean, "a boolean"],
  ["oracle_runs_default", isPositiveInt, "a positive integer"],
  ["red_bash_allow", isString, "a string"],
  ["stuck_threshold", isPositiveInt, "a positive integer"],
  ["pr_host", isOneOf(["gh", "glab"]), "one of gh|glab"],
  ["agent_model", isString, "a string"],
  ["prefer_solo", isBoolean, "a boolean"],
  ["verbose", isBoolean, "a boolean"],
];

export const KNOWN_CONFIG_KEYS: ReadonlySet<string> = new Set(CONFIG_SCHEMA.map(([key]) => key));

/**
 * Validates a parsed `.sddx/config.json` object against the known schema:
 * unrecognized top-level keys and values that fail their key's domain rule
 * are both reported as warnings (never a hard failure — a newer sddx
 * version's config read by an older one should not break). `agent_model`'s
 * own malformed-segment warnings (from `parseAgentModel`) are folded in.
 */
export function validateConfigObject(obj: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  for (const key of Object.keys(obj)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) warnings.push(`unrecognized key "${key}"`);
  }
  for (const [key, isValid, expectation] of CONFIG_SCHEMA) {
    if (key in obj && !isValid(obj[key])) {
      warnings.push(`"${key}" must be ${expectation} — got ${JSON.stringify(obj[key])}`);
    }
  }
  if (typeof obj.agent_model === "string") {
    warnings.push(...parseAgentModel(obj.agent_model).warnings);
  }
  return warnings;
}
