import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureRepo, writeConfig } from "./fixtures";
import { completeTask, createRun, readTaskState, sddx, startTask } from "./helpers";
import { scenario } from "./scenario";

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

const GOAL = "2026-01-01-test-goal";
const phaseOf = (cwd: string, id: string): string =>
  JSON.parse(sddx(cwd, "task", "show", id).stdout).phase;

describe("task state survives worktree removal", () => {
  scenario("task-lifecycle", "Cleanup refuses a live task", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const wt = startTask(cwd, "T1");
    const r = sddx(cwd, "cleanup", "T1");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("T1 is IN_PROGRESS");
    expect(existsSync(wt)).toBe(true);
    expect(phaseOf(cwd, "T1")).toBe("IN_PROGRESS");
  });

  scenario("task-lifecycle", "Abandonment outlives its worktree", () => {
    const cwd = fixtureRepo();
    createRun(cwd, {
      tasks: [
        { id: "T1" },
        { id: "T2", dependsOn: ["T1"], extra: "on_dependency_failure: block" },
        { id: "T3" },
      ],
    });
    startTask(cwd, "T1");
    expect(sddx(cwd, "task", "abandon", "T1", "--reason", "dead end").status).toBe(0);
    expect(sddx(cwd, "sweep").stdout).toContain("swept");
    expect(existsSync(join(cwd, ".sddx-worktrees", "T1"))).toBe(false);
    expect(phaseOf(cwd, "T1")).toBe("ABANDONED");
    const r = sddx(cwd, "task", "start", "T3");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "task T1 was abandoned and T2 declares on_dependency_failure: block",
    );
  });

  scenario("task-lifecycle", "Uncommitted spec in a finished worktree is kept", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const { worktree } = completeTask(cwd, "T1");
    const draft = join(worktree, ".sddx", "specs", "2026-01-02-next-goal.md");
    writeFileSync(draft, "# Next goal\n");
    expect(sddx(cwd, "sweep").stdout).toContain("(dirty)");
    expect(existsSync(draft)).toBe(true);
    expect(sddx(cwd, "cleanup", "T1").status).toBe(1);
    expect(existsSync(draft)).toBe(true);
  });

  test("a finished task's clean worktree is still swept", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const { worktree } = completeTask(cwd, "T1");
    expect(git(worktree, "status", "--porcelain")).toBe("");
    sddx(cwd, "sweep");
    expect(existsSync(worktree)).toBe(false);
    expect(phaseOf(cwd, "T1")).toBe("DONE");
  });

  test("abandoning a started task moves its record to the main checkout", () => {
    const cwd = fixtureRepo();
    createRun(cwd, {
      tasks: [{ id: "T1" }, { id: "T2", dependsOn: ["T1"] }],
    });
    startTask(cwd, "T1");
    sddx(cwd, "task", "abandon", "T1", "--reason", "dead end");
    expect(existsSync(join(cwd, ".sddx", "tasks", "T1.json"))).toBe(true);
    expect(existsSync(join(cwd, ".sddx-worktrees", "T1", ".sddx", "tasks", "T1.json"))).toBe(false);
    expect(phaseOf(cwd, "T2")).toBe("ABANDONED");
  });
});

describe("abandoning a task that never started", () => {
  scenario("task-lifecycle", "Abandon a planned task", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1", extra: "retry: {max_attempts: 3, workspace: fresh}" }] });
    const r = sddx(cwd, "task", "abandon", "T1", "--reason", "out of scope");
    expect(r.status).toBe(0);
    const t = readTaskState(cwd, "T1") as { phase: string; attempt_count: number };
    expect(t.phase).toBe("ABANDONED");
    expect(t.attempt_count).toBe(1);
  });
});

describe("reporting abandoned tasks", () => {
  scenario("task-lifecycle", "A reason of skipped is still a failure", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }, { id: "T2", dependsOn: ["T1"] }, { id: "T3" }] });
    startTask(cwd, "T3");
    sddx(cwd, "task", "abandon", "T3", "--reason", "skipped");
    startTask(cwd, "T1");
    sddx(cwd, "task", "abandon", "T1", "--reason", "dead end");
    const report = JSON.parse(sddx(cwd, "run", "report", "--goal", GOAL, "--output", "json").stdout)
      .data as {
      failed: number;
      skipped: number;
      tasks: Array<{ taskId: string; status: string }>;
    };
    expect(report.failed).toBe(2);
    expect(report.skipped).toBe(1);
    expect(report.tasks.find((t) => t.taskId === "T3")?.status).toBe("failed");
    expect(report.tasks.find((t) => t.taskId === "T2")?.status).toBe("skipped");
  });

  test("the board judges stuck by the same threshold verify uses", () => {
    const cwd = fixtureRepo();
    writeConfig(cwd, { interaction_mode: "human", stuck_threshold: 10 });
    git(cwd, "add", ".sddx/config.json");
    git(cwd, "commit", "-qm", "config");
    createRun(cwd, { tasks: [{ id: "T1" }] });
    startTask(cwd, "T1");
    writeConfig(cwd, { interaction_mode: "human", stuck_threshold: 2 });
    sddx(cwd, "verify", "T1");
    expect(sddx(cwd, "verify", "T1").stderr).toContain("T1 is stuck");
    const rows = JSON.parse(sddx(cwd, "board", "--output", "json").stdout).data.tasks as Array<{
      id: string;
      stuck: boolean;
    }>;
    expect(rows.find((t) => t.id === "T1")?.stuck).toBe(true);
  });
});

test("an abandoned task's record stays readable after cleanup removes its worktree and branch", () => {
  const cwd = fixtureRepo();
  createRun(cwd, { tasks: [{ id: "T1" }] });
  startTask(cwd, "T1");
  sddx(cwd, "task", "abandon", "T1", "--reason", "parked");
  const r = sddx(cwd, "cleanup", "T1");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("removed worktree");
  expect(git(cwd, "branch", "--list", "sddx/T1")).toBe("");
  expect(phaseOf(cwd, "T1")).toBe("ABANDONED");
});
