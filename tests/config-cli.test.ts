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
    const envelope = JSON.parse(r.stdout);
    expect(envelope.schema_version).toBe("1.0");
    expect(envelope.data).toMatchObject({
      stuck_threshold: 3,
      oracle_runs_default: 1,
      board_enabled: true,
      pr_host: null,
      agent_model: {},
      verbose: false,
    });
    // removed in 4.0 — absent from the resolved shape entirely
    expect(envelope.data.workspace_mode).toBeUndefined();
    expect(envelope.data.prefer_solo).toBeUndefined();
  });

  test("env var overrides config.json", () => {
    const cwd = fixtureRepo();
    withConfig(cwd, { stuck_threshold: 9 });
    const r = cli(cwd, { ...process.env, SDDX_STUCK_THRESHOLD: "12" }, "config", "show", "--json");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).data.stuck_threshold).toBe(12);
  });

  test("--json is a deprecated alias for --output json, with a stderr notice", () => {
    const cwd = fixtureRepo();
    const r = cli(cwd, process.env, "config", "show", "--json");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("--json is deprecated");
    expect(JSON.parse(r.stdout).command).toBe("config show");
  });

  test("--output json matches the --json alias shape", () => {
    const cwd = fixtureRepo();
    const r = cli(cwd, process.env, "config", "show", "--output", "json");
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const envelope = JSON.parse(r.stdout);
    expect(envelope.schema_version).toBe("1.0");
    expect(envelope.data.stuck_threshold).toBe(3);
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

  test("structurally-valid but out-of-range values are flagged, not silently defaulted", () => {
    const cwd = fixtureRepo();
    withConfig(cwd, { stuck_threshold: -2 });
    const r = cli(cwd, process.env, "config", "validate");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"stuck_threshold" must be a positive integer — got -2');
  });

  test("a removed key is named as removed, not as an unrecognized typo", () => {
    // The two mean different things to whoever reads the warning: unrecognized
    // suggests a misspelling, removed means a setting that used to work and
    // silently stopped. A user who set workspace_mode needs the latter.
    const cwd = fixtureRepo();
    withConfig(cwd, { workspace_mode: "branch", prefer_solo: true });
    const r = cli(cwd, process.env, "config", "validate");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"workspace_mode" removed in sddx 4.0');
    expect(r.stdout).toContain("worktree is the only workspace strategy");
    expect(r.stdout).toContain('"prefer_solo" removed in sddx 4.0');
    expect(r.stdout).toContain("one-node");
    // named as removed, NOT as a typo
    expect(r.stdout).not.toContain('unrecognized key "workspace_mode"');
    expect(r.stdout).not.toContain('unrecognized key "prefer_solo"');
  });

  test("a removed key does not change execution behavior", () => {
    // It is a notice, never a failure, and nothing downstream reads it.
    const cwd = fixtureRepo();
    withConfig(cwd, { workspace_mode: "none", prefer_solo: true, stuck_threshold: 7 });
    const shown = cli(cwd, process.env, "config", "show", "--output", "json");
    expect(shown.status).toBe(0);
    const data = JSON.parse(shown.stdout).data;
    // the surviving key still resolves normally alongside the dead ones
    expect(data.stuck_threshold).toBe(7);
    expect(data.workspace_mode).toBeUndefined();
    expect(data.prefer_solo).toBeUndefined();
    expect(cli(cwd, process.env, "config", "validate").status).toBe(0);
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

describe("interaction mode surfaced through the config CLI", () => {
  test("config show reports both keys in json and terminal output", () => {
    const cwd = fixtureRepo();
    const json = cli(cwd, process.env, "config", "show", "--output", "json");
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout).data).toMatchObject({
      interaction_mode: "human",
      auto_max_tasks: 6,
    });

    withConfig(cwd, { interaction_mode: "auto", auto_max_tasks: 2 });
    const term = cli(cwd, process.env, "config", "show");
    expect(term.status).toBe(0);
    expect(term.stdout).toContain("interaction_mode: auto");
    expect(term.stdout).toContain("auto_max_tasks: 2");
  });

  test("config validate reports an out-of-domain mode and ceiling", () => {
    const cwd = fixtureRepo();
    withConfig(cwd, { interaction_mode: "yolo", auto_max_tasks: 0 });
    const r = cli(cwd, process.env, "config", "validate");
    expect(r.stdout + r.stderr).toContain("interaction_mode");
    expect(r.stdout + r.stderr).toContain("auto_max_tasks");
  });

  test("a broken config still resolves to human, never auto", () => {
    const cwd = fixtureRepo();
    mkdirSync(join(cwd, ".sddx"), { recursive: true });
    writeFileSync(join(cwd, ".sddx", "config.json"), "{not json");
    const r = cli(cwd, process.env, "config", "show", "--output", "json");
    expect(JSON.parse(r.stdout).data.interaction_mode).toBe("human");
  });
});
