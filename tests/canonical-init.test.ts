// The canonical initializer: everything validated before anything is created,
// and anything created is removed when a later step fails.
//
// Before this, `graph create` validated specs and the schedule, then created
// the run branch, then created tasks one at a time — so a collision on the
// third task surfaced after the run branch and two worktrees already existed,
// and nothing removed them. The user was left with a half-run they had to
// unpick by hand, and a goal id that would now collide on the retry.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureClone } from "./fixtures";
import { goalIds, repoRoot } from "./helpers";

const CLI = join(repoRoot, "src/cli.ts");
const cli = (cwd: string, ...args: string[]) =>
  spawnSync("bun", [CLI, ...args], { cwd, encoding: "utf8" });
const g = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

const spec = (task: string, scope: string) =>
  `task: ${task}\nsuccess_criteria:\n  - a\noracle:\n  type: command\n  run: "exit 0"\nscope:\n  - ${scope}\n`;

/** `n` independent root tasks with disjoint scopes. */
function rootsGraph(cwd: string, n: number): string {
  mkdirSync(join(cwd, "specs"), { recursive: true });
  const lines = ["goal: ship the widget", "tasks:"];
  for (let i = 0; i < n; i++) {
    writeFileSync(join(cwd, "specs", `n${i}.yaml`), spec(`build part ${i}`, `src/n${i}/**`));
    lines.push(`  - alias: n${i}`, `    spec: specs/n${i}.yaml`);
  }
  writeFileSync(join(cwd, "graph.yaml"), `${lines.join("\n")}\n`);
  return "graph.yaml";
}

function approveAndCreate(cwd: string, rel: string) {
  const a = cli(cwd, "graph", "approve", "--graph", rel);
  if (a.status !== 0) return a;
  return cli(cwd, "graph", "create", "--graph", rel);
}

/** Everything a run creates, so a refusal can be asserted to have left none of it. */
function runState(cwd: string) {
  const dir = (p: string) => (existsSync(join(cwd, p)) ? readdirSync(join(cwd, p)) : []);
  return {
    goals: goalIds(cwd),
    tasks: dir(join(".sddx", "tasks")),
    worktrees: dir(".sddx-worktrees"),
    branches: g(cwd, "branch", "--list", "sddx/*").stdout.trim(),
  };
}

const EMPTY = { goals: [], tasks: [], worktrees: [], branches: "" };

/** What a plan WOULD create, without creating anything. */
function planned(cwd: string, rel: string): { ids: string[]; runBranch: string } {
  const dry = cli(cwd, "graph", "create", "--graph", rel, "--dry-run", "--output", "json");
  const data = JSON.parse(dry.stdout).data;
  return { ids: data.taskIds as string[], runBranch: data.runBranch as string };
}

describe("preflight completes before any mutation", () => {
  test("a task-branch collision is caught before the run branch is created", () => {
    const { clone: cwd } = fixtureClone();
    const rel = rootsGraph(cwd, 2);
    const { ids } = planned(cwd, rel);
    expect(ids.length).toBe(2);
    // occupy the SECOND task's branch — the collision must surface in preflight,
    // not partway through creation with the run branch already made
    g(cwd, "branch", `sddx/${ids[1]}`);

    const r = approveAndCreate(cwd, rel);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(ids[1] as string);
    expect(runState(cwd).goals).toEqual([]);
    expect(g(cwd, "branch", "--list", "sddx/run-*").stdout.trim()).toBe("");
  });

  test("a run-branch collision is caught in preflight", () => {
    const { clone: cwd } = fixtureClone();
    const rel = rootsGraph(cwd, 1);
    const { runBranch } = planned(cwd, rel);
    g(cwd, "branch", runBranch);

    const r = approveAndCreate(cwd, rel);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(runBranch);
    expect(runState(cwd).goals).toEqual([]);
  });

  test("an occupied worktree destination is caught in preflight", () => {
    const { clone: cwd } = fixtureClone();
    const rel = rootsGraph(cwd, 1);
    const [id] = planned(cwd, rel).ids;
    mkdirSync(join(cwd, ".sddx-worktrees", id as string), { recursive: true });
    writeFileSync(join(cwd, ".sddx-worktrees", id as string, "squatter.txt"), "x\n");

    const r = approveAndCreate(cwd, rel);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(id as string);
    expect(runState(cwd).goals).toEqual([]);
    expect(g(cwd, "branch", "--list", "sddx/run-*").stdout.trim()).toBe("");
  });

  test("preflight refusal leaves no goal, task, worktree, or branch behind", () => {
    const { clone: cwd } = fixtureClone();
    const rel = rootsGraph(cwd, 3);
    const { ids } = planned(cwd, rel);
    g(cwd, "branch", `sddx/${ids[2]}`);

    expect(approveAndCreate(cwd, rel).status).not.toBe(0);
    const state = runState(cwd);
    expect(state.goals).toEqual([]);
    expect(state.tasks).toEqual([]);
    expect(state.worktrees).toEqual([]);
    // only the branch the test itself planted
    expect(state.branches.replace(`sddx/${ids[2]}`, "").trim()).toBe("");
  });
});

describe("rollback after a partial initialization", () => {
  test("failure creating the second of three roots removes the first, the run branch, and the goal", () => {
    const { clone: cwd } = fixtureClone();
    const rel = rootsGraph(cwd, 3);
    const { ids } = planned(cwd, rel);

    // A ref DIRECTORY at `sddx/<id1>/…` makes `git branch sddx/<id1>` fail with
    // a lock error, while `branchExists("sddx/<id1>")` is legitimately false —
    // so preflight passes and creation fails partway, which is exactly the
    // shape rollback exists for.
    expect(g(cwd, "branch", `sddx/${ids[1]}/blocker`).status).toBe(0);

    const r = approveAndCreate(cwd, rel);
    expect(r.status).not.toBe(0);

    const state = runState(cwd);
    expect(state.goals).toEqual([]);
    expect(state.tasks).toEqual([]);
    expect(state.worktrees).toEqual([]);
    expect(g(cwd, "branch", "--list", "sddx/run-*").stdout.trim()).toBe("");
    // the first task's branch and worktree are gone too
    expect(state.branches).not.toContain(`sddx/${ids[0]}`);
  });
});

describe("a one-node graph is an ordinary run", () => {
  test("goal record, run branch, one task branch, one worktree", () => {
    const { clone: cwd } = fixtureClone();
    const rel = rootsGraph(cwd, 1);
    const created = approveAndCreate(cwd, rel);
    expect(created.status).toBe(0);

    const state = runState(cwd);
    expect(state.goals).toHaveLength(1);
    expect(state.worktrees).toHaveLength(1);
    expect(g(cwd, "branch", "--list", "sddx/run-*").stdout.trim()).not.toBe("");

    const [id] = state.worktrees;
    expect(state.branches).toContain(`sddx/${id}`);
    // the task's own state lives in its worktree, as for any node of any graph
    expect(
      existsSync(join(cwd, ".sddx-worktrees", id as string, ".sddx", "tasks", `${id}.json`)),
    ).toBe(true);
  });
});

describe("the canonical path does not downgrade", () => {
  test("auto resolves to worktree and refuses rather than silently using branch mode", () => {
    const { clone: cwd } = fixtureClone();
    writeFileSync(
      join(cwd, ".gitmodules"),
      '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = ./x\n',
    );
    g(cwd, "add", "-A");
    g(cwd, "commit", "-qm", "gitmodules");
    g(cwd, "push", "-q", "origin", "HEAD");
    // scope reaches the submodule, so worktree mode cannot proceed
    mkdirSync(join(cwd, "specs"), { recursive: true });
    writeFileSync(join(cwd, "specs", "a.yaml"), spec("do the widget work", "vendor/lib/**"));
    writeFileSync(
      join(cwd, "graph.yaml"),
      "goal: ship the widget\ntasks:\n  - alias: a\n    spec: specs/a.yaml\n",
    );

    const r = cli(cwd, "graph", "create", "--graph", "graph.yaml");
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("→ branch mode");
    expect(runState(cwd)).toEqual(EMPTY);
  });
});
