import { git } from "./git";
import {
  currentlyMergedTaskIds,
  type GoalApproval,
  goalCounts,
  type MergeEntry,
  readGoal,
} from "./goal";
import { resolveReceiptPath } from "./receipt";
import { blockedOn, resolveTaskState, skippedOn } from "./task";
import { resolveMainRepoRoot } from "./worktree";

/** One task's oracle and how it actually came out. */
export interface OracleOutcome {
  taskId: string;
  run: string;
  expect: string;
  /** `pass` only when a receipt exists — a verdict is never a claim. */
  verdict: "pass" | "abandoned" | "outstanding";
}

/**
 * Where a task actually ended up.
 *
 * `merged` and `failed` were the only outcomes the report distinguished, so a
 * task whose merge CONFLICTED read as "outstanding" — indistinguishable from
 * one still being worked on, even though it has a passing oracle and a receipt
 * and needs a human to resolve a merge. Likewise a dependent skipped because
 * its parent was abandoned looked like work still in flight.
 */
export type TaskStatus = "merged" | "failed" | "skipped" | "blocked" | "conflicted" | "outstanding";

export interface TaskOutcome {
  taskId: string;
  status: TaskStatus;
  /** The oracle and its verdict, as `OracleOutcome` reports them. */
  oracle: OracleOutcome;
  /** Path of the receipt backing a `pass`, or null when there is none. A
   * verdict the reader cannot open is a claim, which is what receipts replace. */
  receiptPath: string | null;
  /** The task's most recent integration result, or null if never attempted. */
  integration: "merged" | "conflict" | "reverted" | null;
  /** For `blocked`/`skipped`, the ancestor responsible. */
  because: string | null;
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
  skipped: number;
  blocked: number;
  conflicted: number;
  outstanding: number;
  total: number;
  diffStat: string;
  reviewCommands: string[];
  /** Per-task outcome, in the goal's task order. Every task appears exactly
   * once, and the counts above are derived from these — they cannot disagree. */
  tasks: TaskOutcome[];
  /** Per-task oracle outcomes, in the goal's task order. Retained alongside
   * `tasks` for callers that only want the oracle view. */
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
  // Run from the repository root, never the caller's cwd. A pathspec is
  // relative to cwd, and so is git's own default diff scope — reporting from a
  // subdirectory silently truncated the summary to that subtree, showing a
  // reviewer a materially incomplete picture of what the run changed. The goal
  // record itself needs no exclusion: it lives in `refs/sddx/goals/*`, not in
  // the run branch's tree.
  const diffStat = git(
    resolveMainRepoRoot(cwd),
    "diff",
    "--stat",
    `${goal.base_sha}...${goal.run_branch}`,
  );

  const oracles: OracleOutcome[] = [];
  const tasks: TaskOutcome[] = [];
  const assumptions: string[] = [];
  // Most recent integration attempt per task, read from the goal's merge log —
  // the declared source of truth; `task.integration` is a derived mirror.
  const latestMerge = new Map<string, MergeEntry>();
  for (const e of goal.merges) latestMerge.set(e.task_id, e);

  for (const id of goal.task_ids) {
    const task = resolveTaskState(cwd, id);
    for (const a of task?.assumptions ?? []) if (!assumptions.includes(a)) assumptions.push(a);
    // `pass` requires a receipt — a task's own phase is not evidence. Use the
    // shared cross-location lookup: a receipt may live in the task's worktree,
    // the main checkout, its own `sddx/<id>` branch, or the run branch, and a
    // swept worktree or branch-mode task has none of the first two.
    const receiptPath = resolveReceiptPath(cwd, id);
    const oracle: OracleOutcome = {
      taskId: id,
      run: task?.oracle.run ?? "(unknown)",
      expect: task?.oracle.expect ?? "(unknown)",
      verdict: receiptPath ? "pass" : task?.phase === "ABANDONED" ? "abandoned" : "outstanding",
    };
    oracles.push(oracle);

    const entry = latestMerge.get(id) ?? null;
    const skipper = task ? skippedOn(cwd, task) : null;
    const blocker = task ? blockedOn(cwd, task) : null;
    // Precedence mirrors the board's: a terminal outcome for the task itself
    // outranks anything inherited from an ancestor.
    const status: TaskStatus = merged.includes(id)
      ? "merged"
      : failed.includes(id)
        ? "failed"
        : entry?.result === "conflict"
          ? "conflicted"
          : skipper
            ? "skipped"
            : blocker
              ? "blocked"
              : "outstanding";
    tasks.push({
      taskId: id,
      status,
      oracle,
      receiptPath,
      integration: entry?.result ?? null,
      because: skipper ?? blocker ?? null,
    });
  }
  const count = (s: TaskStatus): number => tasks.filter((t) => t.status === s).length;

  return {
    goalId: goal.id,
    goal: goal.goal,
    runBranch: goal.run_branch,
    targetBranch,
    baseSha: goal.base_sha,
    // Derived from `tasks`, so a count can never disagree with the per-task
    // listing sitting next to it in the same summary.
    merged: count("merged"),
    failed: count("failed"),
    skipped: count("skipped"),
    blocked: count("blocked"),
    conflicted: count("conflicted"),
    outstanding: count("outstanding"),
    total: goalCounts(goal).total,
    diffStat,
    tasks,
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
  // "Completed" means every task merged. Keying it on `outstanding` alone
  // called a run complete while a task sat failed, skipped, or verified-but-
  // not-integrated — the summary's headline contradicting its own counts three
  // lines below. This report can be requested at any point mid-run.
  const done = r.merged === r.total;
  const stalled = r.outstanding === 0 && !done;
  const lines = [
    done ? "Run completed" : stalled ? "Run finished with unresolved tasks" : "Run in progress",
    "",
    `Goal: ${r.goal}`,
    `Review branch: ${r.runBranch}`,
    `Target branch remains unchanged: ${r.targetBranch}`,
    "",
    ...(r.approval ? approvalLines(r.approval) : []),
    "Summary",
    `- ${r.merged} of ${r.total} task(s) merged`,
    // Only non-zero buckets are printed: a clean run should not have to be read
    // past five "0 task(s)" lines to see that it worked. The JSON rendering
    // carries every count regardless.
    ...(r.failed > 0 ? [`- ${r.failed} task(s) failed`] : []),
    ...(r.conflicted > 0 ? [`- ${r.conflicted} task(s) verified but not integrated`] : []),
    ...(r.skipped > 0 ? [`- ${r.skipped} task(s) skipped`] : []),
    ...(r.blocked > 0 ? [`- ${r.blocked} task(s) blocked`] : []),
    ...(r.outstanding > 0 ? [`- ${r.outstanding} task(s) outstanding`] : []),
    ...(r.diffStat ? r.diffStat.split("\n").map((l) => `- ${l.trim()}`) : []),
    "",
    "Tasks",
    ...r.tasks.map((t) => {
      const why = t.because ? ` (${t.because})` : "";
      const receipt = t.receiptPath ? ` — receipt ${t.receiptPath}` : "";
      return `- ${t.taskId}: ${t.status}${why}${receipt}`;
    }),
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
