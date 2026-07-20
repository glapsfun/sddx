import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headSha } from "../src/lib/git";
import { createGoal, readGoal } from "../src/lib/goal";
import { createGoalPr } from "../src/lib/pr";
import { goalBranchName } from "../src/lib/prbranch";
import { parseSpec } from "../src/lib/spec";
import { createTask, taskId, transition, writeTask } from "../src/lib/task";
import { verifyTask } from "../src/lib/verify";
import { fixtureClone } from "./fixtures";

const g = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

function branchExists(cwd: string, branch: string): boolean {
  return (
    spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd })
      .status === 0
  );
}

/** A real DONE task with a real verified receipt on its own branch — same
 * invariants `sddx verify` produces, not a hand-crafted fixture. */
function realDoneTask(cwd: string, sentence: string, file: string): string {
  const spec = parseSpec(
    `task: ${sentence}\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\n`,
  ).spec!;
  const id = taskId(spec.task);
  g(cwd, "switch", "-c", `sddx/${id}`);
  let t = createTask(cwd, spec, ".sddx/specs/x.yaml", {
    mode: "branch",
    branch: `sddx/${id}`,
    base_sha: headSha(cwd),
  });
  t = transition(t, "RED", { testExit: 1 });
  t = transition(t, "GREEN", { testExit: 0 });
  t = transition(t, "VERIFY");
  t.evidence.oracle_red = { exit_code: 1, at: new Date(0).toISOString() };
  writeTask(cwd, t);
  writeFileSync(join(cwd, file), `${id}\n`);
  const res = verifyTask(cwd, id, { pluginVersion: "0.0.1" });
  if (res.verdict !== "pass") throw new Error(`fixture task ${id} failed to verify`);
  g(cwd, "switch", "main");
  return id;
}

function configurePrHost(cwd: string): void {
  mkdirSync(join(cwd, ".sddx"), { recursive: true });
  writeFileSync(join(cwd, ".sddx", "config.json"), JSON.stringify({ pr_host: "gh" }));
}

function fakeGh(
  binDir: string,
  opts: { authExit?: number; openExit?: number; openOut?: string },
): void {
  const authExit = opts.authExit ?? 0;
  const openExit = opts.openExit ?? 0;
  const openOut = opts.openOut ?? "https://github.com/org/repo/pull/1";
  writeFileSync(
    join(binDir, "gh"),
    [
      "#!/bin/sh",
      'if [ "$1" = "auth" ]; then',
      '  echo "auth status"',
      `  exit ${authExit}`,
      "fi",
      'if [ "$1" = "pr" ]; then',
      `  echo "${openOut}"`,
      `  exit ${openExit}`,
      "fi",
      "exit 0",
    ].join("\n"),
  );
  chmodSync(join(binDir, "gh"), 0o755);
}

describe("createGoalPr", () => {
  let binDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "sddx-fakebin-"));
    originalPath = process.env.PATH;
    process.env.PATH = binDir;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  test("full path: two-task goal ships with markers on both tasks and the goal", () => {
    const { clone } = fixtureClone();
    fakeGh(binDir, {});

    const id1 = realDoneTask(clone, "First shipped task", "a.txt");
    const id2 = realDoneTask(clone, "Second shipped task", "b.txt");
    // written on "main" after both task branches exist — writing it earlier
    // would just get swept away by each task branch's own `switch` roundtrip
    configurePrHost(clone);
    const goal = createGoal(clone, "Ship both tasks together", [id1, id2]);

    const res = createGoalPr(clone, goal.id);
    expect(res.prUrl).toBe("https://github.com/org/repo/pull/1");
    expect(res.taskIds).toEqual([id1, id2]);
    expect(res.branch).toBe(goalBranchName(goal.id));

    for (const id of [id1, id2]) {
      const raw = g(clone, "show", `sddx/${id}:.sddx/tasks/${id}.json`);
      const shipped = JSON.parse(raw).shipped;
      expect(shipped.goal_id).toBe(goal.id);
      expect(shipped.pr_url).toBe(res.prUrl);
    }
    expect(readGoal(clone, goal.id).shipped?.pr_url).toBe(res.prUrl);

    const remoteBranches = g(clone, "ls-remote", "--heads", "origin");
    expect(remoteBranches).toContain(res.branch);

    // the temp goal worktree is cleaned up, only task branches' worktrees (none, in branch mode) remain
    expect(g(clone, "worktree", "list", "--porcelain")).not.toContain(`goal-${goal.id}`);
  });

  test("refuses to re-run on an already-shipped goal instead of opening a duplicate PR", () => {
    const { clone } = fixtureClone();
    fakeGh(binDir, {});

    const id = realDoneTask(clone, "Shipped once already", "a.txt");
    configurePrHost(clone);
    const goal = createGoal(clone, "Ship exactly once", [id]);

    const first = createGoalPr(clone, goal.id);
    expect(first.prUrl).toBe("https://github.com/org/repo/pull/1");

    expect(() => createGoalPr(clone, goal.id)).toThrow(/already shipped/);
    // no second goal branch was pushed
    const remoteBranches = g(clone, "ls-remote", "--heads", "origin");
    expect(
      remoteBranches.split("\n").filter((l) => l.includes(goalBranchName(goal.id))),
    ).toHaveLength(1);
  });

  test("a push failure cleans up the goal worktree so a retry isn't blocked", () => {
    const { clone } = fixtureClone();
    const id = realDoneTask(clone, "Task whose push will fail", "a.txt");
    const goal = createGoal(clone, "Push failure goal", [id]);

    const realOrigin = g(clone, "remote", "get-url", "origin");
    spawnSync("git", ["remote", "set-url", "origin", "/nonexistent/path/nope.git"], { cwd: clone });

    expect(() => createGoalPr(clone, goal.id)).toThrow();
    // the worktree must not survive a failed push — otherwise a retry's own
    // `git worktree add` for the same path would fail
    expect(g(clone, "worktree", "list", "--porcelain")).not.toContain(`goal-${goal.id}`);

    // fix the remote and retry — must succeed despite the leftover local
    // branch from the failed attempt (buildGoalBranch always starts over)
    spawnSync("git", ["remote", "set-url", "origin", realOrigin], { cwd: clone });
    configurePrHost(clone);
    fakeGh(binDir, {});
    const res = createGoalPr(clone, goal.id);
    expect(res.prUrl).toBe("https://github.com/org/repo/pull/1");
  });

  test("refuses an incomplete goal with no side effects", () => {
    const { clone } = fixtureClone();
    // no pr_host config needed — the completeness gate runs before host resolution

    const done = realDoneTask(clone, "Only finished task", "a.txt");
    const pending = createTask(
      clone,
      parseSpec(
        "task: still planning\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: t\n",
      ).spec!,
      "s",
      {
        mode: "none",
        branch: null,
        base_sha: "a",
      },
    );
    const goal = createGoal(clone, "Mixed readiness goal", [done, pending.id]);

    expect(() => createGoalPr(clone, goal.id)).toThrow(/not complete/);
    expect(branchExists(clone, goalBranchName(goal.id))).toBe(false);
    expect(g(clone, "ls-remote", "--heads", "origin")).not.toContain(goalBranchName(goal.id));
  });

  test("refuses when the host backend isn't authenticated, before any git mutation", () => {
    const { clone } = fixtureClone();
    fakeGh(binDir, { authExit: 1 });

    const id = realDoneTask(clone, "Auth failure task", "a.txt");
    configurePrHost(clone);
    const goal = createGoal(clone, "Auth failure goal", [id]);

    expect(() => createGoalPr(clone, goal.id)).toThrow(/not authenticated/);
    expect(branchExists(clone, goalBranchName(goal.id))).toBe(false);
    expect(g(clone, "ls-remote", "--heads", "origin")).not.toContain(goalBranchName(goal.id));
  });

  test("refuses on an ambiguous host with no pr_host configured", () => {
    const { clone } = fixtureClone();
    // deliberately no configurePrHost() — origin is a local bare path, matches no known host

    const id = realDoneTask(clone, "Ambiguous host task", "a.txt");
    const goal = createGoal(clone, "Ambiguous host goal", [id]);

    expect(() => createGoalPr(clone, goal.id)).toThrow(/pr_host/);
    expect(branchExists(clone, goalBranchName(goal.id))).toBe(false);
  });
});
