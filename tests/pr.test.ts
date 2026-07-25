import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createBranchAt } from "../src/lib/git";
import { createGoal, goalId, readGoal, runBranchName } from "../src/lib/goal";
import { createGoalPr } from "../src/lib/pr";
import { parseSpec } from "../src/lib/spec";
import { createTask, readTask, taskId, transition, writeTask } from "../src/lib/task";
import { verifyTask } from "../src/lib/verify";
import { createWorktree, resolveBaseRef } from "../src/lib/worktree";
import { fixtureClone } from "./fixtures";

const g = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** Registers a worktree-mode task forked from `mainCwd`'s resolved base ref —
 * the default path, and the only mode where the main checkout (home of the
 * goal file) is never disturbed by a task's own branch/commits. */
function registerTask(mainCwd: string, sentence: string): { id: string; wtPath: string } {
  const spec = parseSpec(
    `task: ${sentence}\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\n`,
  ).spec!;
  const id = taskId(spec.task);
  const base = resolveBaseRef(mainCwd);
  const wtPath = createWorktree(mainCwd, id, base.sha);
  createTask(wtPath, spec, ".sddx/specs/x.yaml", {
    mode: "worktree",
    branch: `sddx/${id}`,
    base_sha: base.sha,
    path: relative(mainCwd, wtPath),
  });
  return { id, wtPath };
}

/** Creates a goal and its run branch up front — required order for
 * run-branch-integration: the goal must exist before a listed task's own
 * `verifyTask` call, so the automatic merge step can find it. */
function registerGoal(mainCwd: string, sentence: string, taskIds: string[]) {
  const base = resolveBaseRef(mainCwd);
  const gid = goalId(sentence);
  const runBranch = runBranchName(gid);
  createBranchAt(mainCwd, runBranch, base.sha);
  return createGoal(mainCwd, sentence, taskIds, { id: gid, runBranch, baseSha: base.sha });
}

/** Drives an already-registered task through RED→GREEN→VERIFY and verifies
 * it — a real DONE task with a real receipt. If the task's goal already
 * exists, this also merges it into the run branch automatically. */
function completeTask(wtPath: string, id: string, file: string): void {
  let t = readTask(wtPath, id);
  t = transition(t, "RED", { testExit: 1 });
  t = transition(t, "GREEN", { testExit: 0 });
  t = transition(t, "VERIFY");
  t.evidence.oracle_red = { exit_code: 1, at: new Date(0).toISOString() };
  writeTask(wtPath, t);
  writeFileSync(join(wtPath, file), `${id}\n`);
  const res = verifyTask(wtPath, id, { pluginVersion: "0.0.1" });
  if (res.verdict !== "pass") throw new Error(`fixture task ${id} failed to verify`);
}

function configurePrHost(cwd: string): void {
  mkdirSync(join(cwd, ".sddx"), { recursive: true });
  writeFileSync(join(cwd, ".sddx", "config.json"), JSON.stringify({ pr_host: "gh" }));
}

function fakeGh(
  binDir: string,
  opts: { authExit?: number; openExit?: number; openOut?: string; existingPrUrl?: string },
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
      'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
      opts.existingPrUrl ? `  echo '{"url":"${opts.existingPrUrl}"}'\n  exit 0` : "  exit 1",
      "fi",
      'if [ "$1" = "pr" ]; then',
      // record the full argv (one per line) so tests can inspect --body content
      `  printf '%s\\n' "$@" > "${binDir}/gh-args.txt"`,
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

  test("full path: two-task goal ships with a real merge history and a receipt-derived body", () => {
    const { clone } = fixtureClone();
    fakeGh(binDir, {});

    const t1 = registerTask(clone, "First shipped task");
    const t2 = registerTask(clone, "Second shipped task");
    configurePrHost(clone);
    const goal = registerGoal(clone, "Ship both tasks together", [t1.id, t2.id]);

    completeTask(t1.wtPath, t1.id, "a.txt");
    completeTask(t2.wtPath, t2.id, "b.txt");

    const res = createGoalPr(clone, goal.id);
    expect(res.prUrl).toBe("https://github.com/org/repo/pull/1");
    expect(res.taskIds).toEqual([t1.id, t2.id]);
    expect(res.branch).toBe(goal.run_branch);

    // real merges, not a reconstruction — both files present on the run branch
    expect(g(clone, "cat-file", "-e", `${goal.run_branch}:a.txt`)).toBe("");
    expect(g(clone, "cat-file", "-e", `${goal.run_branch}:b.txt`)).toBe("");

    expect(readGoal(clone, goal.id).shipped?.pr_url).toBe(res.prUrl);
    const remoteBranches = g(clone, "ls-remote", "--heads", "origin");
    expect(remoteBranches).toContain(goal.run_branch);

    const argv = readFileSync(join(binDir, "gh-args.txt"), "utf8");
    expect(argv).toContain(`--head\n${goal.run_branch}`);
    expect(argv).toContain(`\`${t1.id}\``);
    expect(argv).toContain(`\`${t2.id}\``);
    expect(argv).toContain("2 of 2 task(s) merged");
  });

  test("PR opens from a partially-merged run — body lists only merged tasks and states the outstanding count", () => {
    const { clone } = fixtureClone();
    fakeGh(binDir, {});

    const t1 = registerTask(clone, "Merged task only");
    const t2 = registerTask(clone, "Still-in-flight task");
    configurePrHost(clone);
    const goal = registerGoal(clone, "Partial goal", [t1.id, t2.id]);

    completeTask(t1.wtPath, t1.id, "a.txt");
    // t2 is left registered but never verified — never merges

    const res = createGoalPr(clone, goal.id);
    expect(res.taskIds).toEqual([t1.id]);

    const argv = readFileSync(join(binDir, "gh-args.txt"), "utf8");
    expect(argv).toContain(`\`${t1.id}\``);
    expect(argv).not.toContain(`\`${t2.id}\``);
    expect(argv).toContain("1 of 2 task(s) merged");
    expect(argv).toContain("1 outstanding");
  });

  test("refuses to re-run on an already-shipped goal instead of opening a duplicate PR", () => {
    const { clone } = fixtureClone();
    fakeGh(binDir, {});

    const t = registerTask(clone, "Shipped once already");
    configurePrHost(clone);
    const goal = registerGoal(clone, "Ship exactly once", [t.id]);
    completeTask(t.wtPath, t.id, "a.txt");

    const first = createGoalPr(clone, goal.id);
    expect(first.prUrl).toBe("https://github.com/org/repo/pull/1");

    expect(() => createGoalPr(clone, goal.id)).toThrow(/already shipped/);
  });

  test("refuses a duplicate PR the host already knows about, even without a local shipped marker", () => {
    const { clone } = fixtureClone();
    // no local `shipped` marker at all — simulates it being lost (e.g. the
    // goal file, deliberately never committed, wiped by a stray `git clean`)
    fakeGh(binDir, { existingPrUrl: "https://github.com/org/repo/pull/42" });

    const t = registerTask(clone, "Already has a PR on the host");
    configurePrHost(clone);
    const goal = registerGoal(clone, "Host already knows", [t.id]);
    completeTask(t.wtPath, t.id, "a.txt");

    expect(() => createGoalPr(clone, goal.id)).toThrow(/already has an open PR.*pull\/42/);
    const remoteBranches = g(clone, "ls-remote", "--heads", "origin");
    expect(remoteBranches).not.toContain(goal.run_branch);
  });

  test("refuses when the host backend isn't authenticated, before any push", () => {
    const { clone } = fixtureClone();
    fakeGh(binDir, { authExit: 1 });

    const t = registerTask(clone, "Auth failure task");
    configurePrHost(clone);
    const goal = registerGoal(clone, "Auth failure goal", [t.id]);
    completeTask(t.wtPath, t.id, "a.txt");

    expect(() => createGoalPr(clone, goal.id)).toThrow(/not authenticated/);
    expect(g(clone, "ls-remote", "--heads", "origin")).not.toContain(goal.run_branch);
  });

  test("refuses on an ambiguous host with no pr_host configured", () => {
    const { clone } = fixtureClone();
    // deliberately no configurePrHost() — origin is a local bare path, matches no known host

    const t = registerTask(clone, "Ambiguous host task");
    const goal = registerGoal(clone, "Ambiguous host goal", [t.id]);
    completeTask(t.wtPath, t.id, "a.txt");

    expect(() => createGoalPr(clone, goal.id)).toThrow(/pr_host/);
    expect(g(clone, "ls-remote", "--heads", "origin")).not.toContain(goal.run_branch);
  });

  test("a push failure leaves the goal unshipped, safe to retry once the remote is fixed", () => {
    const { clone } = fixtureClone();
    const t = registerTask(clone, "Task whose push will fail");
    configurePrHost(clone);
    const goal = registerGoal(clone, "Push failure goal", [t.id]);
    completeTask(t.wtPath, t.id, "a.txt");

    const realOrigin = g(clone, "remote", "get-url", "origin");
    spawnSync("git", ["remote", "set-url", "origin", "/nonexistent/path/nope.git"], { cwd: clone });

    expect(() => createGoalPr(clone, goal.id)).toThrow();
    expect(readGoal(clone, goal.id).shipped).toBeUndefined();

    spawnSync("git", ["remote", "set-url", "origin", realOrigin], { cwd: clone });
    fakeGh(binDir, {});
    const res = createGoalPr(clone, goal.id);
    expect(res.prUrl).toBe("https://github.com/org/repo/pull/1");
  });
});
