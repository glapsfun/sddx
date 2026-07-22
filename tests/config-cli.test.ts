import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureRepo } from "./fixtures";
import { repoRoot } from "./helpers";

const CLI_SRC = join(repoRoot, "src/cli.ts");

function cli(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync("bun", [CLI_SRC, ...args], { cwd, encoding: "utf8", env });
}

function withConfig(cwd: string, config: Record<string, unknown>): void {
  mkdirSync(join(cwd, ".sddx"), { recursive: true });
  writeFileSync(join(cwd, ".sddx", "config.json"), JSON.stringify(config));
}

describe("sddx config show", () => {
  test("defaults with no .sddx/config.json", () => {
    const cwd = fixtureRepo();
    const r = cli(cwd, process.env, "config", "show", "--json");
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toMatchObject({
      workspace_mode: "auto",
      stuck_threshold: 3,
      oracle_runs_default: 1,
      board_enabled: true,
      pr_host: null,
      agent_model: {},
      prefer_solo: false,
      verbose: false,
    });
  });

  test("env var overrides config.json", () => {
    const cwd = fixtureRepo();
    withConfig(cwd, { stuck_threshold: 9 });
    const r = cli(cwd, { ...process.env, SDDX_STUCK_THRESHOLD: "12" }, "config", "show", "--json");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).stuck_threshold).toBe(12);
  });

  test("agent_model parsed for human-readable output", () => {
    const cwd = fixtureRepo();
    withConfig(cwd, { agent_model: "verifier=opus" });
    const r = cli(cwd, process.env, "config", "show");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("agent_model: verifier=opus");
  });

  test("verbose=false prints no resolution detail", () => {
    const cwd = fixtureRepo();
    const r = cli(cwd, process.env, "config", "show");
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("resolution detail");
  });

  test("verbose=true names the source that won for each key", () => {
    const cwd = fixtureRepo();
    withConfig(cwd, { verbose: true, stuck_threshold: 9 });
    const r = cli(cwd, { ...process.env, SDDX_ORACLE_RUNS: "2" }, "config", "show");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("resolution detail (verbose):");
    expect(r.stdout).toContain("stuck_threshold: source=config");
    expect(r.stdout).toContain("oracle_runs_default: source=env");
    expect(r.stdout).toContain("red_bash_allow: source=default");
  });
});

describe("sddx config validate", () => {
  test("no config file: reports and exits 0", () => {
    const cwd = fixtureRepo();
    const r = cli(cwd, process.env, "config", "validate");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no .sddx/config.json");
  });

  test("valid config: OK, exits 0", () => {
    const cwd = fixtureRepo();
    withConfig(cwd, { stuck_threshold: 4 });
    const r = cli(cwd, process.env, "config", "validate");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("OK");
  });

  test("unknown key and wrong type: warns, still exits 0", () => {
    const cwd = fixtureRepo();
    withConfig(cwd, { bogus_key: 1, oracle_runs_default: "not-a-number" });
    const r = cli(cwd, process.env, "config", "validate");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('unrecognized key "bogus_key"');
    expect(r.stdout).toContain('"oracle_runs_default" must be a positive integer');
  });

  test("structurally-valid but out-of-range/typo'd values are flagged, not silently defaulted", () => {
    const cwd = fixtureRepo();
    withConfig(cwd, { stuck_threshold: -2, workspace_mode: "worktrees" });
    const r = cli(cwd, process.env, "config", "validate");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"stuck_threshold" must be a positive integer — got -2');
    expect(r.stdout).toContain(
      '"workspace_mode" must be one of auto|worktree|branch|none — got "worktrees"',
    );
  });

  test("malformed JSON: fails loudly", () => {
    const cwd = fixtureRepo();
    mkdirSync(join(cwd, ".sddx"), { recursive: true });
    writeFileSync(join(cwd, ".sddx", "config.json"), "{not json");
    const r = cli(cwd, process.env, "config", "validate");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("not valid JSON");
  });
});
