import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyChain } from "../src/lib/receipt";
import { fixtureClone } from "./fixtures";
import { repoRoot } from "./helpers";

const CLI_SRC = join(repoRoot, "src/cli.ts");

function cli(cwd: string, ...args: string[]): string {
  const r = spawnSync("bun", [CLI_SRC, ...args], { cwd, encoding: "utf8" });
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
  const tasks: Array<{ id: string; wt: string }> = [];
  for (const n of [1, 2]) {
    writeFileSync(
      join(clone, `spec${n}.yaml`),
      `task: parallel greet ${n}\nsuccess_criteria:\n  - "node check${n}.js exits 0"\noracle:\n  type: command\n  run: "node check${n}.js"\n`,
    );
    const out = cli(clone, "task", "create", "--spec", `spec${n}.yaml`);
    const id = /created (\S+)/.exec(out)![1]!;
    tasks.push({ id, wt: join(clone, ".sddx-worktrees", id) });
  }
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

  // neither task's state leaked outside its worktree
  expect(existsSync(join(clone, ".sddx"))).toBe(false);
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
  writeFileSync(
    join(clone, "spec3.yaml"),
    'task: crashed wip\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\n',
  );
  const id3 = /created (\S+)/.exec(cli(clone, "task", "create", "--spec", "spec3.yaml"))![1]!;
  const wt3 = join(clone, ".sddx-worktrees", id3);
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
