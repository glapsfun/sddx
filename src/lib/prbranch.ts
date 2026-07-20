import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { branchExists, forceDeleteBranch, git } from "./git";
import { resolveTaskState } from "./task";
import { removeWorktreeForced, resolveBaseRef, worktreesDir } from "./worktree";

export interface GoalBranchResult {
  branch: string;
  headSha: string;
  /** Left checked out at `headSha` on purpose — the caller needs it (all
   * cherry-picked receipts included) to render the PR body before removing it. */
  worktreePath: string;
}

export const goalBranchName = (goalId: string): string => `sddx/goal-${goalId}`;

function taskCommitSha(cwd: string, taskId: string): string {
  return git(cwd, "rev-parse", `refs/heads/sddx/${taskId}`);
}

/** Always starts fresh: a stale goal branch left over from a previous failed
 * `pr create` run is discarded rather than resumed. */
function resetGoalBranch(cwd: string, branch: string): void {
  if (branchExists(cwd, branch)) forceDeleteBranch(cwd, branch);
}

/**
 * Builds `sddx/goal-<goalId>` from the locally resolved base ref, cherry-picking
 * each task's atomic commit (the tip of `sddx/<task-id>`) in task-creation
 * order. On any conflict — or any other failure once the worktree exists — the
 * whole operation is rolled back: no worktree, no partial branch left behind.
 */
export function buildGoalBranch(cwd: string, goalId: string, taskIds: string[]): GoalBranchResult {
  if (taskIds.length === 0) throw new Error("cannot build a goal branch with zero tasks");

  // resolve every task's state + branch *once, up front* — before touching
  // git state — so a task with no dedicated branch (workspace mode "none"
  // has none) refuses cleanly instead of leaking a half-built worktree, and
  // so ordering-by-created_at doesn't re-resolve each task O(n log n) times
  // inside a sort comparator
  const resolved = taskIds.map((taskId) => {
    const task = resolveTaskState(cwd, taskId);
    if (!task) {
      throw new Error(`task ${taskId} could not be resolved while building the goal branch`);
    }
    if (!branchExists(cwd, `sddx/${taskId}`)) {
      throw new Error(
        `task ${taskId} has no sddx/${taskId} branch — workspace mode "none" tasks can't be ` +
          "cherry-picked into a goal PR; recreate the task with --workspace branch or worktree",
      );
    }
    return { taskId, createdAt: task.created_at, commitSha: taskCommitSha(cwd, taskId) };
  });
  const commits = resolved.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  const branch = goalBranchName(goalId);
  resetGoalBranch(cwd, branch);
  const base = resolveBaseRef(cwd);
  const worktreePath = join(worktreesDir(cwd), `goal-${goalId}`);
  git(cwd, "worktree", "add", "-q", worktreePath, "-b", branch, base.sha);

  try {
    for (const { taskId, commitSha } of commits) {
      const r = spawnSync("git", ["cherry-pick", commitSha], {
        cwd: worktreePath,
        encoding: "utf8",
      });
      if (r.status !== 0) {
        spawnSync("git", ["cherry-pick", "--abort"], { cwd: worktreePath });
        throw new Error(
          `cherry-pick failed for task ${taskId} while building ${branch}: ${(r.stderr ?? "").trim()}`,
        );
      }
    }
  } catch (e) {
    removeWorktreeForced(cwd, worktreePath);
    forceDeleteBranch(cwd, branch);
    throw e;
  }

  const headSha = git(worktreePath, "rev-parse", "HEAD");
  return { branch, headSha, worktreePath };
}
