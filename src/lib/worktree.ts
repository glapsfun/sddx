import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { git } from "./git";
import type { Phase, TaskState } from "./task";

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
