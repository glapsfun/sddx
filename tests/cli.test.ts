import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureClone, fixtureRepo, writeConfig } from "./fixtures";
import {
  completeTask,
  createRun,
  doneFile,
  goalIds,
  goalSpec,
  mutateGoal,
  readGoalAnywhere,
  readTaskState,
  repoRoot,
  sddx,
  startTask,
  writeSpec,
} from "./helpers";

setDefaultTimeout(60_000);

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string }
).version;

const GOAL = "2026-01-01-test-goal";

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

const branchExists = (cwd: string, branch: string) =>
  spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd }).status ===
  0;

/** Nothing a plan start creates exists: no goal, task state, run branch, or worktree. */
function nothingStarted(cwd: string): void {
  expect(goalIds(cwd)).toEqual([]);
  expect(existsSync(join(cwd, ".sddx", "tasks"))).toBe(false);
  expect(git(cwd, "branch", "--list", "sddx/*")).toBe("");
  expect(existsSync(join(cwd, ".sddx-worktrees"))).toBe(false);
}

/** Starts a task, makes its oracle pass, and verifies it into IN_REVIEW. */
function toReview(cwd: string, id: string): string {
  const wt = startTask(cwd, id);
  writeFileSync(join(wt, doneFile(id)), "done\n");
  expect(sddx(cwd, "verify", id).status).toBe(0);
  return wt;
}

/** Merges a task branch into the main checkout's HEAD. The approved spec is
 * committed first: the task branch carries it too, and git refuses to
 * overwrite the untracked copy. */
function mergeIntoMain(cwd: string, id: string): void {
  git(cwd, "add", ".sddx/specs");
  git(cwd, "commit", "-qm", "spec");
  const r = spawnSync("git", ["merge", "-q", "--no-edit", `sddx/${id}`], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`merge sddx/${id}: ${r.stderr}`);
}

describe("sddx cli", () => {
  test("strict profile: task phase records RED/GREEN only with matching evidence, and DONE is no phase", () => {
    const cwd = fixtureRepo();
    writeConfig(cwd, { profile: "strict" });
    createRun(cwd, { tasks: [{ id: "T1" }] });
    startTask(cwd, "T1");
    expect(sddx(cwd, "task", "phase", "T1", "RED", "--test-exit", "0").status).toBe(1);
    expect(sddx(cwd, "task", "phase", "T1", "RED", "--test-exit", "1").status).toBe(0);
    expect(sddx(cwd, "task", "phase", "T1", "GREEN", "--test-exit", "2").status).toBe(1);
    expect(sddx(cwd, "task", "phase", "T1", "GREEN", "--test-exit", "0").status).toBe(0);
    expect(sddx(cwd, "task", "phase", "T1", "DONE", "--test-exit", "0").status).toBe(2);
    const t = readTaskState(cwd, "T1") as {
      phase: string;
      strict: { phase: string; runs: Array<{ test_exit: number; source: string }> };
    };
    expect(t.phase).toBe("IN_PROGRESS");
    expect(t.strict.phase).toBe("GREEN");
    expect(t.strict.runs.map((r) => [r.test_exit, r.source])).toEqual([
      [1, "manual"],
      [0, "manual"],
    ]);
  });

  test("review record passes end-to-end, and cleanup refuses until the work is merged into HEAD", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    toReview(cwd, "T1");
    const reviewed = sddx(cwd, "review", "record", "T1", "--verdict", "pass");
    expect(reviewed.status).toBe(0);
    expect(reviewed.stdout).toContain("T1 DONE");
    expect(reviewed.stdout).toContain(".sddx/receipts/T1.json");

    // The guard, asserted negatively first: without this the test proves
    // nothing, since a `cleanup` that deleted an unintegrated task's branch
    // outright would still pass on the positive case alone. The review merged
    // the task into its run branch, so clear the goal's merge log to make it
    // genuinely unintegrated.
    mutateGoal(cwd, (g) => {
      g.merges = [];
    });
    const refused = sddx(cwd, "cleanup", "T1");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("not merged into HEAD");
    // and the branch it refused to clean up still exists
    expect(branchExists(cwd, "sddx/T1")).toBe(true);

    // once the work is merged somewhere that keeps it, cleanup proceeds
    mergeIntoMain(cwd, "T1");
    const ok = sddx(cwd, "cleanup", "T1");
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("deleted merged branch sddx/T1");
    expect(branchExists(cwd, "sddx/T1")).toBe(false);
  });

  test("a run forks from origin/HEAD in a clone, and starting a task leaves the main checkout alone", () => {
    const { clone } = fixtureClone();
    // a local commit, so origin/HEAD and the local HEAD differ
    writeFileSync(join(clone, "local.txt"), "local\n");
    git(clone, "add", "local.txt");
    git(clone, "commit", "-qm", "local only");
    const head = git(clone, "rev-parse", "HEAD");
    const originHead = git(clone, "rev-parse", "origin/HEAD");
    expect(head).not.toBe(originHead);

    const run = createRun(clone, { tasks: [{ id: "T1" }] });
    // the one commit on main since then is the spec, committed as the plan step requires
    const planned = git(clone, "rev-parse", "HEAD");
    expect(git(clone, "rev-parse", `${planned}~1`)).toBe(head);
    const wt = startTask(clone, "T1");
    expect(existsSync(join(wt, ".sddx", "tasks", "T1.json"))).toBe(true);
    // the worktree sits on the run branch, whose plan commit's parent is origin/HEAD
    expect(git(wt, "rev-parse", "HEAD")).toBe(git(clone, "rev-parse", run.runBranch));
    expect(git(clone, "rev-parse", `${run.runBranch}~1`)).toBe(originHead);
    expect(existsSync(join(wt, "local.txt"))).toBe(false);
    // main checkout untouched: still on main at the same commit, with no task state
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(clone, "rev-parse", "HEAD")).toBe(planned);
    expect(existsSync(join(clone, ".sddx", "tasks", "T1.json"))).toBe(false);
  });

  test("cleanup refuses a dirty worktree, then removes the worktree and merged branch", () => {
    const { clone } = fixtureClone();
    createRun(clone, { tasks: [{ id: "T1" }] });
    const { worktree: wt } = completeTask(clone, "T1");

    writeFileSync(join(wt, "dirty.txt"), "x\n");
    const refused = sddx(clone, "cleanup", "T1");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("uncommitted");
    expect(existsSync(join(wt, "dirty.txt"))).toBe(true);

    rmSync(join(wt, "dirty.txt"));
    mergeIntoMain(clone, "T1");
    const ok = sddx(clone, "cleanup", "T1");
    expect(ok.status).toBe(0);
    expect(existsSync(wt)).toBe(false);
    expect(branchExists(clone, "sddx/T1")).toBe(false);
  });

  test("cleanup accepts a task merged into its goal's run branch (real ancestry, no marker)", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    // a passing review merges the task's branch into the run branch automatically
    const { worktree } = completeTask(cwd, "T1");

    const ok = sddx(cwd, "cleanup", "T1");
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("merged into run branch");
    expect(existsSync(worktree)).toBe(false);
    expect(branchExists(cwd, "sddx/T1")).toBe(false);
  });

  test("cleanup refuses a task whose run-branch merge was reverted and that is not in HEAD", () => {
    const cwd = fixtureRepo();
    const run = createRun(cwd, { tasks: [{ id: "T1" }] });
    completeTask(cwd, "T1");
    // the goal's merge log is sddx's own revert-aware bookkeeping, and the
    // authoritative answer to "is this task's work currently on the run branch"
    const reverted = sddx(cwd, "next-actions", "--goal", run.goalId, "--select", "revert T1");
    expect(reverted.status).toBe(0);
    expect(reverted.stdout).toContain("reverted T1's merge");

    const refused = sddx(cwd, "cleanup", "T1");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("not merged into HEAD");
    expect(branchExists(cwd, "sddx/T1")).toBe(true);
  });

  test("plan start + goal show + task show round-trip via the CLI", () => {
    const cwd = fixtureRepo();
    const run = createRun(cwd, { title: "Ship the greet feature", tasks: [{ id: "T1" }] });
    const shown = sddx(cwd, "goal", "show", run.goalId);
    expect(shown.status).toBe(0);
    const goal = JSON.parse(shown.stdout);
    expect(goal.goal).toBe("Ship the greet feature");
    expect(goal.task_ids).toEqual(run.taskIds);
    expect(goal.spec_path).toBe(run.specPath);
    expect(goal.run_branch).toBe(run.runBranch);

    const task = sddx(cwd, "task", "show", "T1");
    expect(task.status).toBe(0);
    expect(JSON.parse(task.stdout)).toMatchObject({
      id: "T1",
      phase: "PLANNED",
      goal_id: run.goalId,
      spec_path: run.specPath,
    });
    expect(sddx(cwd, "task", "show", "T9").status).toBe(1);
  });

  test("plan start: ordered overlap accepted, tasks + goal written with edges", () => {
    const cwd = fixtureRepo();
    // T2's scope overlaps T1's, which is legal because the edge orders them
    const run = createRun(cwd, {
      tasks: [
        { id: "T1", scope: ["T1.done", "src/db/**"] },
        { id: "T2", scope: ["T2.done", "src/db/schema.ts"], dependsOn: ["T1"] },
      ],
    });
    const goal = readGoalAnywhere(cwd, run.goalId) as {
      task_ids: string[];
      deps: Record<string, string[]>;
    };
    expect(goal.task_ids).toEqual(["T1", "T2"]);
    expect(goal.deps.T2).toEqual(["T1"]);
    const child = JSON.parse(readFileSync(join(cwd, ".sddx", "tasks", "T2.json"), "utf8"));
    expect(child.depends_on).toEqual(["T1"]);
    expect(child.phase).toBe("PLANNED");
    // a dependent has no worktree until its parent is DONE and it is started
    expect(child.workspace).toBeUndefined();
  });

  test("plan start: concurrent scope overlap refused atomically, nothing written", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(
      cwd,
      GOAL,
      goalSpec({
        tasks: [
          { id: "T1", scope: ["src/db/**"] },
          { id: "T2", scope: ["src/db/schema.ts"] },
        ],
      }),
    );
    expect(sddx(cwd, "plan", "approve", spec).status).toBe(1);
    const r = sddx(cwd, "plan", "start", spec);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("scope overlap");
    nothingStarted(cwd);
  });

  test("plan start: a task without an oracle is refused, nothing written", () => {
    const cwd = fixtureRepo();
    const text = goalSpec({ tasks: [{ id: "T1" }, { id: "T2" }] }).replace(
      /(### T2 [^\n]*\n\n```sddx\n)oracle:\n(?: {2}[^\n]*\n)+/,
      "$1",
    );
    expect(text).toContain("### T2");
    const spec = writeSpec(cwd, GOAL, text);
    const r = sddx(cwd, "plan", "start", spec);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("oracle");
    nothingStarted(cwd);
  });

  test("plan start copies on_dependency_failure/retry from the spec, defaulting when absent", () => {
    const cwd = fixtureRepo();
    createRun(cwd, {
      tasks: [
        {
          id: "T1",
          extra: "on_dependency_failure: block\nretry: {max_attempts: 3, workspace: reuse}",
        },
        { id: "T2" },
      ],
    });
    const policy = readTaskState(cwd, "T1");
    expect(policy.on_dependency_failure).toBe("block");
    expect(policy.retry).toEqual({ max_attempts: 3, workspace: "reuse" });
    const plain = readTaskState(cwd, "T2");
    expect(plain.on_dependency_failure).toBeUndefined();
    expect(plain.retry).toBeUndefined();
    expect(plain.attempt_count).toBe(1);
  });

  test("plan start refuses atomically on an invalid on_dependency_failure value", () => {
    const cwd = fixtureRepo();
    const spec = writeSpec(
      cwd,
      GOAL,
      goalSpec({ tasks: [{ id: "T1", extra: "on_dependency_failure: retry" }] }),
    );
    const r = sddx(cwd, "plan", "start", spec);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("on_dependency_failure");
    nothingStarted(cwd);
  });

  test("removed flags are refused by name, not silently ignored", () => {
    // `--workspace none` is a request for NO isolation. Dropping it without a
    // word would hand the caller the opposite of what they asked for, so this
    // has to fail loudly the way the removed commands and config keys do.
    const cwd = fixtureRepo();
    const spec = writeSpec(cwd, GOAL, goalSpec({ tasks: [{ id: "T1" }] }));
    expect(sddx(cwd, "plan", "approve", spec).status).toBe(0);
    for (const args of [["--workspace", "none"], ["--no-branch"]]) {
      const r = sddx(cwd, "plan", "start", spec, ...args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`\`${args[0]}\` was removed`);
      expect(r.stderr).toContain("Drop the flag.");
      // nothing was created on the way to the refusal
      nothingStarted(cwd);
    }
  });

  test("commands removed in sddx 6 exit 2 and name their replacement", () => {
    const cwd = fixtureRepo();
    for (const [args, replacement] of [
      [["graph", "create", "--graph", "graph.yaml"], "sddx plan start <spec>"],
      [["task", "materialize", "T1"], "sddx task start <id>"],
      [["red-check", "T1"], "sddx verify <id>"],
      [["intake"], "sddx spec check <spec>"],
      [["init"], "sddx migrate"],
      [["task", "create"], "sddx plan start <spec>"],
    ] as const) {
      const r = sddx(cwd, ...args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("was removed");
      expect(r.stderr).toContain(replacement);
    }
    expect(existsSync(join(cwd, ".sddx"))).toBe(false);
  });

  test("pr create usage error exits 2 without --goal", () => {
    const cwd = fixtureRepo();
    expect(sddx(cwd, "pr", "create").status).toBe(2);
  });

  test("usage errors exit 2", () => {
    const cwd = fixtureRepo();
    expect(sddx(cwd, "frobnicate").status).toBe(2);
    expect(sddx(cwd, "task").status).toBe(2);
  });

  test("--version and -v print the package version outside a git repository", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sddx-nongit-"));
    for (const flag of ["--version", "-v"]) {
      const r = sddx(cwd, flag);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(PACKAGE_VERSION);
    }
  });

  test("--help and -h print usage and exit 0", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sddx-nongit-"));
    for (const flag of ["--help", "-h"]) {
      const r = sddx(cwd, flag);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("usage:");
      expect(r.stdout).toContain("sddx plan start");
      // the removed creation paths are not advertised
      expect(r.stdout).not.toContain("sddx graph");
      expect(r.stdout).not.toContain("sddx task create");
      expect(r.stdout).not.toContain("sddx goal create");
      expect(r.stdout).not.toContain("--workspace");
    }
  });

  test("plan start + a passing review merge automatically; run report and next-actions --goal reflect it", () => {
    const cwd = fixtureRepo();
    const run = createRun(cwd, { tasks: [{ id: "T1" }] });
    toReview(cwd, "T1");
    const reviewed = sddx(cwd, "review", "record", "T1", "--verdict", "pass");
    expect(reviewed.status).toBe(0);
    expect(reviewed.stdout).toContain(`merged into ${run.runBranch}`);

    const report = sddx(cwd, "run", "report", "--goal", run.goalId);
    expect(report.status).toBe(0);
    expect(report.stdout).toContain("Run completed");
    expect(report.stdout).toContain("1 of 1 task(s) merged");
    expect(report.stdout).toContain("Target branch remains unchanged: main");

    const menu = sddx(cwd, "next-actions", "--goal", run.goalId);
    expect(menu.status).toBe(0);
    expect(menu.stdout).toContain("Create PR/MR");
    expect(menu.stdout).toContain("Review Changes");

    const review = sddx(cwd, "next-actions", "--goal", run.goalId, "--select", "review changes");
    expect(review.status).toBe(0);
    expect(review.stdout).toContain(".sddx/specs");
    expect(review.stdout).toContain("T1.done");
  });
});
