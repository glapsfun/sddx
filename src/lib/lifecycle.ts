// Task lifecycle commands that move a task between PLANNED, IN_PROGRESS and
// ABANDONED: starting its worktree, listing what can start, and abandoning with
// the retry and dependency-failure policies applied.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { profile } from "./config";
import { type Goal, readGoal } from "./goal";
import { clearProofRecord } from "./proof";
import {
  abandonOrRetry,
  assertV6,
  blockedOn,
  failurePolicyOf,
  type RetryOutcome,
  readTask,
  resolveTaskState,
  type TaskState,
  taskHome,
  taskPath,
  transition,
  writeTask,
} from "./task";
import { releaseForRetry, resolveMainRepoRoot, startTaskWorkspace } from "./worktree";

/** The goal-halting failure, if a `block`-policy task has an abandoned parent. */
export function goalHalt(root: string, goal: Goal): string | null {
  for (const id of goal.task_ids) {
    const t = resolveTaskState(root, id);
    if (!t || failurePolicyOf(t) !== "block") continue;
    for (const parentId of t.depends_on ?? []) {
      const parent = resolveTaskState(root, parentId);
      if (parent?.phase === "ABANDONED") {
        return `task ${parentId} was abandoned and ${id} declares on_dependency_failure: block, so goal ${goal.id} is halted`;
      }
    }
  }
  return null;
}

export interface Started {
  task: TaskState;
  path: string;
  baseSha: string;
  reused: boolean;
}

export function startTask(cwd: string, id: string): Started {
  const root = resolveMainRepoRoot(cwd);
  const home = taskHome(root, id);
  if (!home) throw new Error(`no such task: ${id}`);
  const task = readTask(home, id);
  assertV6(task);
  if (task.phase !== "PLANNED") {
    throw new Error(`task ${id} is ${task.phase}; task start requires PLANNED`);
  }
  const blocker = blockedOn(root, task);
  if (blocker) {
    const parent = resolveTaskState(root, blocker);
    throw new Error(
      `cannot start ${id}: dependency ${blocker} is ${parent?.phase ?? "missing"}, not DONE`,
    );
  }
  const goal = readGoal(root, task.goal_id);
  const halt = goalHalt(root, goal);
  if (halt) throw new Error(`cannot start ${id}: ${halt}`);

  const ws = startTaskWorkspace(root, task, goal.run_branch);
  task.workspace = {
    branch: `sddx/${id}`,
    base_sha: ws.baseSha,
    path: join(".sddx-worktrees", id),
  };
  task.profile = profile(root);
  if (task.profile === "strict") task.strict = { runs: [] };
  transition(task, "IN_PROGRESS");
  writeTask(ws.path, task);
  if (home === root) rmSync(taskPath(root, id), { force: true });
  return { task, path: ws.path, baseSha: ws.baseSha, reused: ws.reused };
}

/** PLANNED tasks of a goal whose dependencies are all DONE, unless the goal is halted. */
export function readyTasks(cwd: string, goalId: string): string[] {
  const root = resolveMainRepoRoot(cwd);
  const goal = readGoal(root, goalId);
  if (goalHalt(root, goal)) return [];
  return goal.task_ids.filter((id) => {
    const t = resolveTaskState(root, id);
    return t?.phase === "PLANNED" && blockedOn(root, t) === null;
  });
}

export interface Abandoned extends RetryOutcome {
  task: TaskState;
  skipped: string[];
}

/**
 * Writes a terminal state to the main checkout and drops the worktree copy. A
 * worktree is disposable once its task is finished, so the record of an
 * abandonment must not live only there: sweep would delete it, and with it the
 * fact that halts a `block`-policy goal.
 */
function persistTerminal(root: string, home: string, task: TaskState): void {
  writeTask(root, task);
  if (home !== root) rmSync(taskPath(home, task.id), { force: true });
}

/** Marks every `skip`-policy descendant of an abandoned task as abandoned too. */
function cascadeSkips(root: string, goal: Goal, failedId: string): string[] {
  const skipped: string[] = [];
  const queue = [failedId];
  while (queue.length > 0) {
    const parentId = queue.shift() as string;
    for (const id of goal.task_ids) {
      const home = taskHome(root, id);
      if (!home) continue;
      const t = readTask(home, id);
      if (t.phase !== "PLANNED" || !(t.depends_on ?? []).includes(parentId)) continue;
      if (failurePolicyOf(t) !== "skip") continue;
      t.abandon_reason = "skipped";
      t.skipped_on = parentId;
      transition(t, "ABANDONED", `skipped: dependency ${parentId} was abandoned`);
      persistTerminal(root, home, t);
      skipped.push(id);
      queue.push(id);
    }
  }
  return skipped;
}

export function abandonTask(cwd: string, id: string, reason: string): Abandoned {
  const root = resolveMainRepoRoot(cwd);
  const home = taskHome(root, id);
  if (!home) throw new Error(`no such task: ${id}`);
  const task = readTask(home, id);
  const outcome = abandonOrRetry(task, reason);
  clearProofRecord(root, id);
  if (outcome.retried) {
    const hadWorktree = task.workspace !== undefined;
    releaseForRetry(root, task);
    if (hadWorktree && task.workspace === undefined) {
      writeTask(root, task);
    } else {
      writeTask(home, task);
    }
    return { ...outcome, task, skipped: [] };
  }
  persistTerminal(root, home, task);
  const skipped = cascadeSkips(root, readGoal(root, task.goal_id), id);
  return { ...outcome, task, skipped };
}
