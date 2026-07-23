import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { branchExists, forceDeleteBranch, git } from "./git";
import {
  dependsOnList,
  type Phase,
  resolveTaskState,
  retryPolicyOf,
  sddxDir,
  type TaskState,
  writeTask,
} from "./task";

export const worktreesDir = (cwd: string): string => join(cwd, ".sddx-worktrees");

export interface BaseRef {
  sha: string;
  source: "origin/HEAD" | "origin/main" | "origin/master" | "HEAD";
}

function tryRev(cwd: string, ref: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], {
    cwd,
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Resolve the fork point from local refs only — never a fetch (G6: no network). */
export function resolveBaseRef(cwd: string): BaseRef {
  const symref = spawnSync("git", ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], {
    cwd,
    encoding: "utf8",
  });
  if (symref.status === 0) {
    const sha = tryRev(cwd, symref.stdout.trim());
    if (sha) return { sha, source: "origin/HEAD" };
  }
  for (const [ref, source] of [
    ["refs/remotes/origin/main", "origin/main"],
    ["refs/remotes/origin/master", "origin/master"],
  ] as const) {
    const sha = tryRev(cwd, ref);
    if (sha) return { sha, source };
  }
  return { sha: git(cwd, "rev-parse", "HEAD"), source: "HEAD" };
}

const gitCommonDir = (cwd: string): string => {
  const dir = git(cwd, "rev-parse", "--git-common-dir");
  // Absolute already when run from inside a linked worktree; relative (".git")
  // when run from the main worktree.
  return isAbsolute(dir) ? dir : join(cwd, dir);
};

/** The main repo root, resolvable from anywhere in the repo — including from
 * inside a linked worktree, whose own directory a retry may be about to
 * discard (see `retryWorkspace`). */
export const resolveMainRepoRoot = (cwd: string): string => dirname(gitCommonDir(cwd));

const EXCLUDE_LINE = ".sddx-worktrees/";

export function ensureExcluded(cwd: string): void {
  const infoDir = join(gitCommonDir(cwd), "info");
  mkdirSync(infoDir, { recursive: true });
  const exclude = join(infoDir, "exclude");
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (current.split("\n").includes(EXCLUDE_LINE)) return;
  const sep = current === "" || current.endsWith("\n") ? "" : "\n";
  appendFileSync(exclude, `${sep}${EXCLUDE_LINE}\n`);
}

export function worktreeAvailable(cwd: string): boolean {
  // A repo that is itself a linked worktree must not nest further worktrees.
  const r = spawnSync("git", ["worktree", "list"], { cwd });
  if (r.status !== 0) return false;
  const gitDir = git(cwd, "rev-parse", "--git-dir");
  const common = git(cwd, "rev-parse", "--git-common-dir");
  return gitDir === common;
}

export function createWorktree(cwd: string, id: string, baseSha: string): string {
  ensureExcluded(cwd);
  mkdirSync(worktreesDir(cwd), { recursive: true });
  const path = join(worktreesDir(cwd), id);
  git(cwd, "worktree", "add", "-q", path, "-b", `sddx/${id}`, baseSha);
  return path;
}

/** Sequentially `git merge --no-ff` each remaining parent commit into whatever is
 * already checked out in `worktreePath` (the first parent's commit). Never an
 * octopus merge. Aborts and rethrows naming the failing SHA on conflict — a
 * conflict here means a gate blind spot (STRICT scope proof missed a shared
 * file), not something to auto-resolve. Returns the final commit SHA. */
function mergeParentsSequential(worktreePath: string, remaining: readonly string[]): string {
  for (const sha of remaining) {
    const r = spawnSync("git", ["merge", "--no-ff", "-m", `sddx: merge dependency ${sha}`, sha], {
      cwd: worktreePath,
      encoding: "utf8",
    });
    if (r.status !== 0) {
      spawnSync("git", ["merge", "--abort"], { cwd: worktreePath });
      throw new Error(`merge of ${sha} failed: ${(r.stderr ?? r.stdout ?? "").trim()}`);
    }
  }
  return git(worktreePath, "rev-parse", "HEAD");
}

/** Branch mode has no isolated worktree of its own, so a fan-in merge borrows a
 * throwaway one (the same technique `pr.ts` uses for goal-branch assembly):
 * check the branch out into a scratch worktree, merge there, force-remove the
 * scratch worktree — the branch pointer keeps the merge commit. */
function mergeParentsInBranch(cwd: string, taskId: string, remaining: readonly string[]): string {
  const tmpPath = join(worktreesDir(cwd), `materialize-${taskId}`);
  git(cwd, "worktree", "add", "-q", tmpPath, `sddx/${taskId}`);
  try {
    return mergeParentsSequential(tmpPath, remaining);
  } finally {
    removeWorktreeForced(cwd, tmpPath);
  }
}

/**
 * Materialize a deferred dependent task's workspace once every named parent is
 * DONE. With one parent, the workspace forks directly from its DONE commit
 * (tip of `sddx/<parent-id>`) rather than origin/HEAD, so the dependent's
 * writes land on top of the parent's committed tree. With several parents
 * (fan-in), it forks from the first-listed parent's commit and sequentially
 * merges the rest in — safe by construction because `graph create`'s overlap
 * ⟹ ordered gate already proved every pair of co-parents has disjoint scope.
 * Honors the mode chosen at create time:
 *   - worktree → a worktree forked from the fork/merge commit; the task state
 *     + spec move into it (where resolveTaskState finds the live copy first)
 *     and the deferred main-checkout copies are removed.
 *   - branch → a `sddx/<id>` branch at the fork/merge commit; the task stays
 *     in the main checkout (worktrees would be unsafe here — this is why
 *     branch mode was chosen, e.g. submodules).
 * Fails loud — never forks from a wrong or partial base — if any parent is not
 * DONE, a parent's commit is unresolvable, or the merge conflicts.
 */
export function materializeDependent(
  cwd: string,
  taskId: string,
): { path?: string; baseSha: string; mode: "worktree" | "branch" } {
  const task = resolveTaskState(cwd, taskId);
  if (!task) throw new Error(`no such task: ${taskId}`);
  const parentIds = dependsOnList(task);
  if (parentIds.length === 0) {
    throw new Error(`task ${taskId} has no depends_on to materialize from`);
  }
  const parentShas: string[] = [];
  for (const parentId of parentIds) {
    const parent = resolveTaskState(cwd, parentId);
    if (!parent) throw new Error(`cannot materialize ${taskId}: parent ${parentId} not found`);
    if (parent.phase !== "DONE") {
      throw new Error(
        `cannot materialize ${taskId}: parent ${parentId} is ${parent.phase}, not DONE`,
      );
    }
    const sha = tryRev(cwd, `refs/heads/sddx/${parentId}`) ?? tryRev(cwd, `sddx/${parentId}`);
    if (!sha) {
      throw new Error(
        `cannot materialize ${taskId}: parent ${parentId}'s DONE commit is unresolvable`,
      );
    }
    parentShas.push(sha);
  }
  const forkSha = parentShas[0] as string;
  const rest = parentShas.slice(1);

  if (task.workspace.mode === "branch") {
    // no worktree — worktrees are unsafe in this repo (why branch mode was picked).
    // Create the branch at the fork commit; the task/spec stay in the main checkout.
    git(cwd, "branch", `sddx/${taskId}`, forkSha);
    let finalSha = forkSha;
    if (rest.length > 0) {
      try {
        finalSha = mergeParentsInBranch(cwd, taskId, rest);
      } catch (e) {
        throw new Error(
          `cannot materialize ${taskId}: fan-in merge conflict combining parents [${parentIds.join(", ")}] — ${(e as Error).message}`,
        );
      }
    }
    task.workspace = { mode: "branch", branch: `sddx/${taskId}`, base_sha: finalSha };
    writeTask(cwd, task);
    return { baseSha: finalSha, mode: "branch" };
  }

  const path = createWorktree(cwd, taskId, forkSha);
  let finalSha = forkSha;
  if (rest.length > 0) {
    try {
      finalSha = mergeParentsSequential(path, rest);
    } catch (e) {
      removeWorktreeForced(cwd, path);
      throw new Error(
        `cannot materialize ${taskId}: fan-in merge conflict combining parents [${parentIds.join(", ")}] — ${(e as Error).message}`,
      );
    }
  }
  // carry the spec into the new worktree, then write the updated task state there
  const relSpec = task.spec_path;
  const specSrc = join(cwd, relSpec);
  if (existsSync(specSrc)) {
    mkdirSync(join(sddxDir(path), "specs"), { recursive: true });
    copyFileSync(specSrc, join(path, relSpec));
  }
  task.workspace = {
    mode: "worktree",
    branch: `sddx/${taskId}`,
    base_sha: finalSha,
    path: join(".sddx-worktrees", taskId),
  };
  writeTask(path, task);

  // remove the deferred copies from the main checkout so the worktree is the only
  // live source (resolveTaskState prefers the worktree copy regardless, but a
  // lingering stale main-checkout file would confuse the board and sweep)
  rmSync(join(cwd, ".sddx", "tasks", `${taskId}.json`), { force: true });
  if (existsSync(specSrc)) rmSync(specSrc, { force: true });

  return { path, baseSha: finalSha, mode: "worktree" };
}

/**
 * Applies a task's `retry.workspace` policy after `abandonOrRetry` resets it to
 * PLAN for another attempt: `fresh` (default) discards the current worktree/
 * branch and re-forks from the same recorded base, so a dirty build or partial
 * edit from the failed attempt can't poison the next one; `reuse` leaves the
 * workspace untouched. `cwd` may be the task's own worktree (the common case —
 * `task phase <id> ABANDONED` runs from inside it); the main repo root is
 * resolved independently since a `fresh` retry is about to discard that very
 * directory. Also discards and re-materializes any dependent that had already
 * materialized against this task's prior (now-superseded) commit — recursively,
 * through its own dependents — never rebasing any of them.
 */
export function retryWorkspace(cwd: string, task: TaskState): void {
  const policy = retryPolicyOf(task);
  const root = resolveMainRepoRoot(cwd);
  if (policy.workspace === "fresh") {
    const branch = `sddx/${task.id}`;
    if (task.workspace.mode === "worktree" && task.workspace.path) {
      const oldAbs = join(root, task.workspace.path);
      const specAbs = join(oldAbs, task.spec_path);
      const specBytes = existsSync(specAbs) ? readFileSync(specAbs) : null;
      if (existsSync(oldAbs)) {
        try {
          removeWorktreeForced(root, oldAbs);
        } catch {
          // best-effort — a manually-removed or already-gone worktree is fine
        }
      }
      if (branchExists(root, branch)) forceDeleteBranch(root, branch);
      const newAbs = createWorktree(root, task.id, task.workspace.base_sha);
      mkdirSync(join(sddxDir(newAbs), "tasks"), { recursive: true });
      if (specBytes) {
        mkdirSync(dirname(join(newAbs, task.spec_path)), { recursive: true });
        writeFileSync(join(newAbs, task.spec_path), specBytes);
      }
      task.workspace = { ...task.workspace, path: relative(root, newAbs) };
    } else if (task.workspace.mode === "branch" && task.workspace.branch) {
      // never left the main checkout — just park the branch back at its base
      git(root, "branch", "-f", branch, task.workspace.base_sha);
    }
    // mode "none": nothing isolated to reset
  }
  rematerializeStaleDependents(root, task.id);
}

const allKnownTaskIds = (cwd: string): string[] => {
  const ids = new Set<string>();
  const mainDir = join(cwd, ".sddx", "tasks");
  if (existsSync(mainDir)) {
    for (const f of readdirSync(mainDir)) if (f.endsWith(".json")) ids.add(f.slice(0, -5));
  }
  for (const id of worktreeIds(cwd)) ids.add(id);
  return [...ids];
};

/** A dependent counts as already-materialized once its base is a real SHA
 * rather than the deferred `pending:...` placeholder. */
const isMaterialized = (t: TaskState): boolean => !t.workspace.base_sha.startsWith("pending:");

/**
 * After `retriedTaskId` produces a new commit, discard and re-materialize any
 * dependent whose workspace was already built from its earlier (now stale)
 * commit — recursing into that dependent's own already-materialized
 * dependents. Never rebases; always tears down and recreates via the same
 * fork-or-merge path `materializeDependent` uses for a first materialization.
 */
export function rematerializeStaleDependents(cwd: string, retriedTaskId: string): string[] {
  const rebuilt: string[] = [];
  for (const id of allKnownTaskIds(cwd)) {
    if (id === retriedTaskId) continue;
    const t = resolveTaskState(cwd, id);
    if (!t) continue;
    if (!dependsOnList(t).includes(retriedTaskId)) continue;
    if (!isMaterialized(t)) continue; // not yet materialized — nothing to discard

    const staleBranch = `sddx/${id}`;
    if (t.workspace.mode === "worktree" && t.workspace.path) {
      const abs = join(cwd, t.workspace.path);
      if (existsSync(abs)) {
        try {
          removeWorktreeForced(cwd, abs);
        } catch {
          // best-effort
        }
      }
    }
    // the stale branch (worktree or branch mode) must go too, or re-materializing
    // via createWorktree/`git branch` would collide with the old tip
    if (branchExists(cwd, staleBranch)) forceDeleteBranch(cwd, staleBranch);
    // reset to deferred so materializeDependent treats it as a fresh dispatch
    t.workspace = {
      mode: t.workspace.mode,
      branch: null,
      base_sha: `pending:${dependsOnList(t).join(",")}`,
    };
    mkdirSync(join(cwd, ".sddx", "tasks"), { recursive: true });
    writeTask(cwd, t); // re-home the state to the main checkout before rebuilding
    materializeDependent(cwd, id);
    rebuilt.push(id);
    rebuilt.push(...rematerializeStaleDependents(cwd, id));
  }
  return rebuilt;
}

export const isDirty = (worktreePath: string): boolean =>
  git(worktreePath, "status", "--porcelain") !== "";

/** Non-forced removal: git itself refuses when the worktree is dirty. */
export function removeWorktree(cwd: string, path: string): void {
  git(cwd, "worktree", "remove", path);
  git(cwd, "worktree", "prune");
}

/** Forced removal for scratch worktrees sddx creates and owns for the
 * duration of one command (goal-branch construction, shipped-marker commits)
 * — never for task worktrees, which hold user work and use the guarded
 * `removeWorktree` above instead. */
export function removeWorktreeForced(cwd: string, path: string): void {
  git(cwd, "worktree", "remove", "--force", path);
  git(cwd, "worktree", "prune");
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string | null;
}

export function listSddxWorktrees(cwd: string): WorktreeInfo[] {
  const dir = worktreesDir(cwd);
  if (!existsSync(dir)) return [];
  // git prints fully resolved paths (/private/var vs /var on macOS) — compare canonically,
  // but report paths rooted at the caller's cwd spelling.
  const realPrefix = `${realpathSync(dir)}/`;
  const prefix = `${dir}/`;
  const out = git(cwd, "worktree", "list", "--porcelain");
  const entries: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};
  for (const line of `${out}\n`.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null, head: null };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "" && current.path) {
      if (current.path.startsWith(realPrefix)) {
        current.path = prefix + current.path.slice(realPrefix.length);
        entries.push(current as WorktreeInfo);
      }
      current = {};
    }
  }
  return entries;
}

export function hasSubmodules(cwd: string, baseSha: string): boolean {
  const r = spawnSync("git", ["cat-file", "-e", `${baseSha}:.gitmodules`], { cwd });
  return r.status === 0;
}

const LOCK_STALE_MS = 10 * 60_000;

export interface SweepResult {
  removed: string[];
  skipped: Array<{ path: string; reason: string }>;
  locked: boolean;
}

function acquireLock(lockPath: string, now: number): boolean {
  try {
    mkdirSync(lockPath);
    return true;
  } catch {
    let age = 0;
    try {
      age = now - statSync(lockPath).mtimeMs;
    } catch {
      // lock vanished between mkdir and stat — retry once
      try {
        mkdirSync(lockPath);
        return true;
      } catch {
        return false;
      }
    }
    if (age <= LOCK_STALE_MS) return false;
    try {
      rmdirSync(lockPath);
      mkdirSync(lockPath);
      return true;
    } catch {
      return false;
    }
  }
}

function readWorktreeTask(worktreePath: string, id: string): TaskState | null {
  const path = join(worktreePath, ".sddx", "tasks", `${id}.json`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as TaskState;
  } catch {
    return null;
  }
}

const DISPOSABLE: ReadonlySet<Phase> = new Set(["DONE", "ABANDONED"]);

/** Persist skip results for the board: repo-relative paths, sorted, timestamp-free. */
function writeSweepState(cwd: string, skipped: Array<{ path: string; reason: string }>): void {
  const entries = skipped
    .map((s) => ({ path: relative(cwd, s.path), reason: s.reason }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  mkdirSync(join(cwd, ".sddx"), { recursive: true });
  writeFileSync(
    join(cwd, ".sddx", "sweep.json"),
    `${JSON.stringify({ skipped: entries }, null, 2)}\n`,
  );
}

export function sweep(cwd: string, opts: { now?: number } = {}): SweepResult {
  const now = opts.now ?? Date.now();
  const lockPath = join(gitCommonDir(cwd), "sddx-sweep.lock");
  if (!acquireLock(lockPath, now)) {
    return { removed: [], skipped: [], locked: true };
  }
  const removed: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  try {
    for (const wt of listSddxWorktrees(cwd)) {
      const id = wt.branch?.replace(/^sddx\//, "");
      if (!id) {
        skipped.push({ path: wt.path, reason: "no sddx branch" });
        continue;
      }
      const task = readWorktreeTask(wt.path, id);
      if (!task) {
        skipped.push({ path: wt.path, reason: "no readable task state" });
        continue;
      }
      if (!DISPOSABLE.has(task.phase)) {
        skipped.push({ path: wt.path, reason: `phase ${task.phase}` });
        continue;
      }
      if (isDirty(wt.path)) {
        skipped.push({ path: wt.path, reason: "dirty" });
        continue;
      }
      if (task.phase === "DONE" && !existsSync(join(wt.path, ".sddx", "receipts", `${id}.json`))) {
        skipped.push({ path: wt.path, reason: "DONE without receipt" });
        continue;
      }
      try {
        removeWorktree(cwd, wt.path);
        removed.push(wt.path);
      } catch (e) {
        skipped.push({ path: wt.path, reason: `remove failed: ${(e as Error).message}` });
      }
    }
    // scan completed — record what was refused so the board can flag it
    writeSweepState(cwd, skipped);
  } finally {
    try {
      rmdirSync(lockPath);
    } catch {
      // already released or stolen — nothing to do
    }
  }
  return { removed, skipped, locked: false };
}

// readdirSync kept out of the hot path; re-exported for CLI reporting convenience.
export const worktreeIds = (cwd: string): string[] =>
  existsSync(worktreesDir(cwd)) ? readdirSync(worktreesDir(cwd)) : [];
