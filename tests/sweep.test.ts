import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createWorktree, resolveBaseRef, sweep } from "../src/lib/worktree";
import { fixtureClone } from "./fixtures";
import { createRun, fakeRedCheck, repoRoot } from "./helpers";

const CLI_SRC = join(repoRoot, "src/cli.ts");
const SPEC = (n: number) =>
  `task: sweep fixture ${n}\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\n`;

function cli(cwd: string, ...args: string[]) {
  const r = spawn(cwd, ...args);
  if (r.status !== 0) throw new Error(`cli ${args.join(" ")}: ${r.stderr}${r.stdout}`);
  return r.stdout;
}

const spawn = (cwd: string, ...args: string[]) =>
  spawnSync("bun", [CLI_SRC, ...args], { cwd, encoding: "utf8" });

/** One task in its own one-node run. Each fixture task gets its own goal so the
 * run branches never collide — a run is the only way to create a task now. */
function makeTask(clone: string, n: number): { id: string; wt: string } {
  const { taskIds } = createRun(
    clone,
    spawn,
    `sweep goal ${n}`,
    [{ alias: `t${n}`, spec: SPEC(n) }],
    { graphName: `graph${n}.yaml` },
  );
  const id = taskIds[0] as string;
  return { id, wt: join(clone, ".sddx-worktrees", id) };
}

/** Create a worktree task and drive it to DONE (verified, receipt committed). */
function doneTask(clone: string, n: number): { id: string; wt: string } {
  const { id, wt } = makeTask(clone, n);
  cli(wt, "task", "phase", id, "RED", "--test-exit", "1");
  cli(wt, "task", "phase", id, "GREEN", "--test-exit", "0");
  cli(wt, "task", "phase", id, "VERIFY");
  fakeRedCheck(wt, id);
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
  const { wt: inProgressWt } = makeTask(clone, 3);

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
  expect(res.skipped.map((s) => ({ ...s, path: realpathSync(s.path) }))).toEqual([
    { path: realpathSync(orphan), reason: "no readable task state" },
  ]);
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

test("guarded cleanup survives the branch-mode removals: dirty and receiptless are never touched", () => {
  // `retire-alternate-flows` deleted the branch/none cleanup paths. The two
  // guarantees that matter are NOT part of that deletion and must be provably
  // intact: sweep never touches a worktree with uncommitted changes, and never
  // removes a DONE worktree whose receipt is missing.
  const { clone } = fixtureClone();

  // (a) DONE + clean + receipt → removable, and its branch survives
  const removable = doneTask(clone, 1);

  // (b) DONE + receipt, but dirty → skipped, contents untouched
  const dirty = doneTask(clone, 2);
  writeFileSync(join(dirty.wt, "uncommitted.txt"), "work in progress\n");

  // (c) DONE but receipt deleted → skipped, never removed
  const receiptless = doneTask(clone, 3);
  rmSync(join(receiptless.wt, ".sddx", "receipts", `${receiptless.id}.json`), { force: true });
  cli(receiptless.wt, "task", "show", receiptless.id); // state still readable
  spawnSync("git", ["rm", "-q", "--cached", `.sddx/receipts/${receiptless.id}.json`], {
    cwd: receiptless.wt,
  });
  spawnSync("git", ["commit", "-qm", "drop receipt"], { cwd: receiptless.wt });

  const res = sweep(clone);
  expect(res.locked).toBe(false);

  expect(res.removed).toEqual([removable.wt]);
  expect(existsSync(removable.wt)).toBe(false);
  expect(
    spawnSync("git", ["rev-parse", "--verify", `refs/heads/sddx/${removable.id}`], {
      cwd: clone,
    }).status,
  ).toBe(0);

  expect(existsSync(dirty.wt)).toBe(true);
  expect(readFileSync(join(dirty.wt, "uncommitted.txt"), "utf8")).toBe("work in progress\n");
  expect(res.skipped).toContainEqual({ path: dirty.wt, reason: "dirty" });

  expect(existsSync(receiptless.wt)).toBe(true);
  expect(res.skipped).toContainEqual({ path: receiptless.wt, reason: "DONE without receipt" });
});
