import { spawnSync } from "node:child_process";

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

export const stageAll = (cwd: string): void => {
  git(cwd, "add", "-A");
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
