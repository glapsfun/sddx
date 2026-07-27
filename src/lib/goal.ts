import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
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

/** Approval provenance for the whole goal, written once by `graph create` and
 * denormalized onto every receipt the goal produces. */
export interface GoalApproval {
  mode: "human" | "auto";
  requested_mode?: "human" | "auto";
  degraded_reason?: string;
  plan_sha256: string;
  at: string;
  /** Reserved for mid-run per-node spec revisions; always empty in this version. */
  amendments?: never[];
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
  /** How this goal's plan was approved. Absent for a goal created before
   * approval provenance existed, or via the standalone `goal create`. */
  approval?: GoalApproval;
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

/** Path of the goal record INSIDE its run branch's tree. */
const goalBlobPath = (id: string): string => `.sddx/goals/${id}.json`;

const sh = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) =>
  spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });

/** Repo root, resolvable from inside a linked task worktree too. Local rather
 * than imported from worktree.ts to keep this module's dependencies one-way. */
function mainRoot(cwd: string): string {
  const r = sh(cwd, ["rev-parse", "--git-common-dir"]);
  if (r.status !== 0) return cwd;
  const dir = (r.stdout ?? "").trim();
  const abs = isAbsolute(dir) ? dir : join(cwd, dir);
  return abs.replace(/\/\.git\/?$/, "").replace(/\/\.git$/, "") || cwd;
}

/**
 * Commits `content` to `path` on `branch` without checking anything out.
 *
 * A temporary index plus `commit-tree` avoids adding a worktree for every write
 * — integration already pays for one, but `graph create` and `pr create` would
 * each need their own, and a worktree add/remove per goal update is a lot of
 * churn for one JSON file.
 *
 * `update-ref` is given the expected old value, so it is a compare-and-swap: if
 * a concurrent verifier advanced the branch between our read and our write, the
 * update fails rather than discarding their commit. The caller re-reads and
 * retries. The goal lock already serializes sibling verifiers, but the lock is
 * per-goal-per-machine and the ref is the actual shared resource.
 */
function commitToBranch(
  root: string,
  branch: string,
  path: string,
  content: string,
  message: string,
): void {
  const ref = `refs/heads/${branch}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const oldSha = sh(root, ["rev-parse", "--verify", "--quiet", ref]).stdout?.trim();
    if (!oldSha) throw new Error(`run branch ${branch} does not exist`);

    const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      input: content,
      encoding: "utf8",
    });
    if (blob.status !== 0) throw new Error(`git hash-object failed: ${blob.stderr}`);
    const blobSha = (blob.stdout ?? "").trim();

    const indexDir = mkdtempSync(join(tmpdir(), "sddx-idx-"));
    const env = { GIT_INDEX_FILE: join(indexDir, "index") };
    try {
      const read = sh(root, ["read-tree", oldSha], env);
      if (read.status !== 0) throw new Error(`git read-tree failed: ${read.stderr}`);
      const upd = sh(
        root,
        ["update-index", "--add", "--cacheinfo", `100644,${blobSha},${path}`],
        env,
      );
      if (upd.status !== 0) throw new Error(`git update-index failed: ${upd.stderr}`);
      const tree = sh(root, ["write-tree"], env);
      if (tree.status !== 0) throw new Error(`git write-tree failed: ${tree.stderr}`);
      const treeSha = (tree.stdout ?? "").trim();

      const commit = spawnSync("git", ["commit-tree", treeSha, "-p", oldSha, "-m", message], {
        cwd: root,
        encoding: "utf8",
      });
      if (commit.status !== 0) throw new Error(`git commit-tree failed: ${commit.stderr}`);
      const commitSha = (commit.stdout ?? "").trim();

      const cas = sh(root, ["update-ref", ref, commitSha, oldSha]);
      if (cas.status === 0) return;
      // lost the race — re-read and rebuild on the new tip
    } finally {
      rmSync(indexDir, { recursive: true, force: true });
    }
  }
  throw new Error(`could not update ${branch} after repeated concurrent modification`);
}

const branchExistsAt = (root: string, branch: string): boolean =>
  sh(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;

/** The goal record as committed on its run branch, or null when absent. */
function readGoalFromBranch(root: string, id: string): Goal | null {
  const r = sh(root, ["show", `${runBranchName(id)}:${goalBlobPath(id)}`]);
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout ?? "") as Goal;
  } catch {
    return null;
  }
}

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
  /** Approval provenance, when the goal came from an approved plan. */
  approval?: GoalApproval;
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
  const root = mainRoot(cwd);
  const path = goalPath(root, id);
  if (existsSync(path)) throw new Error(`goal ${id} already exists at ${path}`);
  if (readGoalFromBranch(root, id)) {
    throw new Error(`goal ${id} already exists on ${runBranchName(id)}`);
  }
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
    ...(opts.approval ? { approval: { amendments: [] as never[], ...opts.approval } } : {}),
    created_at: now,
    updated_at: now,
  };
  // Committed to the run branch, not written loose in the main checkout. The
  // record holds `merges`, the declared single source of truth for integration
  // state — as uncommitted local state it was the one run artifact that could
  // not be audited, did not travel when the run branch was pushed, and vanished
  // if `.sddx/` was cleaned, while the receipts it contextualizes survived.
  //
  // The older reasoning against committing it (that it would bind the record to
  // whatever branch happened to be checked out) predates run branches: this one
  // is sddx-owned, created before any task workspace, and lives exactly as long
  // as the goal does.
  //
  // Only when the run branch exists, which the canonical initializer guarantees
  // by creating it first. The legacy standalone `goal create` assembles a goal
  // with no run branch of its own; it keeps the loose file until
  // `retire-alternate-flows` removes that path. The invariant binds the
  // canonical initializer, not every caller.
  if (branchExistsAt(root, opts.runBranch)) {
    commitToBranch(
      root,
      opts.runBranch,
      goalBlobPath(id),
      `${JSON.stringify(g, null, 2)}\n`,
      `sddx(${id}): create goal`,
    );
  } else {
    mkdirSync(goalsDir(root), { recursive: true });
    writeFileSync(path, `${JSON.stringify(g, null, 2)}\n`);
  }
  return g;
}

export function readGoal(cwd: string, id: string): Goal {
  const root = mainRoot(cwd);
  // Legacy first: a goal written before records moved onto the run branch lives
  // uncommitted in the main checkout, and must keep reading and reporting.
  const path = goalPath(root, id);
  const g = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Goal)
    : readGoalFromBranch(root, id);
  if (!g) throw new Error(`no such goal: ${id} (${path} or ${runBranchName(id)})`);
  if (typeof g.run_branch !== "string" || typeof g.base_sha !== "string" || !g.merges) {
    throw new Error(
      `goal ${id} (${path}) is missing run_branch/base_sha/merges — written by an ` +
        "incompatible sddx version; recreate it with the current graph/goal create",
    );
  }
  return g;
}

export function writeGoal(cwd: string, g: Goal): void {
  const root = mainRoot(cwd);
  g.updated_at = new Date().toISOString();
  const content = `${JSON.stringify(g, null, 2)}\n`;
  // A legacy goal stays where it is. Migrating it onto the run branch mid-run
  // would move the merge log out from under anything already reading it.
  const legacy = goalPath(root, g.id);
  if (existsSync(legacy)) {
    writeFileSync(legacy, content);
    return;
  }
  commitToBranch(root, g.run_branch, goalBlobPath(g.id), content, `sddx(${g.id}): update goal`);
}

/** Scans every goal file in `cwd` for one whose `task_ids` includes `taskId` —
 * the reverse lookup a task needs at verify time to find its own goal (goals
 * are cross-task and always live in the main checkout, never inside a task's
 * own worktree, so this always reads from the main repo root). */
export function findGoalForTask(cwd: string, id: string): Goal | null {
  const root = mainRoot(cwd);
  // Legacy uncommitted records first, then every run branch. A run branch is
  // named after its goal, so enumerating `sddx/run-*` enumerates the goals
  // without needing a directory to scan.
  const dir = goalsDir(root);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const g = JSON.parse(readFileSync(join(dir, f), "utf8")) as Goal;
        if (g.task_ids.includes(id)) return g;
      } catch {
        // unreadable goal file — skip, same as before
      }
    }
  }
  const branches = sh(root, ["branch", "--list", "sddx/run-*", "--format=%(refname:short)"]);
  for (const branch of (branches.stdout ?? "").split("\n").map((s) => s.trim())) {
    if (!branch.startsWith("sddx/run-")) continue;
    const g = readGoalFromBranch(root, branch.slice("sddx/run-".length));
    if (g?.task_ids.includes(id)) return g;
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
