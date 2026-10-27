import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGoal } from "../src/lib/goal";
import { createGoalPr } from "../src/lib/pr";
import { fixtureClone, writeConfig } from "./fixtures";
import { completeTask, createRun, sddx } from "./helpers";

setDefaultTimeout(60_000);

const g = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

const REAL_GIT = Bun.which("git");
const REAL_BUN = process.execPath;

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

  beforeEach(() => {
    // Only this directory is on PATH while a PR is created, so the host CLI is
    // always the fake one (or absent). git and bun are linked in because Bun
    // resolves an executable against the PATH current at spawn time.
    binDir = mkdtempSync(join(tmpdir(), "sddx-fakebin-"));
    if (!REAL_GIT) throw new Error("git not found on PATH");
    symlinkSync(REAL_GIT, join(binDir, "git"));
    symlinkSync(REAL_BUN, join(binDir, "bun"));
  });

  /** Runs `fn` with PATH limited to the fake bin directory. */
  function withHostPath<T>(fn: () => T): T {
    const saved = process.env.PATH;
    process.env.PATH = binDir;
    try {
      return fn();
    } finally {
      process.env.PATH = saved;
    }
  }

  /** A clone with a started goal of T1..Tn and `pr_host` configured. */
  function goal(n: number, opts: { prHost?: boolean } = {}) {
    const { clone } = fixtureClone();
    const run = createRun(clone, {
      title: "Ship the tasks together",
      tasks: Array.from({ length: n }, (_, i) => ({ id: `T${i + 1}` })),
    });
    if (opts.prHost !== false) writeConfig(clone, { pr_host: "gh" });
    return { clone, ...run };
  }

  test("full path: a two-task goal ships through the CLI with real merges and a receipt-derived body", () => {
    const { clone, goalId, runBranch } = goal(2);
    fakeGh(binDir, {});
    completeTask(clone, "T1");
    completeTask(clone, "T2");

    const r = withHostPath(() => sddx(clone, "pr", "create", "--goal", goalId, "--output", "json"));
    expect(r.status).toBe(0);
    const res = JSON.parse(r.stdout).data;
    expect(res.prUrl).toBe("https://github.com/org/repo/pull/1");
    expect(res.taskIds).toEqual(["T1", "T2"]);
    expect(res.branch).toBe(runBranch);

    // real merges, not a reconstruction: both tasks' files are on the run branch
    expect(g(clone, "cat-file", "-e", `${runBranch}:T1.done`)).toBe("");
    expect(g(clone, "cat-file", "-e", `${runBranch}:T2.done`)).toBe("");

    expect(readGoal(clone, goalId).shipped?.pr_url).toBe(res.prUrl);
    expect(g(clone, "ls-remote", "--heads", "origin")).toContain(runBranch);
    // the goal record travels with the PR, so a reviewer's clone has the merge log
    expect(g(clone, "ls-remote", "origin", `refs/sddx/goals/${goalId}`)).toContain(goalId);

    const argv = readFileSync(join(binDir, "gh-args.txt"), "utf8");
    expect(argv).toContain(`--head\n${runBranch}`);
    expect(argv).toContain("--title\nShip the tasks together");
    expect(argv).toContain("`T1`");
    expect(argv).toContain("`T2`");
    expect(argv).toContain("2 of 2 task(s) merged");
  });

  test("PR opens from a partially-merged run: the body lists only merged tasks and states the outstanding count", () => {
    const { clone, goalId } = goal(2);
    fakeGh(binDir, {});
    completeTask(clone, "T1");
    // T2 is never started, so it never merges

    const res = withHostPath(() => createGoalPr(clone, goalId));
    expect(res.taskIds).toEqual(["T1"]);

    const argv = readFileSync(join(binDir, "gh-args.txt"), "utf8");
    expect(argv).toContain("`T1`");
    expect(argv).not.toContain("`T2`");
    expect(argv).toContain("1 of 2 task(s) merged");
    expect(argv).toContain("1 outstanding");
  });

  test("refuses to re-run on an already-shipped goal instead of opening a duplicate PR", () => {
    const { clone, goalId } = goal(1);
    fakeGh(binDir, {});
    completeTask(clone, "T1");

    const first = withHostPath(() => createGoalPr(clone, goalId));
    expect(first.prUrl).toBe("https://github.com/org/repo/pull/1");

    expect(() => withHostPath(() => createGoalPr(clone, goalId))).toThrow(/already shipped/);
    const again = withHostPath(() => sddx(clone, "pr", "create", "--goal", goalId));
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("already shipped");
  });

  test("refuses a duplicate PR the host already knows about, even without a local shipped marker", () => {
    const { clone, goalId, runBranch } = goal(1);
    // no local `shipped` marker at all, as if it had been lost
    fakeGh(binDir, { existingPrUrl: "https://github.com/org/repo/pull/42" });
    completeTask(clone, "T1");

    expect(() => withHostPath(() => createGoalPr(clone, goalId))).toThrow(
      /already has an open PR.*pull\/42/,
    );
    expect(g(clone, "ls-remote", "--heads", "origin")).not.toContain(runBranch);
  });

  test("refuses when the host backend isn't authenticated, before any push", () => {
    const { clone, goalId, runBranch } = goal(1);
    fakeGh(binDir, { authExit: 1 });
    completeTask(clone, "T1");

    expect(() => withHostPath(() => createGoalPr(clone, goalId))).toThrow(/not authenticated/);
    expect(g(clone, "ls-remote", "--heads", "origin")).not.toContain(runBranch);
  });

  test("refuses on an ambiguous host with no pr_host configured", () => {
    // origin is a local bare path, which matches no known host
    const { clone, goalId, runBranch } = goal(1, { prHost: false });
    completeTask(clone, "T1");

    expect(() => withHostPath(() => createGoalPr(clone, goalId))).toThrow(/pr_host/);
    expect(g(clone, "ls-remote", "--heads", "origin")).not.toContain(runBranch);
  });

  test("a push failure leaves the goal unshipped, safe to retry once the remote is fixed", () => {
    const { clone, goalId } = goal(1);
    fakeGh(binDir, {});
    completeTask(clone, "T1");

    const realOrigin = g(clone, "remote", "get-url", "origin");
    g(clone, "remote", "set-url", "origin", "/nonexistent/path/nope.git");

    // authenticated, so the failure is the push itself
    expect(() => withHostPath(() => createGoalPr(clone, goalId))).toThrow(/push/);
    expect(readGoal(clone, goalId).shipped).toBeUndefined();

    g(clone, "remote", "set-url", "origin", realOrigin);
    const res = withHostPath(() => createGoalPr(clone, goalId));
    expect(res.prUrl).toBe("https://github.com/org/repo/pull/1");
  });
});
