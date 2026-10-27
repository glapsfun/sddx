// The goal record lives in its own ref, `refs/sddx/goals/<id>`.
//
// It holds `merges`, declared the single source of truth for integration state,
// yet as uncommitted local state in the main checkout it was the one run
// artifact that could not be audited, did not travel when the run branch was
// pushed, and vanished if `.sddx/` was cleaned, while the receipts it gives
// context to survived. That contradicts "state is files in git".
//
// A ref rather than a file in the run branch's tree, because a tree path
// travels with the branch and both directions of that were wrong: merging the
// run branch landed a frozen snapshot on the default branch that shadowed the
// live record forever, and deleting the merged branch destroyed it outright.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findGoalForTask, readGoal, writeGoal } from "../src/lib/goal";
import { fixtureClone } from "./fixtures";
import { CLI, completeTask, createRun, doneFile, sddx, startTask } from "./helpers";

setDefaultTimeout(60_000);

const g = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

/** A clone with a started goal of `n` independent tasks, T1..Tn. */
function run(n: number) {
  const { clone: cwd } = fixtureClone();
  const { goalId } = createRun(cwd, {
    tasks: Array.from({ length: n }, (_, i) => ({ id: `T${i + 1}` })),
  });
  return { cwd, goalId };
}

describe("the merge log is durable", () => {
  test("it survives removal of .sddx/goals from the main checkout", () => {
    const { cwd, goalId } = run(1);
    completeTask(cwd, "T1");

    // the loose directory is not where the record lives any more
    rmSync(join(cwd, ".sddx", "goals"), { recursive: true, force: true });

    const goal = readGoal(cwd, goalId);
    expect(goal.merges).toHaveLength(1);
    expect(goal.merges[0]?.result).toBe("merged");
    expect(sddx(cwd, "run", "report", "--goal", goalId).status).toBe(0);
    const shown = sddx(cwd, "goal", "show", goalId);
    expect(shown.status).toBe(0);
    expect(JSON.parse(shown.stdout).merges).toHaveLength(1);
  });

  test("it is present in a second clone once the run branch is pushed", () => {
    const { cwd, goalId } = run(1);
    completeTask(cwd, "T1");

    expect(g(cwd, "push", "-q", "origin", `sddx/run-${goalId}`).status).toBe(0);
    // the record is not in the branch's tree, so it needs its own push, the
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
    // and nothing loose was ever copied: the record is object-store content
    expect(existsSync(join(second, ".sddx", "goals", `${goalId}.json`))).toBe(false);
    const goal = readGoal(second, goalId);
    expect(goal.id).toBe(goalId);
    expect(goal.merges).toHaveLength(1);
  });

  test("two sibling tasks reviewed concurrently both land merge entries", async () => {
    const { cwd, goalId } = run(2);
    const ids = ["T1", "T2"];

    // bring both to IN_REVIEW, then record both passing reviews at once
    for (const id of ids) {
      const wt = startTask(cwd, id);
      writeFileSync(join(wt, doneFile(id)), "done\n");
      expect(sddx(cwd, "verify", id).status).toBe(0);
    }
    const procs = ids.map((id) =>
      Bun.spawn(["bun", CLI, "review", "record", id, "--verdict", "pass"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    for (const code of await Promise.all(procs.map((p) => p.exited))) expect(code).toBe(0);

    // neither write overwrote the other
    const goal = readGoal(cwd, goalId);
    expect(goal.merges.map((m) => m.task_id).sort()).toEqual(ids);
    expect(goal.merges.every((m) => m.result === "merged")).toBe(true);
  });
});

describe("legacy loose goal records", () => {
  test("a loose record is used only when no ref exists, and stays loose when written", () => {
    const { cwd, goalId } = run(1);

    // a goal written before refs existed: copy it loose, drop the ref
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

    expect(sddx(cwd, "run", "report", "--goal", goalId).status).toBe(0);
  });

  test("a stale loose snapshot never shadows the live ref", () => {
    // Merging a run branch used to land a point-in-time copy of the record at
    // `.sddx/goals/<id>.json` on the default branch, and the read path
    // preferred it, freezing the merge log at whatever it held on merge day.
    const { cwd, goalId } = run(1);

    const stale = readGoal(cwd, goalId);
    mkdirSync(join(cwd, ".sddx", "goals"), { recursive: true });
    writeFileSync(
      join(cwd, ".sddx", "goals", `${goalId}.json`),
      `${JSON.stringify({ ...stale, merges: [] }, null, 2)}\n`,
    );

    completeTask(cwd, "T1");

    // the later merge is visible despite the frozen file sitting next to it
    expect(readGoal(cwd, goalId).merges).toHaveLength(1);
  });

  test("findGoalForTask sees goals in both locations", () => {
    const { cwd, goalId } = run(1);
    expect(findGoalForTask(cwd, "T1")?.id).toBe(goalId);

    // the same record, loose only
    const record = readGoal(cwd, goalId);
    mkdirSync(join(cwd, ".sddx", "goals"), { recursive: true });
    writeFileSync(join(cwd, ".sddx", "goals", `${goalId}.json`), JSON.stringify(record));
    expect(g(cwd, "update-ref", "-d", `refs/sddx/goals/${goalId}`).status).toBe(0);
    expect(findGoalForTask(cwd, "T1")?.id).toBe(goalId);
  });
});
