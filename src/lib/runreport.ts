import { git } from "./git";
import { currentlyMergedTaskIds, goalCounts, readGoal } from "./goal";
import { resolveTaskState } from "./task";

export interface RunReport {
  goalId: string;
  runBranch: string;
  targetBranch: string;
  baseSha: string;
  merged: number;
  failed: number;
  outstanding: number;
  total: number;
  diffStat: string;
  reviewCommands: string[];
}

/**
 * The run-completion report: what merged, what failed, what's still
 * outstanding, a `diff --stat` summary, and the exact commands to review the
 * combined result — everything `/sddx:run` needs to hand the user at the end
 * of a run, derived fresh from the goal file and task states, never cached.
 */
export function generateRunReport(cwd: string, goalId: string, targetBranch: string): RunReport {
  const goal = readGoal(cwd, goalId);
  const merged = currentlyMergedTaskIds(goal);
  const failed = goal.task_ids.filter(
    (id) => !merged.includes(id) && resolveTaskState(cwd, id)?.phase === "ABANDONED",
  );
  const outstanding = goal.task_ids.filter((id) => !merged.includes(id) && !failed.includes(id));
  const diffStat = git(cwd, "diff", "--stat", `${goal.base_sha}...${goal.run_branch}`);
  return {
    goalId: goal.id,
    runBranch: goal.run_branch,
    targetBranch,
    baseSha: goal.base_sha,
    merged: merged.length,
    failed: failed.length,
    outstanding: outstanding.length,
    total: goalCounts(goal).total,
    diffStat,
    reviewCommands: [
      `git switch ${goal.run_branch}`,
      `git diff ${targetBranch}...${goal.run_branch}`,
      `git log --oneline ${targetBranch}..${goal.run_branch}`,
    ],
  };
}

export function renderRunReport(r: RunReport): string {
  // "Completed" only once nothing is still outstanding — this report can be
  // requested at any point mid-run, not only at the very end.
  const lines = [
    r.outstanding > 0 ? "Run in progress" : "Run completed",
    "",
    `Review branch: ${r.runBranch}`,
    `Base branch remains unchanged: ${r.targetBranch}`,
    "",
    "Summary",
    `- ${r.merged} of ${r.total} task(s) merged`,
    ...(r.failed > 0 ? [`- ${r.failed} task(s) failed`] : []),
    ...(r.outstanding > 0 ? [`- ${r.outstanding} task(s) outstanding`] : []),
    ...(r.diffStat ? r.diffStat.split("\n").map((l) => `- ${l.trim()}`) : []),
    "",
    "Review commands",
    ...r.reviewCommands,
  ];
  return lines.join("\n");
}
