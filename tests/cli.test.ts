import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureClone, fixtureRepo } from "./fixtures";
import { fakeRedCheck, repoRoot } from "./helpers";

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string }
).version;

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

  test("cleanup accepts a shipped marker corroborated by its goal file", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "spec.yaml"), SPEC);
    const id = /created (\S+)/.exec(
      cli(cwd, "task", "create", "--spec", "spec.yaml", "--workspace", "branch").stdout,
    )![1]!;
    cli(cwd, "task", "phase", id, "RED", "--test-exit", "1");
    cli(cwd, "task", "phase", id, "GREEN", "--test-exit", "0");
    cli(cwd, "task", "phase", id, "VERIFY");
    fakeRedCheck(cwd, id);
    expect(cli(cwd, "verify", id).status).toBe(0);
    spawnSync("git", ["switch", "-q", "main"], { cwd });

    // not merged by ancestry (no merge happened) — refused, same as always
    expect(cli(cwd, "cleanup", id).status).toBe(1);

    // a real goal, shipped — this is the corroborating record `cleanup` checks.
    // `goal create` now commits the goal file itself (state is files in git),
    // so the shipped-marker edit below must be committed too, the same way
    // `pr create` commits it — an uncommitted edit would block the branch
    // switch that follows (git refuses to discard local changes on checkout).
    const goalCreated = cli(cwd, "goal", "create", "--goal", "Ship it", "--tasks", id);
    const goalId = /created goal (\S+)/.exec(goalCreated.stdout)![1]!;
    const prUrl = "https://github.com/org/repo/pull/1";
    const goalFile = join(cwd, ".sddx", "goals", `${goalId}.json`);
    const g = JSON.parse(readFileSync(goalFile, "utf8"));
    g.shipped = { pr_url: prUrl, at: new Date().toISOString() };
    writeFileSync(goalFile, `${JSON.stringify(g, null, 2)}\n`);
    spawnSync("git", ["add", "--", goalFile], { cwd });
    spawnSync("git", ["commit", "-qm", "mark goal shipped"], { cwd });

    // simulate what `pr create` does after cherry-picking this task's commit
    // into that goal PR: a shipped-marker commit on the task's own branch
    spawnSync("git", ["switch", "-q", `sddx/${id}`], { cwd });
    const taskFile = join(cwd, ".sddx", "tasks", `${id}.json`);
    const t = JSON.parse(readFileSync(taskFile, "utf8"));
    t.shipped = { goal_id: goalId, pr_url: prUrl, at: new Date().toISOString() };
    writeFileSync(taskFile, `${JSON.stringify(t, null, 2)}\n`);
    // scoped add: `-A` would also sweep the still-uncommitted goal file (it
    // carries over across the branch switch) onto the task's own branch and
    // strand it there once we switch back to main
    spawnSync("git", ["add", taskFile], { cwd });
    spawnSync("git", ["commit", "-qm", "mark shipped"], { cwd });
    spawnSync("git", ["switch", "-q", "main"], { cwd });

    const ok = cli(cwd, "cleanup", id);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain(`shipped in goal ${goalId}`);
    expect(
      spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/sddx/${id}`], { cwd })
        .status,
    ).not.toBe(0);
  });

  test("cleanup refuses a shipped marker with no corroborating goal record", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "spec.yaml"), SPEC);
    const id = /created (\S+)/.exec(
      cli(cwd, "task", "create", "--spec", "spec.yaml", "--workspace", "branch").stdout,
    )![1]!;
    cli(cwd, "task", "phase", id, "RED", "--test-exit", "1");
    cli(cwd, "task", "phase", id, "GREEN", "--test-exit", "0");
    cli(cwd, "task", "phase", id, "VERIFY");
    fakeRedCheck(cwd, id);
    expect(cli(cwd, "verify", id).status).toBe(0);

    // a fabricated (or stale) shipped marker with no matching goal file —
    // e.g. a hand-edited task file, or a goal id that was never shipped
    spawnSync("git", ["switch", "-q", `sddx/${id}`], { cwd });
    const taskFile = join(cwd, ".sddx", "tasks", `${id}.json`);
    const t = JSON.parse(readFileSync(taskFile, "utf8"));
    t.shipped = {
      goal_id: "20260719-nonexistent-goal",
      pr_url: "https://github.com/org/repo/pull/999",
      at: new Date().toISOString(),
    };
    writeFileSync(taskFile, `${JSON.stringify(t, null, 2)}\n`);
    spawnSync("git", ["add", "-A"], { cwd });
    spawnSync("git", ["commit", "-qm", "mark shipped"], { cwd });
    spawnSync("git", ["switch", "-q", "main"], { cwd });

    const refused = cli(cwd, "cleanup", id);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("not merged into HEAD");
    expect(
      spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/sddx/${id}`], { cwd })
        .status,
    ).toBe(0);
  });

  test("goal create + goal show round-trip via the CLI", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "spec.yaml"), SPEC);
    const id = /created (\S+)/.exec(
      cli(cwd, "task", "create", "--spec", "spec.yaml", "--no-branch").stdout,
    )![1]!;
    const created = cli(cwd, "goal", "create", "--goal", "Ship the greet feature", "--tasks", id);
    expect(created.status).toBe(0);
    const goalIdMatch = /created goal (\S+)/.exec(created.stdout)![1]!;
    const shown = cli(cwd, "goal", "show", goalIdMatch);
    expect(shown.status).toBe(0);
    expect(JSON.parse(shown.stdout).task_ids).toEqual([id]);
  });

  test("pr create usage error exits 2 without --goal", () => {
    const cwd = fixtureRepo();
    expect(cli(cwd, "pr", "create").status).toBe(2);
  });

  test("usage errors exit 2", () => {
    const cwd = fixtureRepo();
    expect(cli(cwd, "frobnicate").status).toBe(2);
    expect(cli(cwd, "task").status).toBe(2);
    expect(cli(cwd, "task", "create", "--spec", "x.yaml", "--workspace", "bogus").status).toBe(2);
  });

  test("--version and -v print the package version outside a git repository", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sddx-nongit-"));
    for (const flag of ["--version", "-v"]) {
      const r = cli(cwd, flag);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(PACKAGE_VERSION);
    }
  });

  test("--help and -h print usage and exit 0", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sddx-nongit-"));
    for (const flag of ["--help", "-h"]) {
      const r = cli(cwd, flag);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("usage:");
      expect(r.stdout).toContain("sddx task create");
    }
  });
});
