import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.error) throw new Error(`git not runnable: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(r.stderr ?? "").trim()}`);
  }
  return (r.stdout ?? "").trim();
}

export const headSha = (cwd: string): string => git(cwd, "rev-parse", "HEAD");

export const currentBranch = (cwd: string): string => git(cwd, "rev-parse", "--abbrev-ref", "HEAD");

export const createBranch = (cwd: string, name: string): void => {
  git(cwd, "switch", "-c", name);
};

/** Creates `name` at `sha` without checking it out — for branches (like a run
 * branch) that must exist without disturbing whatever `cwd` currently has
 * checked out. */
export const createBranchAt = (cwd: string, name: string, sha: string): void => {
  git(cwd, "branch", name, sha);
};

export function branchExists(cwd: string, name: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], {
    cwd,
  });
  return r.status === 0;
}

export function isMerged(cwd: string, branch: string): boolean {
  return git(cwd, "branch", "--merged", "HEAD", "--format=%(refname:short)")
    .split("\n")
    .includes(branch);
}

export const deleteBranch = (cwd: string, name: string): void => {
  git(cwd, "branch", "-d", name);
};

/** For branches proven safe by a non-ancestry marker (e.g. a cherry-picked
 * `shipped` task) rather than by git's own merge check. */
export const forceDeleteBranch = (cwd: string, name: string): void => {
  git(cwd, "branch", "-D", name);
};

/** null when the remote doesn't exist — never throws, so host detection can fall through. */
export function remoteUrl(cwd: string, remote: string): string | null {
  const r = spawnSync("git", ["remote", "get-url", remote], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** null when HEAD has no configured upstream — never throws. */
export function upstreamBranch(cwd: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    cwd,
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Commits on HEAD not yet on its upstream. 0 when there is no upstream (callers
 * should check `upstreamBranch` separately — that distinguishes "clean" from
 * "never pushed", which this alone cannot). */
export function commitsAheadOfUpstream(cwd: string): number {
  const r = spawnSync("git", ["rev-list", "--count", "@{u}..HEAD"], { cwd, encoding: "utf8" });
  return r.status === 0 ? Number(r.stdout.trim()) : 0;
}

/** The remote's default branch (e.g. "main"), read from `origin/HEAD`; falls
 * back to a local "main" or "master" branch when that symref isn't set. */
export function defaultBranch(cwd: string): string {
  const r = spawnSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
    cwd,
    encoding: "utf8",
  });
  if (r.status === 0) {
    const m = /^refs\/remotes\/origin\/(.+)$/.exec(r.stdout.trim());
    if (m?.[1]) return m[1];
  }
  return branchExists(cwd, "main") ? "main" : "master";
}

export const push = (cwd: string, branch: string): void => {
  git(cwd, "push", "-u", "origin", branch);
};

/** `.sddx/goals/` is cross-task state that lives in the main checkout "by
 * definition" (see `run-orchestration`) — never inside any single task's own
 * commit. In worktree mode this exclusion is moot (a task's worktree is a
 * separate directory that never contains the goals folder at all), but in
 * branch mode the task's workspace *is* the shared checkout, so an
 * indiscriminate `add -A` would otherwise sweep up a goal file that happens
 * to be sitting there and bury it inside the task's own branch. */
export const stageAll = (cwd: string): void => {
  git(cwd, "add", "-A", "--", ".", ":!.sddx/goals");
};

/** Stages exactly one path — unlike `stageAll`, safe to call in a shared
 * checkout that may have unrelated in-progress edits sitting alongside it. */
export const stagePath = (cwd: string, path: string): void => {
  git(cwd, "add", "--", path);
};

export const writeTree = (cwd: string): string => git(cwd, "write-tree");

export function commit(cwd: string, message: string): string {
  git(cwd, "commit", "-m", message);
  return headSha(cwd);
}

/**
 * The tree of `base` with `files` (repository-relative path to content) added
 * or replaced, built in a temporary index so neither the worktree's files nor
 * its real index change.
 */
export function treeWith(cwd: string, base: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sddx-index-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
  const run = (args: string[], input?: string): string => {
    const r = spawnSync("git", args, { cwd, env, input, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr ?? "").trim()}`);
    return (r.stdout ?? "").trim();
  };
  try {
    run(["read-tree", base]);
    for (const [path, content] of Object.entries(files)) {
      const blob = run(["hash-object", "-w", "--stdin"], content);
      run(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
    }
    return run(["write-tree"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Commits `files` on top of `baseTree` as the next commit of `branch`, which
 * must be checked out in `worktree`, then writes the files and resets the index
 * to the new commit. Built with plumbing, so no hook can alter or veto content
 * that was already verified and reviewed; signed when `commit.gpgSign` asks for
 * it, as `git commit` would. Nothing is written if the commit cannot be made.
 */
export function commitOnBranch(opts: {
  worktree: string;
  branch: string;
  baseTree: string;
  files: Record<string, string>;
  readOnly?: string[];
  message: string;
}): string {
  const { worktree, branch } = opts;
  const ref = `refs/heads/${branch}`;
  const head = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], {
    cwd: worktree,
    encoding: "utf8",
  });
  if ((head.stdout ?? "").trim() !== ref) {
    throw new Error(`${worktree} is not on its branch ${branch}`);
  }
  const parent = git(worktree, "rev-parse", ref);
  const tree = treeWith(worktree, opts.baseTree, opts.files);
  const sign = spawnSync("git", ["config", "--type=bool", "--get", "commit.gpgsign"], {
    cwd: worktree,
    encoding: "utf8",
  });
  const signArgs = (sign.stdout ?? "").trim() === "true" ? ["-S"] : [];
  const commitSha = git(
    worktree,
    "commit-tree",
    tree,
    "-p",
    parent,
    ...signArgs,
    "-m",
    opts.message,
  );
  git(worktree, "update-ref", "-m", opts.message, ref, commitSha, parent);
  for (const [path, content] of Object.entries(opts.files)) {
    const abs = join(worktree, path);
    mkdirSync(dirname(abs), { recursive: true });
    rmSync(abs, { force: true });
    writeFileSync(abs, content);
    if (opts.readOnly?.includes(path)) chmodSync(abs, 0o444);
  }
  git(worktree, "reset", "-q");
  return commitSha;
}

/** The worktree that has `branch` checked out, or null when none has. */
export function checkedOutAt(cwd: string, branch: string): string | null {
  const out = git(cwd, "worktree", "list", "--porcelain");
  let path: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}
