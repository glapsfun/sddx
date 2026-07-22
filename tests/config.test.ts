import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  boardEnabled,
  oracleRuns,
  parseAgentModel,
  resolveValue,
  stuckThreshold,
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
