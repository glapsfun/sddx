// The goal record lives on its run branch.
//
// It holds `merges`, declared the single source of truth for integration state
// — yet as uncommitted local state in the main checkout it was the one run
// artifact that could not be audited, did not travel when the run branch was
// pushed, and vanished if `.sddx/` was cleaned, while the receipts it gives
// context to survived. That contradicts "state is files in git".
//
// The older reasoning against committing it — that it would bind the record to
// whatever branch happened to be checked out — predates run branches. This one
// is sddx-owned, created before any task workspace, and lives exactly as long
// as the goal does.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findGoalForTask, readGoal, writeGoal } from "../src/lib/goal";
import { fixtureClone } from "./fixtures";
import { fakeRedCheck, repoRoot } from "./helpers";

const CLI = join(repoRoot, "src/cli.ts");
const cli = (cwd: string, ...args: string[]) =>
  spawnSync("bun", [CLI, ...args], { cwd, encoding: "utf8" });
const g = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

const spec = (task: string, part: string) =>
  `task: ${task}\nsuccess_criteria:\n  - a\nscope:\n  - ${part}/**\noracle:\n  type: command\n  run: "test -f ${part}/out.txt"\n`;

/** `n` independent root tasks, each satisfied by writing its own file. */
function plan(cwd: string, n: number): string {
  mkdirSync(join(cwd, "specs"), { recursive: true });
  const lines = ["goal: ship the widget", "tasks:"];
  for (let i = 0; i < n; i++) {
    writeFileSync(join(cwd, "specs", `n${i}.yaml`), spec(`build part ${i}`, `part${i}`));
    lines.push(`  - alias: n${i}`, `    spec: specs/n${i}.yaml`);
  }
  writeFileSync(join(cwd, "graph.yaml"), `${lines.join("\n")}\n`);
  return "graph.yaml";
}

function create(cwd: string, rel: string) {
  expect(cli(cwd, "graph", "approve", "--graph", rel).status).toBe(0);
  const r = cli(cwd, "graph", "create", "--graph", rel, "--output", "json");
  expect(r.status).toBe(0);
  const data = JSON.parse(r.stdout).data;
  return { goalId: data.goalId as string, ids: data.taskIds as string[] };
}

/** Drive one worktree task to DONE, which merges it into the run branch. */
function complete(cwd: string, id: string, part: string): void {
  const wt = join(cwd, ".sddx-worktrees", id);
  expect(cli(wt, "task", "phase", id, "RED", "--test-exit", "1").status).toBe(0);
  fakeRedCheck(wt, id);
  mkdirSync(join(wt, part), { recursive: true });
  writeFileSync(join(wt, part, "out.txt"), "done\n");
  expect(cli(wt, "task", "phase", id, "GREEN", "--test-exit", "0").status).toBe(0);
  expect(cli(wt, "task", "phase", id, "VERIFY").status).toBe(0);
  expect(cli(wt, "verify", id).status).toBe(0);
}

describe("the merge log is durable", () => {
  test("it survives removal of .sddx/goals from the main checkout", () => {
    const { clone: cwd } = fixtureClone();
    const rel = plan(cwd, 1);
    const { goalId, ids } = create(cwd, rel);
    complete(cwd, ids[0] as string, "part0");

    // the loose directory is not where the record lives any more
    rmSync(join(cwd, ".sddx", "goals"), { recursive: true, force: true });

    const goal = readGoal(cwd, goalId);
    expect(goal.merges).toHaveLength(1);
    expect(goal.merges[0]?.result).toBe("merged");
    expect(cli(cwd, "run", "report", "--goal", goalId).status).toBe(0);
  }, 60_000);

  test("it is present in a second clone once the run branch is pushed", () => {
    const { clone: cwd } = fixtureClone();
    const rel = plan(cwd, 1);
    const { goalId, ids } = create(cwd, rel);
    complete(cwd, ids[0] as string, "part0");

    expect(g(cwd, "push", "-q", "origin", `sddx/run-${goalId}`).status).toBe(0);
    const second = join(cwd, "..", `second-${goalId}`);
    expect(g(cwd, "clone", "-q", join(cwd, "..", "origin.git"), second).status).toBe(0);
    expect(g(second, "checkout", "-q", `sddx/run-${goalId}`).status).toBe(0);

    // read straight out of the fresh clone — no .sddx/goals/ was ever copied
    expect(existsSync(join(second, ".sddx", "goals", `${goalId}.json`))).toBe(true);
    const goal = readGoal(second, goalId);
    expect(goal.id).toBe(goalId);
    expect(goal.merges).toHaveLength(1);
  }, 60_000);

  test("two sibling tasks verifying concurrently both land merge entries", () => {
    const { clone: cwd } = fixtureClone();
    const rel = plan(cwd, 2);
    const { goalId, ids } = create(cwd, rel);

    // stage both to VERIFY, then run both verifies at once
    for (const [i, id] of ids.entries()) {
      const wt = join(cwd, ".sddx-worktrees", id);
      expect(cli(wt, "task", "phase", id, "RED", "--test-exit", "1").status).toBe(0);
      fakeRedCheck(wt, id);
      mkdirSync(join(wt, `part${i}`), { recursive: true });
      writeFileSync(join(wt, `part${i}`, "out.txt"), "done\n");
      expect(cli(wt, "task", "phase", id, "GREEN", "--test-exit", "0").status).toBe(0);
      expect(cli(wt, "task", "phase", id, "VERIFY").status).toBe(0);
    }
    const procs = ids.map((id) =>
      spawnSync("bun", [CLI, "verify", id], {
        cwd: join(cwd, ".sddx-worktrees", id),
        encoding: "utf8",
      }),
    );
    for (const p of procs) expect(p.status).toBe(0);

    // neither write overwrote the other
    const goal = readGoal(cwd, goalId);
    expect(goal.merges.map((m) => m.task_id).sort()).toEqual([...ids].sort());
  }, 60_000);
});

describe("legacy loose goal records", () => {
  test("a record in the main checkout still reads, reports, and updates in place", () => {
    const { clone: cwd } = fixtureClone();
    const rel = plan(cwd, 1);
    const { goalId } = create(cwd, rel);

    // Simulate a goal written before records moved: copy it loose and drop it
    // from the branch's future reads by writing the legacy location.
    const onBranch = readGoal(cwd, goalId);
    mkdirSync(join(cwd, ".sddx", "goals"), { recursive: true });
    writeFileSync(
      join(cwd, ".sddx", "goals", `${goalId}.json`),
      `${JSON.stringify({ ...onBranch, merges: [] }, null, 2)}\n`,
    );

    // the loose record wins, and stays loose when written
    const goal = readGoal(cwd, goalId);
    expect(goal.merges).toEqual([]);
    goal.shipped = { pr_url: "https://example.invalid/pr/1", at: new Date(0).toISOString() };
    writeGoal(cwd, goal);
    expect(readGoal(cwd, goalId).shipped?.pr_url).toBe("https://example.invalid/pr/1");
    expect(existsSync(join(cwd, ".sddx", "goals", `${goalId}.json`))).toBe(true);

    expect(cli(cwd, "run", "report", "--goal", goalId).status).toBe(0);
  }, 60_000);

  test("findGoalForTask sees goals in both locations", () => {
    const { clone: cwd } = fixtureClone();
    const rel = plan(cwd, 1);
    const { goalId, ids } = create(cwd, rel);

    const found = findGoalForTask(cwd, ids[0] as string);
    expect(found?.id).toBe(goalId);
  }, 60_000);
});
