import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

/** `graph create` now requires an approval token under the default human mode.
 * These tests exercise creation mechanics, so they approve first — the same two
 * steps a user takes — rather than sidestepping the gate with auto mode. */
function approveAndCreate(cwd: string, ...args: string[]) {
  const graphIdx = args.indexOf("--graph");
  const wsIdx = args.indexOf("--workspace");
  // The token records the workspace strategy it was approved for, so approve
  // must be given the same one the create will use.
  const approve = spawnSync(
    "bun",
    [
      CLI_SRC,
      "graph",
      "approve",
      "--graph",
      args[graphIdx + 1],
      ...(wsIdx === -1 ? [] : ["--workspace", args[wsIdx + 1]]),
    ],
    { cwd, encoding: "utf8" },
  );
  if (approve.status !== 0) return approve;
  return cli(cwd, ...args);
}

const SPEC = `task: add greet
success_criteria:
  - greet prints hello
oracle:
  type: command
  run: "exit 0"
`;

/** A two-node graph.yaml + specs where the dependent's scope overlaps its parent's
 * (legal, because the edge orders them). specs live in a subdir of the graph file. */
function mkdtempScopedSpecs(cwd: string): void {
  mkdirSync(join(cwd, "specs"), { recursive: true });
  writeFileSync(
    join(cwd, "specs", "schema.yaml"),
    `task: migrate the schema\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\nscope:\n  - src/db/**\n`,
  );
  writeFileSync(
    join(cwd, "specs", "api.yaml"),
    `task: build the api\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\nscope:\n  - src/db/schema.ts\n`,
  );
  writeFileSync(
    join(cwd, "graph.yaml"),
    "goal: ship the feature\ntasks:\n  - alias: schema\n    spec: specs/schema.yaml\n  - alias: api\n    spec: specs/api.yaml\n    depends_on: schema\n",
  );
}

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

  test("cleanup accepts a task merged into its goal's run branch (real ancestry, no marker)", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "spec.yaml"), SPEC);
    writeFileSync(
      join(cwd, "graph.yaml"),
      "goal: ship it\ntasks:\n  - alias: only\n    spec: spec.yaml\n",
    );
    const created = approveAndCreate(
      cwd,
      "graph",
      "create",
      "--graph",
      "graph.yaml",
      "--workspace",
      "branch",
    );
    expect(created.status).toBe(0);
    const id = /created (\S+) phase=PLAN/.exec(created.stdout)![1]!;

    cli(cwd, "task", "phase", id, "RED", "--test-exit", "1");
    cli(cwd, "task", "phase", id, "GREEN", "--test-exit", "0");
    cli(cwd, "task", "phase", id, "VERIFY");
    fakeRedCheck(cwd, id);
    // verify merges the task's branch into the goal's run branch automatically
    expect(cli(cwd, "verify", id).status).toBe(0);
    spawnSync("git", ["switch", "-q", "main"], { cwd });

    const ok = cli(cwd, "cleanup", id);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("merged into run branch");
    expect(
      spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/sddx/${id}`], { cwd })
        .status,
    ).not.toBe(0);
  });

  test("cleanup refuses a task not merged into HEAD or any goal's run branch", () => {
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

  test("task create --depends-on records a deferred workspace; unknown parent refused", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "spec.yaml"), SPEC);
    const parentId = /created (\S+)/.exec(
      cli(cwd, "task", "create", "--spec", "spec.yaml", "--no-branch").stdout,
    )![1]!;

    writeFileSync(
      join(cwd, "child.yaml"),
      `task: use the greet output\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\nscope:\n  - src/child/**\n`,
    );
    const child = cli(cwd, "task", "create", "--spec", "child.yaml", "--depends-on", parentId);
    expect(child.status).toBe(0);
    expect(child.stdout).toContain(`depends_on=${parentId}`);
    expect(child.stdout).toContain("workspace=deferred");
    const childId = /created (\S+)/.exec(child.stdout)![1]!;
    const state = JSON.parse(readFileSync(join(cwd, ".sddx", "tasks", `${childId}.json`), "utf8"));
    expect(state.depends_on).toEqual([parentId]);
    expect(state.workspace.base_sha).toBe(`pending:${parentId}`);
    expect(state.workspace.path).toBeUndefined();
    expect(existsSync(join(cwd, ".sddx-worktrees", childId))).toBe(false);

    // unknown parent is refused
    const bad = cli(cwd, "task", "create", "--spec", "child.yaml", "--depends-on", "no-such-task");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("no such task");
  });

  test("graph create: ordered overlap accepted, tasks + goal written with edges", () => {
    const cwd = fixtureRepo();
    mkdtempScopedSpecs(cwd);
    // branch mode: `none` is incompatible with dependent tasks (no base to fork from)
    const r = approveAndCreate(
      cwd,
      "graph",
      "create",
      "--graph",
      "graph.yaml",
      "--workspace",
      "branch",
    );
    expect(r.status).toBe(0);
    const goalId = /created goal (\S+)/.exec(r.stdout)![1]!;
    const goal = JSON.parse(readFileSync(join(cwd, ".sddx", "goals", `${goalId}.json`), "utf8"));
    expect(goal.task_ids.length).toBe(2);
    // the dependent records its parent as an edge and is deferred
    const [rootId, childId] = goal.task_ids as [string, string];
    expect(goal.deps[childId]).toEqual([rootId]);
    const child = JSON.parse(readFileSync(join(cwd, ".sddx", "tasks", `${childId}.json`), "utf8"));
    expect(child.depends_on).toEqual([rootId]);
    expect(child.workspace.base_sha).toBe(`pending:${rootId}`);
  });

  test("graph create: concurrent scope overlap refused atomically — nothing written", () => {
    const cwd = fixtureRepo();
    writeFileSync(
      join(cwd, "a.yaml"),
      `task: task a\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\nscope:\n  - src/db/**\n`,
    );
    writeFileSync(
      join(cwd, "b.yaml"),
      `task: task b\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\nscope:\n  - src/db/schema.ts\n`,
    );
    // a and b are both roots (no depends_on) with overlapping scope → illegal
    writeFileSync(
      join(cwd, "graph.yaml"),
      "goal: do a and b\ntasks:\n  - alias: a\n    spec: a.yaml\n  - alias: b\n    spec: b.yaml\n",
    );
    const r = approveAndCreate(
      cwd,
      "graph",
      "create",
      "--graph",
      "graph.yaml",
      "--workspace",
      "none",
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("scope overlap");
    // atomic: no task files, no goal directory
    expect(existsSync(join(cwd, ".sddx", "tasks"))).toBe(false);
    expect(existsSync(join(cwd, ".sddx", "goals"))).toBe(false);
  });

  test("graph create: a node whose spec lacks an oracle is refused, nothing written", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "ok.yaml"), SPEC);
    writeFileSync(join(cwd, "bad.yaml"), "task: t\nsuccess_criteria:\n  - a\n");
    writeFileSync(
      join(cwd, "graph.yaml"),
      "goal: g\ntasks:\n  - alias: ok\n    spec: ok.yaml\n  - alias: bad\n    spec: bad.yaml\n",
    );
    const r = approveAndCreate(
      cwd,
      "graph",
      "create",
      "--graph",
      "graph.yaml",
      "--workspace",
      "none",
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("oracle");
    expect(existsSync(join(cwd, ".sddx", "tasks"))).toBe(false);
  });

  test("graph create refuses --workspace none when the graph has a dependency", () => {
    const cwd = fixtureRepo();
    mkdtempScopedSpecs(cwd);
    const r = approveAndCreate(
      cwd,
      "graph",
      "create",
      "--graph",
      "graph.yaml",
      "--workspace",
      "none",
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("none is incompatible with dependent tasks");
    expect(existsSync(join(cwd, ".sddx", "tasks"))).toBe(false);
  });

  test("task create with repeated --depends-on records multiple parents (fan-in)", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "p1.yaml"), SPEC);
    const p1 = /created (\S+)/.exec(
      cli(cwd, "task", "create", "--spec", "p1.yaml", "--workspace", "branch").stdout,
    )![1]!;
    writeFileSync(
      join(cwd, "p2.yaml"),
      `task: another root\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\n`,
    );
    const p2 = /created (\S+)/.exec(
      cli(cwd, "task", "create", "--spec", "p2.yaml", "--workspace", "branch").stdout,
    )![1]!;
    writeFileSync(
      join(cwd, "child.yaml"),
      `task: fan-in child\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\n`,
    );
    const child = cli(
      cwd,
      "task",
      "create",
      "--spec",
      "child.yaml",
      "--depends-on",
      p1,
      "--depends-on",
      p2,
      "--workspace",
      "branch",
    );
    expect(child.status).toBe(0);
    const childId = /created (\S+)/.exec(child.stdout)![1]!;
    const state = JSON.parse(readFileSync(join(cwd, ".sddx", "tasks", `${childId}.json`), "utf8"));
    expect(state.depends_on).toEqual([p1, p2]);
  });

  test("graph create copies on_dependency_failure/retry from the spec, defaulting when absent", () => {
    const cwd = fixtureRepo();
    writeFileSync(
      join(cwd, "root.yaml"),
      `task: policy root\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\non_dependency_failure: block\nretry:\n  max_attempts: 3\n  workspace: reuse\n`,
    );
    writeFileSync(
      join(cwd, "plain.yaml"),
      `task: plain root\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\n`,
    );
    writeFileSync(
      join(cwd, "graph.yaml"),
      "goal: g\ntasks:\n  - alias: policy\n    spec: root.yaml\n  - alias: plain\n    spec: plain.yaml\n",
    );
    const r = approveAndCreate(
      cwd,
      "graph",
      "create",
      "--graph",
      "graph.yaml",
      "--workspace",
      "none",
    );
    expect(r.status).toBe(0);
    const goalId = /created goal (\S+)/.exec(r.stdout)![1]!;
    const goal = JSON.parse(readFileSync(join(cwd, ".sddx", "goals", `${goalId}.json`), "utf8"));
    const policyState = JSON.parse(
      readFileSync(join(cwd, ".sddx", "tasks", `${goal.task_ids[0]}.json`), "utf8"),
    );
    expect(policyState.on_dependency_failure).toBe("block");
    expect(policyState.retry).toEqual({ max_attempts: 3, workspace: "reuse" });
    const plainState = JSON.parse(
      readFileSync(join(cwd, ".sddx", "tasks", `${goal.task_ids[1]}.json`), "utf8"),
    );
    expect(plainState.on_dependency_failure).toBeUndefined();
    expect(plainState.retry).toBeUndefined();
    expect(plainState.attempt_count).toBe(1);
  });

  test("graph create refuses atomically on an invalid on_dependency_failure/retry value", () => {
    const cwd = fixtureRepo();
    writeFileSync(
      join(cwd, "bad.yaml"),
      `task: bad policy\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\non_dependency_failure: retry\n`,
    );
    writeFileSync(join(cwd, "graph.yaml"), "goal: g\ntasks:\n  - alias: bad\n    spec: bad.yaml\n");
    const r = approveAndCreate(
      cwd,
      "graph",
      "create",
      "--graph",
      "graph.yaml",
      "--workspace",
      "none",
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("on_dependency_failure");
    expect(existsSync(join(cwd, ".sddx", "tasks"))).toBe(false);
    expect(existsSync(join(cwd, ".sddx", "goals"))).toBe(false);
  });

  test("task create --depends-on refuses none mode and overlapping siblings", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "p.yaml"), SPEC);
    const parentId = /created (\S+)/.exec(
      cli(cwd, "task", "create", "--spec", "p.yaml", "--no-branch").stdout,
    )![1]!;

    // none mode + a dependency is refused (no isolatable base to fork from)
    writeFileSync(
      join(cwd, "c1.yaml"),
      `task: child one\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\nscope:\n  - src/shared/**\n`,
    );
    const none = cli(
      cwd,
      "task",
      "create",
      "--spec",
      "c1.yaml",
      "--depends-on",
      parentId,
      "--workspace",
      "none",
    );
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("worktree or branch mode");

    // first sibling (branch mode) is accepted
    const c1 = cli(
      cwd,
      "task",
      "create",
      "--spec",
      "c1.yaml",
      "--depends-on",
      parentId,
      "--workspace",
      "branch",
    );
    expect(c1.status).toBe(0);

    // a second sibling of the same parent with overlapping scope is refused
    writeFileSync(
      join(cwd, "c2.yaml"),
      `task: child two\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\nscope:\n  - src/shared/x.ts\n`,
    );
    const c2 = cli(
      cwd,
      "task",
      "create",
      "--spec",
      "c2.yaml",
      "--depends-on",
      parentId,
      "--workspace",
      "branch",
    );
    expect(c2.status).toBe(1);
    expect(c2.stderr).toContain("scope overlap");
  });

  test("goal create refuses concurrent overlapping tasks", () => {
    const cwd = fixtureRepo();
    writeFileSync(
      join(cwd, "a.yaml"),
      `task: alpha\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\nscope:\n  - src/db/**\n`,
    );
    writeFileSync(
      join(cwd, "b.yaml"),
      `task: bravo\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\nscope:\n  - src/db/x.ts\n`,
    );
    const aId = /created (\S+)/.exec(
      cli(cwd, "task", "create", "--spec", "a.yaml", "--no-branch").stdout,
    )![1]!;
    const bId = /created (\S+)/.exec(
      cli(cwd, "task", "create", "--spec", "b.yaml", "--no-branch").stdout,
    )![1]!;
    const r = cli(cwd, "goal", "create", "--goal", "both", "--tasks", `${aId},${bId}`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("scope overlap");
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

  test("graph create + verify merges automatically; run report and next-actions --goal reflect it", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "spec.yaml"), SPEC);
    writeFileSync(
      join(cwd, "graph.yaml"),
      "goal: report it\ntasks:\n  - alias: only\n    spec: spec.yaml\n",
    );
    const created = approveAndCreate(
      cwd,
      "graph",
      "create",
      "--graph",
      "graph.yaml",
      "--workspace",
      "worktree",
    );
    expect(created.status).toBe(0);
    const id = /created (\S+) phase=PLAN/.exec(created.stdout)![1]!;
    const goalId = /created goal (\S+)/.exec(created.stdout)![1]!;
    const wt = join(cwd, ".sddx-worktrees", id);

    cli(wt, "task", "phase", id, "RED", "--test-exit", "1");
    cli(wt, "task", "phase", id, "GREEN", "--test-exit", "0");
    cli(wt, "task", "phase", id, "VERIFY");
    fakeRedCheck(wt, id);
    const verified = cli(wt, "verify", id);
    expect(verified.status).toBe(0);
    expect(verified.stdout).toContain("integrated: merged into");

    const report = cli(cwd, "run", "report", "--goal", goalId);
    expect(report.status).toBe(0);
    expect(report.stdout).toContain("Run completed");
    expect(report.stdout).toContain("1 of 1 task(s) merged");
    expect(report.stdout).toContain("Base branch remains unchanged: main");

    const menu = cli(cwd, "next-actions", "--goal", goalId);
    expect(menu.status).toBe(0);
    expect(menu.stdout).toContain("Create PR/MR");
    expect(menu.stdout).toContain("Review Changes");

    const reviewed = cli(cwd, "next-actions", "--goal", goalId, "--select", "review changes");
    expect(reviewed.status).toBe(0);
    expect(reviewed.stdout).toContain(".sddx/specs");
  });
});
