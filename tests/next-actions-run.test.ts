import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createBranchAt } from "../src/lib/git";
import { createGoal, goalId, runBranchName } from "../src/lib/goal";
import { detectRunState, renderMenu, resolveSelection, runActions } from "../src/lib/next-actions";
import { parseSpec } from "../src/lib/spec";
import {
  abandonOrRetry,
  createTask,
  readTask,
  taskId,
  transition,
  writeTask,
} from "../src/lib/task";
import { verifyTask } from "../src/lib/verify";
import { createWorktree, resolveBaseRef } from "../src/lib/worktree";
import { fixtureRepo } from "./fixtures";

function registerTask(mainCwd: string, sentence: string): { id: string; wtPath: string } {
  const spec = parseSpec(
    `task: ${sentence}\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\n`,
  ).spec!;
  const id = taskId(spec.task);
  const base = resolveBaseRef(mainCwd);
  const wtPath = createWorktree(mainCwd, id, base.sha);
  createTask(wtPath, spec, ".sddx/specs/x.yaml", {
    mode: "worktree",
    branch: `sddx/${id}`,
    base_sha: base.sha,
    path: relative(mainCwd, wtPath),
  });
  return { id, wtPath };
}

function registerGoal(mainCwd: string, sentence: string, taskIds: string[]) {
  const base = resolveBaseRef(mainCwd);
  const gid = goalId(sentence);
  const runBranch = runBranchName(gid);
  createBranchAt(mainCwd, runBranch, base.sha);
  return createGoal(mainCwd, sentence, taskIds, { id: gid, runBranch, baseSha: base.sha });
}

function completeTask(wtPath: string, id: string, file: string) {
  let t = readTask(wtPath, id);
  t = transition(t, "RED", { testExit: 1 });
  t = transition(t, "GREEN", { testExit: 0 });
  t = transition(t, "VERIFY");
  t.evidence.oracle_red = { exit_code: 1, at: new Date(0).toISOString() };
  writeTask(wtPath, t);
  writeFileSync(join(wtPath, file), `${id}\n`);
  const res = verifyTask(wtPath, id, { pluginVersion: "0.0.1" });
  if (res.verdict !== "pass") throw new Error(`fixture task ${id} failed to verify`);
}

function abandonTask(wtPath: string, id: string) {
  const t = readTask(wtPath, id);
  abandonOrRetry(t); // default retry policy: max_attempts 1 → terminal ABANDONED immediately
  writeTask(wtPath, t);
}

describe("detectRunState", () => {
  test("classifies merged, failed, and outstanding tasks", () => {
    const mainCwd = fixtureRepo();
    const merged = registerTask(mainCwd, "Merged task");
    const failed = registerTask(mainCwd, "Failed task");
    const outstanding = registerTask(mainCwd, "Outstanding task");
    const goal = registerGoal(mainCwd, "Mixed run", [merged.id, failed.id, outstanding.id]);

    completeTask(merged.wtPath, merged.id, "a.txt");
    abandonTask(failed.wtPath, failed.id);

    const state = detectRunState(mainCwd, goal.id);
    expect(state.mergedTaskIds).toEqual([merged.id]);
    expect(state.failedTaskIds).toEqual([failed.id]);
    expect(state.outstandingTaskIds).toEqual([outstanding.id]);
    expect(state.runBranch).toBe(goal.run_branch);
    expect(state.shipped).toBeNull();
  });
});

describe("runActions", () => {
  test("no create-pr/merge-to-target actions until something has merged", () => {
    const mainCwd = fixtureRepo();
    const t = registerTask(mainCwd, "Nothing merged yet");
    const goal = registerGoal(mainCwd, "Empty run", [t.id]);
    const actions = runActions(mainCwd, detectRunState(mainCwd, goal.id));
    expect(actions.some((a) => a.id === "create-pr")).toBe(false);
    expect(actions.some((a) => a.id === "merge-to-target")).toBe(false);
    expect(actions.some((a) => a.id === "review")).toBe(true);
    expect(actions.some((a) => a.id === "exit")).toBe(true);
  });

  test("Commit Remaining Changes doesn't appear when only the (never-committed) goal file is dirty", () => {
    const mainCwd = fixtureRepo();
    const t = registerTask(mainCwd, "Clean main checkout after merge");
    const goal = registerGoal(mainCwd, "Clean run", [t.id]);
    completeTask(t.wtPath, t.id, "a.txt");

    // the main checkout's only "dirty" content at this point is the
    // deliberately-uncommitted .sddx/goals/<id>.json — must not surface as
    // something to commit, nor crash if selected anyway
    const actions = runActions(mainCwd, detectRunState(mainCwd, goal.id));
    expect(actions.some((a) => a.id === "commit-remaining")).toBe(false);
  });

  test("a merged task unlocks create-pr, merge-to-target, and its own revert action", () => {
    const mainCwd = fixtureRepo();
    const t = registerTask(mainCwd, "Will be merged");
    const goal = registerGoal(mainCwd, "One task run", [t.id]);
    completeTask(t.wtPath, t.id, "a.txt");

    const state = detectRunState(mainCwd, goal.id);
    const actions = runActions(mainCwd, state);
    expect(actions.some((a) => a.id === "create-pr")).toBe(true);
    expect(actions.some((a) => a.id === "merge-to-target")).toBe(true);
    expect(actions.some((a) => a.id === `revert-${t.id}`)).toBe(true);
  });

  test("a failed task offers a retry action naming it", () => {
    const mainCwd = fixtureRepo();
    const t = registerTask(mainCwd, "Will fail");
    const goal = registerGoal(mainCwd, "Failing run", [t.id]);
    abandonTask(t.wtPath, t.id);

    const actions = runActions(mainCwd, detectRunState(mainCwd, goal.id));
    const retry = actions.find((a) => a.id === `retry-${t.id}`);
    expect(retry).toBeDefined();
    expect(retry?.label).toContain(t.id);
  });

  test("revert action reverts the task's merge and disappears on re-detection", () => {
    const mainCwd = fixtureRepo();
    const t = registerTask(mainCwd, "Revert via menu");
    const goal = registerGoal(mainCwd, "Revert via menu run", [t.id]);
    completeTask(t.wtPath, t.id, "revert-me.txt");

    const state = detectRunState(mainCwd, goal.id);
    const actions = runActions(mainCwd, state);
    const resolved = resolveSelection(`revert ${t.id}`, actions);
    expect("error" in resolved).toBe(false);
    if ("error" in resolved) throw new Error("unreachable");
    const result = resolved.run?.(mainCwd, { branch: state.runBranch });
    expect(result?.ok).toBe(true);

    const after = detectRunState(mainCwd, goal.id);
    expect(after.mergedTaskIds).toEqual([]);
    expect(
      spawnSync("git", ["cat-file", "-e", `${goal.run_branch}:revert-me.txt`], { cwd: mainCwd })
        .status,
    ).not.toBe(0);
  });

  test("menu renders and numeric selection matches natural-language selection", () => {
    const mainCwd = fixtureRepo();
    const t = registerTask(mainCwd, "Menu rendering task");
    const goal = registerGoal(mainCwd, "Menu run", [t.id]);
    completeTask(t.wtPath, t.id, "a.txt");

    const actions = runActions(mainCwd, detectRunState(mainCwd, goal.id));
    const menu = renderMenu(actions);
    expect(menu).toContain("Next Actions");
    expect(menu).toContain("Review Changes");

    const byNumber = resolveSelection("1", actions);
    const byName = resolveSelection("review changes", actions);
    expect("error" in byNumber).toBe(false);
    expect("error" in byName).toBe(false);
    if ("error" in byNumber || "error" in byName) throw new Error("unreachable");
    expect(byNumber.id).toBe(byName.id);
  });
});
