import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  autoMaxTasks,
  boardEnabled,
  CONFIG_KEYS,
  CONFIG_SCHEMA_VERSION,
  gateInteractionMode,
  interactionMode,
  KNOWN_CONFIG_KEYS,
  oracleRuns,
  parseAgentModel,
  resolveConfig,
  resolveValue,
  stuckThreshold,
  validateConfigObject,
} from "../src/lib/config";
import { fixtureRepo } from "./fixtures";
import { repoRoot } from "./helpers";

function withConfig(cwd: string, config: Record<string, unknown>): void {
  mkdirSync(join(cwd, ".sddx"), { recursive: true });
  writeFileSync(join(cwd, ".sddx", "config.json"), JSON.stringify(config));
}

describe("resolveValue", () => {
  test("cliValue beats env beats config beats fallback", () => {
    const env = { FOO: "10" };
    expect(
      resolveValue({
        cliValue: 1,
        env,
        envVar: "FOO",
        envParse: Number,
        configValue: 100,
        fallback: 999,
      }),
    ).toBe(1);
    expect(
      resolveValue({ env, envVar: "FOO", envParse: Number, configValue: 100, fallback: 999 }),
    ).toBe(10);
    expect(resolveValue({ env: {}, envVar: "FOO", configValue: 100, fallback: 999 })).toBe(100);
    expect(resolveValue({ env: {}, envVar: "FOO", fallback: 999 })).toBe(999);
  });

  test("a value that fails to parse falls through to the next source", () => {
    const env = { FOO: "not-a-number" };
    expect(
      resolveValue({
        env,
        envVar: "FOO",
        envParse: (raw) => (Number.isNaN(Number(raw)) ? null : Number(raw)),
        configValue: 42,
        fallback: 999,
      }),
    ).toBe(42);
  });
});

describe("stuckThreshold / oracleRuns / boardEnabled precedence (unchanged)", () => {
  test("stuckThreshold: env > config > default 3", () => {
    const cwd = fixtureRepo();
    expect(stuckThreshold(cwd, {})).toBe(3);
    withConfig(cwd, { stuck_threshold: 5 });
    expect(stuckThreshold(cwd, {})).toBe(5);
    expect(stuckThreshold(cwd, { SDDX_STUCK_THRESHOLD: "7" })).toBe(7);
  });

  test("oracleRuns: spec > env > config > default 1", () => {
    const cwd = fixtureRepo();
    expect(oracleRuns(cwd, undefined, {})).toBe(1);
    withConfig(cwd, { oracle_runs_default: 2 });
    expect(oracleRuns(cwd, undefined, {})).toBe(2);
    expect(oracleRuns(cwd, undefined, { SDDX_ORACLE_RUNS: "4" })).toBe(4);
    expect(oracleRuns(cwd, 9, { SDDX_ORACLE_RUNS: "4" })).toBe(9);
    // a tampered/invalid spec value must not disable the oracle
    expect(oracleRuns(cwd, 0, { SDDX_ORACLE_RUNS: "4" })).toBe(4);
  });

  test("boardEnabled: env > config > default true", () => {
    const cwd = fixtureRepo();
    expect(boardEnabled(cwd, {})).toBe(true);
    withConfig(cwd, { board_enabled: false });
    expect(boardEnabled(cwd, {})).toBe(false);
    expect(boardEnabled(cwd, { SDDX_BOARD_ENABLED: "true" })).toBe(true);
  });
});

describe("parseAgentModel", () => {
  test("valid pairs parsed", () => {
    const { models, warnings } = parseAgentModel("tddExecutor=opus,verifier=sonnet");
    expect(models).toEqual({ tddExecutor: "opus", verifier: "sonnet" });
    expect(warnings).toHaveLength(0);
  });

  test("malformed segment dropped, valid pairs kept, warning recorded", () => {
    const { models, warnings } = parseAgentModel("tddExecutor=opus,not-a-pair,verifier=sonnet");
    expect(models).toEqual({ tddExecutor: "opus", verifier: "sonnet" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not-a-pair");
  });

  test("unknown role dropped", () => {
    const { models, warnings } = parseAgentModel("madeUpRole=opus");
    expect(models).toEqual({});
    expect(warnings).toHaveLength(1);
  });

  test("empty/undefined input yields no models, no warnings", () => {
    expect(parseAgentModel(undefined)).toEqual({ models: {}, warnings: [] });
    expect(parseAgentModel("")).toEqual({ models: {}, warnings: [] });
  });
});

describe("interaction mode config", () => {
  test("interactionMode reads .sddx/config.json only — config > default human", () => {
    const cwd = fixtureRepo();
    expect(interactionMode(cwd)).toBe("human");
    withConfig(cwd, { interaction_mode: "auto" });
    expect(interactionMode(cwd)).toBe("auto");
  });

  test("SECURITY: the environment cannot switch the mode", () => {
    // An inline `SDDX_INTERACTION_MODE=auto sddx …` is part of the command line
    // the agent composes, so honoring it would let the thing the gate constrains
    // switch the gate off. Config — a committed file a human edits — is the only
    // trusted source. Same for the ceiling: raising it buys blast radius.
    // Neither the new name nor the legacy one is honored.
    const cwd = fixtureRepo();
    withConfig(cwd, { interaction_mode: "human", auto_max_tasks: 2 });
    process.env.SDDX_INTERACTION_MODE = "auto";
    process.env.SDDX_EXECUTION_MODE = "auto";
    process.env.SDDX_AUTO_MAX_TASKS = "999";
    try {
      expect(interactionMode(cwd)).toBe("human");
      expect(autoMaxTasks(cwd)).toBe(2);
      expect(gateInteractionMode(cwd)).toBe("human");
    } finally {
      delete process.env.SDDX_INTERACTION_MODE;
      delete process.env.SDDX_EXECUTION_MODE;
      delete process.env.SDDX_AUTO_MAX_TASKS;
    }
  });

  test("an unrecognized mode resolves to human, never auto", () => {
    const cwd = fixtureRepo();
    withConfig(cwd, { interaction_mode: "yolo" });
    expect(interactionMode(cwd)).toBe("human");
  });

  test("an absent value never yields auto", () => {
    const cwd = fixtureRepo();
    expect(interactionMode(cwd)).toBe("human");
    withConfig(cwd, {});
    expect(interactionMode(cwd)).toBe("human");
  });

  test("an unrecognized mode is reported by config validation", () => {
    expect(validateConfigObject({ interaction_mode: "yolo" }).join("\n")).toContain(
      "interaction_mode",
    );
    expect(validateConfigObject({ interaction_mode: "auto" })).toHaveLength(0);
    expect(validateConfigObject({ interaction_mode: "human" })).toHaveLength(0);
  });

  test("autoMaxTasks: config > default, positive integers only", () => {
    const cwd = fixtureRepo();
    expect(autoMaxTasks(cwd)).toBe(6);
    withConfig(cwd, { auto_max_tasks: 3 });
    expect(autoMaxTasks(cwd)).toBe(3);
    // out-of-domain values fall through rather than throwing
    withConfig(cwd, { auto_max_tasks: 0 });
    expect(autoMaxTasks(cwd)).toBe(6);
    withConfig(cwd, { auto_max_tasks: -2 });
    expect(autoMaxTasks(cwd)).toBe(6);
  });

  test("auto_max_tasks domain reported by config validation", () => {
    expect(validateConfigObject({ auto_max_tasks: 0 }).join("\n")).toContain("auto_max_tasks");
    expect(validateConfigObject({ auto_max_tasks: -1 }).join("\n")).toContain("auto_max_tasks");
    expect(validateConfigObject({ auto_max_tasks: 4 })).toHaveLength(0);
  });

  test("both keys appear fully resolved in resolveConfig", () => {
    const cwd = fixtureRepo();
    expect(resolveConfig(cwd, {}).interaction_mode).toBe("human");
    expect(resolveConfig(cwd, {}).auto_max_tasks).toBe(6);
    // config show must display what the gate actually uses
    withConfig(cwd, { interaction_mode: "human" });
    expect(resolveConfig(cwd, { SDDX_INTERACTION_MODE: "auto" }).interaction_mode).toBe("human");
    withConfig(cwd, { interaction_mode: "auto", auto_max_tasks: 2 });
    expect(resolveConfig(cwd, {}).interaction_mode).toBe("auto");
    expect(resolveConfig(cwd, {}).auto_max_tasks).toBe(2);
  });
});

// `execution_mode` → `interaction_mode`. The security property the new name
// describes was always the point: the key decides whether a plan needs a human
// at all, which is about the interaction, not about how execution proceeds.
describe("interaction_mode (renamed from execution_mode)", () => {
  test("the new key is read", () => {
    const cwd = fixtureRepo();
    withConfig(cwd, { interaction_mode: "auto" });
    expect(interactionMode(cwd)).toBe("auto");
  });

  test("the legacy key is still read, so an existing checkout keeps working", () => {
    const cwd = fixtureRepo();
    withConfig(cwd, { execution_mode: "auto" });
    expect(interactionMode(cwd)).toBe("auto");
  });

  test("the legacy key warns, naming its replacement", () => {
    const warnings = validateConfigObject({ execution_mode: "auto" });
    expect(warnings.join("\n")).toContain("execution_mode");
    expect(warnings.join("\n")).toContain("interaction_mode");
  });

  test("the new key warns about nothing", () => {
    expect(validateConfigObject({ interaction_mode: "auto" })).toHaveLength(0);
    expect(validateConfigObject({ interaction_mode: "human" })).toHaveLength(0);
  });

  test("the new key wins when both are present", () => {
    const cwd = fixtureRepo();
    withConfig(cwd, { execution_mode: "auto", interaction_mode: "human" });
    expect(interactionMode(cwd)).toBe("human");
  });

  test("an invalid value resolves to human, never auto — in either key", () => {
    const cwd = fixtureRepo();
    withConfig(cwd, { interaction_mode: "yolo" });
    expect(interactionMode(cwd)).toBe("human");
    withConfig(cwd, { execution_mode: "yolo" });
    expect(interactionMode(cwd)).toBe("human");
  });

  test("an invalid new key does not fall through to a stale legacy auto", () => {
    // The half-finished rename: the key was renamed, its value mistyped, and
    // the old line left behind. Falling through resolved the gate to `auto` —
    // so a user who believes they are in human mode, and whom validation tells
    // the legacy key is ignored, gets a plan that self-approves.
    const cwd = fixtureRepo();
    withConfig(cwd, { interaction_mode: "manual", execution_mode: "auto" });
    expect(interactionMode(cwd)).toBe("human");
  });

  test("resolved config reports the new name only", () => {
    const cwd = fixtureRepo();
    withConfig(cwd, { execution_mode: "auto" });
    const resolved = resolveConfig(cwd, {}) as unknown as Record<string, unknown>;
    expect(resolved.interaction_mode).toBe("auto");
    expect(resolved.execution_mode).toBeUndefined();
  });

  test("neither key is settable by environment variable", () => {
    const cwd = fixtureRepo();
    withConfig(cwd, { interaction_mode: "human" });
    expect(
      resolveConfig(cwd, { SDDX_INTERACTION_MODE: "auto", SDDX_EXECUTION_MODE: "auto" })
        .interaction_mode,
    ).toBe("human");
  });
});

describe("CLI-owned config schema", () => {
  test("every recognized key comes from the CLI schema, not a plugin manifest", () => {
    // The schema used to live in .claude-plugin/plugin.json#userConfig, where a
    // harness prompted for it at enable time. Nothing may read a manifest to
    // learn what a key is.
    const keys = CONFIG_KEYS.map((k) => k.key);
    expect(new Set(keys)).toEqual(new Set(KNOWN_CONFIG_KEYS));
    for (const spec of CONFIG_KEYS) {
      expect(spec.title.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeGreaterThan(0);
    }
    // No manifest path is read to learn what a key is. (The doc comment may
    // still *mention* the retired userConfig block — explaining the history is
    // the point; reading the file is what must not happen.)
    const configSource = readFileSync(join(repoRoot, "src/lib/config.ts"), "utf8");
    expect(configSource).not.toContain(".claude-plugin");
    expect(configSource).not.toContain("plugin.json");
  });

  test("bootstrap policy keys resolve to their defaults when absent", () => {
    const cwd = fixtureRepo();
    const cfg = resolveConfig(cwd);
    expect(cfg.runtime_scope).toBe("global");
    expect(cfg.package_manager).toBe("npm");
    expect(cfg.adapters).toEqual([]);
    expect(cfg.schema_version).toBeNull();
  });

  test("bootstrap policy keys resolve from the config file", () => {
    const cwd = fixtureRepo();
    withConfig(cwd, {
      schema_version: CONFIG_SCHEMA_VERSION,
      runtime_scope: "project",
      package_manager: "bun",
      adapters: ["claude"],
    });
    const cfg = resolveConfig(cwd);
    expect(cfg.runtime_scope).toBe("project");
    expect(cfg.package_manager).toBe("bun");
    expect(cfg.adapters).toEqual(["claude"]);
    expect(cfg.schema_version).toBe(CONFIG_SCHEMA_VERSION);
  });

  test("an environment variable cannot change the runtime scope", () => {
    // Same threat model as interaction_mode: an env var is composable by the
    // agent, and this key decides which sddx a generated adapter invokes.
    const cwd = fixtureRepo();
    withConfig(cwd, { runtime_scope: "project" });
    expect(resolveConfig(cwd, { SDDX_RUNTIME_SCOPE: "global" }).runtime_scope).toBe("project");
  });

  test("an invalid bootstrap value falls back rather than throwing", () => {
    const cwd = fixtureRepo();
    withConfig(cwd, { runtime_scope: "nonsense", package_manager: "pnpm" });
    const cfg = resolveConfig(cwd);
    expect(cfg.runtime_scope).toBe("global");
    expect(cfg.package_manager).toBe("npm");
    // ...and validate names both, so the user is told why they were ignored
    const warnings = validateConfigObject({ runtime_scope: "nonsense", package_manager: "pnpm" });
    expect(warnings.some((w) => w.includes("runtime_scope"))).toBe(true);
    expect(warnings.some((w) => w.includes("package_manager"))).toBe(true);
  });

  test("a stale schema_version is reported, never silently upgraded", () => {
    const cwd = fixtureRepo();
    withConfig(cwd, { schema_version: "0.9" });
    const before = readFileSync(join(cwd, ".sddx", "config.json"), "utf8");

    const warnings = validateConfigObject({ schema_version: "0.9" });
    expect(warnings.some((w) => w.includes("0.9") && w.includes("sddx init"))).toBe(true);

    // reading it changed nothing on disk
    resolveConfig(cwd);
    expect(readFileSync(join(cwd, ".sddx", "config.json"), "utf8")).toBe(before);
  });

  test("a current schema_version produces no warning", () => {
    expect(validateConfigObject({ schema_version: CONFIG_SCHEMA_VERSION })).toEqual([]);
  });
});
