import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planHash } from "../src/lib/approval";
import { approvalGate } from "../src/lib/approvalgate";
import { fixtureClone } from "./fixtures";
import { goalIds, readGoalAnywhere, repoRoot } from "./helpers";

const CLI = join(repoRoot, "src/cli.ts");
const cli = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
  spawnSync("bun", [CLI, ...args], { cwd, encoding: "utf8", env });
const g = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

// Mode is config-only by design (config.ts executionMode): the environment is
// part of the command line the agent composes, so it must not switch the gate.
const human = process.env;
const auto = process.env;
function withMode(cwd: string, mode: "human" | "auto", autoMaxTasks?: number): void {
  mkdirSync(join(cwd, ".sddx"), { recursive: true });
  writeFileSync(
    join(cwd, ".sddx", "config.json"),
    JSON.stringify({
      execution_mode: mode,
      ...(autoMaxTasks ? { auto_max_tasks: autoMaxTasks } : {}),
    }),
  );
}

/**
 * A two-root plan whose oracles pass once each task writes its own file, so a
 * full RED → GREEN → VERIFY cycle can be driven without a subagent.
 */
function planRepo(cwd: string, nodes = 2): string {
  const drafts = join(cwd, ".sddx", "drafts");
  mkdirSync(drafts, { recursive: true });
  const lines = ["goal: ship the widget", "assumptions:", '  - "the project uses Vite"', "tasks:"];
  for (let i = 0; i < nodes; i++) {
    writeFileSync(
      join(drafts, `n${i}.yaml`),
      `task: build part ${i}
success_criteria:
  - "part ${i} exists"
scope:
  - "part${i}/**"
oracle:
  type: command
  run: "test -f part${i}/out.txt"
`,
    );
    lines.push(`  - alias: n${i}`, `    spec: n${i}.yaml`);
  }
  const rel = join(".sddx", "drafts", "graph.yaml");
  writeFileSync(join(cwd, rel), `${lines.join("\n")}\n`);
  return rel;
}

function materialized(cwd: string) {
  const dir = (p: string) => (existsSync(join(cwd, p)) ? readdirSync(join(cwd, p)) : []);
  return {
    goals: goalIds(cwd),
    branches: g(cwd, "branch", "--list", "sddx/*"),
    worktrees: dir(".sddx-worktrees"),
  };
}

/** Drives one worktree task through RED → GREEN → VERIFY using the real CLI. */
function completeTask(cwd: string, env: NodeJS.ProcessEnv, id: string, part: string): void {
  const wt = join(cwd, ".sddx-worktrees", id);
  expect(existsSync(wt)).toBe(true);
  // RED first (earned from a failing test exit), then red-check records that the
  // oracle itself genuinely fails — red-check requires phase RED, not PLAN
  expect(cli(wt, env, "task", "phase", id, "RED", "--test-exit", "1").status).toBe(0);
  expect(cli(wt, env, "red-check", id).status).toBe(0);
  mkdirSync(join(wt, part), { recursive: true });
  writeFileSync(join(wt, part, "out.txt"), "done\n");
  expect(cli(wt, env, "task", "phase", id, "GREEN", "--test-exit", "0").status).toBe(0);
  expect(cli(wt, env, "task", "phase", id, "VERIFY").status).toBe(0);
  const v = cli(wt, env, "verify", id);
  expect(v.status).toBe(0);
}

function aliasMap(stdout: string): Record<string, string> {
  return JSON.parse(stdout).data.aliasToId as Record<string, string>;
}

describe("human mode end-to-end", () => {
  test("blocks the whole run before approval, then completes with matching provenance", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 2);

    // 1. nothing exists, and the gate refuses to create anything
    const blocked = cli(cwd, human, "graph", "create", "--graph", rel);
    expect(blocked.status).toBe(3);
    expect(materialized(cwd)).toEqual({ goals: [], branches: "", worktrees: [] });

    // 2. the plan renders without side effects
    const dry = cli(cwd, human, "graph", "create", "--graph", rel, "--dry-run");
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("nothing written");
    expect(materialized(cwd)).toEqual({ goals: [], branches: "", worktrees: [] });

    // 3. approve, then create
    expect(cli(cwd, human, "graph", "approve", "--graph", rel).status).toBe(0);
    const created = cli(cwd, human, "graph", "create", "--graph", rel, "--output", "json");
    expect(created.status).toBe(0);
    const map = aliasMap(created.stdout);
    const goalId = JSON.parse(created.stdout).data.goalId as string;

    // 4. drive both tasks to DONE
    completeTask(cwd, human, map.n0, "part0");
    completeTask(cwd, human, map.n1, "part1");

    // 5. every receipt agrees with the goal on mode and plan hash
    const goal = readGoalAnywhere(cwd, goalId) as any;
    expect(goal.approval.mode).toBe("human");
    expect(goal.approval.plan_sha256).toBe(planHash(join(cwd, rel)).hash);
    for (const id of Object.values(map)) {
      const r = JSON.parse(
        readFileSync(join(cwd, ".sddx-worktrees", id, ".sddx", "receipts", `${id}.json`), "utf8"),
      );
      expect(r.version).toBe(4);
      expect(r.approval.mode).toBe("human");
      expect(r.approval.plan_sha256).toBe(goal.approval.plan_sha256);
      // the graph-level assumption reached every receipt
      expect(r.approval.assumptions).toContain("the project uses Vite");
    }

    // 6. the summary reports it, and the audit is clean
    const report = cli(cwd, human, "run", "report", "--goal", goalId);
    expect(report.status).toBe(0);
    expect(report.stdout).toContain("ship the widget");
    expect(report.stdout).toContain("mode: human");
    expect(report.stdout).toContain("2 of 2");
    expect(cli(cwd, human, "audit").status).toBe(0);
  }, 60_000);

  test("an interrupted run resumes with no second approval", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 2);
    cli(cwd, human, "graph", "approve", "--graph", rel);
    const created = cli(cwd, human, "graph", "create", "--graph", rel, "--output", "json");
    const map = aliasMap(created.stdout);
    const goalId = JSON.parse(created.stdout).data.goalId as string;

    // one task lands; the "session dies" here
    completeTask(cwd, human, map.n0, "part0");

    // resuming reads the board and finds the remaining task Ready — no gate,
    // because the gate is armed on graph create only and that already happened
    const board = cli(cwd, human, "board", "--output", "json");
    expect(board.status).toBe(0);
    completeTask(cwd, human, map.n1, "part1");

    const report = cli(cwd, human, "run", "report", "--goal", goalId);
    expect(report.stdout).toContain("2 of 2");
    expect(report.stdout).toContain("Run completed");
  }, 60_000);

  test("editing a spec after approval blocks creation with a hash mismatch", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 2);
    cli(cwd, human, "graph", "approve", "--graph", rel);

    writeFileSync(
      join(cwd, ".sddx", "drafts", "n1.yaml"),
      `task: build part 1 differently
success_criteria:
  - "part 1 exists"
scope:
  - "part1/**"
oracle:
  type: command
  run: "test -f part1/out.txt"
`,
    );
    const r = cli(cwd, human, "graph", "create", "--graph", rel);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("no approval");
    expect(materialized(cwd)).toEqual({ goals: [], branches: "", worktrees: [] });
  }, 30_000);
});

describe("auto mode end-to-end", () => {
  test("completes the same goal unattended with mode auto in every receipt", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 2);
    withMode(cwd, "auto");

    // no approval step at all
    const created = cli(cwd, auto, "graph", "create", "--graph", rel, "--output", "json");
    expect(created.status).toBe(0);
    const map = aliasMap(created.stdout);
    const goalId = JSON.parse(created.stdout).data.goalId as string;
    expect(existsSync(join(cwd, ".sddx", "approvals"))).toBe(false);

    completeTask(cwd, auto, map.n0, "part0");
    completeTask(cwd, auto, map.n1, "part1");

    for (const id of Object.values(map)) {
      const r = JSON.parse(
        readFileSync(join(cwd, ".sddx-worktrees", id, ".sddx", "receipts", `${id}.json`), "utf8"),
      );
      expect(r.approval.mode).toBe("auto");
    }
    const report = cli(cwd, auto, "run", "report", "--goal", goalId);
    expect(report.stdout).toContain("mode: auto");
    expect(report.stdout).toContain("2 of 2");
    expect(cli(cwd, auto, "audit").status).toBe(0);
  }, 60_000);

  test("exceeding auto_max_tasks refuses terminally and cannot be approved away", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 3);
    withMode(cwd, "auto", 2);
    const capped = auto;

    const refused = cli(cwd, capped, "graph", "create", "--graph", rel);
    expect(refused.status).not.toBe(0);
    // exit 3 is "approval required"; a bound refuses rather than arming the gate
    expect(refused.status).not.toBe(3);
    expect(refused.stderr).toContain("auto_max_tasks");
    expect(materialized(cwd)).toEqual({ goals: [], branches: "", worktrees: [] });

    // No token can buy the run: approving is a human act, so it belongs to
    // human mode. Previously this path produced a run recorded `auto` that a
    // human had in fact approved — the hybrid this behavior removes.
    expect(cli(cwd, capped, "graph", "approve", "--graph", rel).status).not.toBe(0);
    expect(cli(cwd, capped, "graph", "create", "--graph", rel).status).not.toBe(0);
    expect(materialized(cwd)).toEqual({ goals: [], branches: "", worktrees: [] });
  }, 60_000);

  test("the same plan runs once configuration selects human mode", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 3);
    withMode(cwd, "human", 2);
    expect(cli(cwd, human, "graph", "approve", "--graph", rel).status).toBe(0);
    const created = cli(cwd, human, "graph", "create", "--graph", rel, "--output", "json");
    expect(created.status).toBe(0);
    const goalId = JSON.parse(created.stdout).data.goalId as string;
    const goal = readGoalAnywhere(cwd, goalId) as any;
    expect(goal.approval.mode).toBe("human");
    expect(goal.approval.requested_mode).toBeUndefined();
    expect(goal.approval.degraded_reason).toBeUndefined();
  }, 60_000);

  test("the completion summary has identical sections in both modes", () => {
    const sections = (env: NodeJS.ProcessEnv) => {
      const { clone: cwd } = fixtureClone();
      const rel = planRepo(cwd, 1);
      withMode(cwd, env === auto ? "auto" : "human");
      cli(cwd, env, "graph", "approve", "--graph", rel);
      const created = cli(cwd, env, "graph", "create", "--graph", rel, "--output", "json");
      const map = aliasMap(created.stdout);
      const goalId = JSON.parse(created.stdout).data.goalId as string;
      completeTask(cwd, env, map.n0, "part0");
      return cli(cwd, env, "run", "report", "--goal", goalId)
        .stdout.split("\n")
        .filter((l) =>
          /^(Goal|Approval|Summary|Oracle results|Assumptions|Review commands):?$/.test(
            l.trim().replace(/:.*$/, (m) => (l.startsWith("Goal") ? m : "")),
          ),
        );
    };
    const h = sections(human);
    const a = sections(auto);
    expect(h.length).toBeGreaterThan(0);
    expect(h).toEqual(a);
  }, 90_000);
});

describe("the gate is not self-grantable", () => {
  test("SECURITY: approve+create in one turn still raises the dialog on approve", () => {
    // The defeat this closes: an agent runs `graph approve` (ungated) then
    // `graph create`, which now finds a token and passes — so human mode became a
    // no-op that recorded `mode: human` for work no human saw. The fix is that
    // `graph approve` is itself gated and ALWAYS asks.
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 2);
    withMode(cwd, "human");

    expect(approvalGate({ command: `sddx graph approve --graph ${rel}`, cwd }).decision).toBe(
      "ask",
    );
    // and the create the agent would chain after it is gated too, until a token exists
    expect(approvalGate({ command: `sddx graph create --graph ${rel}`, cwd }).decision).toBe("ask");
    // both halves of a compound command are inspected
    expect(
      approvalGate({
        command: `sddx graph approve --graph ${rel} && sddx graph create --graph ${rel}`,
        cwd,
      }).decision,
    ).toBe("ask");
  }, 30_000);

  test("SECURITY: swapping --workspace after approval is refused, not silently applied", () => {
    // Approving a `worktree` render must not authorize `--workspace none`, which
    // runs every task in the user's live checkout instead of an isolated worktree.
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, 1);
    withMode(cwd, "human");
    expect(
      cli(cwd, process.env, "graph", "approve", "--graph", rel, "--workspace", "worktree").status,
    ).toBe(0);

    const swapped = cli(cwd, process.env, "graph", "create", "--graph", rel, "--workspace", "none");
    expect(swapped.status).toBe(3);
    expect(swapped.stderr).toContain("approved for workspace");
    expect(materialized(cwd)).toEqual({ goals: [], branches: "", worktrees: [] });

    // the strategy that WAS approved still works
    expect(
      cli(cwd, process.env, "graph", "create", "--graph", rel, "--workspace", "worktree").status,
    ).toBe(0);
  }, 30_000);
});
