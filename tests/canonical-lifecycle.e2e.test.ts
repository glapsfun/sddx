// The canonical run lifecycle, end to end.
//
// Sections 1-6 each proved their own piece in isolation. This exercises them
// together, which is the first time the interactions are under test: deferred
// materialization on top of the typed workspace mode, rollback on top of the
// narrowed preconditions, the run summary reading a goal record that lives in a
// ref, and human/auto producing the same topology.
//
// Every case here is one of the nine the change's own verification list names.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readGoal } from "../src/lib/goal";
import { fixtureClone } from "./fixtures";
import { fakeRedCheck, goalIds, repoRoot } from "./helpers";

const CLI = join(repoRoot, "src/cli.ts");
const cli = (cwd: string, ...args: string[]) =>
  spawnSync("bun", [CLI, ...args], { cwd, encoding: "utf8" });
const g = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

const spec = (task: string, part: string) =>
  `task: ${task}\nsuccess_criteria:\n  - a\nscope:\n  - ${part}/**\noracle:\n  type: command\n  run: "test -f ${part}/out.txt"\n`;

/** Writes a graph from `[alias, part, dependsOn?]` triples. */
function plan(cwd: string, nodes: Array<[string, string, string?]>): string {
  mkdirSync(join(cwd, "specs"), { recursive: true });
  const lines = ["goal: ship the widget", "tasks:"];
  for (const [alias, part, dep] of nodes) {
    writeFileSync(join(cwd, "specs", `${alias}.yaml`), spec(`build ${alias}`, part));
    lines.push(`  - alias: ${alias}`, `    spec: specs/${alias}.yaml`);
    if (dep) lines.push(`    depends_on: ${dep}`);
  }
  writeFileSync(join(cwd, "graph.yaml"), `${lines.join("\n")}\n`);
  return "graph.yaml";
}

function create(cwd: string, rel = "graph.yaml") {
  expect(cli(cwd, "graph", "approve", "--graph", rel).status).toBe(0);
  const r = cli(cwd, "graph", "create", "--graph", rel, "--output", "json");
  expect(r.status).toBe(0);
  const d = JSON.parse(r.stdout).data;
  return {
    goalId: d.goalId as string,
    byAlias: d.aliasToId as Record<string, string>,
    runBranch: d.runBranch as string,
  };
}

/** RED → GREEN → VERIFY in the task's own workspace, satisfying its oracle. */
function drive(cwd: string, id: string, part: string, root = cwd): void {
  const wt = existsSync(join(root, ".sddx-worktrees", id))
    ? join(root, ".sddx-worktrees", id)
    : root;
  expect(cli(wt, "task", "phase", id, "RED", "--test-exit", "1").status).toBe(0);
  fakeRedCheck(wt, id);
  mkdirSync(join(wt, part), { recursive: true });
  writeFileSync(join(wt, part, "out.txt"), "done\n");
  expect(cli(wt, "task", "phase", id, "GREEN", "--test-exit", "0").status).toBe(0);
  expect(cli(wt, "task", "phase", id, "VERIFY").status).toBe(0);
  expect(cli(wt, "verify", id).status).toBe(0);
}

const state = (cwd: string) => ({
  goals: goalIds(cwd),
  branches: g(cwd, "branch", "--list", "sddx/*").stdout.trim(),
  worktrees: existsSync(join(cwd, ".sddx-worktrees"))
    ? readdirSync(join(cwd, ".sddx-worktrees")).sort()
    : [],
});

describe("one-node run", () => {
  test("goal record, run branch, one worktree, merged, summarized", () => {
    const { clone: cwd } = fixtureClone();
    plan(cwd, [["a", "part-a"]]);
    const { goalId, byAlias, runBranch } = create(cwd);
    drive(cwd, byAlias.a as string, "part-a");

    const goal = readGoal(cwd, goalId);
    expect(goal.run_branch).toBe(runBranch);
    expect(goal.merges.map((m) => m.result)).toEqual(["merged"]);

    const report = cli(cwd, "run", "report", "--goal", goalId);
    expect(report.status).toBe(0);
    expect(report.stdout).toContain("Run completed");
    expect(report.stdout).toContain("1 of 1 task(s) merged");
    expect(cli(cwd, "audit").status).toBe(0);
  }, 60_000);
});

describe("parallel root tasks", () => {
  test("two roots fork from the same run-branch tip and both merge", () => {
    const { clone: cwd } = fixtureClone();
    plan(cwd, [
      ["a", "part-a"],
      ["b", "part-b"],
    ]);
    const { goalId, byAlias, runBranch } = create(cwd);
    const tip = g(cwd, "rev-parse", runBranch).stdout.trim();
    for (const alias of ["a", "b"]) {
      const wt = join(cwd, ".sddx-worktrees", byAlias[alias] as string);
      // both forked from the run branch's initial tip, not from origin/HEAD each
      expect(g(wt, "rev-parse", "HEAD").stdout.trim()).toBe(tip);
    }
    drive(cwd, byAlias.a as string, "part-a");
    drive(cwd, byAlias.b as string, "part-b");

    expect(readGoal(cwd, goalId).merges).toHaveLength(2);
    expect(cli(cwd, "run", "report", "--goal", goalId).stdout).toContain("2 of 2 task(s) merged");
  }, 90_000);
});

describe("dependent and fan-in tasks", () => {
  test("a dependent materializes from its parent's commit, not the run tip", () => {
    const { clone: cwd } = fixtureClone();
    plan(cwd, [
      ["a", "part-a"],
      ["b", "part-b", "a"],
    ]);
    const { goalId, byAlias } = create(cwd);
    const depId = byAlias.b as string;

    // deferred: typed as such, no worktree, and it does not govern the checkout
    expect(existsSync(join(cwd, ".sddx-worktrees", depId))).toBe(false);
    const deferred = JSON.parse(readFileSync(join(cwd, ".sddx", "tasks", `${depId}.json`), "utf8"));
    expect(deferred.workspace.mode).toBe("deferred");
    expect(deferred.workspace.materialize_as).toBe("worktree");

    drive(cwd, byAlias.a as string, "part-a");
    expect(cli(cwd, "task", "materialize", depId).status).toBe(0);
    const depWt = join(cwd, ".sddx-worktrees", depId);
    expect(g(depWt, "rev-parse", "HEAD").stdout.trim()).toBe(
      g(cwd, "rev-parse", `sddx/${byAlias.a}`).stdout.trim(),
    );

    drive(cwd, depId, "part-b");
    expect(readGoal(cwd, goalId).merges).toHaveLength(2);
  }, 90_000);

  test("a fan-in child merges both parents' commits", () => {
    const { clone: cwd } = fixtureClone();
    mkdirSync(join(cwd, "specs"), { recursive: true });
    for (const [alias, part] of [
      ["a", "part-a"],
      ["b", "part-b"],
      ["d", "part-d"],
    ] as const) {
      writeFileSync(join(cwd, "specs", `${alias}.yaml`), spec(`build ${alias}`, part));
    }
    writeFileSync(
      join(cwd, "graph.yaml"),
      [
        "goal: ship the widget",
        "tasks:",
        "  - alias: a",
        "    spec: specs/a.yaml",
        "  - alias: b",
        "    spec: specs/b.yaml",
        "  - alias: d",
        "    spec: specs/d.yaml",
        "    depends_on: [a, b]",
      ].join("\n"),
    );
    const { goalId, byAlias } = create(cwd);
    drive(cwd, byAlias.a as string, "part-a");
    drive(cwd, byAlias.b as string, "part-b");

    expect(cli(cwd, "task", "materialize", byAlias.d as string).status).toBe(0);
    const dWt = join(cwd, ".sddx-worktrees", byAlias.d as string);
    // both parents' work is present in the fan-in worktree
    expect(existsSync(join(dWt, "part-a", "out.txt"))).toBe(true);
    expect(existsSync(join(dWt, "part-b", "out.txt"))).toBe(true);

    drive(cwd, byAlias.d as string, "part-d");
    expect(readGoal(cwd, goalId).merges).toHaveLength(3);
  }, 120_000);
});

describe("partial failure", () => {
  test("one merged, one abandoned, one skipped — reported in a single summary", () => {
    const { clone: cwd } = fixtureClone();
    plan(cwd, [
      ["a", "part-a"],
      ["b", "part-b"],
      ["c", "part-c", "b"],
    ]);
    const { goalId, byAlias } = create(cwd);
    drive(cwd, byAlias.a as string, "part-a");
    const badWt = join(cwd, ".sddx-worktrees", byAlias.b as string);
    expect(cli(badWt, "task", "phase", byAlias.b as string, "ABANDONED").status).toBe(0);

    const out = cli(cwd, "run", "report", "--goal", goalId, "--output", "json");
    expect(out.status).toBe(0);
    const d = JSON.parse(out.stdout).data;
    expect(d.merged).toBe(1);
    expect(d.failed).toBe(1);
    expect(d.skipped).toBe(1);
    expect(d.merged + d.failed + d.skipped + d.blocked + d.conflicted + d.outstanding).toBe(
      d.total,
    );
  }, 90_000);
});

describe("run-branch merge conflict", () => {
  test("aborted and recorded as verified-but-not-integrated, receipt still valid", () => {
    const { clone: cwd } = fixtureClone();
    plan(cwd, [
      ["a", "part-a"],
      ["b", "part-b"],
    ]);
    const { goalId, byAlias, runBranch } = create(cwd);
    drive(cwd, byAlias.a as string, "part-a");

    // Put a conflicting change on the run branch itself, at the exact path task
    // b will write. The plan-time scope gate proves declared lanes disjoint; it
    // cannot prove the run branch has not moved underneath them.
    const scratch = join(cwd, "..", `scratch-${goalId}`);
    expect(g(cwd, "worktree", "add", "-q", scratch, runBranch).status).toBe(0);
    mkdirSync(join(scratch, "part-b"), { recursive: true });
    writeFileSync(join(scratch, "part-b", "out.txt"), "conflicting\n");
    g(scratch, "add", "-A");
    g(scratch, "commit", "-qm", "conflicting change on the run branch");
    expect(g(cwd, "worktree", "remove", "--force", scratch).status).toBe(0);

    drive(cwd, byAlias.b as string, "part-b");

    const goal = readGoal(cwd, goalId);
    const entry = [...goal.merges].reverse().find((m) => m.task_id === byAlias.b);
    expect(entry?.result).toBe("conflict");
    // the conflict is an integration fact, not a verify failure: the task is
    // DONE and its receipt stands
    const wt = join(cwd, ".sddx-worktrees", byAlias.b as string);
    const task = JSON.parse(readFileSync(join(wt, ".sddx", "tasks", `${byAlias.b}.json`), "utf8"));
    expect(task.phase).toBe("DONE");
    expect(existsSync(join(wt, ".sddx", "receipts", `${byAlias.b}.json`))).toBe(true);
    expect(cli(cwd, "audit").status).toBe(0);

    // and the summary distinguishes it from work still in flight
    const d = JSON.parse(
      cli(cwd, "run", "report", "--goal", goalId, "--output", "json").stdout,
    ).data;
    expect(d.conflicted).toBe(1);
    expect(d.merged).toBe(1);
  }, 90_000);
});

describe("worktree preflight refusal", () => {
  test("a scope crossing a submodule refuses and leaves no run state", () => {
    const { clone: cwd } = fixtureClone();
    writeFileSync(
      join(cwd, ".gitmodules"),
      '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = ./x\n',
    );
    g(cwd, "add", "-A");
    g(cwd, "commit", "-qm", "gitmodules");
    g(cwd, "push", "-q", "origin", "HEAD");
    plan(cwd, [["a", "vendor/lib"]]);

    const r = cli(cwd, "graph", "create", "--graph", "graph.yaml");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("vendor/lib");
    expect(state(cwd)).toEqual({ goals: [], branches: "", worktrees: [] });
  }, 60_000);

  test("a task-branch collision refuses before the run branch exists", () => {
    const { clone: cwd } = fixtureClone();
    plan(cwd, [
      ["a", "part-a"],
      ["b", "part-b"],
    ]);
    const dry = cli(
      cwd,
      "graph",
      "create",
      "--graph",
      "graph.yaml",
      "--dry-run",
      "--output",
      "json",
    );
    const ids = JSON.parse(dry.stdout).data.taskIds as string[];
    g(cwd, "branch", `sddx/${ids[1]}`);

    expect(cli(cwd, "graph", "approve", "--graph", "graph.yaml").status).not.toBe(0);
    const r = cli(cwd, "graph", "create", "--graph", "graph.yaml");
    expect(r.status).not.toBe(0);
    expect(goalIds(cwd)).toEqual([]);
    expect(g(cwd, "branch", "--list", "sddx/run-*").stdout.trim()).toBe("");
  }, 60_000);
});

describe("human and auto produce identical topology", () => {
  function withMode(cwd: string, mode: "human" | "auto"): void {
    mkdirSync(join(cwd, ".sddx"), { recursive: true });
    writeFileSync(join(cwd, ".sddx", "config.json"), JSON.stringify({ execution_mode: mode }));
  }

  test("the only difference is how the plan was authorized", () => {
    const shapes: Array<Record<string, unknown>> = [];
    for (const mode of ["human", "auto"] as const) {
      const { clone: cwd } = fixtureClone();
      plan(cwd, [
        ["a", "part-a"],
        ["b", "part-b"],
      ]);
      withMode(cwd, mode);
      // human needs a token; auto within bounds self-approves
      if (mode === "human") {
        expect(cli(cwd, "graph", "approve", "--graph", "graph.yaml").status).toBe(0);
      }
      const r = cli(cwd, "graph", "create", "--graph", "graph.yaml", "--output", "json");
      expect(r.status).toBe(0);
      const byAlias = JSON.parse(r.stdout).data.aliasToId as Record<string, string>;
      drive(cwd, byAlias.a as string, "part-a");
      drive(cwd, byAlias.b as string, "part-b");

      const s = state(cwd);
      shapes.push({
        // ids are derived from the goal sentence, so they match across runs
        worktrees: s.worktrees,
        branches: s.branches
          .split("\n")
          .map((l) => l.trim())
          .sort(),
        merges: readGoal(cwd, s.goals[0] as string).merges.length,
      });
    }
    expect(shapes[0]).toEqual(shapes[1] as Record<string, unknown>);
  }, 120_000);
});
