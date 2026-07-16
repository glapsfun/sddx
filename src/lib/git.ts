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

export const stageAll = (cwd: string): void => {
  git(cwd, "add", "-A");
};

export const writeTree = (cwd: string): string => git(cwd, "write-tree");

export function commit(cwd: string, message: string): string {
  git(cwd, "commit", "-m", message);
  return headSha(cwd);
}
