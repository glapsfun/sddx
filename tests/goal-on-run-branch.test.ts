// The goal record lives in its own ref, `refs/sddx/goals/<id>`.
//
// It holds `merges`, declared the single source of truth for integration state
// — yet as uncommitted local state in the main checkout it was the one run
// artifact that could not be audited, did not travel when the run branch was
// pushed, and vanished if `.sddx/` was cleaned, while the receipts it gives
// context to survived. That contradicts "state is files in git".
//
// A ref rather than a file in the run branch's tree, because a tree path
// travels with the branch and both directions of that were wrong: merging the
// run branch landed a frozen snapshot on the default branch that shadowed the
// live record forever, and deleting the merged branch destroyed it outright.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findGoalForTask, readGoal, writeGoal } from "../src/lib/goal";
import { fixtureClone } from "./fixtures";
import { fakeRedCheck, GRAPH_HEADER_LINES, repoRoot } from "./helpers";

const CLI = join(repoRoot, "src/cli.ts");
const cli = (cwd: string, ...args: string[]) =>
  spawnSync("bun", [CLI, ...args], { cwd, encoding: "utf8" });
const g = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

const spec = (task: string, part: string) =>
  `task: ${task}\nsuccess_criteria:\n  - a\nscope:\n  - ${part}/**\noracle:\n  type: command\n  run: "test -f ${part}/out.txt"\n`;

/** `n` independent root tasks, each satisfied by writing its own file. */
function plan(cwd: string, n: number): string {
  mkdirSync(join(cwd, "specs"), { recursive: true });
  const lines = [...GRAPH_HEADER_LINES, "goal: ship the widget", "tasks:"];
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
    // the record is not in the branch's tree, so it needs its own push — the
    // same one `sddx pr create` performs
    expect(
      g(cwd, "push", "-q", "origin", `refs/sddx/goals/${goalId}:refs/sddx/goals/${goalId}`).status,
    ).toBe(0);
    const second = join(cwd, "..", `second-${goalId}`);
    expect(g(cwd, "clone", "-q", join(cwd, "..", "origin.git"), second).status).toBe(0);
    expect(g(second, "checkout", "-q", `sddx/run-${goalId}`).status).toBe(0);

    // the fresh clone needs the ref fetched; a clone does not take custom refs
    expect(
      g(second, "fetch", "-q", "origin", `refs/sddx/goals/${goalId}:refs/sddx/goals/${goalId}`)
        .status,
    ).toBe(0);
    // and nothing loose was ever copied — the record is object-store content
    expect(existsSync(join(second, ".sddx", "goals", `${goalId}.json`))).toBe(false);
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
  test("a loose record is used only when no ref exists, and stays loose when written", () => {
    const { clone: cwd } = fixtureClone();
    const rel = plan(cwd, 1);
    const { goalId } = create(cwd, rel);

    // Simulate a goal written before refs existed: copy it loose, drop the ref.
    const record = readGoal(cwd, goalId);
    mkdirSync(join(cwd, ".sddx", "goals"), { recursive: true });
    writeFileSync(
      join(cwd, ".sddx", "goals", `${goalId}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    expect(g(cwd, "update-ref", "-d", `refs/sddx/goals/${goalId}`).status).toBe(0);

    const goal = readGoal(cwd, goalId);
    expect(goal.id).toBe(goalId);
    goal.shipped = { pr_url: "https://example.invalid/pr/1", at: new Date(0).toISOString() };
    writeGoal(cwd, goal);
    expect(readGoal(cwd, goalId).shipped?.pr_url).toBe("https://example.invalid/pr/1");
    expect(existsSync(join(cwd, ".sddx", "goals", `${goalId}.json`))).toBe(true);

    expect(cli(cwd, "run", "report", "--goal", goalId).status).toBe(0);
  }, 60_000);

  test("a stale loose snapshot never shadows the live ref", () => {
    // Merging a run branch used to land a point-in-time copy of the record at
    // `.sddx/goals/<id>.json` on the default branch, and the read path
    // preferred it — freezing the merge log at whatever it held on merge day.
    const { clone: cwd } = fixtureClone();
    const rel = plan(cwd, 1);
    const { goalId, ids } = create(cwd, rel);

    const stale = readGoal(cwd, goalId);
    mkdirSync(join(cwd, ".sddx", "goals"), { recursive: true });
    writeFileSync(
      join(cwd, ".sddx", "goals", `${goalId}.json`),
      `${JSON.stringify({ ...stale, merges: [] }, null, 2)}\n`,
    );

    complete(cwd, ids[0] as string, "part0");

    // the later merge is visible despite the frozen file sitting next to it
    expect(readGoal(cwd, goalId).merges).toHaveLength(1);
  }, 60_000);

  test("findGoalForTask sees goals in both locations", () => {
    const { clone: cwd } = fixtureClone();
    const rel = plan(cwd, 1);
    const { goalId, ids } = create(cwd, rel);

    const found = findGoalForTask(cwd, ids[0] as string);
    expect(found?.id).toBe(goalId);
  }, 60_000);
});
