import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * The ref holding a goal record's blob.
 *
 * Deliberately a ref of its own rather than a file in the run branch's tree.
 * A tree path travels with the branch, and both directions of that were wrong:
 * merging the run branch landed a point-in-time snapshot of the record on the
 * default branch, where it shadowed the live one forever; and deleting the run
 * branch after the PR merged destroyed the record — including the merge log,
 * the declared source of truth for integration state — while the receipts it
 * gives context to survived.
 *
 * A ref outside `refs/heads` is carried by neither merge nor branch deletion,
 * is still committed content in the object store (auditable, survives a clean
 * checkout, immune to `.sddx/` being wiped), and `update-ref` gives it
 * compare-and-swap for free.
 */
const goalRef = (id: string): string => `refs/sddx/goals/${id}`;

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
 * Writes `content` as the goal's blob, compare-and-swap against `expected`.
 *
 * Not a commit and not a tree: `update-ref` can point a ref straight at a blob,
 * which is all a single JSON record needs. That removes the temporary index,
 * the tree rebuild, and the commit per update entirely.
 *
 * `expected` is the blob sha the caller read (or `null` for a create), so a
 * concurrent writer is DETECTED rather than overwritten. The previous version
 * retried internally, but a retry re-sent the caller's already-stale `content`
 * — so the loser's write silently clobbered the winner's `merges` entry, which
 * is exactly the data loss the CAS was there to prevent. There is nothing this
 * layer can merge on the caller's behalf, so a conflict throws and the caller,
 * which holds the goal lock and re-reads inside it, is the one that recovers.
 */
function writeGoalBlob(root: string, id: string, content: string, expected: string | null): void {
  const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: root,
    input: content,
    encoding: "utf8",
  });
  if (blob.status !== 0) throw new Error(`git hash-object failed: ${blob.stderr}`);
  const blobSha = (blob.stdout ?? "").trim();

  const ref = goalRef(id);
  const cas = expected
    ? sh(root, ["update-ref", ref, blobSha, expected])
    : sh(root, ["update-ref", ref, blobSha, ""]);
  if (cas.status !== 0) {
    throw new Error(
      `goal ${id} was modified concurrently — re-read it and reapply the change ` +
        `(${(cas.stderr ?? "").trim()})`,
    );
  }
}

const isGitRepo = (root: string): boolean => sh(root, ["rev-parse", "--git-dir"]).status === 0;

/** The blob sha the goal ref currently points at, or null when unset. */
function goalBlobSha(root: string, id: string): string | null {
  const r = sh(root, ["rev-parse", "--verify", "--quiet", goalRef(id)]);
  return r.status === 0 ? (r.stdout ?? "").trim() : null;
}

/**
 * Pushes a goal's ref to `origin`, best-effort.
 *
 * The record is not in any branch's tree, so it does not travel with a branch
 * push — and a reviewer on another clone would otherwise have the run branch
 * without the merge log the PR body is derived from. Failure is not fatal: a
 * remote that refuses non-standard refs must not fail a PR whose branch landed.
 */
export function pushGoalRef(cwd: string, id: string): boolean {
  const root = mainRoot(cwd);
  const ref = goalRef(id);
  return sh(root, ["push", "origin", `${ref}:${ref}`]).status === 0;
}

/** The goal record from its own ref, or null when absent. */
function readGoalFromBranch(root: string, id: string): Goal | null {
  const r = sh(root, ["cat-file", "-p", goalRef(id)]);
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
  if (goalBlobSha(root, id) !== null) {
    throw new Error(`goal ${id} already exists at ${goalRef(id)}`);
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
  // whatever branch happened to be checked out) predates run branches. It is
  // now bound to no branch at all: `refs/sddx/goals/<id>` outlives the run
  // branch and is not carried into the default branch by merging it.
  // Outside a git repository there is no ref to write, so the record stays a
  // loose file — the same place it lived before refs existed.
  if (isGitRepo(root)) {
    writeGoalBlob(root, id, `${JSON.stringify(g, null, 2)}\n`, null);
  } else {
    mkdirSync(goalsDir(root), { recursive: true });
    writeFileSync(path, `${JSON.stringify(g, null, 2)}\n`);
  }
  return g;
}

export function readGoal(cwd: string, id: string): Goal {
  const root = mainRoot(cwd);
  // The ref wins. A `.sddx/goals/<id>.json` in the working tree is only ever a
  // fallback for records written before the ref existed — and it can also be a
  // snapshot that arrived by merging a run branch back when the record lived in
  // the tree. Preferring the file let such a snapshot shadow the live record
  // permanently, freezing the merge log at whatever it held on merge day.
  const path = goalPath(root, id);
  const g =
    readGoalFromBranch(root, id) ??
    (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Goal) : null);
  if (!g) throw new Error(`no such goal: ${id} (${goalRef(id)} or ${path})`);
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
  const current = goalBlobSha(root, g.id);
  if (current === null) {
    // No ref: a record written before refs existed. It stays a loose file —
    // migrating it mid-run would move the merge log out from under anything
    // already reading it.
    const legacy = goalPath(root, g.id);
    if (existsSync(legacy)) {
      writeFileSync(legacy, content);
      return;
    }
    throw new Error(`no such goal: ${g.id} (${goalRef(g.id)})`);
  }
  writeGoalBlob(root, g.id, content, current);
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
  const refs = sh(root, ["for-each-ref", "--format=%(refname)", "refs/sddx/goals/"]);
  for (const ref of (refs.stdout ?? "").split("\n").map((s) => s.trim())) {
    if (!ref.startsWith("refs/sddx/goals/")) continue;
    const g = readGoalFromBranch(root, ref.slice("refs/sddx/goals/".length));
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
