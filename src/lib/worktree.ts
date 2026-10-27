import { spawnSync } from "node:child_process";
import {
  appendFileSync,
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
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { branchExists, forceDeleteBranch, git } from "./git";
import { scopesOverlap } from "./glob-overlap";
import {
  dependsOnList,
  type Phase,
  resolveTaskState,
  retryPolicyOf,
  sddxDir,
  type TaskState,
} from "./task";

export const worktreesDir = (cwd: string): string => join(cwd, ".sddx-worktrees");

/** Suffix of the throwaway worktree `sddx verify` runs the boundary proof in. */
export const PROOF_SUFFIX = "--proof";

export interface BaseRef {
  sha: string;
  source: "origin/HEAD" | "origin/main" | "origin/master" | "HEAD";
}

export function tryRev(cwd: string, ref: string): string | null {
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

export const gitCommonDir = (cwd: string): string => {
  const dir = git(cwd, "rev-parse", "--git-common-dir");
  // Absolute already when run from inside a linked worktree; relative (".git")
  // when run from the main worktree.
  return isAbsolute(dir) ? dir : join(cwd, dir);
};

/**
 * The main repo root, resolvable from anywhere in the repo — including from
 * inside a linked worktree, whose own directory a retry may be about to
 * discard (see `retryWorkspace`).
 *
 * `git worktree list` names the main worktree first, which is the answer
 * directly. Deriving it as `dirname(--git-common-dir)` instead was wrong for a
 * repository that is itself a submodule: there the common dir is
 * `<super>/.git/modules/<name>`, so the "root" came out as `<super>/.git/modules`
 * and worktree creation targeted the superproject's git directory.
 */
export function resolveMainRepoRoot(cwd: string): string {
  const r = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" });
  const first = (r.stdout ?? "").split("\n").find((l) => l.startsWith("worktree "));
  if (r.status === 0 && first) return first.slice("worktree ".length).trim();
  // Older git without --porcelain, or a repo state that cannot list worktrees:
  // fall back to the toplevel, then to the previous derivation.
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (top.status === 0 && (top.stdout ?? "").trim()) return (top.stdout ?? "").trim();
  return dirname(gitCommonDir(cwd));
}

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

/**
 * Can git create worktrees for this repository?
 *
 * This asks one question — does `git worktree list` work — and deliberately no
 * longer asks whether the caller happens to be sitting in a linked worktree.
 * `git-dir !== git-common-dir` means only that, and `git worktree add` against
 * the main repository root works fine from there. sddx runs its own agents
 * inside linked worktrees it created, so that check refused sddx from the very
 * workspaces it had just built.
 *
 * With no branch-mode fallback left, a false positive here costs the user the
 * tool rather than a degraded mode, so the precondition asks only what it must.
 */
export function worktreeAvailable(cwd: string): boolean {
  let root: string;
  try {
    root = resolveMainRepoRoot(cwd);
  } catch {
    return false;
  }
  return spawnSync("git", ["worktree", "list"], { cwd: root }).status === 0;
}

export function createWorktree(cwd: string, id: string, baseSha: string): string {
  // Always against the MAIN repo root: invoked from inside a linked worktree,
  // resolving relative to `cwd` would nest `.sddx-worktrees/` under that
  // worktree, where the sweep and every path-based lookup would not find it.
  const root = resolveMainRepoRoot(cwd);
  ensureExcluded(root);
  mkdirSync(worktreesDir(root), { recursive: true });
  const path = join(worktreesDir(root), id);
  git(root, "worktree", "add", "-q", path, "-b", `sddx/${id}`, baseSha);
  return path;
}

/** Sequentially `git merge --no-ff` each remaining parent commit into whatever is
 * already checked out in `worktreePath` (the first parent's commit). Never an
 * octopus merge. Aborts and rethrows naming the failing SHA on conflict: a
 * conflict here means the scope proof missed a shared file, not something to
 * auto-resolve. Returns the final commit SHA. */
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

/**
 * Builds a PLANNED task's worktree and moves its state into it.
 *
 * A root task forks from its goal's run branch head, which already carries the
 * plan commit (the spec) and every task merged so far. A dependent forks from
 * its first parent's DONE commit and merges the rest in sequence, which is safe
 * because plan check proved co-parents have disjoint scopes. A worktree kept by
 * a `reuse` retry is reused as is. Fails loud, never forking from a wrong base.
 */
export function startTaskWorkspace(
  root: string,
  task: TaskState,
  runBranch: string,
): { path: string; baseSha: string; reused: boolean } {
  const id = task.id;
  const branch = `sddx/${id}`;
  const existing = join(worktreesDir(root), id);
  if (existsSync(existing) && branchExists(root, branch)) {
    const base = task.workspace?.base_sha ?? git(existing, "rev-parse", "HEAD");
    return { path: existing, baseSha: base, reused: true };
  }
  const parents = dependsOnList(task);
  let forkSha: string;
  let rest: string[] = [];
  if (parents.length === 0) {
    const sha = tryRev(root, `refs/heads/${runBranch}`);
    if (!sha) throw new Error(`cannot start ${id}: run branch ${runBranch} does not exist`);
    forkSha = sha;
  } else {
    const shas: string[] = [];
    for (const parentId of parents) {
      const sha = tryRev(root, `refs/heads/sddx/${parentId}`);
      if (!sha) throw new Error(`cannot start ${id}: parent ${parentId}'s commit is unresolvable`);
      shas.push(sha);
    }
    forkSha = shas[0] as string;
    rest = shas.slice(1);
  }
  const path = createWorktree(root, id, forkSha);
  let baseSha = forkSha;
  if (rest.length > 0) {
    try {
      baseSha = mergeParentsSequential(path, rest);
    } catch (e) {
      removeWorktreeForced(root, path);
      if (branchExists(root, branch)) forceDeleteBranch(root, branch);
      throw new Error(
        `cannot start ${id}: merging parents [${parents.join(", ")}] conflicted: ${(e as Error).message}`,
      );
    }
  }
  return { path, baseSha, reused: false };
}

/**
 * Applies a retry's `workspace` policy once `abandonOrRetry` returned the task to
 * PLANNED. `fresh` discards the worktree and branch so a broken attempt cannot
 * leak into the next one, and re-homes the state in the main checkout; `reuse`
 * keeps both, and the state stays in the worktree for the next `task start`.
 */
export function releaseForRetry(root: string, task: TaskState): void {
  if (retryPolicyOf(task).workspace === "reuse") return;
  const branch = `sddx/${task.id}`;
  const abs = join(worktreesDir(root), task.id);
  if (existsSync(abs)) removeWorktreeForced(root, abs);
  if (branchExists(root, branch)) forceDeleteBranch(root, branch);
  task.workspace = undefined;
  mkdirSync(join(sddxDir(root), "tasks"), { recursive: true });
}

/**
 * Anything uncommitted at all, `.sddx/` included. A live task's state file is
 * uncommitted until finalize and a draft spec may be too, so neither may be
 * treated as disposable; a finished task's worktree is clean because finalize
 * commits its state and abandonment moves its state to the main checkout.
 */
export const isDirty = (worktreePath: string): boolean =>
  git(worktreePath, "status", "--porcelain", "--untracked-files=all") !== "";

/** Unforced removal, so git refuses if anything was written after the caller's
 * `isDirty` check. */
export function removeWorktree(cwd: string, path: string): void {
  if (isDirty(path)) {
    throw new Error(`worktree ${path} has uncommitted changes`);
  }
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
  /** The lock reason ("" when locked without one), or null when unlocked. */
  locked: string | null;
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
      current = { path: line.slice("worktree ".length), branch: null, head: null, locked: null };
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = line.slice("locked ".length);
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

/**
 * Submodule paths declared in `.gitmodules` at `baseSha`, or `[]` when the file
 * is absent or unreadable. Read from the commit rather than the working tree so
 * the answer matches what a worktree forked at that SHA would contain.
 */
export function submodulePaths(cwd: string, baseSha: string): string[] {
  const r = spawnSync("git", ["show", `${baseSha}:.gitmodules`], { cwd, encoding: "utf8" });
  if (r.status !== 0 || typeof r.stdout !== "string") return [];
  const paths: string[] = [];
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
    if (m?.[1]) paths.push(m[1].replace(/\\/g, "/").replace(/\/+$/, ""));
  }
  return paths;
}

export interface SubmoduleConflict {
  alias: string;
  submodule: string;
  /** Absent when the task declared no scope at all. */
  scope?: string;
}

/**
 * Which tasks could write inside a submodule, and which one.
 *
 * The blanket rule this replaces refused any repository containing a
 * `.gitmodules`, forever, regardless of what tasks touched — one vendored
 * dependency disqualified the whole repo. sddx already knows each task's write
 * lane, validated at plan time by the same overlap check the schedule gate
 * uses, so the precondition can ask the narrower question it actually means.
 *
 * A task declaring NO scope conflicts whenever any submodule exists: an
 * undeclared write lane cannot be proven disjoint from the submodule path, and
 * this whole narrowing rests on that proof. Same stance the autonomy bounds
 * take toward an unconfined scope.
 */
export function submoduleScopeConflicts(
  cwd: string,
  baseSha: string,
  nodes: ReadonlyArray<{ alias: string; scope: string[] }>,
): SubmoduleConflict[] {
  const submodules = submodulePaths(cwd, baseSha);
  if (submodules.length === 0) return [];
  const conflicts: SubmoduleConflict[] = [];
  for (const node of nodes) {
    if (node.scope.length === 0) {
      conflicts.push({ alias: node.alias, submodule: submodules[0] as string });
      continue;
    }
    for (const sub of submodules) {
      const hit = node.scope.find((s) => scopesOverlap([s], [`${sub}/**`]) || s === sub);
      if (hit) {
        conflicts.push({ alias: node.alias, submodule: sub, scope: hit });
        break;
      }
    }
  }
  return conflicts;
}

/** Lock reason `sddx verify` gives its proof worktree, naming the process that owns it. */
export const proofLockReason = (): string => `sddx verify pid ${process.pid} on ${hostname()}`;

/**
 * Whether the `sddx verify` that created a proof worktree may still be running,
 * read from the lock reason it set. A lock from another host cannot be checked
 * from here, and a lock sddx did not set is someone else's, so both count as
 * live. An unlocked proof worktree has no owner.
 */
export function proofOwner(locked: string | null): { alive: boolean; pid?: number } {
  if (locked === null) return { alive: false };
  const m = /^sddx verify pid (\d+) on (.+)$/.exec(locked);
  if (!m) return { alive: true };
  const pid = Number(m[1]);
  if (m[2] !== hostname()) return { alive: true, pid };
  try {
    process.kill(pid, 0);
    return { alive: true, pid };
  } catch (e) {
    return { alive: (e as NodeJS.ErrnoException).code === "EPERM", pid };
  }
}

/**
 * Removes a scratch worktree sddx owns (a proof or integration checkout),
 * whether or not git still tracks it. One whose admin entry was pruned, or whose
 * `worktree add` died halfway, is a plain directory that `git worktree remove`
 * refuses, and leaving it would fail every later command that needs the path.
 */
export function removeScratchWorktree(root: string, path: string): void {
  // doubled --force also drops a locked entry whose directory is already gone,
  // which `worktree prune` would keep
  if (listSddxWorktrees(root).some((w) => w.path === path)) {
    git(root, "worktree", "remove", "--force", "--force", path);
  }
  rmSync(path, { recursive: true, force: true });
  git(root, "worktree", "prune");
}

/** A checkout sddx makes, under its goal lock, to merge into or revert on a run branch. */
export const isRunBranchScratch = (path: string): boolean =>
  basename(dirname(path)) === ".sddx-worktrees" && /^(integrate|revert)-/.test(basename(path));

/** An untracked proof directory younger than this may be a `worktree add` in progress. */
const PROOF_DIR_GRACE_MS = 60_000;

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
    const listed = listSddxWorktrees(cwd);
    for (const wt of listed) {
      // A proof worktree holds nothing but a checkout of committed objects. It
      // is removed only once the verify that owns it is gone: another session's
      // sweep must not pull the directory out from under a running oracle.
      if (wt.branch === null && wt.path.endsWith(PROOF_SUFFIX)) {
        const owner = proofOwner(wt.locked);
        if (owner.alive) {
          skipped.push({
            path: wt.path,
            reason: owner.pid ? `verify running (pid ${owner.pid})` : "locked",
          });
          continue;
        }
        try {
          removeScratchWorktree(cwd, wt.path);
          removed.push(wt.path);
        } catch (e) {
          skipped.push({ path: wt.path, reason: `remove failed: ${(e as Error).message}` });
        }
        continue;
      }
      const id = wt.branch?.replace(/^sddx\//, "");
      if (!id) {
        skipped.push({ path: wt.path, reason: "no sddx branch" });
        continue;
      }
      const task = resolveTaskState(cwd, id);
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
    const tracked = new Set(listed.map((w) => w.path));
    for (const name of worktreeIds(cwd)) {
      const path = join(worktreesDir(cwd), name);
      if (!name.endsWith(PROOF_SUFFIX) || tracked.has(path)) continue;
      try {
        if (now - statSync(path).mtimeMs < PROOF_DIR_GRACE_MS) continue;
        removeScratchWorktree(cwd, path);
        removed.push(path);
      } catch (e) {
        skipped.push({ path, reason: `remove failed: ${(e as Error).message}` });
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
