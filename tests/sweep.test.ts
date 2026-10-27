import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createWorktree, resolveBaseRef, sweep } from "../src/lib/worktree";
import { fixtureClone } from "./fixtures";
import { completeTask, createRun, repoRoot, sddx, startTask } from "./helpers";

// each test drives whole tasks through the CLI, which can exceed the 5s default under load
setDefaultTimeout(60_000);

/** A clone with one goal of `n` independent tasks, T1..Tn. */
function cloneWithRun(n: number): string {
  const { clone } = fixtureClone();
  createRun(clone, { tasks: Array.from({ length: n }, (_, i) => ({ id: `T${i + 1}` })) });
  return clone;
}

/** Drives a task to DONE: verified, reviewed, receipt committed, merged. */
function doneTask(clone: string, id: string): { id: string; wt: string } {
  return { id, wt: completeTask(clone, id).worktree };
}

const branchExists = (cwd: string, id: string) =>
  spawnSync("git", ["rev-parse", "--verify", `refs/heads/sddx/${id}`], { cwd }).status === 0;

test("fresh lock makes sweep a no-op; stale lock is reclaimed", () => {
  const clone = cloneWithRun(1);
  const { wt } = doneTask(clone, "T1");
  mkdirSync(join(clone, ".git", "sddx-sweep.lock"));

  const blocked = sweep(clone);
  expect(blocked.locked).toBe(true);
  expect(blocked.removed).toEqual([]);
  expect(existsSync(wt)).toBe(true);

  // pretend 11 minutes pass: the same lock is now stale and gets stolen
  const stolen = sweep(clone, { now: Date.now() + 11 * 60_000 });
  expect(stolen.locked).toBe(false);
  expect(stolen.removed).toEqual([wt]);
  expect(existsSync(wt)).toBe(false);
});

test("sweep removes DONE+clean+receipt, keeps branches, skips dirty and in-progress", () => {
  const clone = cloneWithRun(3);
  const done = doneTask(clone, "T1");

  const dirty = doneTask(clone, "T2");
  writeFileSync(join(dirty.wt, "scratch.txt"), "uncommitted\n");

  // in-progress task: started but never verified
  const inProgressWt = startTask(clone, "T3");

  const res = sweep(clone);
  expect(res.locked).toBe(false);
  expect(res.removed).toEqual([done.wt]);
  expect(existsSync(done.wt)).toBe(false);
  expect(existsSync(dirty.wt)).toBe(true);
  expect(existsSync(inProgressWt)).toBe(true);
  expect(res.skipped).toContainEqual({ path: dirty.wt, reason: "dirty" });
  expect(res.skipped).toContainEqual({ path: inProgressWt, reason: "phase IN_PROGRESS" });

  // the swept task's branch survives (branch deletion is cleanup's job), and its
  // state is still readable from the branch tip
  expect(branchExists(clone, done.id)).toBe(true);
  const shown = sddx(clone, "task", "show", done.id);
  expect(shown.status).toBe(0);
  expect(JSON.parse(shown.stdout).phase).toBe("DONE");
});

test("sweep skips worktrees without readable task state and ignores foreign worktrees", () => {
  const { clone } = fixtureClone();
  const orphan = createWorktree(clone, "orphan", resolveBaseRef(clone).sha);
  spawnSync("git", ["worktree", "add", "-q", join(clone, "..", "foreign"), "-b", "user/f"], {
    cwd: clone,
  });

  const res = sweep(clone);
  expect(res.removed).toEqual([]);
  expect(res.skipped.map((s) => ({ ...s, path: realpathSync(s.path) }))).toEqual([
    { path: realpathSync(orphan), reason: "no readable task state" },
  ]);
  expect(existsSync(orphan)).toBe(true);
  expect(existsSync(join(clone, "..", "foreign"))).toBe(true);
});

test("sweep persists sorted skip results to .sddx/sweep.json; clean scan clears them", () => {
  const clone = cloneWithRun(2);
  const first = doneTask(clone, "T1");
  const second = doneTask(clone, "T2");
  writeFileSync(join(first.wt, "scratch.txt"), "uncommitted\n");
  writeFileSync(join(second.wt, "scratch.txt"), "uncommitted\n");

  sweep(clone);
  const statePath = join(clone, ".sddx", "sweep.json");
  const raw = readFileSync(statePath, "utf8");
  expect(raw).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // timestamp-free
  const paths = [relative(clone, first.wt), relative(clone, second.wt)].sort();
  expect(JSON.parse(raw)).toEqual({
    skipped: paths.map((path) => ({ path, reason: "dirty" })),
  });

  // both worktrees cleaned up: the next scan skips nothing and clears stale flags
  rmSync(join(first.wt, "scratch.txt"));
  rmSync(join(second.wt, "scratch.txt"));
  sweep(clone);
  expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ skipped: [] });
});

test("lock-blocked sweep does not write sweep state", () => {
  const clone = cloneWithRun(1);
  const { wt } = doneTask(clone, "T1");
  writeFileSync(join(wt, "scratch.txt"), "uncommitted\n");
  mkdirSync(join(clone, ".git", "sddx-sweep.lock"));

  const blocked = sweep(clone);
  expect(blocked.locked).toBe(true);
  expect(existsSync(join(clone, ".sddx", "sweep.json"))).toBe(false);
});

test("session-start sweeps before rendering, so fresh flags land on the board", () => {
  const clone = cloneWithRun(1);
  const { wt } = doneTask(clone, "T1");
  writeFileSync(join(wt, "scratch.txt"), "uncommitted\n");

  const r = spawnSync("bun", [join(repoRoot, "src/hooks.ts"), "session-start"], {
    cwd: clone,
    encoding: "utf8",
    input: JSON.stringify({ cwd: clone }),
  });
  expect(r.status).toBe(0);
  const board = readFileSync(join(clone, ".sddx", "BOARD.md"), "utf8");
  expect(board).toContain("Flagged worktrees");
  expect(board).toContain("dirty");
});

test("sddx sweep CLI reports removals and skips", () => {
  const clone = cloneWithRun(1);
  doneTask(clone, "T1");
  const r = sddx(clone, "sweep");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("swept ");
  expect(r.stdout).toContain("sweep: 1 removed, 0 skipped");
});

test("guarded sweep: dirty and receiptless worktrees are never touched", () => {
  // The two guarantees that matter: sweep never touches a worktree with
  // uncommitted changes, and never removes a DONE worktree whose receipt is missing.
  const clone = cloneWithRun(3);

  // (a) DONE + clean + receipt: removable, and its branch survives
  const removable = doneTask(clone, "T1");

  // (b) DONE + receipt, but dirty: skipped, contents untouched
  const dirty = doneTask(clone, "T2");
  writeFileSync(join(dirty.wt, "uncommitted.txt"), "work in progress\n");

  // (c) DONE but receipt deleted and the deletion committed: skipped, never removed
  const receiptless = doneTask(clone, "T3");
  rmSync(join(receiptless.wt, ".sddx", "receipts", "T3.json"), { force: true });
  expect(sddx(clone, "task", "show", "T3").status).toBe(0); // state still readable
  spawnSync("git", ["rm", "-q", "--cached", ".sddx/receipts/T3.json"], { cwd: receiptless.wt });
  spawnSync("git", ["commit", "-qm", "drop receipt"], { cwd: receiptless.wt });

  const res = sweep(clone);
  expect(res.locked).toBe(false);

  expect(res.removed).toEqual([removable.wt]);
  expect(existsSync(removable.wt)).toBe(false);
  expect(branchExists(clone, removable.id)).toBe(true);

  expect(existsSync(dirty.wt)).toBe(true);
  expect(readFileSync(join(dirty.wt, "uncommitted.txt"), "utf8")).toBe("work in progress\n");
  expect(res.skipped).toContainEqual({ path: dirty.wt, reason: "dirty" });

  expect(existsSync(receiptless.wt)).toBe(true);
  expect(res.skipped).toContainEqual({ path: receiptless.wt, reason: "DONE without receipt" });
});
