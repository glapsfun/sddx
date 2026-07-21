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
import { join, relative } from "node:path";
import { git } from "./git";
import { type Phase, resolveTaskState, sddxDir, type TaskState, writeTask } from "./task";

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
  return join(cwd, dir);
};

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

/**
 * Materialize a deferred dependent task's workspace at dispatch time. Its parent
 * must be DONE; the workspace is forked from the parent's DONE commit (the tip of
 * `sddx/<parent-id>`) rather than origin/HEAD, so the dependent's writes land on
 * top of the parent's committed tree. Honors the mode chosen at create time:
 *   - worktree → a worktree forked from the parent commit; the task state + spec
 *     move into it (where resolveTaskState finds the live copy first) and the
 *     deferred main-checkout copies are removed.
 *   - branch → a `sddx/<id>` branch at the parent commit; the task stays in the
 *     main checkout (worktrees would be unsafe here — this is why branch mode was
 *     chosen, e.g. submodules).
 * Fails loud — never forks from a wrong base — if the parent is not DONE or its
 * commit is unresolvable.
 */
export function materializeDependent(
  cwd: string,
  taskId: string,
): { path?: string; baseSha: string; mode: "worktree" | "branch" } {
  const task = resolveTaskState(cwd, taskId);
  if (!task) throw new Error(`no such task: ${taskId}`);
  const parentId = task.depends_on;
  if (!parentId) throw new Error(`task ${taskId} has no depends_on to materialize from`);
  const parent = resolveTaskState(cwd, parentId);
  if (!parent) throw new Error(`cannot materialize ${taskId}: parent ${parentId} not found`);
  if (parent.phase !== "DONE") {
    throw new Error(
      `cannot materialize ${taskId}: parent ${parentId} is ${parent.phase}, not DONE`,
    );
  }
  const baseSha = tryRev(cwd, `refs/heads/sddx/${parentId}`) ?? tryRev(cwd, `sddx/${parentId}`);
  if (!baseSha) {
    throw new Error(
      `cannot materialize ${taskId}: parent ${parentId}'s DONE commit is unresolvable`,
    );
  }

  if (task.workspace.mode === "branch") {
    // no worktree — worktrees are unsafe in this repo (why branch mode was picked).
    // Create the branch at the parent commit; the task/spec stay in the main checkout.
    git(cwd, "branch", `sddx/${taskId}`, baseSha);
    task.workspace = { mode: "branch", branch: `sddx/${taskId}`, base_sha: baseSha };
    writeTask(cwd, task);
    return { baseSha, mode: "branch" };
  }

  const path = createWorktree(cwd, taskId, baseSha);
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
    base_sha: baseSha,
    path: join(".sddx-worktrees", taskId),
  };
  writeTask(path, task);

  // remove the deferred copies from the main checkout so the worktree is the only
  // live source (resolveTaskState prefers the worktree copy regardless, but a
  // lingering stale main-checkout file would confuse the board and sweep)
  rmSync(join(cwd, ".sddx", "tasks", `${taskId}.json`), { force: true });
  if (existsSync(specSrc)) rmSync(specSrc, { force: true });

  return { path, baseSha, mode: "worktree" };
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
