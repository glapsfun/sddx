import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createWorktree, resolveBaseRef, sweep } from "../src/lib/worktree";
import { fixtureClone } from "./fixtures";
import { repoRoot } from "./helpers";

const CLI_SRC = join(repoRoot, "src/cli.ts");
const SPEC = (n: number) =>
  `task: sweep fixture ${n}\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\n`;

function cli(cwd: string, ...args: string[]) {
  const r = spawnSync("bun", [CLI_SRC, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`cli ${args.join(" ")}: ${r.stderr}${r.stdout}`);
  return r.stdout;
}

/** Create a worktree task and drive it to DONE (verified, receipt committed). */
function doneTask(clone: string, n: number): { id: string; wt: string } {
  writeFileSync(join(clone, `spec${n}.yaml`), SPEC(n));
  const id = /created (\S+)/.exec(cli(clone, "task", "create", "--spec", `spec${n}.yaml`))![1]!;
  const wt = join(clone, ".sddx-worktrees", id);
  cli(wt, "task", "phase", id, "RED", "--test-exit", "1");
  cli(wt, "task", "phase", id, "GREEN", "--test-exit", "0");
  cli(wt, "task", "phase", id, "VERIFY");
  cli(wt, "verify", id);
  return { id, wt };
}

test("fresh lock makes sweep a no-op; stale lock is reclaimed", () => {
  const { clone } = fixtureClone();
  const { wt } = doneTask(clone, 1);
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
  const { clone } = fixtureClone();
  const done = doneTask(clone, 1);

  const dirty = doneTask(clone, 2);
  writeFileSync(join(dirty.wt, "scratch.txt"), "uncommitted\n");

  // in-progress task: created but never verified
  writeFileSync(join(clone, "spec3.yaml"), SPEC(3));
  const inProgressId = /created (\S+)/.exec(
    cli(clone, "task", "create", "--spec", "spec3.yaml"),
  )![1]!;
  const inProgressWt = join(clone, ".sddx-worktrees", inProgressId);

  const res = sweep(clone);
  expect(res.locked).toBe(false);
  expect(res.removed).toEqual([done.wt]);
  expect(existsSync(done.wt)).toBe(false);
  expect(existsSync(dirty.wt)).toBe(true);
  expect(existsSync(inProgressWt)).toBe(true);
  expect(res.skipped).toContainEqual({ path: dirty.wt, reason: "dirty" });
  expect(res.skipped).toContainEqual({ path: inProgressWt, reason: "phase PLAN" });

  // branch of the swept task survives — branch deletion is cleanup's job
  const branch = spawnSync("git", ["rev-parse", "--verify", `refs/heads/sddx/${done.id}`], {
    cwd: clone,
  });
  expect(branch.status).toBe(0);
});

test("sweep skips worktrees without readable task state and ignores foreign worktrees", () => {
  const { clone } = fixtureClone();
  const orphan = createWorktree(clone, "orphan", resolveBaseRef(clone).sha);
  spawnSync("git", ["worktree", "add", "-q", join(clone, "..", "foreign"), "-b", "user/f"], {
    cwd: clone,
  });

  const res = sweep(clone);
  expect(res.removed).toEqual([]);
  expect(res.skipped).toEqual([{ path: orphan, reason: "no readable task state" }]);
  expect(existsSync(orphan)).toBe(true);
  expect(existsSync(join(clone, "..", "foreign"))).toBe(true);
});

test("sweep persists sorted skip results to .sddx/sweep.json; clean scan clears them", () => {
  const { clone } = fixtureClone();
  const first = doneTask(clone, 1);
  const second = doneTask(clone, 2);
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

  // both worktrees cleaned up → next scan skips nothing and clears stale flags
  rmSync(join(first.wt, "scratch.txt"));
  rmSync(join(second.wt, "scratch.txt"));
  sweep(clone);
  expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ skipped: [] });
});

test("lock-blocked sweep does not write sweep state", () => {
  const { clone } = fixtureClone();
  const { wt } = doneTask(clone, 1);
  writeFileSync(join(wt, "scratch.txt"), "uncommitted\n");
  mkdirSync(join(clone, ".git", "sddx-sweep.lock"));

  const blocked = sweep(clone);
  expect(blocked.locked).toBe(true);
  expect(existsSync(join(clone, ".sddx", "sweep.json"))).toBe(false);
});

test("session-start sweeps before rendering, so fresh flags land on the board", () => {
  const { clone } = fixtureClone();
  const { wt } = doneTask(clone, 1);
  writeFileSync(join(wt, "scratch.txt"), "uncommitted\n");
  mkdirSync(join(clone, ".sddx"), { recursive: true }); // committed in a real sddx repo

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
  const { clone } = fixtureClone();
  doneTask(clone, 1);
  const out = cli(clone, "sweep");
  expect(out).toContain("swept ");
  expect(out).toContain("sweep: 1 removed, 0 skipped");
});
