import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkGoalComplete, createGoal, goalId, readGoal, writeGoal } from "../src/lib/goal";
import type { Receipt } from "../src/lib/receipt";
import { receiptPath } from "../src/lib/receipt";
import { parseSpec } from "../src/lib/spec";
import { createTask, transition, writeTask } from "../src/lib/task";

function specFor(sentence: string) {
  return parseSpec(
    `task: ${sentence}\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: t\n`,
  ).spec!;
}

const spec = specFor("Add a Health endpoint");

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "sddx-goal-"));
}

function doneTaskWithReceipt(cwd: string, sentence: string): string {
  let t = createTask(cwd, specFor(sentence), "s", { mode: "none", branch: null, base_sha: "a" });
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

describe("createGoal / readGoal / writeGoal", () => {
  test("persists task ids and round-trips", () => {
    const cwd = tmpCwd();
    const id1 = doneTaskWithReceipt(cwd, "Task one");
    const id2 = doneTaskWithReceipt(cwd, "Task two");
    const g = createGoal(cwd, "Ship both tasks", [id1, id2]);
    expect(readGoal(cwd, g.id).task_ids).toEqual([id1, id2]);
  });

  test("refuses when a listed task doesn't exist", () => {
    const cwd = tmpCwd();
    expect(() => createGoal(cwd, "Ship a ghost task", ["no-such-task"])).toThrow(/does not exist/);
  });

  test("refuses a duplicate goal id", () => {
    const cwd = tmpCwd();
    const id = doneTaskWithReceipt(cwd, "Same goal sentence twice");
    createGoal(cwd, "Same goal sentence twice", [id]);
    expect(() => createGoal(cwd, "Same goal sentence twice", [id])).toThrow(/already exists/);
  });

  test("writeGoal bumps updated_at and persists a shipped marker", () => {
    const cwd = tmpCwd();
    const id = doneTaskWithReceipt(cwd, "Ship marker roundtrip");
    const g = createGoal(cwd, "Ship marker roundtrip", [id]);
    g.shipped = { pr_url: "https://github.com/org/repo/pull/9", at: new Date().toISOString() };
    writeGoal(cwd, g);
    const back = readGoal(cwd, g.id);
    expect(back.shipped?.pr_url).toBe("https://github.com/org/repo/pull/9");
  });
});

describe("checkGoalComplete", () => {
  test("complete when every task is DONE with a passing receipt", () => {
    const cwd = tmpCwd();
    const id1 = doneTaskWithReceipt(cwd, "Complete task one");
    const id2 = doneTaskWithReceipt(cwd, "Complete task two");
    const g = createGoal(cwd, "Complete goal", [id1, id2]);
    const res = checkGoalComplete(cwd, g.id);
    expect(res.complete).toBe(true);
    expect(res.blocking).toEqual([]);
  });

  test("blocks on a task that isn't DONE yet, naming its phase", () => {
    const cwd = tmpCwd();
    const done = doneTaskWithReceipt(cwd, "Finished task");
    const pending = createTask(cwd, spec, "s", { mode: "none", branch: null, base_sha: "a" });
    const g = createGoal(cwd, "Mixed goal", [done, pending.id]);
    const res = checkGoalComplete(cwd, g.id);
    expect(res.complete).toBe(false);
    expect(res.blocking).toEqual([{ task_id: pending.id, reason: "phase PLAN" }]);
  });

  test("blocks on a DONE task with no receipt", () => {
    const cwd = tmpCwd();
    let t = createTask(cwd, spec, "s", { mode: "none", branch: null, base_sha: "a" });
    t = transition(t, "RED", { testExit: 1 });
    t = transition(t, "GREEN", { testExit: 0 });
    t = transition(t, "VERIFY");
    t = transition(t, "DONE", { internal: true });
    writeTask(cwd, t);
    const g = createGoal(cwd, "Receiptless goal", [t.id]);
    const res = checkGoalComplete(cwd, g.id);
    expect(res.complete).toBe(false);
    expect(res.blocking).toEqual([{ task_id: t.id, reason: "no receipt" }]);
  });

  test("blocks and names a task deleted after the goal was created", () => {
    const cwd = tmpCwd();
    const id = doneTaskWithReceipt(cwd, "Task to be deleted");
    const g = createGoal(cwd, "Drifted goal", [id]);
    // simulate the task file vanishing (manual cleanup outside sddx)
    rmSync(join(cwd, ".sddx", "tasks", `${id}.json`));
    const res = checkGoalComplete(cwd, g.id);
    expect(res.complete).toBe(false);
    expect(res.blocking).toEqual([{ task_id: id, reason: "task state not found" }]);
  });

  test("re-reads fresh at call time, not from a goal-time snapshot", () => {
    const cwd = tmpCwd();
    const id = doneTaskWithReceipt(cwd, "Freshly re-read task");
    const g = createGoal(cwd, "Fresh read goal", [id]);
    expect(checkGoalComplete(cwd, g.id).complete).toBe(true);
    // task gets abandoned after goal creation — the gate must reflect that
    const path = join(cwd, ".sddx", "tasks", `${id}.json`);
    const t = JSON.parse(readFileSync(path, "utf8"));
    t.phase = "ABANDONED";
    writeFileSync(path, `${JSON.stringify(t, null, 2)}\n`);
    const res = checkGoalComplete(cwd, g.id);
    expect(res.complete).toBe(false);
    expect(res.blocking).toEqual([{ task_id: id, reason: "phase ABANDONED" }]);
  });
});
