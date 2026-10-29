import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CreateGoalOptions,
  createGoal,
  currentlyMergedTaskIds,
  findGoalForTask,
  goalCounts,
  goalIdFromSpec,
  readGoal,
  runBranchName,
  writeGoal,
} from "../src/lib/goal";
import { createPlannedTask } from "../src/lib/task";

// A directory outside any git repository, so goal records stay loose files.
function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "sddx-goal-"));
}

const ID = "2026-07-19-ship-it";
const OPTS: CreateGoalOptions = {
  id: ID,
  specPath: `.sddx/specs/${ID}.md`,
  runBranch: runBranchName(ID),
  baseSha: "0".repeat(40),
};

function task(cwd: string, id: string): string {
  createPlannedTask(cwd, {
    id,
    title: `task ${id}`,
    goal_id: ID,
    spec_path: OPTS.specPath,
    oracle: { type: "command", run: "t", expect: "exit 0" },
    scope: [],
    assumptions: [],
    depends_on: [],
  });
  return id;
}

describe("goalIdFromSpec", () => {
  test("is the spec file name without its directory or .md", () => {
    expect(goalIdFromSpec(".sddx/specs/2026-07-19-ship-the-widget.md")).toBe(
      "2026-07-19-ship-the-widget",
    );
    expect(goalIdFromSpec("2026-07-19-x.md")).toBe("2026-07-19-x");
  });
});

describe("runBranchName", () => {
  test("prefixes the goal id with sddx/run-", () => {
    expect(runBranchName("2026-07-19-ship-it")).toBe("sddx/run-2026-07-19-ship-it");
  });
});

describe("createGoal / readGoal / writeGoal", () => {
  test("persists task ids, spec path, edges, run branch, and base sha, and round-trips", () => {
    const cwd = tmpCwd();
    const id1 = task(cwd, "T1");
    const id2 = task(cwd, "T2");
    const g = createGoal(cwd, "Ship both tasks", [id1, id2], { ...OPTS, deps: { T2: ["T1"] } });
    expect(g.id).toBe(ID);
    const back = readGoal(cwd, ID);
    expect(back.goal).toBe("Ship both tasks");
    expect(back.task_ids).toEqual([id1, id2]);
    expect(back.spec_path).toBe(OPTS.specPath);
    expect(back.deps).toEqual({ T2: ["T1"] });
    expect(back.run_branch).toBe(OPTS.runBranch);
    expect(back.base_sha).toBe(OPTS.baseSha);
    expect(back.merges).toEqual([]);
  });

  test("refuses to read a goal file from an incompatible (pre-run-branch) schema", () => {
    const cwd = tmpCwd();
    const g = createGoal(cwd, "Legacy schema goal", [task(cwd, "T1")], OPTS);
    const path = join(cwd, ".sddx", "goals", `${g.id}.json`);
    const legacy = { id: g.id, goal: g.goal, task_ids: g.task_ids, created_at: g.created_at };
    writeFileSync(path, `${JSON.stringify(legacy, null, 2)}\n`);
    expect(() => readGoal(cwd, g.id)).toThrow(/incompatible sddx version/);
  });

  test("refuses when a listed task doesn't exist", () => {
    const cwd = tmpCwd();
    expect(() => createGoal(cwd, "Ship a ghost task", ["no-such-task"], OPTS)).toThrow(
      /does not exist/,
    );
  });

  test("refuses a duplicate goal id", () => {
    const cwd = tmpCwd();
    const id = task(cwd, "T1");
    createGoal(cwd, "Same goal twice", [id], OPTS);
    expect(() => createGoal(cwd, "Same goal twice", [id], OPTS)).toThrow(/already exists/);
  });

  test("writeGoal bumps updated_at and persists a shipped marker", async () => {
    const cwd = tmpCwd();
    const g = createGoal(cwd, "Ship marker roundtrip", [task(cwd, "T1")], OPTS);
    const before = g.updated_at;
    await new Promise((r) => setTimeout(r, 5));
    g.shipped = { pr_url: "https://github.com/org/repo/pull/9", at: new Date().toISOString() };
    writeGoal(cwd, g);
    const back = readGoal(cwd, g.id);
    expect(back.shipped?.pr_url).toBe("https://github.com/org/repo/pull/9");
    expect(back.updated_at > before).toBe(true);
  });
});

describe("findGoalForTask", () => {
  test("finds the goal listing a task", () => {
    const cwd = tmpCwd();
    const id = task(cwd, "T1");
    const g = createGoal(cwd, "Findable goal", [id], OPTS);
    expect(findGoalForTask(cwd, id)?.id).toBe(g.id);
  });

  test("returns null for a task in no goal", () => {
    const cwd = tmpCwd();
    task(cwd, "T1");
    createGoal(cwd, "Other goal", [task(cwd, "T2")], OPTS);
    expect(findGoalForTask(cwd, "T1")).toBeNull();
  });

  test("returns null when no goals directory exists yet", () => {
    expect(findGoalForTask(tmpCwd(), "anything")).toBeNull();
  });
});

describe("currentlyMergedTaskIds / goalCounts", () => {
  test("counts a merged task once, and excludes an unmerged one", () => {
    const cwd = tmpCwd();
    const g = createGoal(cwd, "Partial goal", [task(cwd, "T1"), task(cwd, "T2")], OPTS);
    g.merges.push({
      task_id: "T1",
      commit_sha: "a".repeat(40),
      merged_at: "now",
      result: "merged",
    });
    writeGoal(cwd, g);
    const back = readGoal(cwd, g.id);
    expect(currentlyMergedTaskIds(back)).toEqual(["T1"]);
    expect(goalCounts(back)).toEqual({ merged: 1, outstanding: 1, total: 2 });
  });

  test("a later revert removes a task from the merged count", () => {
    const cwd = tmpCwd();
    const g = createGoal(cwd, "Reverted goal", [task(cwd, "T1")], OPTS);
    g.merges.push({ task_id: "T1", commit_sha: "a".repeat(40), merged_at: "t1", result: "merged" });
    g.merges.push({
      task_id: "T1",
      commit_sha: "b".repeat(40),
      merged_at: "t2",
      result: "reverted",
      reverts: "a".repeat(40),
    });
    writeGoal(cwd, g);
    const back = readGoal(cwd, g.id);
    expect(currentlyMergedTaskIds(back)).toEqual([]);
    expect(goalCounts(back)).toEqual({ merged: 0, outstanding: 1, total: 1 });
  });

  test("a conflict entry never counts as merged", () => {
    const cwd = tmpCwd();
    const g = createGoal(cwd, "Conflicted goal", [task(cwd, "T1")], OPTS);
    g.merges.push({ task_id: "T1", result: "conflict" });
    writeGoal(cwd, g);
    expect(goalCounts(readGoal(cwd, g.id))).toEqual({ merged: 0, outstanding: 1, total: 1 });
  });
});
