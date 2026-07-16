import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  branchExists,
  commit,
  createBranch,
  currentBranch,
  deleteBranch,
  headSha,
  isMerged,
  stageAll,
  writeTree,
} from "../src/lib/git";
import { fixtureRepo } from "./fixtures";

describe("git helpers", () => {
  test("branch create/switch/exists, stage, tree, commit", () => {
    const cwd = fixtureRepo();
    const base = headSha(cwd);
    createBranch(cwd, "sddx/x");
    expect(currentBranch(cwd)).toBe("sddx/x");
    expect(branchExists(cwd, "sddx/x")).toBe(true);
    expect(branchExists(cwd, "sddx/nope")).toBe(false);

    writeFileSync(join(cwd, "a.txt"), "a\n");
    stageAll(cwd);
    expect(writeTree(cwd)).toMatch(/^[0-9a-f]{40}$/);
    const sha = commit(cwd, "sddx(x): add a");
    expect(sha).not.toBe(base);
    expect(headSha(cwd)).toBe(sha);
  });

  test("isMerged and guarded delete", () => {
    const cwd = fixtureRepo();
    createBranch(cwd, "sddx/y");
    writeFileSync(join(cwd, "b.txt"), "b\n");
    stageAll(cwd);
    commit(cwd, "sddx(y): add b");
    expect(isMerged(cwd, "sddx/y")).toBe(true); // merged into itself/HEAD

    const g = (...a: string[]) => spawnSync("git", a, { cwd });
    g("switch", "-q", "main");
    expect(isMerged(cwd, "sddx/y")).toBe(false);
    g("merge", "-q", "--no-edit", "sddx/y");
    expect(isMerged(cwd, "sddx/y")).toBe(true);
    deleteBranch(cwd, "sddx/y");
    expect(branchExists(cwd, "sddx/y")).toBe(false);
  });

  test("failures throw with stderr", () => {
    const cwd = fixtureRepo();
    expect(() => deleteBranch(cwd, "missing")).toThrow(/git/);
  });
});
