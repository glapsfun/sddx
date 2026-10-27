import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureRepo, writeConfig } from "./fixtures";
import { completeTask, createRun, doneFile, readTaskState, sddx, startTask } from "./helpers";
import { scenario } from "./scenario";

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

const GOAL = "2026-01-01-test-goal";

/** Starts a task and makes its default oracle pass, then verifies it into IN_REVIEW. */
function toReview(cwd: string, id: string): string {
  const wt = startTask(cwd, id);
  writeFileSync(join(wt, doneFile(id)), "done\n");
  const v = sddx(cwd, "verify", id);
  if (v.status !== 0) throw new Error(`verify ${id}: ${v.stderr}`);
  return wt;
}

describe("states and transitions", () => {
  scenario("task-lifecycle", "Terminal state cannot change", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    completeTask(cwd, "T1");
    expect(readTaskState(cwd, "T1").phase).toBe("DONE");
    expect(sddx(cwd, "task", "start", "T1").status).toBe(1);
    expect(sddx(cwd, "verify", "T1").status).toBe(1);
    expect(sddx(cwd, "review", "record", "T1", "--verdict", "pass").status).toBe(1);
    expect(sddx(cwd, "task", "abandon", "T1", "--reason", "late").status).toBe(1);
    expect(readTaskState(cwd, "T1").phase).toBe("DONE");
  });

  scenario("task-lifecycle", "Skipping review is impossible", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const wt = startTask(cwd, "T1");
    expect(sddx(cwd, "review", "record", "T1", "--verdict", "pass").status).toBe(1);
    writeFileSync(join(wt, doneFile("T1")), "done\n");
    expect(sddx(cwd, "verify", "T1").status).toBe(0);
    expect(readTaskState(cwd, "T1").phase).toBe("IN_REVIEW");
  });

  scenario("task-lifecycle", "No generic state setter", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    startTask(cwd, "T1");
    const r = sddx(cwd, "task", "phase", "T1", "DONE");
    expect(r.status).toBe(2);
    expect(readTaskState(cwd, "T1").phase).toBe("IN_PROGRESS");
  });
});

describe("task start", () => {
  scenario("task-lifecycle", "Start a root task", () => {
    const cwd = fixtureRepo();
    const run = createRun(cwd, { tasks: [{ id: "T1" }] });
    const r = sddx(cwd, "task", "start", "T1");
    expect(r.status).toBe(0);
    const path = join(cwd, ".sddx-worktrees", "T1");
    expect(r.stdout).toContain(path);
    expect(git(cwd, "rev-parse", "sddx/T1")).toBe(git(cwd, "rev-parse", run.runBranch));
    expect(readTaskState(cwd, "T1").phase).toBe("IN_PROGRESS");
    expect(existsSync(join(cwd, ".sddx", "tasks", "T1.json"))).toBe(false);
  });

  scenario("task-lifecycle", "Dependency not done", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }, { id: "T2", dependsOn: ["T1"] }] });
    toReview(cwd, "T1");
    const r = sddx(cwd, "task", "start", "T2");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("dependency T1 is IN_REVIEW, not DONE");
    expect(readTaskState(cwd, "T2").phase).toBe("PLANNED");
  });

  scenario("task-lifecycle", "Fan-in dependent", () => {
    const cwd = fixtureRepo();
    createRun(cwd, {
      tasks: [{ id: "T1" }, { id: "T2" }, { id: "T3", dependsOn: ["T1", "T2"] }],
    });
    completeTask(cwd, "T1");
    completeTask(cwd, "T2");
    const wt = startTask(cwd, "T3");
    expect(existsSync(join(wt, doneFile("T1")))).toBe(true);
    expect(existsSync(join(wt, doneFile("T2")))).toBe(true);
  });

  scenario("task-lifecycle", "Two independent roots", () => {
    const cwd = fixtureRepo();
    createRun(cwd, {
      tasks: [{ id: "T1" }, { id: "T2" }, { id: "T3", dependsOn: ["T1", "T2"] }],
    });
    const r = sddx(cwd, "task", "ready", "--goal", GOAL, "--output", "json");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).data.ready).toEqual(["T1", "T2"]);
  });

  test("a dependent forks after its parent merged, so it sees the parent's committed work", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }, { id: "T2", dependsOn: ["T1"] }] });
    completeTask(cwd, "T1");
    const wt = startTask(cwd, "T2");
    expect(readFileSync(join(wt, doneFile("T1")), "utf8")).toBe("done\n");
    expect(existsSync(join(wt, ".sddx", "receipts", "T1.json"))).toBe(true);
  });
});

describe("abandon, retry and dependency policy", () => {
  scenario("task-lifecycle", "Retry available", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1", extra: "retry: {max_attempts: 2, workspace: fresh}" }] });
    startTask(cwd, "T1");
    const r = sddx(cwd, "task", "abandon", "T1", "--reason", "broken attempt");
    expect(r.status).toBe(0);
    const t = readTaskState(cwd, "T1") as { phase: string; attempt_count: number };
    expect(t.phase).toBe("PLANNED");
    expect(t.attempt_count).toBe(2);
    expect(existsSync(join(cwd, ".sddx-worktrees", "T1"))).toBe(false);
    expect(git(cwd, "branch", "--list", "sddx/T1")).toBe("");
  });

  scenario("task-lifecycle", "Retries exhausted", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1", extra: "retry: {max_attempts: 2, workspace: fresh}" }] });
    startTask(cwd, "T1");
    sddx(cwd, "task", "abandon", "T1", "--reason", "first");
    startTask(cwd, "T1");
    expect(sddx(cwd, "task", "abandon", "T1", "--reason", "second").status).toBe(0);
    const t = readTaskState(cwd, "T1") as { phase: string; abandon_reason: string };
    expect(t.phase).toBe("ABANDONED");
    expect(t.abandon_reason).toBe("second");
  });

  test("a reuse retry keeps the worktree and resumes in it", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1", extra: "retry: {max_attempts: 2, workspace: reuse}" }] });
    const wt = startTask(cwd, "T1");
    writeFileSync(join(wt, "scratch.txt"), "kept\n");
    sddx(cwd, "task", "abandon", "T1", "--reason", "pause");
    expect(readTaskState(cwd, "T1").phase).toBe("PLANNED");
    const again = startTask(cwd, "T1");
    expect(again).toBe(wt);
    expect(readFileSync(join(wt, "scratch.txt"), "utf8")).toBe("kept\n");
  });

  scenario("task-lifecycle", "Skip past a failed ancestor", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }, { id: "T2", dependsOn: ["T1"] }, { id: "T3" }] });
    startTask(cwd, "T1");
    const r = sddx(cwd, "task", "abandon", "T1", "--reason", "dead end");
    expect(r.status).toBe(0);
    const t2 = readTaskState(cwd, "T2") as { phase: string; abandon_reason: string };
    expect(t2.phase).toBe("ABANDONED");
    expect(t2.abandon_reason).toBe("skipped");
    expect(sddx(cwd, "task", "start", "T3").status).toBe(0);
  });

  scenario("task-lifecycle", "Block halts the goal", () => {
    const cwd = fixtureRepo();
    createRun(cwd, {
      tasks: [
        { id: "T1" },
        { id: "T2", dependsOn: ["T1"], extra: "on_dependency_failure: block" },
        { id: "T3" },
      ],
    });
    startTask(cwd, "T1");
    sddx(cwd, "task", "abandon", "T1", "--reason", "dead end");
    expect(readTaskState(cwd, "T2").phase).toBe("PLANNED");
    const r = sddx(cwd, "task", "start", "T3");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "task T1 was abandoned and T2 declares on_dependency_failure: block",
    );
    expect(
      JSON.parse(sddx(cwd, "task", "ready", "--goal", GOAL, "--output", "json").stdout).data.ready,
    ).toEqual([]);
  });
});

describe("state files and the board", () => {
  scenario("task-lifecycle", "Parallel tasks touch separate files", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }, { id: "T2" }] });
    const wt1 = toReview(cwd, "T1");
    const wt2 = toReview(cwd, "T2");
    const changed = (wt: string) =>
      git(wt, "status", "--porcelain", "--untracked-files=all", "--", ".sddx")
        .split("\n")
        .map((l) => l.slice(3));
    expect(changed(wt1)).toEqual([".sddx/tasks/T1.json"]);
    expect(changed(wt2)).toEqual([".sddx/tasks/T2.json"]);
  });

  scenario("task-lifecycle", "Board after a review failure", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    toReview(cwd, "T1");
    const findings = join(cwd, "review.md");
    writeFileSync(findings, "missing edge case\n");
    expect(
      sddx(cwd, "review", "record", "T1", "--verdict", "fail", "--findings", findings).status,
    ).toBe(0);
    expect(sddx(cwd, "board").status).toBe(0);
    const board = readFileSync(join(cwd, ".sddx", "BOARD.md"), "utf8");
    expect(board).toMatch(/\| T1 \| 2026-01-01-test-goal \| IN_PROGRESS \|/);
  });

  test("the board shows the attempt count and an abandoned task's reason", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }, { id: "T2", dependsOn: ["T1"] }] });
    startTask(cwd, "T1");
    sddx(cwd, "task", "abandon", "T1", "--reason", "dead end");
    const data = JSON.parse(sddx(cwd, "board", "--output", "json").stdout).data.tasks as Array<{
      id: string;
      state: string;
      attempt: string;
      note: string;
    }>;
    expect(data.find((t) => t.id === "T1")).toMatchObject({
      state: "ABANDONED",
      attempt: "1",
      note: "dead end",
    });
    expect(data.find((t) => t.id === "T2")).toMatchObject({ state: "ABANDONED", note: "skipped" });
  });

  scenario("task-lifecycle", "Three identical failures", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    writeConfig(cwd, { interaction_mode: "human", stuck_threshold: 3 });
    startTask(cwd, "T1");
    expect(sddx(cwd, "verify", "T1").stderr).not.toContain("is stuck");
    expect(sddx(cwd, "verify", "T1").stderr).not.toContain("is stuck");
    const third = sddx(cwd, "verify", "T1");
    expect(third.status).toBe(1);
    expect(third.stderr).toContain("T1 is stuck");
    sddx(cwd, "board");
    expect(readFileSync(join(cwd, ".sddx", "BOARD.md"), "utf8")).toContain("IN_PROGRESS stuck");
  });
});

describe("cleaning up after an abandoned task", () => {
  test("sweep and cleanup remove an abandoned worktree whose only change is sddx state", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }, { id: "T2" }] });
    startTask(cwd, "T1");
    sddx(cwd, "task", "abandon", "T1", "--reason", "dead end");
    const sweep = sddx(cwd, "sweep");
    expect(sweep.stdout).toContain(`swept ${join(cwd, ".sddx-worktrees", "T1")}`);
    expect(existsSync(join(cwd, ".sddx-worktrees", "T1"))).toBe(false);

    startTask(cwd, "T2");
    sddx(cwd, "task", "abandon", "T2", "--reason", "also dead");
    const r = sddx(cwd, "cleanup", "T2");
    expect(r.stdout).toContain("removed worktree");
  });

  test("an abandoned worktree holding real uncommitted work is kept", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const wt = startTask(cwd, "T1");
    writeFileSync(join(wt, "notes.txt"), "half-finished idea\n");
    sddx(cwd, "task", "abandon", "T1", "--reason", "parked");
    expect(sddx(cwd, "sweep").stdout).toContain("(dirty)");
    expect(existsSync(join(wt, "notes.txt"))).toBe(true);
  });
});

test("cleanup keeps an abandoned task's branch when it holds committed work", () => {
  const cwd = fixtureRepo();
  createRun(cwd, { tasks: [{ id: "T1" }] });
  const wt = startTask(cwd, "T1");
  writeFileSync(join(wt, "idea.txt"), "worth keeping\n");
  git(wt, "add", "idea.txt");
  git(wt, "commit", "-qm", "wip");
  sddx(cwd, "task", "abandon", "T1", "--reason", "parked");
  const r = sddx(cwd, "cleanup", "T1");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("kept branch sddx/T1");
  expect(git(cwd, "branch", "--list", "sddx/T1")).toContain("sddx/T1");
});

test("timings in the output do not hide a repeated failure from stuck detection", () => {
  const cwd = fixtureRepo();
  // fails identically every time apart from a duration, like a test runner's summary line
  createRun(cwd, { tasks: [{ id: "T1", run: 'echo "1 fail [$(date +%N)ms]"; exit 1' }] });
  writeConfig(cwd, { interaction_mode: "human", stuck_threshold: 3 });
  startTask(cwd, "T1");
  sddx(cwd, "verify", "T1");
  sddx(cwd, "verify", "T1");
  expect(sddx(cwd, "verify", "T1").stderr).toContain("T1 is stuck");
});
