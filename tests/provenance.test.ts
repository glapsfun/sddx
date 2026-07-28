import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureClone } from "./fixtures";
import { GRAPH_HEADER, readGoalAnywhere, repoRoot } from "./helpers";

const CLI_SRC = join(repoRoot, "src/cli.ts");
const cli = (cwd: string, ...args: string[]) =>
  spawnSync("bun", [CLI_SRC, ...args], { cwd, encoding: "utf8", env: process.env });

const BRIEF = `${GRAPH_HEADER}goal: ship the widget
answers:
  - id: q1
    question: which store?
    answer: postgres
assumptions:
  - "the project uses Vite"
`;

/** A two-root plan whose oracles pass once each task writes its own file. */
function planRepo(cwd: string, mode: "human" | "auto"): string {
  mkdirSync(join(cwd, ".sddx"), { recursive: true });
  writeFileSync(
    join(cwd, ".sddx", "config.json"),
    JSON.stringify({ interaction_mode: mode, auto_max_tasks: 9 }),
  );
  const drafts = join(cwd, ".sddx", "drafts");
  mkdirSync(drafts, { recursive: true });
  const lines = [BRIEF.replace(/interaction_mode: human/, `interaction_mode: ${mode}`), "tasks:"];
  for (let i = 0; i < 2; i++) {
    writeFileSync(
      join(drafts, `n${i}.yaml`),
      `task: build part ${i}\nsuccess_criteria:\n  - "part ${i} exists"\nscope:\n  - "part${i}/**"\noracle:\n  type: command\n  run: "test -f part${i}/out.txt"\n`,
    );
    lines.push(`  - alias: n${i}`, `    spec: n${i}.yaml`);
  }
  const rel = join(".sddx", "drafts", "graph.yaml");
  writeFileSync(join(cwd, rel), `${lines.join("\n")}\n`);
  return rel;
}

/** Drives one task from its worktree to DONE with a passing oracle. */
function completeTask(cwd: string, id: string, part: string): void {
  const wt = join(cwd, ".sddx-worktrees", id);
  const run = (...args: string[]) => spawnSync(args[0] as string, args.slice(1), { cwd: wt });
  cli(wt, "task", "phase", id, "RED", "--test-exit", "1");
  cli(wt, "red-check", id);
  mkdirSync(join(wt, part), { recursive: true });
  writeFileSync(join(wt, part, "out.txt"), "done\n");
  run("git", "add", "-A");
  cli(wt, "task", "phase", id, "GREEN", "--test-exit", "0");
  cli(wt, "task", "phase", id, "VERIFY");
  const v = cli(wt, "verify", id);
  expect(v.status).toBe(0);
}

/** Runs a whole goal in `mode`, returning its ids and the paths that matter. */
function runGoal(mode: "human" | "auto") {
  const { clone: cwd } = fixtureClone();
  const rel = planRepo(cwd, mode);
  if (mode === "human") expect(cli(cwd, "graph", "approve", "--graph", rel).status).toBe(0);
  const created = cli(cwd, "graph", "create", "--graph", rel, "--output", "json");
  expect(created.status).toBe(0);
  const data = JSON.parse(created.stdout).data;
  const map = data.aliasToId as Record<string, string>;
  completeTask(cwd, map.n0 as string, "part0");
  completeTask(cwd, map.n1 as string, "part1");
  return { cwd, rel, goalId: data.goalId as string, map };
}

interface GoalShape {
  approval: {
    mode: string;
    authorization: string;
    plan_sha256: string;
    at: string;
  };
  task_ids: string[];
  merges: { status: string }[];
  run_branch: string;
}

const approvalOf = (cwd: string, goalId: string) =>
  (readGoalAnywhere(cwd, goalId) as unknown as GoalShape).approval;

const goalOf = (cwd: string, goalId: string) =>
  readGoalAnywhere(cwd, goalId) as unknown as GoalShape;

const receiptOf = (cwd: string, id: string) =>
  JSON.parse(
    readFileSync(join(cwd, ".sddx-worktrees", id, ".sddx", "receipts", `${id}.json`), "utf8"),
  );

describe("goal-record provenance", () => {
  test("a human run records mode, plan digest, authorization type and timestamp", () => {
    const { cwd, goalId, rel } = runGoal("human");
    const a = approvalOf(cwd, goalId);
    expect(a.mode).toBe("human");
    expect(a.authorization).toBe("human-approval");
    expect(a.plan_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(a.at)).not.toBeNaN();
    // the digest is over the draft as reviewed — brief header included
    expect(readFileSync(join(cwd, rel), "utf8")).toContain("answer: postgres");
  });

  test("an auto run records the authorization as auto, not as a human approval", () => {
    const { cwd, goalId } = runGoal("auto");
    const a = approvalOf(cwd, goalId);
    expect(a.mode).toBe("auto");
    expect(a.authorization).toBe("auto");
  }, 60_000);
});

describe("receipt provenance", () => {
  test("a completed run is interpretable with no access to the conversation", () => {
    const { cwd, map } = runGoal("human");
    for (const id of Object.values(map)) {
      const r = receiptOf(cwd, id);
      // what ran, under what interpretation, authorized how, against which plan
      expect(r.approval.mode).toBe("human");
      expect(r.approval.authorization).toBe("human-approval");
      expect(r.approval.plan_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(r.approval.assumptions).toContain("the project uses Vite");
      expect(r.approval.assumptions).toContain("answered: which store? → postgres");
      expect(r.oracle.run).toContain("test -f");
      expect(r.runs.length).toBeGreaterThan(0);
    }
  });

  test("an auto receipt carries the auto authorization", () => {
    const { cwd, map } = runGoal("auto");
    for (const id of Object.values(map)) {
      expect(receiptOf(cwd, id).approval.authorization).toBe("auto");
    }
  }, 60_000);

  test("the audit accepts the added provenance field", () => {
    const { cwd } = runGoal("human");
    expect(cli(cwd, "audit").status).toBe(0);
  });
});

describe("the run summary reports provenance", () => {
  test("terminal, JSON and Markdown all carry mode, authorization, answers and assumptions", () => {
    const { cwd, goalId } = runGoal("human");

    const term = cli(cwd, "run", "report", "--goal", goalId);
    expect(term.status).toBe(0);
    expect(term.stdout).toContain("mode: human");
    expect(term.stdout).toContain("the project uses Vite");
    expect(term.stdout).toContain("answered: which store? → postgres");

    const json = cli(cwd, "run", "report", "--goal", goalId, "--output", "json");
    const d = JSON.parse(json.stdout).data;
    expect(d.interactionMode).toBe("human");
    expect(d.authorization).toBe("human-approval");
    expect(d.assumptions).toContain("the project uses Vite");

    const md = cli(cwd, "run", "report", "--goal", goalId, "--output", "markdown");
    expect(md.stdout).toContain("the project uses Vite");
  });
});

describe("the two modes differ only in provenance", () => {
  test("git and state topology are identical after authorization", () => {
    const human = runGoal("human");
    const auto = runGoal("auto");

    const shape = (r: ReturnType<typeof runGoal>) => {
      const g = goalOf(r.cwd, r.goalId);
      const branches = spawnSync("git", ["branch", "--list"], { cwd: r.cwd, encoding: "utf8" });
      return {
        taskCount: g.task_ids.length,
        merges: g.merges.map((m) => m.status),
        runBranchShape: g.run_branch.replace(/run-.*/, "run-<id>"),
        branchCount: (branches.stdout ?? "").trim().split("\n").length,
        receiptVersions: Object.values(r.map).map((id) => receiptOf(r.cwd, id).version),
        phases: Object.values(r.map).map(
          (id) =>
            JSON.parse(
              readFileSync(
                join(r.cwd, ".sddx-worktrees", id, ".sddx", "tasks", `${id}.json`),
                "utf8",
              ),
            ).phase,
        ),
      };
    };
    expect(shape(auto)).toEqual(shape(human));

    // ...and the provenance is exactly where they differ
    const hp = approvalOf(human.cwd, human.goalId);
    const ap = approvalOf(auto.cwd, auto.goalId);
    expect(hp.mode).not.toBe(ap.mode);
    expect(hp.authorization).not.toBe(ap.authorization);
  }, 120_000);

  test("both modes reach the identical goal-scoped Next Actions menu", () => {
    const human = runGoal("human");
    const auto = runGoal("auto");
    const menu = (r: ReturnType<typeof runGoal>) => {
      const out = cli(r.cwd, "next-actions", "--goal", r.goalId, "--output", "json");
      expect(out.status).toBe(0);
      return JSON.parse(out.stdout).data.actions;
    };
    expect(menu(auto)).toEqual(menu(human));
  }, 120_000);
});

describe("plan-only approval", () => {
  test("an approval recorded without creating is found by a later run", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, "human");

    // plan only: render and approve, create nothing
    expect(cli(cwd, "graph", "create", "--graph", rel, "--dry-run").status).toBe(0);
    expect(cli(cwd, "graph", "approve", "--graph", rel).status).toBe(0);

    // later, against the unchanged draft, the token still matches
    const created = cli(cwd, "graph", "create", "--graph", rel, "--output", "json");
    expect(created.status).toBe(0);
    expect(JSON.parse(created.stdout).data.goalId).toBeTruthy();
  });

  test("but not once the draft has changed underneath it", () => {
    const { clone: cwd } = fixtureClone();
    const rel = planRepo(cwd, "human");
    expect(cli(cwd, "graph", "approve", "--graph", rel).status).toBe(0);
    writeFileSync(
      join(cwd, rel),
      readFileSync(join(cwd, rel), "utf8").replace("postgres", "sqlite"),
    );
    expect(cli(cwd, "graph", "create", "--graph", rel).status).toBe(3);
  });
});
