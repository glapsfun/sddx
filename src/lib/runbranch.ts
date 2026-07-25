import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { commit, git, stagePath } from "./git";
import { findGoalForTask, readGoal, writeGoal } from "./goal";
import { readTask, writeTask } from "./task";
import { removeWorktreeForced, resolveMainRepoRoot, worktreesDir } from "./worktree";

export interface IntegrationOutcome {
  result: "merged" | "conflict" | "none";
  /** Set only when `result` is "none" and the task belongs to a goal but has
   * no branch to merge (`--workspace none`) — distinguishes a real
   * integration gap from an ordinary task-with-no-goal no-op. */
  reason?: "no-goal" | "no-branch";
  runBranch?: string;
  mergeCommit?: string;
}

const LOCK_STALE_MS = 5 * 60_000;
const LOCK_TIMEOUT_MS = 30_000;

function gitCommonDir(cwd: string): string {
  const dir = git(cwd, "rev-parse", "--git-common-dir");
  return isAbsolute(dir) ? dir : join(cwd, dir);
}

/** Blocking mkdir-based lock, one per goal, shared across worktrees via the
 * git common dir — sibling tasks in the same goal finish `verify` in
 * parallel and would otherwise race on the same run-branch checkout and on
 * `goal.merges`' read-modify-write. Stale locks (a crashed holder) are stolen
 * after `LOCK_STALE_MS`; a live lock still held past `LOCK_TIMEOUT_MS` fails
 * loudly rather than hanging forever. */
function withGoalLock<T>(root: string, goalId: string, fn: () => T): T {
  const lockPath = join(gitCommonDir(root), `sddx-runbranch-${goalId}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch {
      if (existsSync(lockPath)) {
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) rmdirSync(lockPath);
        } catch {
          // vanished or already stolen — fall through to the deadline check
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for run-branch integration lock on goal ${goalId}`);
      }
      spawnSync("sleep", ["0.1"]);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lockPath);
    } catch {
      // already removed — nothing to do
    }
  }
}

/**
 * Merges a verified task's branch into its goal's run branch via a scratch
 * worktree (mirrors `materializeDependent`'s fan-in merge technique), under
 * the goal's lock so concurrent sibling tasks can't race on the checkout or
 * on `goal.merges`. Never throws for a task with no goal, or one created in
 * `--workspace none` mode — a conflict is reported in the result, not
 * thrown, since it's an integration fact about a verified task, not a verify
 * failure.
 */
export function integrateTaskIntoRunBranch(taskCwd: string, id: string): IntegrationOutcome {
  const root = resolveMainRepoRoot(taskCwd);
  const goal = findGoalForTask(root, id);
  if (!goal) return { result: "none", reason: "no-goal" };

  const task = readTask(taskCwd, id);
  const branch = task.workspace.branch;
  if (!branch) return { result: "none", reason: "no-branch", runBranch: goal.run_branch };

  const outcome = withGoalLock(root, goal.id, () => {
    const tmpPath = join(worktreesDir(root), `integrate-${id}`);
    git(root, "worktree", "add", "-q", tmpPath, goal.run_branch);
    let result: IntegrationOutcome;
    try {
      const r = spawnSync(
        "git",
        ["merge", "--no-ff", "-m", `sddx: merge ${id} into ${goal.run_branch}`, branch],
        { cwd: tmpPath, encoding: "utf8" },
      );
      if (r.status !== 0) {
        spawnSync("git", ["merge", "--abort"], { cwd: tmpPath });
        result = { result: "conflict", runBranch: goal.run_branch };
      } else {
        const mergeSha = git(tmpPath, "rev-parse", "HEAD");
        result = { result: "merged", runBranch: goal.run_branch, mergeCommit: mergeSha };
      }
    } finally {
      removeWorktreeForced(root, tmpPath);
    }

    const fresh = readGoal(root, goal.id); // re-read inside the lock — another holder may have updated it
    fresh.merges.push({
      task_id: id,
      ...(result.mergeCommit ? { commit_sha: result.mergeCommit } : {}),
      merged_at: new Date().toISOString(),
      result: result.result === "merged" ? "merged" : "conflict",
    });
    writeGoal(root, fresh); // plain fs write, never committed — see docs/explanation/architecture.md
    return result;
  });

  // Board-visible mirror on the task's own branch — a convenience copy; the
  // goal's `merges` log above stays the source of truth.
  task.integration = {
    run_branch: goal.run_branch,
    ...(outcome.mergeCommit ? { merge_commit: outcome.mergeCommit } : {}),
    merged_at: new Date().toISOString(),
    result: outcome.result === "merged" ? "merged" : "conflict",
  };
  writeTask(taskCwd, task);
  stagePath(taskCwd, join(".sddx", "tasks", `${id}.json`));
  commit(taskCwd, `sddx(${id}): record integration (${outcome.result})`);

  return outcome;
}

/**
 * Reverts a task's current merge from its goal's run branch with
 * `git revert -m 1`, appends a `reverted` entry to the goal's `merges` log,
 * and returns the new commit sha. Throws if the task has no current `merged`
 * entry to revert.
 */
export function revertTaskMerge(cwd: string, goalId: string, id: string): string {
  return withGoalLock(cwd, goalId, () => {
    const goal = readGoal(cwd, goalId);
    const latest = [...goal.merges].reverse().find((e) => e.task_id === id);
    if (latest?.result !== "merged" || !latest.commit_sha) {
      throw new Error(`task ${id} has no current merge in goal ${goalId} to revert`);
    }

    const tmpPath = join(worktreesDir(cwd), `revert-${id}`);
    git(cwd, "worktree", "add", "-q", tmpPath, goal.run_branch);
    let revertSha: string;
    try {
      git(tmpPath, "revert", "-m", "1", "--no-edit", latest.commit_sha);
      revertSha = git(tmpPath, "rev-parse", "HEAD");
    } finally {
      removeWorktreeForced(cwd, tmpPath);
    }

    goal.merges.push({
      task_id: id,
      commit_sha: revertSha,
      merged_at: new Date().toISOString(),
      result: "reverted",
      reverts: latest.commit_sha,
    });
    writeGoal(cwd, goal);
    return revertSha;
  });
}
