import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  autoMaxTasks,
  boardEnabled,
  executionMode,
  gateExecutionMode,
  oracleRuns,
  parseAgentModel,
  resolveConfig,
  resolveValue,
  stuckThreshold,
  validateConfigObject,
} from "../src/lib/config";
import { fixtureRepo } from "./fixtures";

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

describe("execution mode config", () => {
  test("executionMode reads .sddx/config.json only — config > default human", () => {
    const cwd = fixtureRepo();
    expect(executionMode(cwd)).toBe("human");
    withConfig(cwd, { execution_mode: "auto" });
    expect(executionMode(cwd)).toBe("auto");
  });

  test("SECURITY: the environment cannot switch the mode", () => {
    // An inline `SDDX_EXECUTION_MODE=auto sddx …` is part of the command line the
    // agent composes, so honoring it would let the thing the gate constrains
    // switch the gate off. Config — a committed file a human edits — is the only
    // trusted source. Same for the ceiling: raising it buys blast radius.
    const cwd = fixtureRepo();
    withConfig(cwd, { execution_mode: "human", auto_max_tasks: 2 });
    process.env.SDDX_EXECUTION_MODE = "auto";
    process.env.SDDX_AUTO_MAX_TASKS = "999";
    try {
      expect(executionMode(cwd)).toBe("human");
      expect(autoMaxTasks(cwd)).toBe(2);
      expect(gateExecutionMode(cwd)).toBe("human");
    } finally {
      delete process.env.SDDX_EXECUTION_MODE;
      delete process.env.SDDX_AUTO_MAX_TASKS;
    }
  });

  test("an unrecognized mode resolves to human, never auto", () => {
    const cwd = fixtureRepo();
    withConfig(cwd, { execution_mode: "yolo" });
    expect(executionMode(cwd)).toBe("human");
  });

  test("an absent value never yields auto", () => {
    const cwd = fixtureRepo();
    expect(executionMode(cwd)).toBe("human");
    withConfig(cwd, {});
    expect(executionMode(cwd)).toBe("human");
  });

  test("an unrecognized mode is reported by config validation", () => {
    expect(validateConfigObject({ execution_mode: "yolo" }).join("\n")).toContain("execution_mode");
    expect(validateConfigObject({ execution_mode: "auto" })).toHaveLength(0);
    expect(validateConfigObject({ execution_mode: "human" })).toHaveLength(0);
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
    expect(resolveConfig(cwd, {}).execution_mode).toBe("human");
    expect(resolveConfig(cwd, {}).auto_max_tasks).toBe(6);
    // config show must display what the gate actually uses
    withConfig(cwd, { execution_mode: "human" });
    expect(resolveConfig(cwd, { SDDX_EXECUTION_MODE: "auto" }).execution_mode).toBe("human");
    withConfig(cwd, { execution_mode: "auto", auto_max_tasks: 2 });
    expect(resolveConfig(cwd, {}).execution_mode).toBe("auto");
    expect(resolveConfig(cwd, {}).auto_max_tasks).toBe(2);
  });
});
