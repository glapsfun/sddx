import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyChain } from "../src/lib/receipt";
import { fixtureClone } from "./fixtures";
import { createRun, repoRoot } from "./helpers";

const CLI_SRC = join(repoRoot, "src/cli.ts");

const spawnCli = (cwd: string, ...args: string[]) =>
  spawnSync("bun", [CLI_SRC, ...args], { cwd, encoding: "utf8" });

function cli(cwd: string, ...args: string[]): string {
  const r = spawnCli(cwd, ...args);
  if (r.status !== 0) throw new Error(`cli ${args.join(" ")}: ${r.stderr}${r.stdout}`);
  return r.stdout;
}

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

test("M2 oracle: two parallel worktree tasks — chained receipts, clean sweep after crash, zero .sddx merge conflicts", () => {
  const { clone } = fixtureClone();
  const baseSha = git(clone, "rev-parse", "origin/HEAD");

  // ---- create BOTH tasks up front: two live worktrees, forked from the same base
  // Two parallel siblings ARE a two-node graph — one run, disjoint scopes.
  const { taskIds } = createRun(
    clone,
    spawnCli,
    "ship both greets",
    [1, 2].map((n) => ({
      alias: `p${n}`,
      spec: `task: parallel greet ${n}\nsuccess_criteria:\n  - "node check${n}.js exits 0"\nscope:\n  - "greet${n}.js"\n  - "check${n}.js"\noracle:\n  type: command\n  run: "node check${n}.js"\n`,
    })),
  );
  const tasks = taskIds.map((id) => ({ id, wt: join(clone, ".sddx-worktrees", id) }));
  const [t1, t2] = tasks as [(typeof tasks)[0], (typeof tasks)[0]];
  expect(existsSync(t1.wt) && existsSync(t2.wt)).toBe(true);
  expect(git(t1.wt, "rev-parse", "HEAD")).toBe(baseSha);
  expect(git(t2.wt, "rev-parse", "HEAD")).toBe(baseSha);

  // ---- interleave the two TDD loops (as parallel executors would)
  for (const [n, t] of [
    [1, t1],
    [2, t2],
  ] as const) {
    writeFileSync(join(t.wt, `check${n}.js`), `require("./greet${n}.js");\n`);
    const red = spawnSync("node", [`check${n}.js`], { cwd: t.wt });
    expect(red.status).not.toBe(0);
    cli(t.wt, "task", "phase", t.id, "RED", "--test-exit", String(red.status));
    cli(t.wt, "red-check", t.id); // the oracle genuinely fails pre-implementation
  }
  for (const [n, t] of [
    [1, t1],
    [2, t2],
  ] as const) {
    writeFileSync(join(t.wt, `greet${n}.js`), "module.exports = 'hello';\n");
    const green = spawnSync("node", [`check${n}.js`], { cwd: t.wt });
    expect(green.status).toBe(0);
    cli(t.wt, "task", "phase", t.id, "GREEN", "--test-exit", "0");
    cli(t.wt, "task", "phase", t.id, "VERIFY");
    cli(t.wt, "verify", t.id);
  }

  // neither task's state leaked outside its worktree. The main checkout does
  // hold run-level bookkeeping (goal record, drafts) — what must not be there
  // is either task's own state.
  for (const t of tasks) {
    expect(existsSync(join(clone, ".sddx", "tasks", `${t.id}.json`))).toBe(false);
    expect(existsSync(join(clone, ".sddx", "receipts", `${t.id}.json`))).toBe(false);
  }
  expect(existsSync(join(t1.wt, ".sddx", "receipts", `${t2.id}.json`))).toBe(false);

  // ---- zero merge conflicts in .sddx/: merge both branches sequentially
  for (const t of tasks) {
    const merge = spawnSync("git", ["merge", "-q", "--no-edit", `sddx/${t.id}`], {
      cwd: clone,
      encoding: "utf8",
    });
    expect(merge.status).toBe(0);
  }
  for (const t of tasks) {
    expect(existsSync(join(clone, ".sddx", "tasks", `${t.id}.json`))).toBe(true);
    expect(existsSync(join(clone, ".sddx", "receipts", `${t.id}.json`))).toBe(true);
    const state = JSON.parse(readFileSync(join(clone, ".sddx", "tasks", `${t.id}.json`), "utf8"));
    expect(state.phase).toBe("DONE");
    expect(state.workspace.mode).toBe("worktree");
    expect(state.workspace.base_sha).toBe(baseSha);
  }

  // both receipts are roots of the hash tree (parallel from an empty base) and validate together
  expect(verifyChain(clone)).toEqual([]);

  // ---- simulated crash: session died before cleanup; a third task sits dirty
  const { taskIds: crashed } = createRun(
    clone,
    spawnCli,
    "crashed session goal",
    [
      {
        alias: "wip",
        spec: 'task: crashed wip\nsuccess_criteria:\n  - a\nscope:\n  - "wip/**"\noracle:\n  type: command\n  run: "exit 0"\n',
      },
    ],
    { graphName: "graph3.yaml" },
  );
  const wt3 = join(clone, ".sddx-worktrees", crashed[0] as string);
  writeFileSync(join(wt3, "half-finished.js"), "// uncommitted work\n");

  const sweepOut = cli(clone, "sweep");
  expect(sweepOut).toContain("sweep: 2 removed, 1 skipped");
  expect(existsSync(t1.wt)).toBe(false);
  expect(existsSync(t2.wt)).toBe(false);
  expect(existsSync(join(wt3, "half-finished.js"))).toBe(true); // dirty survives

  // branches survive the sweep — merging/deleting them stays a user decision
  expect(git(clone, "rev-parse", "--verify", `refs/heads/sddx/${t1.id}`)).toBeTruthy();
  expect(git(clone, "rev-parse", "--verify", `refs/heads/sddx/${t2.id}`)).toBeTruthy();
});
