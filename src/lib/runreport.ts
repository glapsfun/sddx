import { git } from "./git";
import { currentlyMergedTaskIds, type GoalApproval, goalCounts, readGoal } from "./goal";
import { resolveReceiptRaw } from "./receipt";
import { resolveTaskState } from "./task";

/** One task's oracle and how it actually came out. */
export interface OracleOutcome {
  taskId: string;
  run: string;
  expect: string;
  /** `pass` only when a receipt exists — a verdict is never a claim. */
  verdict: "pass" | "abandoned" | "outstanding";
}

export interface RunReport {
  goalId: string;
  /** The goal sentence, so the summary states what was attempted. */
  goal: string;
  runBranch: string;
  targetBranch: string;
  baseSha: string;
  merged: number;
  failed: number;
  outstanding: number;
  total: number;
  diffStat: string;
  reviewCommands: string[];
  /** Per-task oracle outcomes, in the goal's task order. */
  oracles: OracleOutcome[];
  /** Every assumption recorded across the goal's tasks, deduplicated. */
  assumptions: string[];
  /** How this goal's plan was approved. Absent for a goal predating provenance. */
  approval?: GoalApproval;
}

/**
 * The run-completion report: what merged, what failed, what's still
 * outstanding, a `diff --stat` summary, and the exact commands to review the
 * combined result — everything `/sddx:run` needs to hand the user at the end
 * of a run, derived fresh from the goal file and task states, never cached.
 *
 * Identical across both execution modes by construction: the only
 * mode-dependent content is the approval line and any recorded assumptions.
 */
export function generateRunReport(cwd: string, goalId: string, targetBranch: string): RunReport {
  const goal = readGoal(cwd, goalId);
  const merged = currentlyMergedTaskIds(goal);
  const failed = goal.task_ids.filter(
    (id) => !merged.includes(id) && resolveTaskState(cwd, id)?.phase === "ABANDONED",
  );
  const outstanding = goal.task_ids.filter((id) => !merged.includes(id) && !failed.includes(id));
  // Excludes sddx's own bookkeeping. The goal record is committed to the run
  // branch (it holds the merge log, the single source of truth for integration
  // state, which as loose local state could not be audited and did not travel
  // with a push) — but it is not work the user is reviewing, and a run where
  // nothing merged must still report an empty diff.
  const diffStat = git(
    cwd,
    "diff",
    "--stat",
    `${goal.base_sha}...${goal.run_branch}`,
    "--",
    ".",
    ":(exclude).sddx/goals",
  );

  const oracles: OracleOutcome[] = [];
  const assumptions: string[] = [];
  for (const id of goal.task_ids) {
    const task = resolveTaskState(cwd, id);
    for (const a of task?.assumptions ?? []) if (!assumptions.includes(a)) assumptions.push(a);
    // `pass` requires a receipt — a task's own phase is not evidence. Use the
    // shared cross-location lookup: a receipt may live in the task's worktree,
    // the main checkout, its own `sddx/<id>` branch, or the run branch, and a
    // swept worktree or branch-mode task has none of the first two.
    const hasReceipt = resolveReceiptRaw(cwd, id) !== null;
    oracles.push({
      taskId: id,
      run: task?.oracle.run ?? "(unknown)",
      expect: task?.oracle.expect ?? "(unknown)",
      verdict: hasReceipt ? "pass" : task?.phase === "ABANDONED" ? "abandoned" : "outstanding",
    });
  }

  return {
    goalId: goal.id,
    goal: goal.goal,
    runBranch: goal.run_branch,
    targetBranch,
    baseSha: goal.base_sha,
    merged: merged.length,
    failed: failed.length,
    outstanding: outstanding.length,
    total: goalCounts(goal).total,
    diffStat,
    oracles,
    assumptions,
    ...(goal.approval ? { approval: goal.approval } : {}),
    reviewCommands: [
      `git switch ${goal.run_branch}`,
      `git diff ${targetBranch}...${goal.run_branch}`,
      `git log --oneline ${targetBranch}..${goal.run_branch}`,
    ],
  };
}

/** The approval line: effective mode, the plan it descends from, and any
 * recorded degradation from `auto`. Deliberately does not claim who approved —
 * see the audit's bounded-claims note. */
function approvalLines(a: GoalApproval): string[] {
  const lines = ["Approval", `- mode: ${a.mode}`, `- plan: ${a.plan_sha256.slice(0, 12)}`];
  if (a.requested_mode && a.requested_mode !== a.mode) {
    lines.push(`- requested ${a.requested_mode}, ran as ${a.mode}`);
    if (a.degraded_reason) lines.push(`- reason: ${a.degraded_reason}`);
  }
  return [...lines, ""];
}

export function renderRunReport(r: RunReport): string {
  // "Completed" only once nothing is still outstanding — this report can be
  // requested at any point mid-run, not only at the very end.
  const lines = [
    r.outstanding > 0 ? "Run in progress" : "Run completed",
    "",
    `Goal: ${r.goal}`,
    `Review branch: ${r.runBranch}`,
    `Base branch remains unchanged: ${r.targetBranch}`,
    "",
    ...(r.approval ? approvalLines(r.approval) : []),
    "Summary",
    `- ${r.merged} of ${r.total} task(s) merged`,
    ...(r.failed > 0 ? [`- ${r.failed} task(s) failed`] : []),
    ...(r.outstanding > 0 ? [`- ${r.outstanding} task(s) outstanding`] : []),
    ...(r.diffStat ? r.diffStat.split("\n").map((l) => `- ${l.trim()}`) : []),
    "",
    "Oracle results",
    ...r.oracles.map((o) => `- ${o.taskId}: ${o.verdict} — ${o.run} (expect ${o.expect})`),
    "",
    ...(r.assumptions.length > 0 ? ["Assumptions", ...r.assumptions.map((a) => `- ${a}`), ""] : []),
    "Review commands",
    ...r.reviewCommands,
  ];
  return lines.join("\n");
}
