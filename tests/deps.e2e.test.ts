import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blockedOn, resolveTaskState } from "../src/lib/task";
import { fixtureClone, fixtureRepo } from "./fixtures";
import { fakeRedCheck, repoRoot } from "./helpers";

const CLI = join(repoRoot, "src/cli.ts");
const cli = (cwd: string, ...args: string[]) =>
  spawnSync("bun", [CLI, ...args], { cwd, encoding: "utf8" });
const g = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

function scopedGraph(cwd: string): void {
  mkdirSync(join(cwd, "specs"), { recursive: true });
  // B's scope overlaps A's — legal only because B depends on A (ordered)
  writeFileSync(
    join(cwd, "specs", "a.yaml"),
    `task: parent task alpha\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\nscope:\n  - src/db/**\n`,
  );
  writeFileSync(
    join(cwd, "specs", "b.yaml"),
    `task: child task bravo\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\nscope:\n  - src/db/schema.ts\n`,
  );
  writeFileSync(
    join(cwd, "graph.yaml"),
    "goal: ship the chain\ntasks:\n  - alias: a\n    spec: specs/a.yaml\n  - alias: b\n    spec: specs/b.yaml\n    depends_on: a\n",
  );
}

describe("dependency chain end-to-end", () => {
  test("dependent is blocked until its parent is DONE, then materializes from the parent's commit", () => {
    const { clone } = fixtureClone();
    scopedGraph(clone);

    const created = cli(clone, "graph", "create", "--graph", "graph.yaml");
    expect(created.status).toBe(0);
    const goalId = /created goal (\S+)/.exec(created.stdout)![1]!;
    const shown = JSON.parse(cli(clone, "goal", "show", goalId).stdout);
    const [aId, bId] = shown.task_ids as [string, string];

    // A is a root worktree; B is deferred (no worktree yet)
    const aWt = join(clone, ".sddx-worktrees", aId);
    expect(existsSync(aWt)).toBe(true);
    expect(existsSync(join(clone, ".sddx-worktrees", bId))).toBe(false);

    // B is blocked on A until A reaches DONE
    const bDeferred = resolveTaskState(clone, bId)!;
    expect(blockedOn(clone, bDeferred)).toBe(aId);

    // drive A to DONE inside its own worktree
    cli(aWt, "task", "phase", aId, "RED", "--test-exit", "1");
    cli(aWt, "task", "phase", aId, "GREEN", "--test-exit", "0");
    cli(aWt, "task", "phase", aId, "VERIFY");
    fakeRedCheck(aWt, aId);
    expect(cli(aWt, "verify", aId).status).toBe(0);
    expect(resolveTaskState(clone, aId)!.phase).toBe("DONE");

    // now B is unblocked
    expect(blockedOn(clone, resolveTaskState(clone, bId)!)).toBeNull();

    // materialize B — its worktree forks from A's DONE commit (tip of sddx/<aId>)
    const mat = cli(clone, "task", "materialize", bId);
    expect(mat.status).toBe(0);
    const bWt = join(clone, ".sddx-worktrees", bId);
    expect(existsSync(bWt)).toBe(true);
    expect(g(bWt, "rev-parse", "HEAD")).toBe(g(clone, "rev-parse", `sddx/${aId}`));

    // the deferred main-checkout copy is gone; the live state is the worktree's
    expect(existsSync(join(clone, ".sddx", "tasks", `${bId}.json`))).toBe(false);
    expect(resolveTaskState(clone, bId)!.workspace.base_sha).toBe(
      g(clone, "rev-parse", `sddx/${aId}`),
    );
  });

  test("branch-mode dependent materializes as a branch, not a worktree", () => {
    const cwd = fixtureRepo();
    scopedGraph(cwd);
    const created = cli(cwd, "graph", "create", "--graph", "graph.yaml", "--workspace", "branch");
    expect(created.status).toBe(0);
    const goalId = /created goal (\S+)/.exec(created.stdout)![1]!;
    const [aId, bId] = JSON.parse(cli(cwd, "goal", "show", goalId).stdout).task_ids as [
      string,
      string,
    ];

    // graph create in branch mode leaves HEAD on the root's branch; drive it to DONE
    cli(cwd, "task", "phase", aId, "RED", "--test-exit", "1");
    cli(cwd, "task", "phase", aId, "GREEN", "--test-exit", "0");
    cli(cwd, "task", "phase", aId, "VERIFY");
    fakeRedCheck(cwd, aId);
    expect(cli(cwd, "verify", aId).status).toBe(0);

    const mat = cli(cwd, "task", "materialize", bId);
    expect(mat.status).toBe(0);
    expect(mat.stdout).toContain("branch");
    // a branch at the parent's DONE commit, and NO worktree
    expect(g(cwd, "rev-parse", `sddx/${bId}`)).toBe(g(cwd, "rev-parse", `sddx/${aId}`));
    expect(existsSync(join(cwd, ".sddx-worktrees", bId))).toBe(false);
    expect(resolveTaskState(cwd, bId)!.workspace.mode).toBe("branch");
  });

  test("materialize refuses while the parent is not DONE", () => {
    const { clone } = fixtureClone();
    scopedGraph(clone);
    const created = cli(clone, "graph", "create", "--graph", "graph.yaml");
    const goalId = /created goal (\S+)/.exec(created.stdout)![1]!;
    const [, bId] = JSON.parse(cli(clone, "goal", "show", goalId).stdout).task_ids as [
      string,
      string,
    ];
    const r = cli(clone, "task", "materialize", bId);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not DONE");
  });
});
