import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGoal,
  currentlyMergedTaskIds,
  findGoalForTask,
  goalCounts,
  goalId,
  readGoal,
  runBranchName,
  writeGoal,
} from "../src/lib/goal";
import type { Receipt } from "../src/lib/receipt";
import { receiptPath } from "../src/lib/receipt";
import { parseSpec } from "../src/lib/spec";
import { createTask, transition, writeTask } from "../src/lib/task";

function specFor(sentence: string) {
  return parseSpec(
    `task: ${sentence}\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: t\n`,
  ).spec!;
}

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "sddx-goal-"));
}

const RUN_OPTS = { runBranch: "sddx/run-x", baseSha: "0".repeat(40) };

function doneTaskWithReceipt(cwd: string, sentence: string): string {
  let t = createTask(cwd, specFor(sentence), "s", {
    mode: "worktree",
    branch: null,
    base_sha: "a",
  });
  t = transition(t, "RED", { testExit: 1 });
  t = transition(t, "GREEN", { testExit: 0 });
  t = transition(t, "VERIFY");
  t = transition(t, "DONE", { internal: true });
  writeTask(cwd, t);
  const receipt: Receipt = {
    version: 3,
    task_id: t.id,
    seq: 1,
    prev: "genesis",
    harness: "claude-code",
    model: null,
    plugin_version: "0.0.0",
    oracle: { run: "t", expect: "exit 0" },
    runs: [
      {
        exit_code: 0,
        duration_ms: 1,
        stdout_sha256: "0".repeat(64),
        stderr_sha256: "0".repeat(64),
      },
    ],
    env: { os: "test", arch: "test", runtime: "bun", runtime_version: "1", dirty_tree: false },
    base_sha: "0".repeat(40),
    tree_sha: "0".repeat(40),
    verdict: "pass",
    verified_at: new Date().toISOString(),
    allow: [],
  };
  mkdirSync(join(cwd, ".sddx", "receipts"), { recursive: true });
  writeFileSync(receiptPath(cwd, t.id), `${JSON.stringify(receipt, null, 2)}\n`);
  return t.id;
}

describe("goalId", () => {
  test("uses the same slug+date derivation as taskId", () => {
    expect(goalId("Ship the widget export feature", new Date("2026-07-19T00:00:00Z"))).toBe(
      "20260719-ship-the-widget-export-feature",
    );
  });
});

describe("runBranchName", () => {
  test("prefixes the goal id with sddx/run-", () => {
    expect(runBranchName("20260719-ship-it")).toBe("sddx/run-20260719-ship-it");
  });
});

describe("createGoal / readGoal / writeGoal", () => {
  test("persists task ids, run branch, and base sha, and round-trips", () => {
    const cwd = tmpCwd();
    const id1 = doneTaskWithReceipt(cwd, "Task one");
    const id2 = doneTaskWithReceipt(cwd, "Task two");
    const g = createGoal(cwd, "Ship both tasks", [id1, id2], RUN_OPTS);
    const back = readGoal(cwd, g.id);
    expect(back.task_ids).toEqual([id1, id2]);
    expect(back.run_branch).toBe(RUN_OPTS.runBranch);
    expect(back.base_sha).toBe(RUN_OPTS.baseSha);
    expect(back.merges).toEqual([]);
  });

  test("refuses to read a goal file from an incompatible (pre-run-branch) schema", () => {
    const cwd = tmpCwd();
    const id = doneTaskWithReceipt(cwd, "Legacy schema task");
    const g = createGoal(cwd, "Legacy schema goal", [id], RUN_OPTS);
    const path = join(cwd, ".sddx", "goals", `${g.id}.json`);
    const legacy = { id: g.id, goal: g.goal, task_ids: g.task_ids, created_at: g.created_at };
    writeFileSync(path, `${JSON.stringify(legacy, null, 2)}\n`);
    expect(() => readGoal(cwd, g.id)).toThrow(/incompatible sddx version/);
  });

  test("refuses when a listed task doesn't exist", () => {
    const cwd = tmpCwd();
    expect(() => createGoal(cwd, "Ship a ghost task", ["no-such-task"], RUN_OPTS)).toThrow(
      /does not exist/,
    );
  });

  test("refuses a duplicate goal id", () => {
    const cwd = tmpCwd();
    const id = doneTaskWithReceipt(cwd, "Same goal sentence twice");
    createGoal(cwd, "Same goal sentence twice", [id], RUN_OPTS);
    expect(() => createGoal(cwd, "Same goal sentence twice", [id], RUN_OPTS)).toThrow(
      /already exists/,
    );
  });

  test("accepts a precomputed id instead of re-deriving it", () => {
    const cwd = tmpCwd();
    const id = doneTaskWithReceipt(cwd, "Precomputed id goal");
    const g = createGoal(cwd, "Precomputed id goal", [id], { ...RUN_OPTS, id: "custom-id" });
    expect(g.id).toBe("custom-id");
    expect(readGoal(cwd, "custom-id").id).toBe("custom-id");
  });

  test("writeGoal bumps updated_at and persists a shipped marker", () => {
    const cwd = tmpCwd();
    const id = doneTaskWithReceipt(cwd, "Ship marker roundtrip");
    const g = createGoal(cwd, "Ship marker roundtrip", [id], RUN_OPTS);
    g.shipped = { pr_url: "https://github.com/org/repo/pull/9", at: new Date().toISOString() };
    writeGoal(cwd, g);
    const back = readGoal(cwd, g.id);
    expect(back.shipped?.pr_url).toBe("https://github.com/org/repo/pull/9");
  });
});

describe("findGoalForTask", () => {
  test("finds the goal listing a task", () => {
    const cwd = tmpCwd();
    const id = doneTaskWithReceipt(cwd, "Findable task");
    const g = createGoal(cwd, "Findable goal", [id], RUN_OPTS);
    expect(findGoalForTask(cwd, id)?.id).toBe(g.id);
  });

  test("returns null for a task in no goal", () => {
    const cwd = tmpCwd();
    const id = doneTaskWithReceipt(cwd, "Solo task, no goal");
    expect(findGoalForTask(cwd, id)).toBeNull();
  });

  test("returns null when no goals directory exists yet", () => {
    const cwd = tmpCwd();
    expect(findGoalForTask(cwd, "anything")).toBeNull();
  });
});

describe("currentlyMergedTaskIds / goalCounts", () => {
  test("counts a merged task once, and excludes an unmerged one", () => {
    const cwd = tmpCwd();
    const id1 = doneTaskWithReceipt(cwd, "Merged task");
    const id2 = doneTaskWithReceipt(cwd, "Unmerged task");
    const g = createGoal(cwd, "Partial goal", [id1, id2], RUN_OPTS);
    g.merges.push({ task_id: id1, commit_sha: "a".repeat(40), merged_at: "now", result: "merged" });
    writeGoal(cwd, g);
    const back = readGoal(cwd, g.id);
    expect(currentlyMergedTaskIds(back)).toEqual([id1]);
    expect(goalCounts(back)).toEqual({ merged: 1, outstanding: 1, total: 2 });
  });

  test("a later revert removes a task from the merged count", () => {
    const cwd = tmpCwd();
    const id = doneTaskWithReceipt(cwd, "Reverted task");
    const g = createGoal(cwd, "Reverted goal", [id], RUN_OPTS);
    g.merges.push({ task_id: id, commit_sha: "a".repeat(40), merged_at: "t1", result: "merged" });
    g.merges.push({
      task_id: id,
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
    const id = doneTaskWithReceipt(cwd, "Conflicted task");
    const g = createGoal(cwd, "Conflicted goal", [id], RUN_OPTS);
    g.merges.push({ task_id: id, result: "conflict" });
    writeGoal(cwd, g);
    expect(goalCounts(readGoal(cwd, g.id))).toEqual({ merged: 0, outstanding: 1, total: 1 });
  });
});
