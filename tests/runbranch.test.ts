import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { forceDeleteBranch } from "../src/lib/git";
import { currentlyMergedTaskIds, readGoal } from "../src/lib/goal";
import { resolveReceipt, resolveReceiptRaw } from "../src/lib/receipt";
import { integrateTaskIntoRunBranch, revertTaskMerge } from "../src/lib/runbranch";
import { createPlannedTask, resolveTaskState } from "../src/lib/task";
import { removeWorktreeForced } from "../src/lib/worktree";
import { fixtureRepo } from "./fixtures";
import { CLI, completeTask, createRun, doneFile, sddx, startTask } from "./helpers";

setDefaultTimeout(60_000);

const catFile = (cwd: string, spec: string) =>
  spawnSync("git", ["cat-file", "-e", spec], { cwd }).status;

/** Starts a task, writes its oracle file plus any extra files, and verifies it. */
function toReview(cwd: string, id: string, files: Record<string, string> = {}): string {
  const wt = startTask(cwd, id);
  writeFileSync(join(wt, doneFile(id)), "done\n");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(wt, path, ".."), { recursive: true });
    writeFileSync(join(wt, path), content);
  }
  const v = sddx(cwd, "verify", id);
  if (v.status !== 0) throw new Error(`verify ${id}: ${v.stderr}`);
  return wt;
}

function passReview(cwd: string, id: string) {
  const r = sddx(cwd, "review", "record", id, "--verdict", "pass", "--output", "json");
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout).data as {
    integration: { result: string; runBranch?: string; conflicts?: string[] };
  };
}

describe("integrateTaskIntoRunBranch (via a passing review)", () => {
  test("merges automatically and records the goal's merges log + task's integration field", () => {
    const cwd = fixtureRepo();
    const run = createRun(cwd, { tasks: [{ id: "T1" }] });
    toReview(cwd, "T1");
    const res = passReview(cwd, "T1");
    expect(res.integration.result).toBe("merged");

    const goal = readGoal(cwd, run.goalId);
    expect(goal.merges).toHaveLength(1);
    expect(goal.merges[0]).toMatchObject({ task_id: "T1", result: "merged" });
    expect(catFile(cwd, `${run.runBranch}:T1.done`)).toBe(0);

    const task = resolveTaskState(cwd, "T1");
    expect(task?.integration?.result).toBe("merged");
    expect(task?.integration?.run_branch).toBe(run.runBranch);
  });

  test("a merged task's receipt is still resolvable via the run branch after its own branch is deleted", () => {
    const cwd = fixtureRepo();
    createRun(cwd, { tasks: [{ id: "T1" }] });
    const { worktree } = completeTask(cwd, "T1");

    // what `sddx cleanup <id>` does: remove the worktree, then the branch
    removeWorktreeForced(cwd, worktree);
    forceDeleteBranch(cwd, "sddx/T1");

    expect(resolveReceipt(cwd, "T1")?.task_id).toBe("T1");
    expect(resolveReceiptRaw(cwd, "T1")).not.toBeNull();
  });

  test("a task with no goal is never merged", () => {
    const cwd = fixtureRepo();
    createPlannedTask(cwd, {
      id: "SOLO",
      title: "solo task",
      goal_id: "2026-01-01-no-such-goal",
      spec_path: ".sddx/specs/2026-01-01-no-such-goal.md",
      oracle: { type: "command", run: "true", expect: "exit 0" },
      scope: [],
      assumptions: [],
      depends_on: [],
    });
    expect(integrateTaskIntoRunBranch(cwd, "SOLO")).toEqual({ result: "none", reason: "no-goal" });
  });

  test("a goal task with no branch of its own is never merged", () => {
    const cwd = fixtureRepo();
    const run = createRun(cwd, { tasks: [{ id: "T1" }] });
    // still PLANNED: no worktree and no branch yet
    const before = spawnSync("git", ["for-each-ref"], { cwd, encoding: "utf8" }).stdout;
    expect(integrateTaskIntoRunBranch(cwd, "T1")).toEqual({
      result: "none",
      reason: "no-branch",
      runBranch: run.runBranch,
    });
    expect(spawnSync("git", ["for-each-ref"], { cwd, encoding: "utf8" }).stdout).toBe(before);
  });

  test("two sibling tasks in the same goal reviewed concurrently both end up merged (no lost update)", async () => {
    const cwd = fixtureRepo();
    const run = createRun(cwd, { tasks: [{ id: "T1" }, { id: "T2" }] });
    toReview(cwd, "T1");
    toReview(cwd, "T2");

    const review = (id: string) =>
      Bun.spawn(["bun", CLI, "review", "record", id, "--verdict", "pass"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
    const [p1, p2] = [review("T1"), review("T2")];
    const [exit1, exit2] = await Promise.all([p1.exited, p2.exited]);
    expect(exit1).toBe(0);
    expect(exit2).toBe(0);

    const after = readGoal(cwd, run.goalId);
    expect(currentlyMergedTaskIds(after).sort()).toEqual(["T1", "T2"]);
    expect(after.merges).toHaveLength(2);
  });

  test("a merge conflict aborts cleanly, is reported with its paths, and never blocks the task's own DONE/receipt", () => {
    const cwd = fixtureRepo();
    const run = createRun(cwd, { tasks: [{ id: "T1" }, { id: "T2" }] });
    // both write the same docs file, which no scope confines; T2 forked from
    // the run branch before T1's version landed, so merging it is add/add
    toReview(cwd, "T1", { "docs/shared.txt": "T1 version\n" });
    toReview(cwd, "T2", { "docs/shared.txt": "different content\n" });
    expect(passReview(cwd, "T1").integration.result).toBe("merged");
    const runTip = spawnSync("git", ["rev-parse", run.runBranch], { cwd, encoding: "utf8" }).stdout;

    const r = sddx(cwd, "review", "record", "T2", "--verdict", "pass", "--output", "json");
    expect(r.status).toBe(0); // the task's own review still passed
    const data = JSON.parse(r.stdout).data;
    expect(data.phase).toBe("DONE");
    expect(data.receiptPath).toBeTruthy();
    expect(data.integration.result).toBe("conflict");
    expect(data.integration.conflicts).toEqual(["docs/shared.txt"]);

    const entry = readGoal(cwd, run.goalId).merges.find((m) => m.task_id === "T2");
    expect(entry).toMatchObject({ task_id: "T2", result: "conflict" });
    expect(entry?.commit_sha).toBeUndefined();

    // the run branch itself is untouched by the aborted merge
    expect(spawnSync("git", ["rev-parse", run.runBranch], { cwd, encoding: "utf8" }).stdout).toBe(
      runTip,
    );
    const shared = spawnSync("git", ["show", `${run.runBranch}:docs/shared.txt`], {
      cwd,
      encoding: "utf8",
    });
    expect(shared.stdout).toBe("T1 version\n");
  });
});

describe("revertTaskMerge", () => {
  test("reverts a task's merge and records a reverted entry", () => {
    const cwd = fixtureRepo();
    const run = createRun(cwd, { tasks: [{ id: "T1" }] });
    completeTask(cwd, "T1");

    const before = readGoal(cwd, run.goalId);
    expect(before.merges).toHaveLength(1);
    const mergeSha = before.merges[0]?.commit_sha;

    const revertSha = revertTaskMerge(cwd, run.goalId, "T1");
    expect(revertSha).toBeTruthy();

    const after = readGoal(cwd, run.goalId);
    expect(after.merges).toHaveLength(2);
    expect(after.merges[1]).toMatchObject({ task_id: "T1", result: "reverted", reverts: mergeSha });
    expect(catFile(cwd, `${run.runBranch}:T1.done`)).not.toBe(0);
  });

  test("throws when the task has no current merge to revert", () => {
    const cwd = fixtureRepo();
    const run = createRun(cwd, { tasks: [{ id: "T1" }] });
    expect(() => revertTaskMerge(cwd, run.goalId, "T1")).toThrow(/no current merge/);
  });
});
