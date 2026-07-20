import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGoalBranch, goalBranchName } from "../src/lib/prbranch";
import { fixtureRepo } from "./fixtures";

const g = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

function branchExists(cwd: string, branch: string): boolean {
  return (
    spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd })
      .status === 0
  );
}

/** Commits a minimal "DONE" task (task file + one source file) onto its own
 * branch, forked from whatever is currently checked out, then returns to it. */
function makeTaskBranch(cwd: string, id: string, createdAt: string, file: string): void {
  const startBranch = g(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  g(cwd, "switch", "-c", `sddx/${id}`);
  mkdirSync(join(cwd, ".sddx", "tasks"), { recursive: true });
  writeFileSync(
    join(cwd, ".sddx", "tasks", `${id}.json`),
    JSON.stringify(
      {
        id,
        task: id,
        phase: "DONE",
        spec_path: "x",
        oracle: { type: "command", run: "t", expect: "exit 0" },
        workspace: { mode: "branch", branch: `sddx/${id}`, base_sha: "a" },
        allow: [],
        iterations: 1,
        evidence: {},
        history: [],
        created_at: createdAt,
        updated_at: createdAt,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(cwd, file), `${id}\n`);
  g(cwd, "add", "-A");
  g(cwd, "commit", "-qm", `sddx(${id}): done`);
  g(cwd, "switch", startBranch);
}

describe("buildGoalBranch", () => {
  test("cherry-picks two disjoint tasks in creation order onto a fresh branch", () => {
    const cwd = fixtureRepo();
    makeTaskBranch(cwd, "task-b", "2026-07-19T00:00:02.000Z", "b.txt");
    makeTaskBranch(cwd, "task-a", "2026-07-19T00:00:01.000Z", "a.txt");

    // pass ids out of order — buildGoalBranch must re-sort by created_at
    const res = buildGoalBranch(cwd, "g1", ["task-b", "task-a"]);

    expect(res.branch).toBe(goalBranchName("g1"));
    expect(g(res.worktreePath, "cat-file", "-e", "HEAD:a.txt")).toBe("");
    expect(g(res.worktreePath, "cat-file", "-e", "HEAD:b.txt")).toBe("");

    const subjects = g(res.worktreePath, "log", "--format=%s", "--reverse").split("\n");
    expect(subjects.slice(-2)).toEqual(["sddx(task-a): done", "sddx(task-b): done"]);
  });

  test("conflict aborts the whole operation and names the failing task", () => {
    const cwd = fixtureRepo();
    // both branches add the same new path with different content — add/add conflict
    makeTaskBranch(cwd, "task-c", "2026-07-19T00:00:01.000Z", "shared.txt");
    makeTaskBranch(cwd, "task-d", "2026-07-19T00:00:02.000Z", "shared.txt");

    expect(() => buildGoalBranch(cwd, "g2", ["task-c", "task-d"])).toThrow(/task-d/);

    expect(branchExists(cwd, goalBranchName("g2"))).toBe(false);
    expect(g(cwd, "worktree", "list", "--porcelain")).not.toContain("goal-g2");
  });

  test("always starts over: a stale goal branch from a prior failed run is discarded", () => {
    const cwd = fixtureRepo();
    makeTaskBranch(cwd, "task-e", "2026-07-19T00:00:01.000Z", "e.txt");
    g(cwd, "branch", goalBranchName("g3")); // simulate a leftover from a previous attempt

    const res = buildGoalBranch(cwd, "g3", ["task-e"]);
    expect(g(res.worktreePath, "cat-file", "-e", "HEAD:e.txt")).toBe("");
  });

  test("refuses a task with no dedicated branch, before creating any worktree", () => {
    const cwd = fixtureRepo();
    makeTaskBranch(cwd, "task-f", "2026-07-19T00:00:01.000Z", "f.txt");
    // "task-g" has task state but no sddx/task-g branch — simulates a task
    // created with --workspace none, which never gets a dedicated branch
    mkdirSync(join(cwd, ".sddx", "tasks"), { recursive: true });
    writeFileSync(
      join(cwd, ".sddx", "tasks", "task-g.json"),
      JSON.stringify(
        {
          id: "task-g",
          task: "task-g",
          phase: "DONE",
          spec_path: "x",
          oracle: { type: "command", run: "t", expect: "exit 0" },
          workspace: { mode: "none", branch: null, base_sha: "a" },
          allow: [],
          iterations: 1,
          evidence: {},
          history: [],
          created_at: "2026-07-19T00:00:02.000Z",
          updated_at: "2026-07-19T00:00:02.000Z",
        },
        null,
        2,
      ),
    );

    expect(() => buildGoalBranch(cwd, "g4", ["task-f", "task-g"])).toThrow(/task-g/);
    expect(branchExists(cwd, goalBranchName("g4"))).toBe(false);
    expect(g(cwd, "worktree", "list", "--porcelain")).not.toContain("goal-g4");
  });
});
