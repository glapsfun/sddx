import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createBranchAt, forceDeleteBranch, headSha } from "../src/lib/git";
import {
  createGoal,
  currentlyMergedTaskIds,
  goalId,
  readGoal,
  runBranchName,
} from "../src/lib/goal";
import { resolveReceipt, resolveReceiptRaw } from "../src/lib/receipt";
import { revertTaskMerge } from "../src/lib/runbranch";
import { parseSpec } from "../src/lib/spec";
import {
  createTask,
  readTask,
  resolveTaskState,
  taskId,
  transition,
  writeTask,
} from "../src/lib/task";
import { verifyTask } from "../src/lib/verify";
import { createWorktree, removeWorktreeForced, resolveBaseRef } from "../src/lib/worktree";
import { fixtureRepo } from "./fixtures";
import { repoRoot } from "./helpers";

const g = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** Registers a worktree-mode task forked from `mainCwd`'s resolved base ref —
 * the same default path `graph create` uses, and the only mode where the
 * main checkout (where the goal file lives) is never disturbed by a task's
 * own branch/commits. */
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

/** Creates a goal and its run branch — must exist before a listed task's own
 * `verifyTask` call for the automatic merge step to find it. */
function registerGoal(mainCwd: string, sentence: string, taskIds: string[]) {
  const base = resolveBaseRef(mainCwd);
  const gid = goalId(sentence);
  const runBranch = runBranchName(gid);
  createBranchAt(mainCwd, runBranch, base.sha);
  return createGoal(mainCwd, sentence, taskIds, { id: gid, runBranch, baseSha: base.sha });
}

function driveToVerify(taskCwd: string, id: string, file: string, content: string) {
  let t = readTask(taskCwd, id);
  t = transition(t, "RED", { testExit: 1 });
  t = transition(t, "GREEN", { testExit: 0 });
  t = transition(t, "VERIFY");
  t.evidence.oracle_red = { exit_code: 1, at: new Date(0).toISOString() };
  writeTask(taskCwd, t);
  writeFileSync(join(taskCwd, file), content);
  return verifyTask(taskCwd, id, { pluginVersion: "0.0.1" });
}

/** Drives a registered task through RED→GREEN→VERIFY→DONE. */
function completeTask(taskCwd: string, id: string, file: string) {
  const res = driveToVerify(taskCwd, id, file, `${id}\n`);
  if (res.verdict !== "pass") throw new Error(`fixture task ${id} failed to verify`);
  return res;
}

describe("integrateTaskIntoRunBranch (via verifyTask)", () => {
  test("merges automatically and records the goal's merges log + task's integration field", () => {
    const mainCwd = fixtureRepo();
    const t = registerTask(mainCwd, "Auto merge task");
    const goal = registerGoal(mainCwd, "Auto merge goal", [t.id]);
    const res = completeTask(t.wtPath, t.id, "a.txt");
    expect(res.integration?.result).toBe("merged");

    const updatedGoal = readGoal(mainCwd, goal.id);
    expect(updatedGoal.merges).toHaveLength(1);
    expect(updatedGoal.merges[0]).toMatchObject({ task_id: t.id, result: "merged" });
    expect(g(mainCwd, "cat-file", "-e", `${goal.run_branch}:a.txt`)).toBe("");

    const task = resolveTaskState(mainCwd, t.id);
    expect(task?.integration?.result).toBe("merged");
    expect(task?.integration?.run_branch).toBe(goal.run_branch);
  });

  test("a merged task's receipt is still resolvable via the run branch after its own branch is deleted", () => {
    const mainCwd = fixtureRepo();
    const t = registerTask(mainCwd, "Cleaned up after merge");
    registerGoal(mainCwd, "Cleanup goal", [t.id]);
    completeTask(t.wtPath, t.id, "a.txt");

    // simulate `sddx cleanup <id>`: remove the worktree, then the branch
    removeWorktreeForced(mainCwd, t.wtPath);
    forceDeleteBranch(mainCwd, `sddx/${t.id}`);

    expect(resolveReceipt(mainCwd, t.id)?.task_id).toBe(t.id);
    expect(resolveReceiptRaw(mainCwd, t.id)).not.toBeNull();
  });

  test("a task with no goal is never merged — verify passes with integration result none", () => {
    const mainCwd = fixtureRepo();
    const t = registerTask(mainCwd, "Solo task, no goal");
    const res = completeTask(t.wtPath, t.id, "solo.txt");
    expect(res.integration).toEqual({ result: "none", reason: "no-goal" });
  });

  test("a --workspace none task (no branch) is never merged even inside a goal", () => {
    const mainCwd = fixtureRepo();
    const spec = parseSpec(
      'task: No branch task\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\n',
    ).spec!;
    const id = taskId(spec.task);
    createTask(mainCwd, spec, ".sddx/specs/x.yaml", {
      mode: "worktree",
      branch: null,
      base_sha: headSha(mainCwd),
    });
    const goal = registerGoal(mainCwd, "No branch goal", [id]);
    const res = driveToVerify(mainCwd, id, "x.txt", "x\n");
    expect(res.verdict).toBe("pass");
    expect(res.integration).toEqual({
      result: "none",
      reason: "no-branch",
      runBranch: goal.run_branch,
    });
  });

  test("two sibling tasks in the same goal verifying concurrently both end up merged (no lost update)", async () => {
    const mainCwd = fixtureRepo();
    const t1 = registerTask(mainCwd, "Concurrent task one");
    const t2 = registerTask(mainCwd, "Concurrent task two");
    const goal = registerGoal(mainCwd, "Concurrent goal", [t1.id, t2.id]);

    function prepareForVerify(taskCwd: string, id: string, file: string) {
      let t = readTask(taskCwd, id);
      t = transition(t, "RED", { testExit: 1 });
      t = transition(t, "GREEN", { testExit: 0 });
      t = transition(t, "VERIFY");
      t.evidence.oracle_red = { exit_code: 1, at: new Date(0).toISOString() };
      writeTask(taskCwd, t);
      writeFileSync(join(taskCwd, file), `${id}\n`);
    }
    prepareForVerify(t1.wtPath, t1.id, "c1.txt");
    prepareForVerify(t2.wtPath, t2.id, "c2.txt");

    const cliSrc = join(repoRoot, "src/cli.ts");
    const spawnVerify = (wtPath: string, id: string) =>
      Bun.spawn(["bun", cliSrc, "verify", id], { cwd: wtPath, stdout: "pipe", stderr: "pipe" });
    const [p1, p2] = [spawnVerify(t1.wtPath, t1.id), spawnVerify(t2.wtPath, t2.id)];
    const [exit1, exit2] = await Promise.all([p1.exited, p2.exited]);
    expect(exit1).toBe(0);
    expect(exit2).toBe(0);

    const after = readGoal(mainCwd, goal.id);
    expect(currentlyMergedTaskIds(after).sort()).toEqual([t1.id, t2.id].sort());
    expect(after.merges).toHaveLength(2);
  });

  test("a merge conflict aborts cleanly, is reported, and never blocks the task's own DONE/receipt", () => {
    const mainCwd = fixtureRepo();
    const t1 = registerTask(mainCwd, "First conflicting task");
    const t2 = registerTask(mainCwd, "Second conflicting task");
    const goal = registerGoal(mainCwd, "Conflict goal", [t1.id, t2.id]);
    completeTask(t1.wtPath, t1.id, "shared.txt");

    // t2 forked from the same base as t1, before t1's change existed, so it
    // also newly adds shared.txt — merging it into a run branch that already
    // has t1's version is an add/add conflict.
    const res = driveToVerify(t2.wtPath, t2.id, "shared.txt", "different content\n");

    expect(res.verdict).toBe("pass"); // the task's own oracle still passed
    expect(res.integration?.result).toBe("conflict");

    const updatedGoal = readGoal(mainCwd, goal.id);
    const entry = updatedGoal.merges.find((m) => m.task_id === t2.id);
    expect(entry).toMatchObject({ task_id: t2.id, result: "conflict" });
    expect(entry?.commit_sha).toBeUndefined();

    // the run branch itself is untouched by the aborted merge
    expect(g(mainCwd, "log", "--oneline", goal.run_branch)).not.toContain("different content");
  });
});

describe("revertTaskMerge", () => {
  test("reverts a task's merge and records a reverted entry", () => {
    const mainCwd = fixtureRepo();
    const t = registerTask(mainCwd, "Task to revert");
    const goal = registerGoal(mainCwd, "Revert goal", [t.id]);
    completeTask(t.wtPath, t.id, "revert-me.txt");

    const before = readGoal(mainCwd, goal.id);
    expect(before.merges).toHaveLength(1);
    const mergeSha = before.merges[0]!.commit_sha;

    const revertSha = revertTaskMerge(mainCwd, goal.id, t.id);
    expect(revertSha).toBeTruthy();

    const after = readGoal(mainCwd, goal.id);
    expect(after.merges).toHaveLength(2);
    expect(after.merges[1]).toMatchObject({ task_id: t.id, result: "reverted", reverts: mergeSha });

    expect(
      spawnSync("git", ["cat-file", "-e", `${goal.run_branch}:revert-me.txt`], { cwd: mainCwd })
        .status,
    ).not.toBe(0);
  });

  test("throws when the task has no current merge to revert", () => {
    const mainCwd = fixtureRepo();
    const t = registerTask(mainCwd, "Never merged task");
    const goal = registerGoal(mainCwd, "Never merged goal", [t.id]);
    expect(() => revertTaskMerge(mainCwd, goal.id, t.id)).toThrow(/no current merge/);
  });
});
