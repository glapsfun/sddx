import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dependsOnList, resolveTaskState, sddxDir, taskId } from "./task";

export type MergeResult = "merged" | "conflict" | "reverted";

export interface MergeEntry {
  task_id: string;
  /** The merge (or revert) commit sha on the run branch. Absent for a conflict
   * entry — nothing landed on the run branch when a merge conflicts. */
  commit_sha?: string;
  merged_at?: string;
  result: MergeResult;
  /** Set only on a `reverted` entry: the original `merged` entry's commit_sha. */
  reverts?: string;
}

export interface Goal {
  id: string;
  goal: string;
  task_ids: string[];
  /** Dependency edges: task id → its predecessor task id(s) (fan-in allowed). A
   * legacy single-string value (the pre-DAG shape) is still readable via
   * `depsList()`. Absent/empty for a goal of all-root tasks. Set by `graph create`. */
  deps?: Record<string, string | string[]>;
  /** The live integration branch this goal's verified tasks merge into (see
   * `run-branch-integration`). Named `sddx/run-<id>`, created before any task
   * worktree, at `base_sha`. */
  run_branch: string;
  base_sha: string;
  /** One entry per integration attempt, in the order they happened. A task can
   * appear more than once (e.g. `merged` then later `reverted`). */
  merges: MergeEntry[];
  created_at: string;
  updated_at: string;
  /** Set once by `sddx pr create` after a successful PR/MR open from the run branch. */
  shipped?: { pr_url: string; at: string };
}

/** Normalizes a `Goal.deps` entry to a list, same read-compat as `dependsOnList`. */
export function depsList(
  g: { deps?: Record<string, string | string[]> },
  taskId: string,
): string[] {
  const d = g.deps?.[taskId];
  if (d === undefined) return [];
  return dependsOnList({ depends_on: d });
}

export const goalsDir = (cwd: string): string => join(sddxDir(cwd), "goals");
export const goalPath = (cwd: string, id: string): string => join(goalsDir(cwd), `${id}.json`);

/** Same UTC-date-plus-slug derivation as `taskId` — collisions with a task id are
 * harmless since goals and tasks live in separate directories and the run
 * branch carries a `run-` prefix that keeps branch names distinct. */
export const goalId = (sentence: string, date = new Date()): string => taskId(sentence, date);

/** `sddx/run-<goalId>` — the goal's live integration branch name. */
export const runBranchName = (id: string): string => `sddx/run-${id}`;

export interface CreateGoalOptions {
  deps?: Record<string, string[]>;
  /** Precomputed goal id, so callers that already derived it (to name the run
   * branch before any task exists) don't risk a second, possibly different,
   * derivation if this happens to run across a UTC day boundary. */
  id?: string;
  runBranch: string;
  baseSha: string;
}

export function createGoal(
  cwd: string,
  goalSentence: string,
  taskIds: string[],
  opts: CreateGoalOptions,
): Goal {
  if (taskIds.length === 0) {
    throw new Error("a goal requires at least one task id");
  }
  const now = new Date().toISOString();
  const id = opts.id ?? goalId(goalSentence);
  const path = goalPath(cwd, id);
  if (existsSync(path)) throw new Error(`goal ${id} already exists at ${path}`);
  for (const tid of taskIds) {
    if (!resolveTaskState(cwd, tid)) {
      throw new Error(`task ${tid} does not exist — cannot register it in a goal`);
    }
  }
  const g: Goal = {
    id,
    goal: goalSentence,
    task_ids: taskIds,
    ...(opts.deps && Object.keys(opts.deps).length > 0 ? { deps: opts.deps } : {}),
    run_branch: opts.runBranch,
    base_sha: opts.baseSha,
    merges: [],
    created_at: now,
    updated_at: now,
  };
  mkdirSync(goalsDir(cwd), { recursive: true });
  writeFileSync(path, `${JSON.stringify(g, null, 2)}\n`);
  return g;
}

export function readGoal(cwd: string, id: string): Goal {
  const path = goalPath(cwd, id);
  if (!existsSync(path)) throw new Error(`no such goal: ${id} (${path})`);
  const g = JSON.parse(readFileSync(path, "utf8")) as Goal;
  if (typeof g.run_branch !== "string" || typeof g.base_sha !== "string" || !g.merges) {
    throw new Error(
      `goal ${id} (${path}) is missing run_branch/base_sha/merges — written by an ` +
        "incompatible sddx version; recreate it with the current graph/goal create",
    );
  }
  return g;
}

export function writeGoal(cwd: string, g: Goal): void {
  g.updated_at = new Date().toISOString();
  writeFileSync(goalPath(cwd, g.id), `${JSON.stringify(g, null, 2)}\n`);
}

/** Scans every goal file in `cwd` for one whose `task_ids` includes `taskId` —
 * the reverse lookup a task needs at verify time to find its own goal (goals
 * are cross-task and always live in the main checkout, never inside a task's
 * own worktree, so this always reads from the main repo root). */
export function findGoalForTask(cwd: string, id: string): Goal | null {
  const dir = goalsDir(cwd);
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    let g: Goal;
    try {
      g = JSON.parse(readFileSync(join(dir, f), "utf8")) as Goal;
    } catch {
      continue;
    }
    if (g.task_ids.includes(id)) return g;
  }
  return null;
}

/** A task counts as currently merged if its most recent `merges` entry (in
 * array order) has `result: "merged"` — a later `reverted` entry supersedes it. */
export function currentlyMergedTaskIds(g: Goal): string[] {
  const latestByTask = new Map<string, MergeEntry>();
  for (const entry of g.merges) latestByTask.set(entry.task_id, entry);
  return [...latestByTask.values()].filter((e) => e.result === "merged").map((e) => e.task_id);
}

export interface GoalCounts {
  merged: number;
  outstanding: number;
  total: number;
}

/** Read-only reporting helper — no gate, no pass/fail. `outstanding` is every
 * task not currently merged (still in flight, failed, or conflicted), re-read
 * fresh from `g.merges` rather than any cached snapshot. */
export function goalCounts(g: Goal): GoalCounts {
  const merged = currentlyMergedTaskIds(g).length;
  return { merged, outstanding: g.task_ids.length - merged, total: g.task_ids.length };
}
