import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureClone, fixtureRepo } from "./fixtures";
import {
  createRun,
  fakeRedCheck,
  GRAPH_HEADER,
  goalIds,
  mutateGoal,
  readGoalAnywhere,
  repoRoot,
  taskStatePath,
} from "./helpers";

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
  const approve = spawnSync("bun", [CLI_SRC, "graph", "approve", "--graph", args[graphIdx + 1]], {
    cwd,
    encoding: "utf8",
  });
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
    `${GRAPH_HEADER}goal: ship the feature\ntasks:\n  - alias: schema\n    spec: specs/schema.yaml\n  - alias: api\n    spec: specs/api.yaml\n    depends_on: schema\n`,
  );
}

describe("sddx cli", () => {
  test("phase transitions enforce evidence via flags", () => {
    const cwd = fixtureRepo();
    const { taskIds } = createRun(cwd, cli, "phase it", [{ alias: "only", spec: SPEC }]);
    const id = taskIds[0]!;
    const wt = join(cwd, ".sddx-worktrees", id);
    expect(cli(wt, "task", "phase", id, "RED", "--test-exit", "0").status).toBe(1);
    expect(cli(wt, "task", "phase", id, "RED", "--test-exit", "1").status).toBe(0);
    expect(cli(wt, "task", "phase", id, "GREEN", "--test-exit", "0").status).toBe(0);
    expect(cli(wt, "task", "phase", id, "VERIFY").status).toBe(0);
    expect(cli(wt, "task", "phase", id, "DONE").status).toBe(1); // verifier only
  });

  test("verify pass end-to-end and cleanup guards", () => {
    const cwd = fixtureRepo();
    const { taskIds } = createRun(cwd, cli, "verify it", [{ alias: "only", spec: SPEC }]);
    const id = taskIds[0]!;
    const wt = join(cwd, ".sddx-worktrees", id);
    cli(wt, "task", "phase", id, "RED", "--test-exit", "1");
    cli(wt, "task", "phase", id, "GREEN", "--test-exit", "0");
    cli(wt, "task", "phase", id, "VERIFY");
    fakeRedCheck(wt, id);
    const v = cli(wt, "verify", id);
    expect(v.status).toBe(0);
    expect(v.stdout).toContain(".sddx/receipts/");

    // The guard, asserted negatively first — without this the test proves
    // nothing: a `cleanup` that deleted an unintegrated task's branch outright
    // would still pass on the positive case alone. `verify` merged the task
    // into its run branch, so clear the goal's merge log to make it genuinely
    // unintegrated, the same shape a reverted merge leaves behind.
    mutateGoal(cwd, (g) => {
      g.merges = [];
    });
    const refused = cli(cwd, "cleanup", id);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("not merged into HEAD");
    // and the branch it refused to clean up still exists
    expect(
      spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/sddx/${id}`], { cwd })
        .status,
    ).toBe(0);

    // once the work is merged somewhere that keeps it, cleanup proceeds
    spawnSync("git", ["merge", "-q", "--no-edit", `sddx/${id}`], { cwd });
    expect(cli(cwd, "cleanup", id).status).toBe(0);
  });

  test("a run creates a worktree forked from origin/HEAD in a clone", () => {
    const { clone } = fixtureClone();
    const { taskIds } = createRun(clone, cli, "clone it", [{ alias: "only", spec: SPEC }]);
    const id = taskIds[0]!;
    const wt = join(clone, ".sddx-worktrees", id);
    expect(existsSync(join(wt, ".sddx", "tasks", `${id}.json`))).toBe(true);
    // main checkout untouched: still on main, and the task's state lives in the
    // worktree rather than here
    const g = (...a: string[]) => spawnSync("git", a, { cwd: clone, encoding: "utf8" }).stdout;
    expect(g("rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    expect(existsSync(join(clone, ".sddx", "tasks", `${id}.json`))).toBe(false);
    // worktree HEAD equals origin/HEAD
    const wtHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" });
    expect(wtHead.stdout.trim()).toBe(g("rev-parse", "origin/HEAD").trim());
  });

  test("cleanup refuses a dirty worktree, then removes worktree and merged branch", () => {
    const { clone } = fixtureClone();
    const { taskIds } = createRun(clone, cli, "clean it", [{ alias: "only", spec: SPEC }]);
    const id = taskIds[0]!;
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
      `${GRAPH_HEADER}goal: ship it\ntasks:\n  - alias: only\n    spec: spec.yaml\n`,
    );
    const created = approveAndCreate(cwd, "graph", "create", "--graph", "graph.yaml");
    expect(created.status).toBe(0);
    const id = /created (\S+) phase=PLAN/.exec(created.stdout)![1]!;
    const wt = join(cwd, ".sddx-worktrees", id);

    cli(wt, "task", "phase", id, "RED", "--test-exit", "1");
    cli(wt, "task", "phase", id, "GREEN", "--test-exit", "0");
    cli(wt, "task", "phase", id, "VERIFY");
    fakeRedCheck(wt, id);
    // verify merges the task's branch into the goal's run branch automatically
    expect(cli(wt, "verify", id).status).toBe(0);

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
    const { taskIds } = createRun(cwd, cli, "leave it unmerged", [{ alias: "only", spec: SPEC }]);
    const id = taskIds[0]!;
    const wt = join(cwd, ".sddx-worktrees", id);
    cli(wt, "task", "phase", id, "RED", "--test-exit", "1");
    cli(wt, "task", "phase", id, "GREEN", "--test-exit", "0");
    cli(wt, "task", "phase", id, "VERIFY");
    fakeRedCheck(wt, id);
    expect(cli(wt, "verify", id).status).toBe(0);
    // Clear the goal's merge log — sddx's own revert-aware bookkeeping, and the
    // authoritative answer to "is this task's work currently on the run branch".
    // Emptying it is what a reverted merge looks like to cleanup.
    mutateGoal(cwd, (g) => {
      g.merges = [];
    });

    const refused = cli(cwd, "cleanup", id);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("not merged into HEAD");
    expect(
      spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/sddx/${id}`], { cwd })
        .status,
    ).toBe(0);
  });

  test("graph create + goal show round-trip via the CLI", () => {
    const cwd = fixtureRepo();
    const run = createRun(cwd, cli, "Ship the greet feature", [{ alias: "only", spec: SPEC }]);
    const shown = cli(cwd, "goal", "show", run.goalId);
    expect(shown.status).toBe(0);
    expect(JSON.parse(shown.stdout).task_ids).toEqual(run.taskIds);
  });

  test("graph create: ordered overlap accepted, tasks + goal written with edges", () => {
    const cwd = fixtureRepo();
    mkdtempScopedSpecs(cwd);
    // branch mode: `none` is incompatible with dependent tasks (no base to fork from)
    const r = approveAndCreate(cwd, "graph", "create", "--graph", "graph.yaml");
    expect(r.status).toBe(0);
    const goalId = /created goal (\S+)/.exec(r.stdout)![1]!;
    const goal = readGoalAnywhere(cwd, goalId) as any;
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
      `${GRAPH_HEADER}goal: do a and b\ntasks:\n  - alias: a\n    spec: a.yaml\n  - alias: b\n    spec: b.yaml\n`,
    );
    const r = approveAndCreate(cwd, "graph", "create", "--graph", "graph.yaml");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("scope overlap");
    // atomic: no task files, no goal directory
    expect(existsSync(join(cwd, ".sddx", "tasks"))).toBe(false);
    expect(goalIds(cwd)).toEqual([]);
  });

  test("graph create: a node whose spec lacks an oracle is refused, nothing written", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "ok.yaml"), SPEC);
    writeFileSync(join(cwd, "bad.yaml"), "task: t\nsuccess_criteria:\n  - a\n");
    writeFileSync(
      join(cwd, "graph.yaml"),
      `${GRAPH_HEADER}goal: g\ntasks:\n  - alias: ok\n    spec: ok.yaml\n  - alias: bad\n    spec: bad.yaml\n`,
    );
    const r = approveAndCreate(cwd, "graph", "create", "--graph", "graph.yaml");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("oracle");
    expect(existsSync(join(cwd, ".sddx", "tasks"))).toBe(false);
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
      `${GRAPH_HEADER}goal: g\ntasks:\n  - alias: policy\n    spec: root.yaml\n  - alias: plain\n    spec: plain.yaml\n`,
    );
    const r = approveAndCreate(cwd, "graph", "create", "--graph", "graph.yaml");
    expect(r.status).toBe(0);
    const goalId = /created goal (\S+)/.exec(r.stdout)![1]!;
    const goal = readGoalAnywhere(cwd, goalId) as any;
    const policyState = JSON.parse(readFileSync(taskStatePath(cwd, goal.task_ids[0]), "utf8"));
    expect(policyState.on_dependency_failure).toBe("block");
    expect(policyState.retry).toEqual({ max_attempts: 3, workspace: "reuse" });
    const plainState = JSON.parse(readFileSync(taskStatePath(cwd, goal.task_ids[1]), "utf8"));
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
    writeFileSync(
      join(cwd, "graph.yaml"),
      `${GRAPH_HEADER}goal: g\ntasks:\n  - alias: bad\n    spec: bad.yaml\n`,
    );
    const r = approveAndCreate(cwd, "graph", "create", "--graph", "graph.yaml");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("on_dependency_failure");
    expect(existsSync(join(cwd, ".sddx", "tasks"))).toBe(false);
    expect(goalIds(cwd)).toEqual([]);
  });

  test("removed flags are refused by name, not silently ignored", () => {
    // `--workspace none` is a request for NO isolation. Dropping it without a
    // word would hand the caller the opposite of what they asked for, so this
    // has to fail loudly the way the removed commands and config keys do.
    const cwd = fixtureRepo();
    for (const [flag, value] of [
      ["--workspace", "none"],
      ["--no-branch", null],
    ] as const) {
      const args = value === null ? [flag] : [flag, value];
      const r = cli(cwd, "graph", "create", "--graph", "graph.yaml", ...args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`\`${flag}\` was removed`);
      expect(r.stderr).toContain("migrate-to-v4");
      // nothing was created on the way to the refusal
      expect(existsSync(join(cwd, ".sddx", "tasks"))).toBe(false);
      expect(goalIds(cwd)).toEqual([]);
    }
  });

  test("pr create usage error exits 2 without --goal", () => {
    const cwd = fixtureRepo();
    expect(cli(cwd, "pr", "create").status).toBe(2);
  });

  test("usage errors exit 2", () => {
    const cwd = fixtureRepo();
    expect(cli(cwd, "frobnicate").status).toBe(2);
    expect(cli(cwd, "task").status).toBe(2);
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
      expect(r.stdout).toContain("sddx graph create");
      // the removed creation paths are not advertised
      expect(r.stdout).not.toContain("sddx task create");
      expect(r.stdout).not.toContain("sddx goal create");
      expect(r.stdout).not.toContain("--workspace");
    }
  });

  test("graph create + verify merges automatically; run report and next-actions --goal reflect it", () => {
    const cwd = fixtureRepo();
    writeFileSync(join(cwd, "spec.yaml"), SPEC);
    writeFileSync(
      join(cwd, "graph.yaml"),
      `${GRAPH_HEADER}goal: report it\ntasks:\n  - alias: only\n    spec: spec.yaml\n`,
    );
    const created = approveAndCreate(cwd, "graph", "create", "--graph", "graph.yaml");
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
    expect(report.stdout).toContain("Target branch remains unchanged: main");

    const menu = cli(cwd, "next-actions", "--goal", goalId);
    expect(menu.status).toBe(0);
    expect(menu.stdout).toContain("Create PR/MR");
    expect(menu.stdout).toContain("Review Changes");

    const reviewed = cli(cwd, "next-actions", "--goal", goalId, "--select", "review changes");
    expect(reviewed.status).toBe(0);
    expect(reviewed.stdout).toContain(".sddx/specs");
  });
});
