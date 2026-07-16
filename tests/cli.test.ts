import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fixtureRepo } from "./fixtures";
import { repoRoot } from "./helpers";

const CLI_SRC = join(repoRoot, "src/cli.ts");

function cli(cwd: string, ...args: string[]) {
  return spawnSync("bun", [CLI_SRC, ...args], { cwd, encoding: "utf8" });
}

const SPEC = `task: add greet
success_criteria:
  - greet prints hello
oracle:
  type: command
  run: "exit 0"
`;

describe("sddx cli", () => {
  test("task create validates spec, creates branch, writes state", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "spec.yaml"), SPEC);
    const r = cli(cwd, "task", "create", "--spec", "spec.yaml");
    expect(r.status).toBe(0);
    const id = /created (\S+)/.exec(r.stdout)![1]!;
    expect(existsSync(join(cwd, ".sddx", "tasks", `${id}.json`))).toBe(true);
    expect(existsSync(join(cwd, ".sddx", "specs", `${id}.yaml`))).toBe(true);
    const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd, encoding: "utf8",
    }).stdout.trim();
    expect(branch).toBe(`sddx/${id}`);
  });

  test("task create rejects an oracle-less spec with exit 1", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "bad.yaml"), "task: t\nsuccess_criteria:\n  - a\n");
    const r = cli(cwd, "task", "create", "--spec", "bad.yaml");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("oracle");
  });

  test("phase transitions enforce evidence via flags", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "spec.yaml"), SPEC);
    const id = /created (\S+)/.exec(
      cli(cwd, "task", "create", "--spec", "spec.yaml", "--no-branch").stdout,
    )![1]!;
    expect(cli(cwd, "task", "phase", id, "RED", "--test-exit", "0").status).toBe(1);
    expect(cli(cwd, "task", "phase", id, "RED", "--test-exit", "1").status).toBe(0);
    expect(cli(cwd, "task", "phase", id, "GREEN", "--test-exit", "0").status).toBe(0);
    expect(cli(cwd, "task", "phase", id, "VERIFY").status).toBe(0);
    expect(cli(cwd, "task", "phase", id, "DONE").status).toBe(1); // verifier only
  });

  test("verify pass end-to-end and cleanup guards", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "spec.yaml"), SPEC);
    const id = /created (\S+)/.exec(
      cli(cwd, "task", "create", "--spec", "spec.yaml").stdout,
    )![1]!;
    cli(cwd, "task", "phase", id, "RED", "--test-exit", "1");
    cli(cwd, "task", "phase", id, "GREEN", "--test-exit", "0");
    cli(cwd, "task", "phase", id, "VERIFY");
    const v = cli(cwd, "verify", id);
    expect(v.status).toBe(0);
    expect(v.stdout).toContain(".sddx/receipts/");

    // cleanup refuses while on the task branch, then works after merge from main
    expect(cli(cwd, "cleanup", id).status).toBe(1);
    spawnSync("git", ["switch", "-q", "main"], { cwd });
    spawnSync("git", ["merge", "-q", "--no-edit", `sddx/${id}`], { cwd });
    expect(cli(cwd, "cleanup", id).status).toBe(0);
  });

  test("usage errors exit 2", () => {
    const cwd = fixtureRepo();
    expect(cli(cwd, "frobnicate").status).toBe(2);
    expect(cli(cwd, "task").status).toBe(2);
  });
});
