import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureClone, fixtureRepo } from "./fixtures";
import { fakeRedCheck, repoRoot } from "./helpers";

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
    const r = cli(cwd, "task", "create", "--spec", "spec.yaml", "--workspace", "branch");
    expect(r.status).toBe(0);
    const id = /created (\S+)/.exec(r.stdout)![1]!;
    expect(existsSync(join(cwd, ".sddx", "tasks", `${id}.json`))).toBe(true);
    expect(existsSync(join(cwd, ".sddx", "specs", `${id}.yaml`))).toBe(true);
    const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
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
      cli(cwd, "task", "create", "--spec", "spec.yaml", "--workspace", "branch").stdout,
    )![1]!;
    cli(cwd, "task", "phase", id, "RED", "--test-exit", "1");
    cli(cwd, "task", "phase", id, "GREEN", "--test-exit", "0");
    cli(cwd, "task", "phase", id, "VERIFY");
    fakeRedCheck(cwd, id);
    const v = cli(cwd, "verify", id);
    expect(v.status).toBe(0);
    expect(v.stdout).toContain(".sddx/receipts/");

    // cleanup refuses while on the task branch, then works after merge from main
    expect(cli(cwd, "cleanup", id).status).toBe(1);
    spawnSync("git", ["switch", "-q", "main"], { cwd });
    spawnSync("git", ["merge", "-q", "--no-edit", `sddx/${id}`], { cwd });
    expect(cli(cwd, "cleanup", id).status).toBe(0);
  });

  test("default auto workspace creates a worktree from origin/HEAD in a clone", () => {
    const { clone } = fixtureClone();
    writeFileSync(join(clone, "spec.yaml"), SPEC);
    const r = cli(clone, "task", "create", "--spec", "spec.yaml");
    expect(r.status).toBe(0);
    const id = /created (\S+)/.exec(r.stdout)![1]!;
    expect(r.stdout).toContain(`worktree=${join(".sddx-worktrees", id)}`);
    const wt = join(clone, ".sddx-worktrees", id);
    expect(existsSync(join(wt, ".sddx", "tasks", `${id}.json`))).toBe(true);
    // main checkout untouched: still on main, no .sddx, clean status
    const g = (...a: string[]) => spawnSync("git", a, { cwd: clone, encoding: "utf8" }).stdout;
    expect(g("rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    expect(existsSync(join(clone, ".sddx"))).toBe(false);
    expect(g("status", "--porcelain")).not.toContain(".sddx"); // spec.yaml is test scaffolding
    // worktree HEAD equals origin/HEAD
    const wtHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" });
    expect(wtHead.stdout.trim()).toBe(g("rev-parse", "origin/HEAD").trim());
  });

  test("auto downgrades to branch mode when submodules exist, with one notice line", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, ".gitmodules"), '[submodule "x"]\n\tpath = x\n\turl = ./x\n');
    spawnSync("git", ["add", "-A"], { cwd });
    spawnSync("git", ["commit", "-qm", "gitmodules"], { cwd });
    writeFileSync(join(cwd, "spec.yaml"), SPEC);
    const r = cli(cwd, "task", "create", "--spec", "spec.yaml");
    expect(r.status).toBe(0);
    const notices = r.stdout.split("\n").filter((l) => l.includes("branch mode"));
    expect(notices).toEqual(["submodules detected → branch mode"]);
    expect(r.stdout).not.toContain("worktree=");
  });

  test("cleanup refuses a dirty worktree, then removes worktree and merged branch", () => {
    const { clone } = fixtureClone();
    writeFileSync(join(clone, "spec.yaml"), SPEC);
    const id = /created (\S+)/.exec(
      cli(clone, "task", "create", "--spec", "spec.yaml").stdout,
    )![1]!;
    const wt = join(clone, ".sddx-worktrees", id);

    // complete the task inside the worktree
    cli(wt, "task", "phase", id, "RED", "--test-exit", "1");
    cli(wt, "task", "phase", id, "GREEN", "--test-exit", "0");
    cli(wt, "task", "phase", id, "VERIFY");
    fakeRedCheck(wt, id);
    expect(cli(wt, "verify", id).status).toBe(0);

    writeFileSync(join(wt, "dirty.txt"), "x\n");
    const refused = cli(clone, "cleanup", id);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("uncommitted");
    expect(existsSync(join(wt, "dirty.txt"))).toBe(true);

    spawnSync("rm", [join(wt, "dirty.txt")]);
    spawnSync("git", ["merge", "-q", "--no-edit", `sddx/${id}`], { cwd: clone });
    const ok = cli(clone, "cleanup", id);
    expect(ok.status).toBe(0);
    expect(existsSync(wt)).toBe(false);
  });

  test("usage errors exit 2", () => {
    const cwd = fixtureRepo();
    expect(cli(cwd, "frobnicate").status).toBe(2);
    expect(cli(cwd, "task").status).toBe(2);
    expect(cli(cwd, "task", "create", "--spec", "x.yaml", "--workspace", "bogus").status).toBe(2);
  });
});
