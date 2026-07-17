import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createWorktree,
  ensureExcluded,
  hasSubmodules,
  listSddxWorktrees,
  removeWorktree,
  resolveBaseRef,
  worktreesDir,
} from "../src/lib/worktree";
import { fixtureClone, fixtureRepo } from "./fixtures";

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

test("resolveBaseRef prefers origin/HEAD in a clone", () => {
  const { clone } = fixtureClone();
  const base = resolveBaseRef(clone);
  expect(base.source).toBe("origin/HEAD");
  expect(base.sha).toBe(git(clone, "rev-parse", "origin/HEAD"));
});

test("resolveBaseRef falls back to origin/main when origin/HEAD symref is missing", () => {
  const { clone } = fixtureClone();
  git(clone, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
  const base = resolveBaseRef(clone);
  expect(base.source).toBe("origin/main");
  expect(base.sha).toBe(git(clone, "rev-parse", "refs/remotes/origin/main"));
});

test("resolveBaseRef falls back to local HEAD without a remote", () => {
  const repo = fixtureRepo();
  const base = resolveBaseRef(repo);
  expect(base.source).toBe("HEAD");
  expect(base.sha).toBe(git(repo, "rev-parse", "HEAD"));
});

test("createWorktree adds .sddx-worktrees/<id> on branch sddx/<id> at the base SHA", () => {
  const { clone } = fixtureClone();
  const base = resolveBaseRef(clone);
  // local main moves ahead; the worktree must still fork from origin/HEAD
  writeFileSync(join(clone, "ahead.txt"), "ahead\n");
  git(clone, "add", "-A");
  git(clone, "commit", "-qm", "local ahead");

  const path = createWorktree(clone, "t1", base.sha);
  expect(path).toBe(join(worktreesDir(clone), "t1"));
  expect(git(path, "rev-parse", "HEAD")).toBe(base.sha);
  expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("sddx/t1");
  expect(existsSync(join(path, "ahead.txt"))).toBe(false);
});

test("worktree edits are invisible to the main checkout", () => {
  const { clone } = fixtureClone();
  const path = createWorktree(clone, "iso", resolveBaseRef(clone).sha);
  writeFileSync(join(path, "scratch.txt"), "uncommitted\n");
  expect(git(clone, "status", "--porcelain")).toBe("");
});

test("ensureExcluded writes .git/info/exclude once, never .gitignore", () => {
  const { clone } = fixtureClone();
  ensureExcluded(clone);
  ensureExcluded(clone);
  const exclude = readFileSync(join(clone, ".git", "info", "exclude"), "utf8");
  expect(exclude.split("\n").filter((l) => l === ".sddx-worktrees/")).toHaveLength(1);
  expect(git(clone, "status", "--porcelain")).toBe("");
});

test("createWorktree excludes the worktrees dir from git status", () => {
  const { clone } = fixtureClone();
  createWorktree(clone, "ex", resolveBaseRef(clone).sha);
  expect(git(clone, "status", "--porcelain")).toBe("");
});

test("listSddxWorktrees sees only sddx-managed worktrees", () => {
  const { clone } = fixtureClone();
  const path = createWorktree(clone, "mine", resolveBaseRef(clone).sha);
  git(clone, "worktree", "add", "-q", join(clone, "..", "foreign"), "-b", "user/foreign");
  const listed = listSddxWorktrees(clone);
  expect(listed.map((w) => w.path)).toEqual([path]);
  expect(listed[0]?.branch).toBe("sddx/mine");
});

test("removeWorktree refuses a dirty worktree and removes a clean one", () => {
  const { clone } = fixtureClone();
  const path = createWorktree(clone, "rm", resolveBaseRef(clone).sha);
  writeFileSync(join(path, "dirty.txt"), "x\n");
  expect(() => removeWorktree(clone, path)).toThrow();
  expect(existsSync(join(path, "dirty.txt"))).toBe(true);

  spawnSync("rm", [join(path, "dirty.txt")]);
  removeWorktree(clone, path);
  expect(existsSync(path)).toBe(false);
  expect(git(clone, "rev-parse", "--verify", "refs/heads/sddx/rm")).toBeTruthy();
});

test("hasSubmodules detects .gitmodules in the base tree", () => {
  const repo = fixtureRepo();
  const head = git(repo, "rev-parse", "HEAD");
  expect(hasSubmodules(repo, head)).toBe(false);
  writeFileSync(join(repo, ".gitmodules"), '[submodule "x"]\n\tpath = x\n\turl = ./x\n');
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "add gitmodules");
  expect(hasSubmodules(repo, git(repo, "rev-parse", "HEAD"))).toBe(true);
});
