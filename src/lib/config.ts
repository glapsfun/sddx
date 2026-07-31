// Shared reader for .sddx/config.json, the repository's reviewed project
// policy, authored by `sddx init` against the CLI-owned schema below.
// Unreadable config never changes behavior — defaults apply.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SddxConfig {
  test_globs?: string;
  exempt_globs?: string;
  max_iterations_default?: number;
  board_enabled?: boolean;
  oracle_runs_default?: number;
  red_bash_allow?: string;
  stuck_threshold?: number;
  pr_host?: "gh" | "glab";
  agent_model?: string;
  verbose?: boolean;
  /** Renamed from `execution_mode`. Both are read; the new name wins. */
  interaction_mode?: InteractionMode;
  /** DEPRECATED — read for compatibility, never written. See `interactionMode`. */
  execution_mode?: InteractionMode;
  auto_max_tasks?: number;
  /** Written by `sddx init`. Absent in files predating the bootstrap command. */
  schema_version?: string;
  runtime_scope?: RuntimeScope;
  package_manager?: PackageManager;
  adapters?: string[];
}

/**
 * Which approval gates are armed. `auto` is `human` with the plan-approval gate
 * pre-satisfied — never a second execution path.
 *
 * Named for the INTERACTION it governs, not for execution: the two modes share
 * one execution engine and differ only in whether a human is consulted before
 * materialization. The old name (`execution_mode`) suggested two ways of
 * running, which is exactly what this is not.
 */
export type InteractionMode = "human" | "auto";

export const INTERACTION_MODES = ["human", "auto"] as const;

/**
 * How generated adapter content invokes sddx.
 *
 * `global` resolves an `sddx` from PATH; `project` runs a lockfile-backed
 * project dependency through the package manager. Neither ever copies an sddx
 * runtime into `.sddx/` — package managers own package bytes.
 */
export type RuntimeScope = "global" | "project";
export const RUNTIME_SCOPES = ["global", "project"] as const;

/**
 * Package managers whose no-install local execution form has been verified.
 *
 * Only verified managers are offered: guessing an invocation would generate
 * adapter content that fails at the moment a user actually needs it to work.
 */
export type PackageManager = "npm" | "bun";
export const PACKAGE_MANAGERS = ["npm", "bun"] as const;

/**
 * The schema `sddx init` writes. Bumped when a key's meaning changes, not when
 * one is added — an added key resolves to its default under an older reader.
 */
export const CONFIG_SCHEMA_VERSION = "1.0";

/** The node-count ceiling above which `auto` arms the approval gate anyway. */
export const DEFAULT_AUTO_MAX_TASKS = 6;

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

const asMode = (v: unknown): InteractionMode | null =>
  typeof v === "string" && (INTERACTION_MODES as readonly string[]).includes(v)
    ? (v as InteractionMode)
    : null;

/**
 * `.sddx/config.json` ONLY — deliberately no CLI flag and no environment
 * override, breaking the ladder every other key follows.
 *
 * The reason is the threat model this gate exists for. A CLI flag and an inline
 * `VAR=value` prefix are both part of the command line the agent composes, so
 * honoring either would let the thing the gate constrains switch the gate off:
 * `sddx graph create … --mode auto` would silently satisfy a user who
 * configured `human`. Config is a committed file a human edits, and it is the
 * only source a gate decision may trust. For unattended CI, commit
 * `interaction_mode: "auto"` — reviewable, unlike an env var.
 *
 * An invalid or unreadable value resolves to `human`, never `auto`.
 */
export function interactionMode(root: string): InteractionMode {
  const cfg = readConfig(root);
  // The new name wins, and it wins even when its value is junk: a PRESENT
  // `interaction_mode` is the answer, so a typo resolves to `human` rather than
  // falling through to a stale `execution_mode: "auto"` left behind by the
  // rename. Falling through would make an unreadable value resolve to `auto` —
  // the one thing this key documents it never does.
  if (cfg.interaction_mode !== undefined) return asMode(cfg.interaction_mode) ?? "human";
  // Absent entirely: the legacy key is still read so a checkout configured
  // before the rename keeps its mode rather than silently falling back to
  // `human` — a silent fallback would be safe but would also mean an unattended
  // CI run mysteriously starts asking for approval.
  return asMode(cfg.execution_mode) ?? "human";
}

/** The gate's mode. Same config-only resolution as `interactionMode`; the alias
 * exists so gate call sites read as what they are. */
export const gateInteractionMode = interactionMode;

/**
 * `.sddx/config.json` only, for the same reason as `interactionMode`: raising the
 * ceiling widens how much unattended work self-approves, so an environment
 * override would be a second way for the agent to buy itself blast radius.
 */
export function autoMaxTasks(root: string): number {
  return positiveInt(readConfig(root).auto_max_tasks) ?? DEFAULT_AUTO_MAX_TASKS;
}

const KNOWN_AGENT_ROLES = ["intake", "orchestrator", "planner", "tddExecutor", "verifier"] as const;

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
  test_globs: string;
  exempt_globs: string;
  max_iterations_default: number;
  board_enabled: boolean;
  oracle_runs_default: number;
  red_bash_allow: string;
  stuck_threshold: number;
  pr_host: "gh" | "glab" | null;
  agent_model: Record<string, string>;
  verbose: boolean;
  interaction_mode: InteractionMode;
  auto_max_tasks: number;
  runtime_scope: RuntimeScope;
  package_manager: PackageManager;
  adapters: string[];
  schema_version: string | null;
}

const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

const asRuntimeScope = (v: unknown): RuntimeScope | null =>
  typeof v === "string" && (RUNTIME_SCOPES as readonly string[]).includes(v)
    ? (v as RuntimeScope)
    : null;

const asPackageManager = (v: unknown): PackageManager | null =>
  typeof v === "string" && (PACKAGE_MANAGERS as readonly string[]).includes(v)
    ? (v as PackageManager)
    : null;

/** Every config key, fully resolved (env/config/default precedence applied),
 * for `sddx config show` and any caller that wants the whole picture at once. */
export function resolveConfig(root: string, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const cfg = readConfig(root);
  return {
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
    verbose: resolveValue({ configValue: cfg.verbose, configParse: bool, fallback: false }),
    // both config-only by design — see interactionMode()
    interaction_mode: interactionMode(root),
    auto_max_tasks: autoMaxTasks(root),
    // Bootstrap policy: config-file-only, like interaction_mode. An env var
    // here would let a caller change which sddx a generated adapter invokes,
    // which is the one thing the resolver exists to make reproducible.
    runtime_scope: asRuntimeScope(cfg.runtime_scope) ?? "global",
    package_manager: asPackageManager(cfg.package_manager) ?? "npm",
    adapters: Array.isArray(cfg.adapters) ? cfg.adapters.filter((a) => typeof a === "string") : [],
    schema_version: typeof cfg.schema_version === "string" ? cfg.schema_version : null,
  };
}

const isString = (v: unknown): boolean => typeof v === "string";
const isBoolean = (v: unknown): boolean => typeof v === "boolean";
const isPositiveInt = (v: unknown): boolean => positiveInt(v) !== null;
const isOneOf =
  (values: readonly string[]) =>
  (v: unknown): boolean =>
    typeof v === "string" && (values as readonly string[]).includes(v);

/** One configuration key, fully described. */
export interface ConfigKeySpec {
  key: string;
  /** Enforces the same domain rule the corresponding resolver applies. */
  isValid: (v: unknown) => boolean;
  /** Human phrasing of that rule, used in warnings: `must be <expectation>`. */
  expectation: string;
  /** The value that applies when the key is absent. */
  default: string | number | boolean;
  /** Short label, shown when `sddx init` asks about the key. */
  title: string;
  description: string;
  /** Deprecated compatibility spellings are validated but never offered. */
  deprecated?: boolean;
}

/**
 * The full known-key schema, owned by the CLI.
 *
 * This is the single description of sddx's configuration surface: the
 * validator, `sddx config show`, and `sddx init`'s prompts all read it. It
 * previously lived in the plugin manifest's `userConfig` block, where an AI
 * harness prompted for it at plugin-enable time — which made a harness the
 * source of a project's policy. Configuration is now authored by `sddx init`
 * into `.sddx/config.json` and no manifest is read to determine what a key is.
 *
 * `isValid` enforces the domain rule, not just JS `typeof` — so a
 * structurally-valid-but-out-of-range value (`stuck_threshold: -2`) is caught
 * here instead of silently falling back to its default at resolution time with
 * nothing telling the user why. `KNOWN_CONFIG_KEYS` is derived from this list
 * so the two can never drift.
 */
export const CONFIG_KEYS: readonly ConfigKeySpec[] = [
  {
    key: "test_globs",
    isValid: isString,
    expectation: "a string",
    default: "",
    title: "Test globs",
    description: "Space-separated extra globs classified as test files by the TDD gate",
  },
  {
    key: "exempt_globs",
    isValid: isString,
    expectation: "a string",
    default: "",
    title: "Exempt globs",
    description: "Space-separated extra globs exempt from the RED-phase write block",
  },
  {
    key: "max_iterations_default",
    isValid: isPositiveInt,
    expectation: "a positive integer",
    default: 5,
    title: "Max iterations",
    description: "Default stop rule: max loop iterations per task",
  },
  {
    key: "board_enabled",
    isValid: isBoolean,
    expectation: "a boolean",
    default: true,
    title: "Board enabled",
    description: "Regenerate .sddx/BOARD.md automatically",
  },
  {
    key: "oracle_runs_default",
    isValid: isPositiveInt,
    expectation: "a positive integer",
    default: 1,
    title: "Oracle runs",
    description:
      "How many times verify executes the oracle; every run must pass (flakiness detection)",
  },
  {
    key: "red_bash_allow",
    isValid: isString,
    expectation: "a string",
    default: "",
    title: "RED Bash allow-list",
    description:
      "Space-separated extra commands the RED-phase Bash gate allows (extends the built-in list, never replaces it)",
  },
  {
    key: "stuck_threshold",
    isValid: isPositiveInt,
    expectation: "a positive integer",
    default: 3,
    title: "Stuck threshold",
    description:
      "Consecutive identical test failures before a task is flagged stuck and escalation is requested",
  },
  {
    key: "pr_host",
    isValid: isOneOf(["gh", "glab"]),
    expectation: "one of gh|glab",
    default: "",
    title: "PR host",
    description:
      "PR-host CLI for `sddx pr create`: gh | glab. Empty auto-detects from the origin remote",
  },
  {
    key: "agent_model",
    isValid: isString,
    expectation: "a string",
    default: "",
    title: "Agent model overrides",
    description:
      "Comma-separated role=model pairs (roles: orchestrator, planner, tddExecutor, verifier) — advisory, read by /sddx:run when dispatching subagents",
  },
  {
    key: "verbose",
    isValid: isBoolean,
    expectation: "a boolean",
    default: false,
    title: "Verbose CLI output",
    description:
      "When true, sddx config show also prints which source (env var, .sddx/config.json, or built-in default) resolved each key",
  },
  {
    key: "interaction_mode",
    isValid: isOneOf(INTERACTION_MODES),
    expectation: `one of ${INTERACTION_MODES.join("|")}`,
    default: "human",
    title: "Interaction mode",
    description:
      "Whether a human is consulted before anything is created: human (one question round, then plan approval) | auto (unattended up to the run branch, refusing rather than prompting at any autonomy bound)",
  },
  {
    key: "execution_mode",
    isValid: isOneOf(INTERACTION_MODES),
    expectation: `one of ${INTERACTION_MODES.join("|")}`,
    default: "human",
    title: "Interaction mode (deprecated spelling)",
    description: "Renamed to interaction_mode. Still read; never written.",
    deprecated: true,
  },
  {
    key: "auto_max_tasks",
    isValid: isPositiveInt,
    expectation: "a positive integer",
    default: DEFAULT_AUTO_MAX_TASKS,
    title: "Auto-mode task ceiling",
    description: "In auto mode, a plan with more nodes than this is refused rather than run",
  },
  {
    key: "runtime_scope",
    isValid: isOneOf(RUNTIME_SCOPES),
    expectation: `one of ${RUNTIME_SCOPES.join("|")}`,
    default: "global",
    title: "Runtime scope",
    description:
      "How generated adapter content invokes sddx: global (an `sddx` on PATH) | project (a lockfile-backed project dependency run through the package manager)",
  },
  {
    key: "package_manager",
    isValid: isOneOf(PACKAGE_MANAGERS),
    expectation: `one of ${PACKAGE_MANAGERS.join("|")}`,
    default: "npm",
    title: "Package manager",
    description: "Which package manager runs the project-local binary when runtime_scope=project",
  },
  {
    key: "adapters",
    isValid: (v) => Array.isArray(v) && v.every((a) => typeof a === "string"),
    expectation: "an array of strings",
    default: "",
    title: "Enabled adapters",
    description: "Project adapters `sddx init`/`sync` maintain (currently: claude)",
  },
  {
    key: "schema_version",
    isValid: isString,
    expectation: "a string",
    default: CONFIG_SCHEMA_VERSION,
    title: "Config schema version",
    description: "The config schema this file was written against",
  },
];

export const KNOWN_CONFIG_KEYS: ReadonlySet<string> = new Set(CONFIG_KEYS.map((k) => k.key));

/**
 * Keys that were real and are now gone, each with what to do instead.
 *
 * These are reported BY NAME rather than as a generic "unrecognized key",
 * because the two mean different things to whoever is reading the warning: an
 * unrecognized key is probably a typo, while a removed key is a setting that
 * used to work and silently stopped. A user who set `workspace_mode: "branch"`
 * needs to know their isolation strategy changed, not that they misspelled
 * something.
 *
 * Neither key changes behavior any more — worktree is the invariant and there
 * is no solo path to prefer — so this is a notice, never a hard failure.
 */
const REMOVED_CONFIG_KEYS: ReadonlyMap<string, string> = new Map([
  [
    "workspace_mode",
    "removed in sddx 4.0 — worktree is the only workspace strategy, so there is nothing to select. Remove the key; runs are unaffected.",
  ],
  [
    "prefer_solo",
    "removed in sddx 4.0 along with `--solo` and `/sddx:quick` — a trivial task is a one-node `/sddx:run`. Remove the key; runs are unaffected.",
  ],
]);

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
    const removed = REMOVED_CONFIG_KEYS.get(key);
    if (removed !== undefined) {
      warnings.push(`"${key}" ${removed}`);
      continue;
    }
    if (!KNOWN_CONFIG_KEYS.has(key)) warnings.push(`unrecognized key "${key}"`);
  }
  for (const { key, isValid, expectation } of CONFIG_KEYS) {
    if (key in obj && !isValid(obj[key])) {
      warnings.push(`"${key}" must be ${expectation} — got ${JSON.stringify(obj[key])}`);
    }
  }
  // A file written by a NEWER sddx is reported, never rewritten: silently
  // upgrading a config as a side effect of an unrelated command would edit
  // reviewed policy without review. `sddx init` is how policy changes.
  const version = obj.schema_version;
  if (typeof version === "string" && version !== CONFIG_SCHEMA_VERSION) {
    warnings.push(
      `"schema_version" is "${version}" but this sddx writes "${CONFIG_SCHEMA_VERSION}" — re-run \`sddx init\` to reconcile it`,
    );
  }
  if (typeof obj.agent_model === "string") {
    warnings.push(...parseAgentModel(obj.agent_model).warnings);
  }
  // Read, but named for what it is. The key is still honored, so this is a
  // rename notice rather than a failure — and it names the replacement, since
  // a warning that does not say what to do instead is just noise.
  if ("execution_mode" in obj) {
    warnings.push(
      obj.interaction_mode === undefined
        ? '"execution_mode" has been renamed to "interaction_mode" — the old name is still read, rename it to silence this'
        : '"execution_mode" is ignored because "interaction_mode" is also set — remove the old key',
    );
  }
  return warnings;
}
