import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blockedOn, resolveTaskState } from "../src/lib/task";
import { rematerializeStaleDependents } from "../src/lib/worktree";
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

function driveToDone(worktree: string, id: string): void {
  cli(worktree, "task", "phase", id, "RED", "--test-exit", "1");
  cli(worktree, "task", "phase", id, "GREEN", "--test-exit", "0");
  cli(worktree, "task", "phase", id, "VERIFY");
  fakeRedCheck(worktree, id);
  expect(cli(worktree, "verify", id).status).toBe(0);
}

describe("fan-in dependency end-to-end", () => {
  function fanInGraph(cwd: string): void {
    mkdirSync(join(cwd, "specs"), { recursive: true });
    writeFileSync(
      join(cwd, "specs", "a.yaml"),
      `task: root task alpha\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\nscope:\n  - src/a/**\n`,
    );
    writeFileSync(
      join(cwd, "specs", "b.yaml"),
      `task: root task bravo\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\nscope:\n  - src/b/**\n`,
    );
    writeFileSync(
      join(cwd, "specs", "d.yaml"),
      `task: fan-in task delta\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\nscope:\n  - src/d/**\n`,
    );
    writeFileSync(
      join(cwd, "graph.yaml"),
      "goal: ship the fan-in\ntasks:\n  - alias: a\n    spec: specs/a.yaml\n  - alias: b\n    spec: specs/b.yaml\n  - alias: d\n    spec: specs/d.yaml\n    depends_on: [a, b]\n",
    );
  }

  test("a two-parent fan-in child materializes via a clean merge of both DONE commits", () => {
    const { clone } = fixtureClone();
    fanInGraph(clone);

    const created = cli(clone, "graph", "create", "--graph", "graph.yaml");
    expect(created.status).toBe(0);
    const goalId = /created goal (\S+)/.exec(created.stdout)![1]!;
    const shown = JSON.parse(cli(clone, "goal", "show", goalId).stdout);
    const [aId, bId, dId] = shown.task_ids as [string, string, string];

    // A and B are independent root worktrees; D is deferred
    expect(existsSync(join(clone, ".sddx-worktrees", aId))).toBe(true);
    expect(existsSync(join(clone, ".sddx-worktrees", bId))).toBe(true);
    expect(existsSync(join(clone, ".sddx-worktrees", dId))).toBe(false);
    expect(blockedOn(clone, resolveTaskState(clone, dId)!)).toBe(aId);

    driveToDone(join(clone, ".sddx-worktrees", aId), aId);
    // still blocked on B even though A is DONE
    expect(blockedOn(clone, resolveTaskState(clone, dId)!)).toBe(bId);
    driveToDone(join(clone, ".sddx-worktrees", bId), bId);
    expect(blockedOn(clone, resolveTaskState(clone, dId)!)).toBeNull();

    const mat = cli(clone, "task", "materialize", dId);
    expect(mat.status).toBe(0);
    const dWt = join(clone, ".sddx-worktrees", dId);
    expect(existsSync(dWt)).toBe(true);

    const aSha = g(clone, "rev-parse", `sddx/${aId}`);
    const bSha = g(clone, "rev-parse", `sddx/${bId}`);
    const dHead = g(dWt, "rev-parse", "HEAD");
    const parents = g(dWt, "log", "-1", "--format=%P", dHead).split(" ").filter(Boolean);
    expect(parents).toEqual([aSha, bSha]);
    expect(resolveTaskState(clone, dId)!.workspace.base_sha).toBe(dHead);
  });
});

describe("retry end-to-end", () => {
  test("a fresh retry resets a worktree task to PLAN, then abandons once attempts are exhausted", () => {
    const { clone } = fixtureClone();
    writeFileSync(
      join(clone, "spec.yaml"),
      `task: flaky root task\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\nretry:\n  max_attempts: 2\n  workspace: fresh\n`,
    );
    const created = cli(clone, "task", "create", "--spec", "spec.yaml", "--workspace", "worktree");
    const id = /created (\S+)/.exec(created.stdout)![1]!;
    const wt = join(clone, ".sddx-worktrees", id);
    const originalBase = resolveTaskState(clone, id)!.workspace.base_sha;

    cli(wt, "task", "phase", id, "RED", "--test-exit", "1");
    cli(wt, "task", "phase", id, "GREEN", "--test-exit", "0");

    const firstAbandon = cli(wt, "task", "phase", id, "ABANDONED");
    expect(firstAbandon.status).toBe(0);
    expect(firstAbandon.stdout).toContain("retry 2/2");
    const afterRetry = resolveTaskState(clone, id)!;
    expect(afterRetry.phase).toBe("PLAN");
    expect(afterRetry.attempt_count).toBe(2);
    // fresh: the worktree still exists at the same relative path, re-forked
    // from the same base, with no leftover GREEN-phase evidence
    expect(existsSync(wt)).toBe(true);
    expect(afterRetry.evidence).toEqual({});
    expect(afterRetry.workspace.base_sha).toBe(originalBase);
    expect(g(wt, "rev-parse", "HEAD")).toBe(originalBase);

    // second attempt exhausts the retry budget
    cli(wt, "task", "phase", id, "RED", "--test-exit", "1");
    cli(wt, "task", "phase", id, "GREEN", "--test-exit", "0");
    const secondAbandon = cli(wt, "task", "phase", id, "ABANDONED");
    expect(secondAbandon.status).toBe(0);
    expect(secondAbandon.stdout).not.toContain("retry");
    expect(resolveTaskState(clone, id)!.phase).toBe("ABANDONED");
  });

  test("the cascade mechanism discards and re-materializes an already-materialized dependent once its parent's commit moves", () => {
    // `abandonOrRetry` only ever fires on a non-terminal task, and a dependent
    // only ever materializes once its parent is DONE — so in normal operation
    // a retry can never catch a dependent already built against a stale
    // commit. `rematerializeStaleDependents` exists as the defensive-by-
    // construction guarantee behind that invariant; this test exercises it
    // directly against a hand-constructed "parent's commit moved" state,
    // which is the only way to observe it without violating the invariant.
    const { clone } = fixtureClone();
    mkdirSync(join(clone, "specs"), { recursive: true });
    writeFileSync(
      join(clone, "specs", "a.yaml"),
      `task: chain parent\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\nscope:\n  - src/a/**\n`,
    );
    writeFileSync(
      join(clone, "specs", "b.yaml"),
      `task: chain child\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\nscope:\n  - src/a/child.ts\n`,
    );
    writeFileSync(
      join(clone, "graph.yaml"),
      "goal: ship the chain\ntasks:\n  - alias: a\n    spec: specs/a.yaml\n  - alias: b\n    spec: specs/b.yaml\n    depends_on: a\n",
    );
    const created = cli(clone, "graph", "create", "--graph", "graph.yaml");
    const goalId = /created goal (\S+)/.exec(created.stdout)![1]!;
    const [aId, bId] = JSON.parse(cli(clone, "goal", "show", goalId).stdout).task_ids as [
      string,
      string,
    ];
    const aWt = join(clone, ".sddx-worktrees", aId);

    driveToDone(aWt, aId);
    const firstDoneSha = g(clone, "rev-parse", `sddx/${aId}`);
    expect(cli(clone, "task", "materialize", bId).status).toBe(0);
    const bWt = join(clone, ".sddx-worktrees", bId);
    expect(g(bWt, "rev-parse", "HEAD")).toBe(firstDoneSha);

    // simulate "A's commit moved" directly at the git level, from inside A's
    // own worktree (which already has `sddx/<aId>` checked out) — bypassing
    // the task lifecycle, which has no path to produce this on its own
    mkdirSync(join(aWt, "src", "a"), { recursive: true });
    writeFileSync(join(aWt, "src", "a", "extra.ts"), "// superseding commit\n");
    spawnSync("git", ["add", "-A"], { cwd: aWt });
    spawnSync("git", ["commit", "-qm", "superseding commit"], { cwd: aWt });
    const secondSha = g(clone, "rev-parse", `sddx/${aId}`);
    expect(secondSha).not.toBe(firstDoneSha);

    const rebuilt = rematerializeStaleDependents(clone, aId);
    expect(rebuilt).toEqual([bId]);
    expect(g(bWt, "rev-parse", "HEAD")).toBe(secondSha);
    expect(resolveTaskState(clone, bId)!.workspace.base_sha).toBe(secondSha);
  });
});
